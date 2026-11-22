// Dead code removal (SPEC 4.3, D46): a pure operation whose result nothing needs goes, and so does a block parameter whose
// value nothing needs, with what each edge passes it. Loads, checks and effects stay: a load can fault and a check can trap,
// which is the program's behaviour, and the backend drops a plain load nothing uses at every level, as it always has.
import { edgesOf, ValMap, type Func, type Instr } from "../ir.ts";
import { effectOf } from "./util.ts";

export interface DceStats {
  instrs: number;
  params: number;
}

/** Marks what's needed from the roots (effects, loads, checks, branch conditions, returns) and removes the rest. */
export function dceFunc(
  f: Func,
  stats: DceStats,
  faults: { dropEffect?: boolean; dropLive?: boolean } = {},
): boolean {
  const n = f.types.length;
  const live = new Uint8Array(n);
  // R36: by value number in arrays (ir.ts's ValMap), not Maps, and a pure instruction's operands read from it when needed
  const defInstr = new ValMap<Instr>(n);
  // Block parameter to the values each edge passes it.
  const paramIn = new Map<number, number[]>();
  const byId = new Map<number, (typeof f.blocks)[number]>();
  for (const b of f.blocks) byId.set(b.id, b);
  const stack: number[] = [];
  const need = (v: number): void => {
    if (live[v] === 1) return;
    live[v] = 1;
    stack.push(v);
  };
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      const eff = effectOf(ins);
      if (eff === "pure" && ins.res.length > 0) {
        for (const r of ins.res) defInstr.set(r, ins);
      } else {
        // Kept whatever its results' fate: its operands are needed.
        for (const r of ins.res) live[r] = 1;
        for (const o of ins.ops) if (o.t === "v") need(o.id);
      }
    }
    const t = b.term;
    if (t.k === "brif") need(t.cond);
    else if (t.k === "switch") need(t.val);
    else if (t.k === "ret") for (const v of t.vals) need(v);
    for (const e of edgesOf(t)) {
      const target = byId.get(e.block);
      if (target === undefined) continue;
      target.params.forEach((p, i) => {
        let l = paramIn.get(p);
        if (l === undefined) paramIn.set(p, (l = []));
        l.push(e.args[i]!);
      });
    }
  }
  for (const p of f.params) live[p] = 1;

  while (stack.length > 0) {
    const v = stack.pop()!;
    const d = defInstr.get(v);
    if (d !== undefined) for (const o of d.ops) if (o.t === "v") need(o.id);
    const ins = paramIn.get(v);
    if (ins !== undefined) for (const x of ins) need(x);
  }
  // Injected for opt-a: the first live add in the function is taken for dead, so its uses are left undefined.
  if (faults.dropLive === true) {
    for (const b of f.blocks) {
      const ins = b.instrs.find(
        (i) =>
          i.op.startsWith("add.") &&
          !i.op.includes("chk") &&
          i.res.length === 1 &&
          live[i.res[0]!] === 1,
      );
      if (ins !== undefined) {
        live[ins.res[0]!] = 2;
        break;
      }
    }
  }
  let changed = false;
  // Parameters nothing needs, and what each edge passes them.
  const dropAt = new Map<number, Set<number>>();
  for (const b of f.blocks.slice(1)) {
    b.params.forEach((p, i) => {
      if (live[p] === 1) return;
      let s = dropAt.get(b.id);
      if (s === undefined) dropAt.set(b.id, (s = new Set()));
      s.add(i);
    });
  }
  for (const b of f.blocks) {
    const before = b.instrs.length;
    const kept = (ins: Instr): boolean => {
      const eff = effectOf(ins);
      if (eff === "pure" && ins.res.length > 0 && ins.res.every((r) => live[r] !== 1)) return false;
      if (ins.res.length === 1 && live[ins.res[0]!] === 2) return false;
      // Injected for opt-a: a store whose value is a constant is dropped, as a pass that forgot effects would.
      if (faults.dropEffect === true && ins.op.startsWith("store.") && ins.ops.length === 2) {
        const v = ins.ops[1];
        if (v?.t === "v" && f.types[v.id] === "i32" && constantDef(f, v.id)) return false;
      }
      return true;
    };
    // R36: a block's list made again only where something in it goes
    if (!b.instrs.every(kept)) b.instrs = b.instrs.filter(kept);
    stats.instrs += before - b.instrs.length;
    if (b.instrs.length !== before) changed = true;
    const d = dropAt.get(b.id);
    if (d !== undefined) {
      b.params = b.params.filter((_, i) => !d.has(i));
      stats.params += d.size;
      changed = true;
    }
    for (const e of edgesOf(b.term)) {
      const dd = dropAt.get(e.block);
      if (dd !== undefined) e.args = e.args.filter((_, i) => !dd.has(i));
    }
  }
  return changed;
}

function constantDef(f: Func, v: number): boolean {
  for (const b of f.blocks)
    for (const ins of b.instrs) if (ins.res[0] === v) return ins.op.startsWith("iconst.");
  return false;
}
