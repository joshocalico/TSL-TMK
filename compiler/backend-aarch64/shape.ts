// The backend's own reshaping of a function before selection, at -O1 and -O2 only (SPEC 4.4, D75). It works on a copy, so the
// TIR, its text and its tirhash are what the optimiser made; only the machine code differs.
//
// Branch threading. A block with no instructions that only branches on one of its parameters is what `&&`, `||` and an
// inlined boolean result leave: each predecessor computes a compare, passes it in as an argument, and the block tests it
// again. Where the predecessor's own branch already decided that value (the argument is the condition it branched on), the
// edge goes straight to the side the second test would take; where the predecessor jumps there unconditionally, it takes the
// test itself, so its compare sits in the same block as its only use and selection fuses it into the branch. Nothing new is
// computed and no block is copied, so a value is never used anywhere its definition doesn't reach.
import {
  edgesOf,
  reversePostorder,
  type Block,
  type Edge,
  type Func,
  type TirType,
} from "../tir/ir.ts";
import { removeUnreachable } from "../tir/passes/cfg.ts";
import { bitsOf, cloneFunc } from "../tir/passes/util.ts";

export interface ShapeStats {
  threaded: number;
}

/** The function with branches threaded, in reverse postorder, or the function itself if nothing applied. */
export function threadBranches(f0: Func, faults: ReadonlySet<string>, stats?: ShapeStats): Func {
  const f = cloneFunc(f0);
  const consts = new Map<number, bigint>();
  for (const b of f.blocks)
    for (const ins of b.instrs) {
      const o = ins.ops[0];
      if (ins.op.startsWith("iconst.") && o?.t === "i" && ins.res.length === 1)
        consts.set(ins.res[0]!, o.val);
    }
  let changed = false;
  // Each round redirects at least one edge, so it ends; the guard is the bound the rules don't need.
  for (let round = 0; round < 4 * f.blocks.length + 4; round++) {
    if (!threadOnce(f, consts, faults)) break;
    changed = true;
    if (stats !== undefined) stats.threaded++;
  }
  if (!changed) return f0;
  removeUnreachable(f);
  const order = reversePostorder(f);
  f.blocks = order.map((i) => f.blocks[i]!);
  return f;
}

/** Uses of each value outside the terminator of the block that defines it as a parameter. */
function outsideUses(f: Func): Int32Array {
  const n = new Int32Array(f.types.length);
  const paramOf = new Int32Array(f.types.length).fill(-1);
  f.blocks.forEach((b, bi) => b.params.forEach((p) => (paramOf[p] = bi)));
  f.blocks.forEach((b, bi) => {
    for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "v") n[o.id]!++;
    const vals: number[] = [];
    const t = b.term;
    if (t.k === "brif") vals.push(t.cond);
    if (t.k === "switch") vals.push(t.val);
    if (t.k === "ret") vals.push(...t.vals);
    for (const e of edgesOf(t)) vals.push(...e.args);
    for (const v of vals) if (paramOf[v] !== bi) n[v]!++;
  });
  return n;
}

function threadOnce(f: Func, consts: Map<number, bigint>, faults: ReadonlySet<string>): boolean {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const outside = outsideUses(f);
  // A loop header (the target of an edge from itself or a later block) is left alone: redirecting into a loop past its
  // header would give the loop a second entry.
  const header = new Set<number>();
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) if (index.get(e.block)! <= i) header.add(e.block);
  });
  const entry = f.blocks[0]!.id;
  // A candidate tests one parameter: directly (no instructions), or (one instruction) by comparing it for equality with a
  // constant, the compare used by nothing else. `known` is what an edge's arguments say about that test, or null.
  type Cand = {
    b: Block;
    k: number;
    known: (arg: number, nonzero: boolean | null) => boolean | null;
  };
  const candidate = (id: number): Cand | null => {
    const b = f.blocks[index.get(id)!]!;
    const bt = b.term;
    if (id === entry || header.has(id) || bt.k !== "brif") return null;
    // Its parameters are used by nothing but its own compare and terminator.
    const inBlock = (v: number): number =>
      b.instrs.reduce((n, x) => n + x.ops.filter((o) => o.t === "v" && o.id === v).length, 0);
    if (b.params.some((p) => outside[p] !== inBlock(p))) return null;
    const isConst = (v: number, nonzero: boolean | null): boolean | null => {
      const c = consts.get(v);
      return c !== undefined ? c !== 0n : nonzero;
    };
    if (b.instrs.length === 0) {
      if (b.params.some((p) => outside[p] !== 0)) return null;
      const k = b.params.indexOf(bt.cond);
      return k < 0 ? null : { b, k, known: isConst };
    }
    // Constants used only inside the block don't count: they're rebuilt where they're used, and go with the block.
    const real = b.instrs.filter((x) => !x.op.startsWith("iconst."));
    if (real.length !== 1) return null;
    for (const x of b.instrs) {
      if (real.includes(x)) continue;
      const r = x.res[0]!;
      const inside = real[0]!.ops.filter((o) => o.t === "v" && o.id === r).length;
      if (outside[r] !== inside) return null;
    }
    const ins = real[0]!;
    const p = ins.op.split(".");
    if (p[0] !== "icmp" || (p[1] !== "eq" && p[1] !== "ne")) return null;
    if (ins.res[0] !== bt.cond || outside[bt.cond] !== 1) return null;
    const vals = ins.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    const ki = b.params.indexOf(vals[0]!) >= 0 && consts.has(vals[1]!) ? 0 : 1;
    const k = b.params.indexOf(vals[ki]!);
    const other = consts.get(vals[1 - ki]!);
    if (k < 0 || other === undefined || b.params.includes(vals[1 - ki]!)) return null;
    const bits = bitsOf(p[2] as TirType);
    const eq = p[1] === "eq";
    return {
      b,
      k,
      known: (arg, nonzero) => {
        const c = consts.get(arg);
        if (c !== undefined)
          return (BigInt.asUintN(bits, c) === BigInt.asUintN(bits, other)) === eq;
        if (nonzero !== null && other === 0n) return nonzero !== eq;
        return null;
      },
    };
  };
  const subst = (b: Block, e: Edge, x: Edge): Edge => {
    const m = new Map<number, number>();
    b.params.forEach((p, i) => m.set(p, e.args[i]!));
    return { block: x.block, args: x.args.map((a) => m.get(a) ?? a) };
  };
  for (const p of f.blocks) {
    const t = p.term;
    if (t.k === "br") {
      const c = candidate(t.to.block);
      if (c === null || c.b === p) continue;
      const bt = c.b.term as Extract<Block["term"], { k: "brif" }>;
      let value = c.known(t.to.args[c.k]!, null);
      if (value === null) {
        if (c.b.instrs.length > 0) continue; // its compare would have to be copied
        // Unknown: the block's test moves into the predecessor, beside the compare that made its argument.
        p.term = {
          k: "brif",
          cond: t.to.args[c.k]!,
          t: subst(c.b, t.to, bt.t),
          f: subst(c.b, t.to, bt.f),
        };
        return true;
      }
      if (faults.has("b3-thread-invert")) value = !value;
      p.term = { k: "br", to: subst(c.b, t.to, value ? bt.t : bt.f) };
      return true;
    }
    const edges: { e: Edge; known: boolean | null; set: (x: Edge) => void }[] = [];
    if (t.k === "brif") {
      edges.push({ e: t.t, known: true, set: (x) => (t.t = x) });
      edges.push({ e: t.f, known: false, set: (x) => (t.f = x) });
    } else if (t.k === "switch") {
      t.cases.forEach((c) => edges.push({ e: c.to, known: null, set: (x) => (c.to = x) }));
      edges.push({ e: t.def, known: null, set: (x) => (t.def = x) });
    }
    for (const { e, known, set } of edges) {
      const c = candidate(e.block);
      if (c === null || c.b === p) continue;
      const bt = c.b.term as Extract<Block["term"], { k: "brif" }>;
      const arg = e.args[c.k]!;
      let value = c.known(arg, t.k === "brif" && arg === t.cond ? known : null);
      if (value === null) continue;
      // The bug put into this rule (OPT_FAULTS, D75): the edge goes where the test would not have taken it.
      if (faults.has("b3-thread-invert")) value = !value;
      set(subst(c.b, e, value ? bt.t : bt.f));
      return true;
    }
  }
  return false;
}

/**
 * The order to lay a function's blocks out in (reverse postorder at -O0). Blocks that only trap go last. Loop rotation: a loop whose header ends in a test
 * with one way out, and whose other blocks are together with the latch last and jumping back to the header, gets the header
 * moved to just after the latch. The latch then falls into the test, which branches back to the body when the loop goes on, so an iteration runs one
 * taken branch, not a taken jump back plus the test; entering the loop costs one jump to the test instead. Innermost first,
 * so an inner loop rotates inside its outer loop's range, which stays contiguous.
 */
export function layoutBlocks(f: Func, _faults: ReadonlySet<string>): number[] {
  const n = f.blocks.length;
  // A block that only traps is cold: they all go last, so they don't sit inside a loop's blocks or between a branch and
  // the block it would fall into.
  const cold = (i: number): boolean => {
    const b = f.blocks[i]!;
    return i !== 0 && b.instrs.length === 0 && (b.term.k === "trap" || b.term.k === "unreachable");
  };
  const all = f.blocks.map((_, i) => i);
  const order = [...all.filter((i) => !cold(i)), ...all.filter(cold)];
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const preds: number[][] = f.blocks.map(() => []);
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) preds[index.get(e.block)!]!.push(i);
  });
  const loops = new Map<number, Set<number>>();
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) {
      const h = index.get(e.block)!;
      if (h > i) continue;
      const members = loops.get(h) ?? new Set<number>([h]);
      loops.set(h, members);
      const stack = [i];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (members.has(x)) continue;
        members.add(x);
        for (const p of preds[x]!) stack.push(p);
      }
    }
  });
  const byInner = [...loops].sort((a, b) => a[1].size - b[1].size || a[0] - b[0]);
  for (const [h, members] of byInner) {
    if (h === 0 || members.size < 2) continue;
    const t = f.blocks[h]!.term;
    if (t.k !== "brif") continue;
    const tIn = members.has(index.get(t.t.block)!);
    const fIn = members.has(index.get(t.f.block)!);
    if (tIn === fIn) continue;
    const pos = new Int32Array(n);
    order.forEach((b, i) => (pos[b] = i));
    // The rest of the loop has to be together, with the latch last, so the latch can fall into the header put after it.
    let lo = n;
    let hi = -1;
    for (const m of members) {
      if (m === h) continue;
      lo = Math.min(lo, pos[m]!);
      hi = Math.max(hi, pos[m]!);
    }
    if (hi - lo + 1 !== members.size - 1 || (pos[h]! > lo && pos[h]! < hi)) continue;
    const latch = f.blocks[order[hi]!]!.term;
    if (latch.k !== "br" || index.get(latch.to.block) !== h) continue;
    const at = pos[h]!;
    order.splice(at, 1);
    order.splice(at < hi ? hi : hi + 1, 0, h);
  }
  return order;
}

/**
 * The lowest address a load can fault at and still be a null dereference to the runtime: `__rt_exception` takes a data abort
 * below it at a listed instruction for trap 6 (rt-tir.ts). Nothing is mapped there (runtime.ts: the first 64 KiB is never
 * RAM or a device).
 */
export const NULL_GUARD_BYTES = 65536;

const LOAD_BYTES: Record<string, number> = {
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  ix: 8,
  ptr: 8,
  f32: 4,
  f64: 8,
};

/**
 * R7: an explicit null check whose next operation is a load through the same reference, at an offset inside the null guard,
 * left to the load. `brif (icmp.eq x, 0), T, S` with T a block that only traps with code 6 (`!` on null), and S reached from
 * this branch alone, whose instructions up to its first that isn't pure are a load from `x` plus a constant offset (through
 * `bitcast` and a `gep` with a constant index): the branch becomes a jump to S, and the load is returned, by its result, to
 * be listed in the image's table of loads standing for a null check (`__rt_null_pcs`), with its offset. A fault at that
 * instruction at exactly that address, the offset itself, is the reference having been null, and is trap 6 whether a
 * `native.try` is active or not (`__rt_exception`), exactly what the check's own trap reported: inside a try `TMK:C ... T 6`,
 * outside `TMK:PANIC trap 6`. Anything else keeps its old report outside a try (`TMK:FATAL`, with the ESR): a load nowhere in
 * the table, and a listed one through a reference that wasn't null but faulted all the same (a `manual` or unsafe program's
 * bad address), which at -O0 passed the check and faulted the same way.
 *
 * The backend's, not the optimiser's: on Wasm a load near 0 reads linear memory and never faults, so the TIR keeps its check.
 * `skip` names loads (by result) the selection drops or computes again at each use, so their check stays.
 */
export function implicitNullChecks(
  f0: Func,
  trapCode: ReadonlyMap<number, number>,
  faults: ReadonlySet<string>,
  skip: ReadonlySet<number> = new Set(),
): { f: Func; loads: Map<number, number> } {
  // Each load by its result, with the offset from the reference it reads at: where it faults when the reference is null.
  const loads = new Map<number, number>();
  const def = new Map<number, Block["instrs"][number]>();
  for (const b of f0.blocks) for (const ins of b.instrs) for (const r of ins.res) def.set(r, ins);
  const index = new Map<number, number>();
  f0.blocks.forEach((b, i) => index.set(b.id, i));
  const preds = new Map<number, number>();
  for (const b of f0.blocks)
    for (const e of edgesOf(b.term)) preds.set(e.block, (preds.get(e.block) ?? 0) + 1);
  const constOf = (v: number): bigint | null => {
    const d = def.get(v);
    const o = d?.ops[0];
    return d !== undefined && d.op.startsWith("iconst.") && o?.t === "i" ? o.val : null;
  };
  const nullTrap = (id: number): boolean => {
    const b = f0.blocks[index.get(id)!]!;
    return (
      b.params.length === 0 &&
      b.instrs.length === 0 &&
      b.term.k === "trap" &&
      trapCode.get(b.term.id) === 6
    );
  };
  // Each rewrite is decided on f0 and applied to the copy by block position: blocks and values are the same in both.
  const rewrites: { at: number; to: Edge }[] = [];
  f0.blocks.forEach((b, at) => {
    const t = b.term;
    if (t.k !== "brif") return;
    const c = def.get(t.cond);
    if (c === undefined) return;
    const p = c.op.split(".");
    if (p[0] !== "icmp" || (p[1] !== "eq" && p[1] !== "ne")) return;
    if (p[2] !== "i64" && p[2] !== "ptr" && p[2] !== "ix") return;
    const [a, z] = c.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    const x = constOf(z!) === 0n ? a! : constOf(a!) === 0n ? z! : null;
    if (x === null) return;
    const [nul, go] = p[1] === "eq" ? [t.t, t.f] : [t.f, t.t];
    if (!nullTrap(nul.block) || go.args.length > 0 || go.block === nul.block) return;
    const s = f0.blocks[index.get(go.block)!]!;
    if (s.params.length > 0 || preds.get(s.id) !== 1 || index.get(s.id) === 0) return;
    // Addresses that are x plus a known offset, as S makes them.
    const off = new Map<number, bigint>([[x, 0n]]);
    for (const ins of s.instrs) {
      const q = ins.op.split(".");
      const vals = ins.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
      if (q[0] === "load" && q.length === 3 && (q[2] === "na" || q[2] === "inv")) {
        const o = off.get(vals[0]!);
        const size = BigInt(LOAD_BYTES[q[1]!] ?? 8);
        if (o !== undefined && o >= 0n && o + size <= BigInt(NULL_GUARD_BYTES)) {
          if (!skip.has(ins.res[0]!)) {
            loads.set(ins.res[0]!, Number(o));
            rewrites.push({ at, to: go });
          }
        }
        return;
      }
      // The bug put into this rule (OPT_FAULTS, R7): a store before the load is passed over, so it runs before the fault
      // where -O0's check trapped first.
      if (q[0] === "store" && faults.has("b3-null-past-store")) continue;
      if (!isPureOp(ins.op)) return;
      if (q[0] === "bitcast" && (q[1] === "ptr" || q[1] === "i64")) {
        const o = off.get(vals[0]!);
        if (o !== undefined) off.set(ins.res[0]!, o);
      } else if (q[0] === "gep") {
        const o = off.get(vals[0]!);
        const k = constOf(vals[1]!);
        const imms = ins.ops.filter((y) => y.t === "i").map((y) => (y as { val: bigint }).val);
        if (o !== undefined && k !== null && imms.length === 2)
          off.set(ins.res[0]!, o + BigInt.asIntN(64, k) * imms[0]! + imms[1]!);
      }
    }
  });
  if (rewrites.length === 0) return { f: f0, loads };
  const f = cloneFunc(f0);
  for (const r of rewrites) f.blocks[r.at]!.term = { k: "br", to: { block: r.to.block, args: [] } };
  removeUnreachable(f);
  const order = reversePostorder(f);
  f.blocks = order.map((i) => f.blocks[i]!);
  return { f, loads };
}

const PURE_OPS = new Set([
  "iconst",
  "fconst",
  "globaladdr",
  "funcaddr",
  "add",
  "sub",
  "mul",
  "and",
  "or",
  "xor",
  "shl",
  "lshr",
  "ashr",
  "neg",
  "not",
  "fadd",
  "fsub",
  "fmul",
  "fdiv",
  "fneg",
  "fabs",
  "fsqrt",
  "icmp",
  "fcmp",
  "zext",
  "sext",
  "trunc",
  "fpromote",
  "fdemote",
  "sitofp",
  "uitofp",
  "bitcast",
  "select",
  "gep",
]);

/** An operation that can't trap and has no effect: a check (`.chk`) is neither. */
function isPureOp(op: string): boolean {
  const p = op.split(".");
  return PURE_OPS.has(p[0]!) && p[1] !== "chk";
}
