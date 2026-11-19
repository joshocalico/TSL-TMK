// TIR: a typed SSA control-flow graph with block parameters (SPEC 4.3).

export type TirType = "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "ptr" | "ix";

export type Operand =
  | { t: "v"; id: number } // an SSA value
  | { t: "i"; val: bigint } // an integer immediate; fconst carries the IEEE bit pattern here
  | { t: "ixmax" } // the target's largest ix: 2^32-1 on wasm32, 2^53-1 on 64-bit targets
  | { t: "trap"; id: number }
  | { t: "sym"; name: string } // a function or global
  | { t: "sig"; id: number }
  | { t: "name"; name: string }; // an intrinsic's name

export interface Instr {
  op: string;
  ops: Operand[];
  res: number[];
  /**
   * Lowering's note on a plain load of a class id (D50's, D70's, and a printed class's, 3.4, D73): what it reads is written
   * by the object's construction and by nothing while the object lives. Not part of the canonical text, so -O0's TIR and
   * tirhash are what they were; at -O1 and -O2 the optimiser's first step makes such a load `load.T.inv`, which is.
   */
  inv?: true;
  /**
   * R27 (D77): lowering's note on a plain load of a separated field (compiler/host/separate.ts): what it reads is 0 or the
   * address of a block no object is in, which only its class's code reaches. Outside the canonical text, as `inv` is.
   */
  sep?: true;
  /**
   * R27 (D77): lowering's note on a plain load or store of an object's field: its bytes are an object's, never a separated
   * field's block. Outside the canonical text.
   */
  obj?: true;
  /**
   * R29 (D79): lowering's note on a call tslc's table-links proof (compiler/host/links.ts) proved in bounds: the callee's
   * leading bounds check (its compare noted `chk`) can't fire here, so the inliner takes it out of this call's copy. Outside
   * the canonical text, as `inv` is, so -O0 is what it was.
   */
  inb?: true;
  /**
   * R29 (D79): lowering's note on the compare of a method's leading bounds check, `if (i >= this.len) trap(Trap.Bounds)`, of
   * its parameter `chk`: what a call noted `inb` has taken out. Outside the canonical text.
   */
  chk?: number;
}

export interface Edge {
  block: number;
  args: number[];
}

export type Term =
  | { k: "br"; to: Edge }
  | { k: "brif"; cond: number; t: Edge; f: Edge }
  | { k: "switch"; val: number; cases: { key: bigint; to: Edge }[]; def: Edge }
  | { k: "ret"; vals: number[] }
  | { k: "trap"; id: number }
  | { k: "unreachable" };

export interface Block {
  id: number;
  params: number[];
  instrs: Instr[];
  term: Term;
}

export interface Func {
  name: string;
  params: number[];
  rets: TirType[];
  attrs: string[];
  blocks: Block[]; // blocks[0] is the entry
  types: TirType[]; // value id to type
}

export interface Sig {
  params: TirType[];
  rets: TirType[];
}

export interface Global {
  name: string;
  size: number;
  align: number;
  section: string;
  bytes?: Uint8Array;
}

export interface TrapSite {
  id: number;
  kind: string;
  code: number;
  loc: string; // repo-relative file:line:col
  msg?: string; // for a lowered `throw`: JSON of the error's constructor and message parts
}

/** A function outside the module: only a JS host has these, for a fallback's shim (SPEC 4.5). */
export interface Extern {
  name: string;
  params: TirType[];
  rets: TirType[];
}

export interface Module {
  sigs: Sig[];
  globals: Global[];
  funcs: Func[];
  traps: TrapSite[];
  externs: Extern[];
  /**
   * The optimiser level that made this module, set by the pass manager at -O1 and -O2 and absent at -O0. Never printed, so
   * it's in no tirhash; the AArch64 backend reads it for its own -O1 and -O2 code shape (SPEC 4.4, D75).
   */
  opt?: 1 | 2;
}

export const INT_TYPES: readonly TirType[] = ["i8", "i16", "i32", "i64", "ix"];
export const FLOAT_TYPES: readonly TirType[] = ["f32", "f64"];

export function isTirType(s: string): s is TirType {
  return s === "ptr" || INT_TYPES.includes(s as TirType) || FLOAT_TYPES.includes(s as TirType);
}

// --- CFG helpers, shared by the verifier and the backends

export function edgesOf(term: Term): Edge[] {
  switch (term.k) {
    case "br":
      return [term.to];
    case "brif":
      return [term.t, term.f];
    case "switch":
      return [...term.cases.map((c) => c.to), term.def];
    default:
      return [];
  }
}

/** Reverse postorder of the blocks reachable from the entry, as positions into f.blocks. */
export function reversePostorder(f: Func): number[] {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const seen = new Set<number>();
  const post: number[] = [];
  // An explicit stack: generated functions can nest deeper than the JS stack allows.
  const stack: { at: number; next: number; succ: number[] }[] = [];
  const enter = (at: number): void => {
    seen.add(at);
    const succ = edgesOf(f.blocks[at]!.term).map((e) => index.get(e.block) ?? -1);
    stack.push({ at, next: 0, succ });
  };
  enter(0);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.next < top.succ.length) {
      const s = top.succ[top.next++]!;
      if (s >= 0 && !seen.has(s)) enter(s);
    } else {
      post.push(top.at);
      stack.pop();
    }
  }
  return post.reverse();
}

export interface Cfg {
  rpo: number[]; // block positions in reverse postorder
  rpoIndex: Map<number, number>; // block position to rpo index
  preds: number[][]; // block position to predecessor positions, one per edge
  idom: Map<number, number>; // block position to its immediate dominator's position
}

/** Cooper, Harvey and Kennedy's iterative dominators. Reducible graphs settle in a few rounds. */
export function buildCfg(f: Func): Cfg {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const rpo = reversePostorder(f);
  const rpoIndex = new Map<number, number>();
  rpo.forEach((b, i) => rpoIndex.set(b, i));
  const preds: number[][] = f.blocks.map(() => []);
  for (const at of rpo) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const to = index.get(e.block);
      if (to !== undefined) preds[to]!.push(at);
    }
  }
  const idom = new Map<number, number>();
  idom.set(rpo[0]!, rpo[0]!);
  const intersect = (a0: number, b0: number): number => {
    let a = a0;
    let b = b0;
    while (a !== b) {
      while (rpoIndex.get(a)! > rpoIndex.get(b)!) a = idom.get(a)!;
      while (rpoIndex.get(b)! > rpoIndex.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  let changed = true;
  for (let round = 0; changed && round <= rpo.length + 1; round++) {
    changed = false;
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i]!;
      let best = -1;
      for (const p of preds[b]!) {
        if (!idom.has(p)) continue;
        best = best < 0 ? p : intersect(p, best);
      }
      if (best >= 0 && idom.get(b) !== best) {
        idom.set(b, best);
        changed = true;
      }
    }
  }
  return { rpo, rpoIndex, preds, idom };
}

// --- operation signatures

export interface OpShape {
  args: (TirType | "any-int" | "any-float" | "any")[]; // the value operands, in order
  imms: ("int" | "intmax" | "trap" | "sym" | "sig" | "name")[]; // the others, in order
  rets: TirType[];
}

function typeSuffix(parts: string[], i: number): TirType | null {
  const t = parts[i];
  return t !== undefined && isTirType(t) ? t : null;
}

const WRAP_BIN = new Set(["add", "sub", "mul", "and", "or", "xor", "shl", "lshr", "ashr"]);
const WRAP_UN = new Set(["neg", "not"]);
const FLOAT_BIN = new Set(["fadd", "fsub", "fmul", "fdiv", "frem", "fcopysign"]);
const FLOAT_UN = new Set(["fneg", "fabs", "fsqrt", "ffloor", "fceil", "ftrunc", "fnearest"]);
const DIVS = new Set(["sdiv", "udiv", "srem", "urem"]);

const SHAPES = new Map<string, OpShape | null>();

/** The shape of every operation except calls. Returns null for an unknown operation. Kept by name: callers only read it. */
export function opShape(op: string): OpShape | null {
  let s = SHAPES.get(op);
  if (s === undefined) {
    s = opShape0(op);
    SHAPES.set(op, s);
  }
  return s;
}

function opShape0(op: string): OpShape | null {
  const p = op.split(".");
  const b = p[0]!;
  const last = typeSuffix(p, p.length - 1);
  if (p.length === 2 && last !== null) {
    if (b === "iconst" || b === "fconst") return { args: [], imms: ["int"], rets: [last] };
    if (WRAP_BIN.has(b)) return { args: [last, last], imms: [], rets: [last] };
    if (WRAP_UN.has(b)) return { args: [last], imms: [], rets: [last] };
    if (FLOAT_BIN.has(b)) return { args: [last, last], imms: [], rets: [last] };
    if (FLOAT_UN.has(b)) return { args: [last], imms: [], rets: [last] };
    if (DIVS.has(b)) return { args: [last, last], imms: ["trap"], rets: [last] };
    if (b === "zext" || b === "sext" || b === "trunc")
      return { args: ["any-int"], imms: [], rets: [last] };
    if (b === "sitofp" || b === "uitofp") return { args: ["any-int"], imms: [], rets: [last] };
    if (b === "select") return { args: ["i32", last, last], imms: [], rets: [last] };
    if (b === "bitcast") return { args: ["any"], imms: [], rets: [last] };
  }
  if (op === "alloca") return { args: [], imms: ["int", "int", "trap"], rets: ["ptr"] };
  if (op === "globaladdr" || op === "funcaddr") return { args: [], imms: ["sym"], rets: ["ptr"] };
  if (op === "shl.js32" || op === "lshr.js32" || op === "ashr.js32")
    return { args: ["i32", "i32"], imms: [], rets: ["i32"] };
  if (op === "shl.big" || op === "lshr.big" || op === "ashr.big")
    return { args: ["i64", "i64"], imms: [], rets: ["i64"] };
  if (p.length === 4 && p[1] === "chk" && (p[2] === "s" || p[2] === "u") && last !== null) {
    if (b === "add" || b === "sub" || b === "mul")
      return { args: [last, last], imms: ["trap"], rets: [last] };
  }
  if (b === "range" && p.length === 4 && p[1] === "chk" && last !== null)
    return { args: [last], imms: ["int", "intmax", "trap"], rets: [last] };
  if ((b === "fmin" || b === "fmax") && p[1] === "js" && last !== null)
    return { args: [last, last], imms: [], rets: [last] };
  if ((b === "icmp" || b === "fcmp") && p.length === 3 && last !== null)
    return { args: [last, last], imms: [], rets: ["i32"] };
  if (op === "fpromote") return { args: ["f32"], imms: [], rets: ["f64"] };
  if (op === "fdemote") return { args: ["f64"], imms: [], rets: ["f32"] };
  if ((b === "fptosi" || b === "fptoui") && p[1] === "sat" && last !== null)
    return { args: ["any-float"], imms: [], rets: [last] };
  if (op === "js.toint32") return { args: ["f64"], imms: [], rets: ["i32"] };
  // A load is plain (`na`), atomic, or plain and invariant (`inv`: a class id, D73), which only the optimiser makes.
  if (b === "load" && p.length === 3) {
    const t = typeSuffix(p, 1);
    if (t !== null) return { args: ["ptr"], imms: [], rets: [t] };
  }
  if (b === "store" && p.length === 3) {
    const t = typeSuffix(p, 1);
    if (t !== null) return { args: ["ptr", t], imms: [], rets: [] };
  }
  if (op === "bounds.chk") return { args: ["ix", "ix"], imms: ["trap"], rets: ["ix"] };
  if (op === "gep") return { args: ["ptr", "ix"], imms: ["int", "int"], rets: ["ptr"] };
  // A reference's pointer, without its generation; and the same after checking that generation (SPEC 3.5).
  if (op === "ref.addr") return { args: ["i64"], imms: [], rets: ["ptr"] };
  if (op === "gen.chk") return { args: ["i64"], imms: ["trap"], rets: ["ptr"] };
  return null;
}

/** Intrinsics M1 uses. The list grows by name, as in SPEC 4.3. */
export const INTRINSICS: Record<string, Sig> = {
  clz32: { params: ["i32"], rets: ["i32"] },
  "trap.code": { params: ["i32"], rets: [] },
  // Linear memory for down-lowered code. A target maps these to whatever backs its arena.
  "mem.base": { params: [], rets: ["ptr"] }, // the arena start: after statics, or the caller's (4.5)
  "mem.ensure": { params: ["ptr"], rets: [] }, // addresses below this exist, or trap 14
  "mem.fill": { params: ["ptr", "i32", "ix"], rets: [] },
  "mem.copy": { params: ["ptr", "ptr", "ix"], rets: [] }, // overlap allowed, as memmove
  // The native target's bare-metal runtime (SPEC 4.5, 5.10). Not available on a JS host.
  "native.fma": { params: ["f64", "f64", "f64"], rets: ["f64"] }, // a * b + c, rounded once: libm only
  "native.putc": { params: ["i32"], rets: [] }, // one byte to the PL011
  "native.counter": { params: [], rets: ["i64"] }, // CNTVCT_EL0, never PMCCNTR
  "native.frequency": { params: [], rets: ["i64"] }, // CNTFRQ_EL0
  "native.off": { params: [], rets: [] }, // PSCI SYSTEM_OFF
  "native.try": { params: ["ptr"], rets: ["i32"] }, // calls a function: 0, or 1 if it trapped
  "native.unwind": { params: [], rets: [] }, // back to the innermost native.try, returning 1
  "native.sp": { params: [], rets: ["ptr"] }, // the stack pointer: a recursive function's test against a stack limit (D49)
  // JS Math functions with no TIR operation. On a JS host these are the host's own, so they agree.
  ...Object.fromEntries(
    [
      "sin",
      "cos",
      "tan",
      "asin",
      "acos",
      "atan",
      "sinh",
      "cosh",
      "tanh",
      "exp",
      "expm1",
      "log",
      "log2",
      "log10",
      "log1p",
      "cbrt",
    ].map((n) => [`math.${n}`, { params: ["f64"], rets: ["f64"] } as Sig]),
  ),
  "math.atan2": { params: ["f64", "f64"], rets: ["f64"] },
  "math.pow": { params: ["f64", "f64"], rets: ["f64"] },
};

/** The result types of an instruction, given how to look up a callee's return types. */
export function resultTypes(m: Module, sigOf: Map<string, TirType[]>, ins: Instr): TirType[] {
  if (ins.op === "call") {
    const callee = ins.ops[0];
    if (callee?.t !== "sym") throw new Error("call needs a function symbol");
    const rets = sigOf.get(callee.name) ?? m.externs.find((e) => e.name === callee.name)?.rets;
    if (rets === undefined) throw new Error(`call to unknown function @${callee.name}`);
    return rets;
  }
  if (ins.op === "call.indirect") {
    const s = ins.ops[0];
    if (s?.t !== "sig") throw new Error("call.indirect needs a signature");
    const sig = m.sigs[s.id];
    if (sig === undefined) throw new Error(`unknown signature sig${s.id}`);
    return sig.rets;
  }
  if (ins.op === "intrinsic") {
    const n = ins.ops[0];
    if (n?.t !== "name") throw new Error("intrinsic needs a name");
    const sig = INTRINSICS[n.name];
    if (sig === undefined) throw new Error(`unknown intrinsic ${n.name}`);
    return sig.rets;
  }
  const shape = opShape(ins.op);
  if (shape === null) throw new Error(`unknown operation ${ins.op}`);
  return shape.rets;
}

// --- canonical form

/**
 * Sorts functions and globals, drops unreachable blocks, renumbers blocks and values in reverse
 * postorder (parameters first), and renumbers traps and signatures by first use.
 */
export function canonicalize(m: Module): Module {
  const sigMap = new Map<number, number>();
  const sigs: Sig[] = [];
  const trapMap = new Map<number, number>();
  const traps: TrapSite[] = [];
  const trapById = new Map<number, TrapSite>();
  for (const t of m.traps) trapById.set(t.id, t);
  const useTrap = (id: number): number => {
    let n = trapMap.get(id);
    if (n === undefined) {
      n = traps.length + 1;
      trapMap.set(id, n);
      const site = trapById.get(id);
      if (site === undefined) throw new Error(`unknown trap t${id}`);
      traps.push({ ...site, id: n });
    }
    return n;
  };
  const useSig = (id: number): number => {
    let n = sigMap.get(id);
    if (n === undefined) {
      n = sigs.length;
      sigMap.set(id, n);
      sigs.push(m.sigs[id]!);
    }
    return n;
  };
  const funcs = [...m.funcs].sort((a, b) => cmpStr(a.name, b.name));
  const out: Func[] = [];
  for (const f of funcs) {
    const rpo = reversePostorder(f);
    const blockMap = new Map<number, number>();
    rpo.forEach((at, i) => blockMap.set(f.blocks[at]!.id, i));
    const valMap = new Map<number, number>();
    const types: TirType[] = [];
    const def = (v: number): number => {
      const n = types.length;
      valMap.set(v, n);
      types.push(f.types[v]!);
      return n;
    };
    const params = f.params.map(def);
    for (const at of rpo) {
      const b = f.blocks[at]!;
      b.params.forEach(def);
      for (const ins of b.instrs) ins.res.forEach(def);
    }
    const val = (v: number): number => {
      const n = valMap.get(v);
      if (n === undefined) throw new Error(`@${f.name}: use of undefined value %${v}`);
      return n;
    };
    const edge = (e: Edge): Edge => ({ block: blockMap.get(e.block)!, args: e.args.map(val) });
    const blocks: Block[] = rpo.map((at, i) => {
      const b = f.blocks[at]!;
      const instrs = b.instrs.map((ins): Instr => ({
        op: ins.op,
        res: ins.res.map(val),
        ops: ins.ops.map((o): Operand => {
          if (o.t === "v") return { t: "v", id: val(o.id) };
          if (o.t === "trap") return { t: "trap", id: useTrap(o.id) };
          if (o.t === "sig") return { t: "sig", id: useSig(o.id) };
          return o;
        }),
        ...(ins.inv === true ? { inv: true as const } : {}),
        ...(ins.sep === true ? { sep: true as const } : {}),
        ...(ins.obj === true ? { obj: true as const } : {}),
        ...(ins.inb === true ? { inb: true as const } : {}),
        ...(ins.chk !== undefined ? { chk: ins.chk } : {}),
      }));
      const tm = b.term;
      let term: Term;
      switch (tm.k) {
        case "br":
          term = { k: "br", to: edge(tm.to) };
          break;
        case "brif":
          term = { k: "brif", cond: val(tm.cond), t: edge(tm.t), f: edge(tm.f) };
          break;
        case "switch":
          term = {
            k: "switch",
            val: val(tm.val),
            cases: tm.cases.map((c) => ({ key: c.key, to: edge(c.to) })),
            def: edge(tm.def),
          };
          break;
        case "ret":
          term = { k: "ret", vals: tm.vals.map(val) };
          break;
        case "trap":
          term = { k: "trap", id: useTrap(tm.id) };
          break;
        case "unreachable":
          term = tm;
          break;
      }
      return { id: i, params: b.params.map(val), instrs, term };
    });
    out.push({ name: f.name, params, rets: f.rets, attrs: f.attrs, blocks, types });
  }
  return {
    sigs,
    globals: [...m.globals].sort((a, b) => cmpStr(a.name, b.name)),
    funcs: out,
    traps,
    externs: [...m.externs].sort((a, b) => cmpStr(a.name, b.name)),
    ...(m.opt !== undefined ? { opt: m.opt } : {}),
  };
}

/** Code-unit order, independent of locale, so output is the same on every host. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
