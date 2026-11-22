// Loads the optimiser left unused still run (SPEC 3.10, 4.3, D46). Natively a null dereference traps 6 by faulting, so a
// load is part of a program's behaviour, and the backend drops a plain load whose value nothing uses, as it has from the
// start. After inlining or folding, a load whose value was used at -O0 can lose its last use: say a getter's result the
// caller ignores. It ran at -O0 and must run here, so its value goes to a word no one reads, which keeps it. A load the
// backend dropped at -O0 is marked before anything runs, and stays as it is, so no level runs a load -O0 didn't.
import { select } from "../../backend-aarch64/regalloc.ts";
import {
  edgesOf,
  reversePostorder,
  ValMap,
  type Func,
  type Instr,
  type Module,
  type TirType,
  type ValLookup,
} from "../ir.ts";
import { effectOf, opParts, valueOps } from "./util.ts";

export const KEEP_GLOBAL = "__opt_keep";

/** The backend's own answer, for the test that `deadLoads` gives the same (compiler/tir/tir.test.ts). */
export function deadLoadsBySelect(f: Func): Instr[] {
  // The backend sees blocks in reverse postorder, the canonical order, and its sweep for dead values depends on it.
  const rpo = reversePostorder(f);
  f.blocks = rpo.map((i) => f.blocks[i]!);
  const s = select(f);
  const out: Instr[] = [];
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (effectOf(ins) !== "load") continue;
      const r = ins.res[0]!;
      if (s.dead[r] === true) out.push(ins);
    }
  }
  return out;
}

const is64 = (t: TirType): boolean => t === "i64" || t === "ix" || t === "ptr";
const isFloat = (t: TirType): boolean => t === "f32" || t === "f64";

/**
 * The plain loads the backend would drop from this function as it is: the same rule as its instruction selection (regalloc.ts
 * `select`), with renames counted against what they rename, and a pure value dead when nothing counts as using it. Only
 * that part of `select`, which is most of the optimiser's time on a large module if it's all run.
 */
export function deadLoads(f: Func, inOrder = false): Instr[] {
  // A canonical function's blocks are already in reverse postorder.
  if (!inOrder) {
    const rpo = reversePostorder(f);
    f.blocks = rpo.map((i) => f.blocks[i]!);
  }
  const n = f.types.length;
  const alias = new Int32Array(n);
  for (let i = 0; i < n; i++) alias[i] = i;
  const constInt = new Uint8Array(n);
  let anyLoad = false;
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      const res = ins.res[0];
      if (res === undefined) continue;
      const p = opParts(ins.op);
      const base = p[0]!;
      if (base === "iconst") constInt[res] = 1;
      else if (base === "load") anyLoad = true;
      else if (ins.op === "bounds.chk") alias[res] = valueOps(ins)[0]!;
      else if (base === "zext" || base === "bitcast" || base === "trunc" || base === "sext") {
        const src = valueOps(ins)[0]!;
        const from = f.types[src]!;
        const to = f.types[res]!;
        if (base === "zext" && !isFloat(from) && (!is64(from) || is64(to))) alias[res] = src;
        else if (base === "bitcast" && isFloat(from) === isFloat(to) && is64(from) === is64(to))
          alias[res] = src;
        else if (base === "trunc" && ((is64(from) && is64(to)) || from === to)) alias[res] = src;
        else if (base === "sext" && from === to) alias[res] = src;
      }
    }
  }
  if (!anyLoad) return [];
  for (let i = 0; i < n; i++) {
    let c = i;
    for (let guard = 0; alias[c] !== c && guard < n + 1; guard++) c = alias[c]!;
    alias[i] = c;
  }
  // A rename of a constant, at another type, is a constant of its own.
  for (let i = 0; i < n; i++) {
    const c = alias[i]!;
    if (c !== i && constInt[c] === 1 && f.types[i] !== f.types[c]) alias[i] = i;
  }
  const uses = new Int32Array(n);
  for (const b of f.blocks) {
    for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "v") uses[alias[o.id]!]!++;
    const t = b.term;
    if (t.k === "brif") uses[alias[t.cond]!]!++;
    else if (t.k === "switch") uses[alias[t.val]!]!++;
    else if (t.k === "ret") for (const v of t.vals) uses[alias[v]!]!++;
    for (const e of edgesOf(t)) for (const v of e.args) uses[alias[v]!]!++;
  }
  const out: Instr[] = [];
  for (let bi = f.blocks.length - 1; bi >= 0; bi--) {
    const b = f.blocks[bi]!;
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      const ins = b.instrs[i]!;
      if (ins.res.length !== 1 || !backendPure(ins.op)) continue;
      const r = ins.res[0]!;
      if (alias[r] !== r || uses[r] !== 0) continue;
      if (opParts(ins.op)[0] === "load") out.push(ins);
      for (const o of ins.ops) if (o.t === "v") uses[alias[o.id]!]!--;
    }
  }
  return out;
}

/** regalloc.ts's `isPure`: what its sweep for dead values may drop. Loads count. */
const BACKEND_PURE = new Set([
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
  "frem",
  "fneg",
  "fabs",
  "fsqrt",
  "ffloor",
  "fceil",
  "ftrunc",
  "fnearest",
  "fmin",
  "fmax",
  "fcopysign",
  "icmp",
  "fcmp",
  "zext",
  "sext",
  "trunc",
  "fpromote",
  "fdemote",
  "sitofp",
  "uitofp",
  "fptosi",
  "fptoui",
  "js",
  "bitcast",
  "select",
  "gep",
  "load",
  "ref",
]);
function backendPure(op: string): boolean {
  const p = opParts(op);
  if (!BACKEND_PURE.has(p[0]!)) return false;
  if (p[1] === "chk") return false;
  if (p[0] === "load" && p[2] !== "na" && p[2] !== "inv") return false;
  return true;
}

/** An address that can't fault: a global's, or a frame slot's, at a constant or any offset the program was checked into. */
function safeAddress(defs: ValLookup<Instr>, v: number): boolean {
  let cur = v;
  for (let guard = 0; guard < 16; guard++) {
    const d = defs.get(cur);
    if (d === undefined) return false;
    if (d.op === "globaladdr" || d.op === "alloca") return true;
    if (d.op !== "gep") return false;
    cur = valueOps(d)[0]!;
  }
  return false;
}

/** Keeps each load that ran at -O0 and that nothing would keep now. Returns how many it kept. */
export function keepLoads(m: Module, deadAtO0: WeakSet<Instr>): number {
  let kept = 0;
  for (const f of m.funcs) {
    const dead = deadLoads(f);
    if (dead.length === 0) continue;
    const defs = new ValMap<Instr>(f.types.length);
    for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) defs.set(r, ins);
    const wanted = new Set(
      dead.filter((ins) => !deadAtO0.has(ins) && !safeAddress(defs, valueOps(ins)[0]!)),
    );
    if (wanted.size === 0) continue;
    for (const b of f.blocks) {
      for (let i = 0; i < b.instrs.length; i++) {
        const ins = b.instrs[i]!;
        if (!wanted.has(ins)) continue;
        const r = ins.res[0]!;
        const t = f.types[r]!;
        f.types.push("ptr");
        const g = f.types.length - 1;
        b.instrs.splice(
          i + 1,
          0,
          { op: "globaladdr", ops: [{ t: "sym", name: KEEP_GLOBAL }], res: [g] },
          {
            op: `store.${t}.na`,
            ops: [
              { t: "v", id: g },
              { t: "v", id: r },
            ],
            res: [],
          },
        );
        i += 2;
        kept++;
      }
    }
  }
  if (kept > 0 && !m.globals.some((g) => g.name === KEEP_GLOBAL)) {
    m.globals.push({ name: KEEP_GLOBAL, size: 8, align: 8, section: "data" });
  }
  return kept;
}

/** Marks the loads the backend drops at -O0, before any pass runs, so copies made later carry the mark. The module is canonical. */
export function markDeadAtO0(m: Module): WeakSet<Instr> {
  const set = new WeakSet<Instr>();
  for (const f of m.funcs) for (const ins of deadLoads(f, true)) set.add(ins);
  return set;
}
