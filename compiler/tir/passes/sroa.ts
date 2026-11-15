// Scalar replacement of frame slots (SPEC 4.3, D46): the simplest form, for what inlining leaves. A stack object whose
// constructor and methods were inlined is an `alloca`, a `mem.fill` with zero, and loads and stores at constant offsets.
// Where that's all it is, each field becomes an SSA value, with block parameters where paths join, and the slot goes.
// A slot is left alone if anything else sees its address: a call, a store of the address itself, a check, a copy, an index
// that isn't constant, accesses that overlap without being the same field, or no zero fill before the first access.
import { buildCfg, edgesOf, type Block, type Func, type Instr, type TirType } from "../ir.ts";
import { removeUnreachable } from "./cfg.ts";
import { intImm, newValue, substitute, valueOps } from "./util.ts";

export interface SroaStats {
  promoted: number;
  loads: number;
  stores: number;
}

const SIZE: Record<TirType, number> = {
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  f32: 4,
  f64: 8,
  ptr: 8,
  ix: 8,
};

interface Access {
  ins: Instr;
  block: number; // id
  kind: "load" | "store" | "fill" | "gep";
  off: number;
  t?: TirType;
}

interface Slot {
  alloca: Instr;
  size: number;
  accesses: Access[];
  fields: { off: number; t: TirType }[];
}

export function sroaFunc(f: Func, stats: SroaStats): boolean {
  const entry = f.blocks[0]!;
  const allocas = entry.instrs.filter((i) => i.op === "alloca");
  if (allocas.length === 0) return false;
  const consts = new Map<number, bigint>();
  const users = new Map<number, { ins: Instr; block: number }[]>();
  const termUse = new Set<number>();
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op.startsWith("iconst.")) consts.set(ins.res[0]!, intImm(ins, 0));
      for (const o of ins.ops) {
        if (o.t !== "v") continue;
        let l = users.get(o.id);
        if (l === undefined) users.set(o.id, (l = []));
        l.push({ ins, block: b.id });
      }
    }
    const t = b.term;
    if (t.k === "brif") termUse.add(t.cond);
    if (t.k === "switch") termUse.add(t.val);
    if (t.k === "ret") for (const v of t.vals) termUse.add(v);
    for (const e of edgesOf(t)) for (const v of e.args) termUse.add(v);
  }
  const slots: Slot[] = [];
  for (const a of allocas) {
    const s = analyse(f, a, users, termUse, consts);
    if (s !== null) slots.push(s);
  }
  if (slots.length === 0) return false;
  removeUnreachable(f);
  for (const s of slots) promote(f, s, stats);
  return true;
}

function analyse(
  f: Func,
  a: Instr,
  users: Map<number, { ins: Instr; block: number }[]>,
  termUse: Set<number>,
  consts: Map<number, bigint>,
): Slot | null {
  const p = a.res[0]!;
  const size = Number(intImm(a, 0));
  if (termUse.has(p)) return null;
  const accesses: Access[] = [];
  const direct = (addr: number, off: number, ins: Instr, block: number): boolean => {
    const vals = valueOps(ins);
    if (
      ins.op.startsWith("load.") &&
      (ins.op.endsWith(".na") || ins.op.endsWith(".inv")) &&
      vals[0] === addr
    ) {
      accesses.push({ ins, block, kind: "load", off, t: f.types[ins.res[0]!]! });
      return true;
    }
    if (
      ins.op.startsWith("store.") &&
      ins.op.endsWith(".na") &&
      vals[0] === addr &&
      vals[1] !== addr
    ) {
      accesses.push({ ins, block, kind: "store", off, t: f.types[vals[1]!]! });
      return true;
    }
    return false;
  };
  for (const u of users.get(p) ?? []) {
    const ins = u.ins;
    // One store of zero over the whole slot, as a small object is cleared: the same as a fill.
    if (ins.op.startsWith("store.") && ins.op.endsWith(".na")) {
      const [addr, v] = valueOps(ins);
      const t = v !== undefined ? f.types[v] : undefined;
      if (addr === p && v !== p && t !== undefined && SIZE[t] === size && consts.get(v!) === 0n) {
        accesses.push({ ins, block: u.block, kind: "fill", off: 0 });
        continue;
      }
    }
    if (direct(p, 0, ins, u.block)) continue;
    if (ins.op === "intrinsic" && ins.ops[0]?.t === "name" && ins.ops[0].name === "mem.fill") {
      const [dst, byte, len] = valueOps(ins);
      if (dst !== p || byte === p || len === p) return null;
      if (consts.get(byte!) !== 0n || consts.get(len!) !== BigInt(size)) return null;
      accesses.push({ ins, block: u.block, kind: "fill", off: 0 });
      continue;
    }
    if (ins.op === "gep") {
      const [base, idx] = valueOps(ins);
      if (base !== p || idx === p) return null;
      const iv = consts.get(idx!);
      if (iv === undefined) return null;
      const off = Number(iv * intImm(ins, 0) + intImm(ins, 1));
      const g = ins.res[0]!;
      if (termUse.has(g)) return null;
      accesses.push({ ins, block: u.block, kind: "gep", off });
      for (const gu of users.get(g) ?? []) if (!direct(g, off, gu.ins, gu.block)) return null;
      continue;
    }
    return null;
  }
  // Fields: each access is a whole field, the same type at the same offset, overlapping no other, inside the slot.
  const fields: { off: number; t: TirType }[] = [];
  for (const x of accesses) {
    if (x.t === undefined) continue;
    const w = SIZE[x.t];
    if (x.off < 0 || x.off + w > size) return null;
    const same = fields.find((y) => y.off === x.off);
    if (same !== undefined) {
      if (same.t !== x.t) return null;
      continue;
    }
    for (const y of fields) if (x.off < y.off + SIZE[y.t] && y.off < x.off + w) return null;
    fields.push({ off: x.off, t: x.t });
  }
  // A zero fill in the entry block, before any access in it: every load then reads something written.
  const entry = f.blocks[0]!;
  const fillAt = entry.instrs.findIndex((i) =>
    accesses.some((x) => x.kind === "fill" && x.ins === i),
  );
  if (fillAt < 0) return null;
  for (let i = 0; i < fillAt; i++)
    if (accesses.some((x) => x.ins === entry.instrs[i] && x.kind !== "gep")) return null;
  if (accesses.filter((x) => x.kind === "fill").length !== 1) return null;
  fields.sort((x, y) => x.off - y.off);
  return { alloca: a, size, accesses, fields };
}

function zeroOf(f: Func, t: TirType): Instr {
  const r = newValue(f, t);
  if (t === "f32" || t === "f64")
    return { op: `fconst.${t}`, ops: [{ t: "i", val: 0n }], res: [r] };
  return { op: `iconst.${t}`, ops: [{ t: "i", val: 0n }], res: [r] };
}

/** Classic SSA construction for each field: parameters at the iterated dominance frontier of the stores, then renaming. */
function promote(f: Func, s: Slot, stats: SroaStats): void {
  const cfg = buildCfg(f);
  const posOf = new Map<number, number>();
  f.blocks.forEach((b, i) => posOf.set(b.id, i));
  // Dominance frontiers (Cooper, Harvey and Kennedy).
  const df: Set<number>[] = f.blocks.map(() => new Set());
  for (let b = 0; b < f.blocks.length; b++) {
    const preds = cfg.preds[b]!;
    if (preds.length < 2) continue;
    for (const p of preds) {
      let runner = p;
      for (let guard = 0; guard <= f.blocks.length && runner !== cfg.idom.get(b); guard++) {
        df[runner]!.add(b);
        const up = cfg.idom.get(runner);
        if (up === undefined || up === runner) break;
        runner = up;
      }
    }
  }
  const children: number[][] = f.blocks.map(() => []);
  for (const [b, d] of cfg.idom) if (b !== d) children[d]!.push(b);
  for (const c of children) c.sort((x, y) => cfg.rpoIndex.get(x)! - cfg.rpoIndex.get(y)!);
  const nf = s.fields.length;
  const fieldAt = new Map<number, number>();
  s.fields.forEach((x, i) => fieldAt.set(x.off, i));
  // Where each field is written: its stores, and the entry block's fill.
  const defBlocks: Set<number>[] = s.fields.map(() => new Set([0]));
  for (const x of s.accesses)
    if (x.kind === "store") defBlocks[fieldAt.get(x.off)!]!.add(posOf.get(x.block)!);
  // Parameters: phis[block position] is the field's new parameter there.
  const phis: Map<number, number>[] = f.blocks.map(() => new Map());
  for (let fi = 0; fi < nf; fi++) {
    const work = [...defBlocks[fi]!];
    const placed = new Set<number>();
    while (work.length > 0) {
      const b = work.pop()!;
      for (const d of df[b]!) {
        if (placed.has(d)) continue;
        placed.add(d);
        phis[d]!.set(fi, newValue(f, s.fields[fi]!.t));
        if (!defBlocks[fi]!.has(d)) work.push(d);
      }
    }
  }
  // Parameters go on in field order, after the block's own.
  for (let b = 0; b < f.blocks.length; b++) {
    const m = phis[b]!;
    for (let fi = 0; fi < nf; fi++) {
      const v = m.get(fi);
      if (v !== undefined) f.blocks[b]!.params.push(v);
    }
  }
  const role = new Map<Instr, Access>();
  for (const x of s.accesses) role.set(x.ins, x);
  const subst = new Map<number, number>();
  const drop = new Set<Instr>([s.alloca]);
  // Renaming, over the dominator tree, with an explicit stack.
  const cur: number[] = Array.from({ length: nf }, () => -1);
  type Frame = { b: number; saved: number[] | null; next: number };
  const stack: Frame[] = [{ b: cfg.rpo[0]!, saved: null, next: -1 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next === -1) {
      top.saved = [...cur];
      const blk: Block = f.blocks[top.b]!;
      const m = phis[top.b]!;
      for (const [fi, v] of m) cur[fi] = v;
      const out: Instr[] = [];
      for (const ins of blk.instrs) {
        const x = role.get(ins);
        if (x === undefined) {
          out.push(ins);
          continue;
        }
        drop.add(ins);
        if (x.kind === "fill") {
          for (let fi = 0; fi < nf; fi++) {
            const z = zeroOf(f, s.fields[fi]!.t);
            out.push(z);
            cur[fi] = z.res[0]!;
          }
        } else if (x.kind === "store") {
          cur[fieldAt.get(x.off)!] = valueOps(ins)[1]!;
          stats.stores++;
        } else if (x.kind === "load") {
          subst.set(ins.res[0]!, cur[fieldAt.get(x.off)!]!);
          stats.loads++;
        }
      }
      blk.instrs = out;
      for (const e of edgesOf(blk.term)) {
        const to = posOf.get(e.block)!;
        const m2 = phis[to]!;
        for (let fi = 0; fi < nf; fi++) if (m2.has(fi)) e.args.push(cur[fi]!);
      }
      top.next = 0;
    }
    const kids = children[top.b]!;
    if (top.next < kids.length) {
      stack.push({ b: kids[top.next++]!, saved: null, next: -1 });
    } else {
      for (let fi = 0; fi < nf; fi++) cur[fi] = top.saved![fi]!;
      stack.pop();
    }
  }
  for (const b of f.blocks) b.instrs = b.instrs.filter((i) => !drop.has(i));
  substitute(f, subst);
  stats.promoted++;
}
