// What the optimiser's passes share (SPEC 4.3, D46): what an operation may do, uses, renaming, and cloning.
import {
  edgesOf,
  type Block,
  type Edge,
  type Func,
  type Instr,
  type Module,
  type TirType,
} from "../ir.ts";

/**
 * What running an instruction can do, besides giving its results.
 * - `pure`: nothing. It can be removed when unused, and folded.
 * - `load`: a plain load. It can fault on a bad address, which is how a null dereference traps 6 natively (SPEC 3.10), so
 *   the passes never remove one: the backend drops a plain load nothing uses, at every level, and `keep` makes sure a load
 *   the optimiser left unused still runs wherever it ran at -O0.
 * - `check`: a check or a division that can trap, and does nothing else. It goes only where its operands prove it can't fire.
 * - `effect`: anything else: stores, calls, the intrinsics with effects, atomics, device access, alloca.
 */
export type Effect = "pure" | "load" | "check" | "effect";

const PURE_BASES = new Set([
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
  "ref",
]);

/** Intrinsics that only compute from their operands. */
export const PURE_INTRINSICS = new Set(["clz32", "native.fma"]);

const EFFECT_CACHE = new Map<string, Effect>();

export function effectOf(ins: Instr): Effect {
  if (ins.op !== "intrinsic") {
    const hit = EFFECT_CACHE.get(ins.op);
    if (hit !== undefined) return hit;
    const e = effectOfOp(ins);
    EFFECT_CACHE.set(ins.op, e);
    return e;
  }
  return effectOfOp(ins);
}

/** An operation's name split at its dots, kept: the passes ask for it of every instruction, many times. */
const PARTS_CACHE = new Map<string, string[]>();
export function opParts(op: string): string[] {
  let p = PARTS_CACHE.get(op);
  if (p === undefined) {
    p = op.split(".");
    PARTS_CACHE.set(op, p);
  }
  return p;
}

function effectOfOp(ins: Instr): Effect {
  const p = ins.op.split(".");
  const b = p[0]!;
  if (b === "intrinsic") {
    const n = ins.ops[0];
    if (n?.t === "name" && (PURE_INTRINSICS.has(n.name) || n.name.startsWith("math.")))
      return "pure";
    return "effect";
  }
  if (b === "load") return p.length === 3 && (p[2] === "na" || p[2] === "inv") ? "load" : "effect";
  if (p[1] === "chk" || b === "bounds" || b === "gen") return "check";
  if (b === "sdiv" || b === "udiv" || b === "srem" || b === "urem") return "check";
  if (PURE_BASES.has(b)) return "pure";
  return "effect";
}

/** The value operands of an instruction, in order. */
export function valueOps(ins: Instr): number[] {
  const out: number[] = [];
  for (const o of ins.ops) if (o.t === "v") out.push(o.id);
  return out;
}

export function trapOf(ins: Instr): number | undefined {
  for (const o of ins.ops) if (o.t === "trap") return o.id;
  return undefined;
}

export function intImm(ins: Instr, i: number): bigint {
  let k = 0;
  for (const o of ins.ops) {
    if (o.t === "i") {
      if (k === i) return o.val;
      k++;
    }
  }
  throw new Error(`${ins.op}: no immediate ${i}`);
}

export function calleeOf(ins: Instr): string | undefined {
  if (ins.op !== "call") return undefined;
  const s = ins.ops[0];
  return s?.t === "sym" ? s.name : undefined;
}

export function newValue(f: Func, t: TirType): number {
  f.types.push(t);
  return f.types.length - 1;
}

export function newBlockId(f: Func): number {
  let max = -1;
  for (const b of f.blocks) if (b.id > max) max = b.id;
  return max + 1;
}

/** Replaces every use of a value by another, as `subst` says, in instructions, edges and terminators. */
export function substitute(f: Func, subst: Map<number, number>): void {
  if (subst.size === 0) return;
  const look = (v: number): number => {
    let c = v;
    for (let guard = 0; guard < 64; guard++) {
      const n = subst.get(c);
      if (n === undefined || n === c) return c;
      c = n;
    }
    return c;
  };
  const edge = (e: Edge): void => {
    for (let i = 0; i < e.args.length; i++) e.args[i] = look(e.args[i]!);
  };
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      for (const o of ins.ops) if (o.t === "v") o.id = look(o.id);
    }
    const t = b.term;
    if (t.k === "brif") t.cond = look(t.cond);
    else if (t.k === "switch") t.val = look(t.val);
    else if (t.k === "ret") t.vals = t.vals.map(look);
    for (const e of edgesOf(t)) edge(e);
  }
}

/** How many times each value is used. */
export function useCounts(f: Func): Int32Array {
  const n = new Int32Array(f.types.length);
  for (const b of f.blocks) {
    for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "v") n[o.id]!++;
    const t = b.term;
    if (t.k === "brif") n[t.cond]!++;
    else if (t.k === "switch") n[t.val]!++;
    else if (t.k === "ret") for (const v of t.vals) n[v]!++;
    for (const e of edgesOf(t)) for (const v of e.args) n[v]!++;
  }
  return n;
}

export function blockIndex(f: Func): Map<number, number> {
  const m = new Map<number, number>();
  f.blocks.forEach((b, i) => m.set(b.id, i));
  return m;
}

/** Predecessor counts by block id, one per edge. */
export function predCounts(f: Func): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of f.blocks) m.set(b.id, 0);
  for (const b of f.blocks)
    for (const e of edgesOf(b.term)) m.set(e.block, (m.get(e.block) ?? 0) + 1);
  return m;
}

export function cloneInstr(ins: Instr): Instr {
  const c: Instr = { op: ins.op, ops: ins.ops.map((o) => ({ ...o })), res: [...ins.res] };
  if (ins.inv === true) c.inv = true;
  if (ins.sep === true) c.sep = true;
  if (ins.obj === true) c.obj = true;
  if (ins.inb === true) c.inb = true;
  if (ins.chk !== undefined) c.chk = ins.chk;
  return c;
}

export function cloneTerm(t: Block["term"]): Block["term"] {
  const e = (x: Edge): Edge => ({ block: x.block, args: [...x.args] });
  switch (t.k) {
    case "br":
      return { k: "br", to: e(t.to) };
    case "brif":
      return { k: "brif", cond: t.cond, t: e(t.t), f: e(t.f) };
    case "switch":
      return {
        k: "switch",
        val: t.val,
        cases: t.cases.map((c) => ({ key: c.key, to: e(c.to) })),
        def: e(t.def),
      };
    case "ret":
      return { k: "ret", vals: [...t.vals] };
    case "trap":
      return { k: "trap", id: t.id };
    case "unreachable":
      return { k: "unreachable" };
  }
}

export function cloneFunc(f: Func): Func {
  return {
    name: f.name,
    params: [...f.params],
    rets: [...f.rets],
    attrs: [...f.attrs],
    types: [...f.types],
    blocks: f.blocks.map((b) => ({
      id: b.id,
      params: [...b.params],
      instrs: b.instrs.map(cloneInstr),
      term: cloneTerm(b.term),
    })),
  };
}

export function cloneModule(m: Module): Module {
  return {
    sigs: m.sigs.map((s) => ({ params: [...s.params], rets: [...s.rets] })),
    globals: m.globals.map((g) => ({ ...g })),
    funcs: m.funcs.map(cloneFunc),
    traps: m.traps.map((t) => ({ ...t })),
    externs: m.externs.map((e) => ({ ...e })),
    ...(m.opt !== undefined ? { opt: m.opt } : {}),
  };
}

/** Width in bits of an integer type, with ix taken as 64: callers that fold ix stay inside what's the same on wasm32. */
export function bitsOf(t: TirType): number {
  switch (t) {
    case "i8":
      return 8;
    case "i16":
      return 16;
    case "i32":
      return 32;
    default:
      return 64;
  }
}

/** A constant as lowering writes it: signed, in the type's width. */
export function signedConst(t: TirType, v: bigint): bigint {
  return BigInt.asIntN(bitsOf(t), v);
}

export function isIntType(t: TirType): boolean {
  return t === "i8" || t === "i16" || t === "i32" || t === "i64" || t === "ix" || t === "ptr";
}

/** The size of a function as the inliner counts it: roughly the instructions the backend emits for it (D46). */
export function costOf(f: Func): number {
  let c = 0;
  for (const b of f.blocks) {
    for (const ins of b.instrs) c += instrCost(ins);
    c += termCost(b.term);
  }
  return c;
}

export function instrCost(ins: Instr): number {
  const b = opParts(ins.op)[0]!;
  switch (b) {
    // Rebuilt at each use, or a rename: the backend emits nothing for them on their own.
    case "iconst":
    case "fconst":
    case "globaladdr":
    case "funcaddr":
    case "zext":
    case "bitcast":
    case "alloca":
      return 0;
    case "call":
    case "call.indirect":
      return 4 + valueOps(ins).length;
    case "intrinsic": {
      const n = ins.ops[0];
      if (n?.t === "name" && (n.name === "mem.fill" || n.name === "mem.copy")) return 4;
      return n?.t === "name" && n.name.startsWith("math.") ? 4 : 1;
    }
    case "sdiv":
    case "udiv":
    case "srem":
    case "urem":
    case "frem":
      return 3;
    default:
      return effectOf(ins) === "check" ? 2 : 1;
  }
}

export function termCost(t: Block["term"]): number {
  switch (t.k) {
    case "br":
      return 0;
    case "brif":
      return 1;
    case "switch":
      return 1 + t.cases.length * 2;
    default:
      return 1;
  }
}

/**
 * R26's optimiser changes put back as they were, for tools/r26-pins.ts (`TMK_R26_OFF`, a comma-separated list): `range`
 * (range.ts's signed tests by their smaller side, a float compare of converted i32s where they're known, and a target
 * reached through its own `zext`), `rounds` (-O2's loop copying in one round), `inline` (the inliner's loop blocks as computed
 * before a split), `codeat` (class printing's `charCodeAt` in floats). Never set otherwise.
 */
export function r26Off(part: string): boolean {
  return offList("TMK_R26_OFF").includes(part);
}

// The switches' lists, split once for each value the variable has (R35: range.ts asks for each value it looks at, and the
// split was a few percent of -O1's check elimination). A test that changes the variable gets its new list.
const offLists = new Map<string, { raw: string; list: string[] }>();
function offList(name: string): string[] {
  const raw = process.env[name] ?? "";
  const was = offLists.get(name);
  if (was !== undefined && was.raw === raw) return was.list;
  const list = raw.split(",");
  offLists.set(name, { raw, list });
  return list;
}

/**
 * R32's parts put back as they were, for tools/r32-pins.ts (`TMK_R32_OFF`, a comma-separated list): `range` (range.ts's
 * facts from a float compare's edge, so `js.toint32` of a float known in `[0, n)` is too), `index` (class printing's
 * `s[x]` in `rc` as compiler/rt has it, one test joined by `||`), `stable` (a string literal ahead of a later operand's
 * statements held in a temporary, as before); `units` is emit-rcstr.ts's (r32UnitsOff). Never set otherwise.
 */
export function r32Off(part: string): boolean {
  return offList("TMK_R32_OFF").includes(part);
}

/**
 * R35's parts put back as they were, for tools/r35-pins.ts (`TMK_R35_OFF`, a comma-separated list): `checks` (-O1 without
 * check elimination's one round, as before), `saves` (the backend saving at a cold call every value whose interval spans
 * it, live after it or not); `units` and `joined` are the printing's. Never set otherwise.
 */
export function r35Off(part: string): boolean {
  return offList("TMK_R35_OFF").includes(part);
}

/** R28's parts turned off, a measurement only (`TMK_R28_OFF=grow`, say). */
export function r28Off(part: string): boolean {
  return (process.env.TMK_R28_OFF ?? "").split(",").includes(part);
}
