// Instruction-selection facts and linear-scan register allocation over SSA (SPEC 4.4).
//
// Selection decides which values need no register of their own: constants and symbol addresses are
// rebuilt at each use, a bounds check's result and a zero-extension are their operand under another
// name, a gep used only as a load or store address in its block folds into the access, and a compare
// used only by a branch or select in its block folds into it. Allocation then works on what is left:
// one interval per value from its definition to its last use, in reverse postorder, with no holes and
// no splitting. A value gets one register or one stack slot for its whole life.
//
// R30, at -O1 and -O2 (`coldsplit`): a call that runs only on some of its loop's turns, or outside a loop on only some of
// the ways through the function, is cold. A value live across cold calls only may take a register the caller doesn't need
// kept, which is stored to a slot of its own just before each such call and loaded back just after; so the way through
// that calls nothing needs no callee-saved register for it, and the prologue saves fewer. A value live across any other
// call still takes a callee-saved register, as before.
//
// R35: a value is stored before a cold call and loaded back after it only where it's live after it: read later in the
// call's block or live out of it. An interval has no holes, so it can span a cold call on a way through the function that
// never reads it again (`concat`'s short way, whose call is its last word, spanned the long ways' values).
import { buildCfg, edgesOf, type Func, type Instr, type TirType } from "../tir/ir.ts";
import { type MemOp, memImmOk } from "./encode.ts";

const LOAD_OP: Record<string, MemOp> = {
  i8: "ldrb",
  i16: "ldrh",
  i32: "ldrw",
  i64: "ldrx",
  ix: "ldrx",
  ptr: "ldrx",
};

// Locations: 0..31 general registers, 32..63 float registers, from 64 a byte offset from SP + 64.
export const NONE = -1;
export const FP_BASE = 32;
export const MEM_BASE = 64;

/** x8, x16, x17 and d29, d30, d31 are the emitter's scratch registers, never allocated. */
export const SCRATCH_X8 = 8;
export const SCRATCH_X16 = 16;
export const SCRATCH_X17 = 17;
export const SCRATCH_D29 = 29;
export const SCRATCH_D30 = 30;
export const SCRATCH_D31 = 31;

const GP_CALLER = [9, 10, 11, 12, 13, 14, 15, 7, 6, 5, 4, 3, 2, 1, 0];
const GP_CALLEE_ALL = [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
const FP_CALLER = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 7, 6, 5, 4, 3, 2, 1, 0];
const FP_CALLEE = [8, 9, 10, 11, 12, 13, 14, 15];

export function isFloat(t: TirType): boolean {
  return t === "f32" || t === "f64";
}

export function is64(t: TirType): boolean {
  return t === "i64" || t === "ix" || t === "ptr";
}

export interface GepFold {
  base: number;
  idx: number;
  scale: number;
  off: number;
}

export type Remat =
  | { k: "int"; val: bigint }
  | { k: "float"; bits: bigint; d: boolean }
  | { k: "global"; name: string }
  | { k: "func"; name: string };

export interface Selection {
  f: Func;
  alias: Int32Array; // a value's canonical name
  remat: (Remat | undefined)[];
  gep: (GepFold | undefined)[];
  cmp: boolean[]; // a compare folded into its only user
  dead: boolean[];
  def: (Instr | undefined)[];
  /** -O1 and -O2 (D75): computed again at each use from operands in registers, not kept in a register or a slot. */
  recomp: boolean[];
  /** The bug put into rematerialisation (OPT_FAULTS): a recomputed value's operands aren't kept live to its uses. */
  staleFault?: boolean;
}

const PURE = new Set([
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

function isPure(ins: Instr): boolean {
  const p = ins.op.split(".");
  const b = p[0]!;
  if (!PURE.has(b)) return false;
  if (p[1] === "chk") return false;
  // A load that isn't plain may order against other threads and devices.
  // A class id's load (`inv`, D73) is a plain load to the backend: what it adds is only what the optimiser may share.
  if (b === "load" && p[2] !== "na" && p[2] !== "inv") return false;
  return true;
}

function valueOps(ins: Instr): number[] {
  const out: number[] = [];
  for (const o of ins.ops) if (o.t === "v") out.push(o.id);
  return out;
}

export function select(f: Func, shaped = false, addresses = false): Selection {
  const n = f.types.length;
  const alias = new Int32Array(n);
  for (let i = 0; i < n; i++) alias[i] = i;
  const remat: (Remat | undefined)[] = Array.from({ length: n }, () => undefined);
  const def: (Instr | undefined)[] = Array.from({ length: n }, () => undefined);
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      for (const r of ins.res) def[r] = ins;
      const res = ins.res[0];
      if (res === undefined) continue;
      const p = ins.op.split(".");
      const base = p[0]!;
      if (base === "iconst") {
        const o = ins.ops[0]!;
        if (o.t === "i") remat[res] = { k: "int", val: normalise(o.val, f.types[res]!) };
      } else if (base === "fconst") {
        const o = ins.ops[0]!;
        if (o.t === "i") remat[res] = { k: "float", bits: o.val, d: p[1] === "f64" };
      } else if (base === "globaladdr" || base === "funcaddr") {
        const o = ins.ops[0]!;
        if (o.t === "sym") {
          remat[res] = { k: base === "globaladdr" ? "global" : "func", name: o.name };
        }
      } else if (ins.op === "bounds.chk") {
        alias[res] = valueOps(ins)[0]!;
      } else if (base === "zext") {
        // Every integer register holds its value zero-extended, so widening is a rename.
        const from = f.types[valueOps(ins)[0]!]!;
        const to = f.types[res]!;
        if (!isFloat(from) && (!is64(from) || is64(to))) alias[res] = valueOps(ins)[0]!;
      } else if (base === "bitcast") {
        const from = f.types[valueOps(ins)[0]!]!;
        const to = f.types[res]!;
        if (isFloat(from) === isFloat(to) && is64(from) === is64(to))
          alias[res] = valueOps(ins)[0]!;
      } else if (base === "trunc") {
        const from = f.types[valueOps(ins)[0]!]!;
        const to = f.types[res]!;
        if (is64(from) && is64(to)) alias[res] = valueOps(ins)[0]!;
        else if (from === to) alias[res] = valueOps(ins)[0]!;
      } else if (base === "sext") {
        const from = f.types[valueOps(ins)[0]!]!;
        const to = f.types[res]!;
        if (from === to) alias[res] = valueOps(ins)[0]!;
      }
    }
  }
  const canon = (v: number): number => {
    let c = v;
    for (let guard = 0; alias[c] !== c && guard < n + 1; guard++) c = alias[c]!;
    return c;
  };
  for (let i = 0; i < n; i++) alias[i] = canon(i);
  // A rename of a constant is that constant.
  for (let i = 0; i < n; i++) {
    const c = alias[i]!;
    if (c !== i && remat[c] !== undefined && f.types[i] !== f.types[c]) {
      const r = remat[c]!;
      if (r.k === "int") {
        remat[i] = { k: "int", val: normalise(r.val, f.types[i]!) };
        alias[i] = i;
      }
    }
  }

  // Use counts, for dead code and folding. Renames count against the name they rename.
  const uses = new Int32Array(n);
  const useOf = (v: number): void => {
    uses[alias[v]!]!++;
  };
  const useList = (ins: Instr): number[] => valueOps(ins).map((v) => alias[v]!);
  for (const b of f.blocks) {
    for (const ins of b.instrs) for (const v of valueOps(ins)) useOf(v);
    const t = b.term;
    if (t.k === "brif") useOf(t.cond);
    if (t.k === "switch") useOf(t.val);
    if (t.k === "ret") t.vals.forEach(useOf);
    for (const e of edgesOf(t)) e.args.forEach(useOf);
  }
  const dead: boolean[] = Array.from({ length: n }, () => false);
  const deadInstr = new Set<Instr>();
  for (let bi = f.blocks.length - 1; bi >= 0; bi--) {
    const b = f.blocks[bi]!;
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      const ins = b.instrs[i]!;
      if (ins.res.length !== 1 || !isPure(ins)) continue;
      const r = ins.res[0]!;
      if (alias[r] !== r || uses[r] !== 0) continue;
      dead[r] = true;
      deadInstr.add(ins);
      for (const v of useList(ins)) uses[v]!--;
    }
  }

  // Which values fold into their users.
  const gep: (GepFold | undefined)[] = Array.from({ length: n }, () => undefined);
  const cmp: boolean[] = Array.from({ length: n }, () => false);
  const blockOf = new Int32Array(n).fill(-1);
  f.blocks.forEach((b, bi) => {
    for (const ins of b.instrs) if (!deadInstr.has(ins)) for (const r of ins.res) blockOf[r] = bi;
  });
  const addrUses = new Int32Array(n);
  const anyAddrUses = new Int32Array(n); // -O1 and -O2: as a load's or store's address in any block
  const condUses = new Int32Array(n);
  const anyCondUses = new Int32Array(n); // -O1 and -O2: as a branch's or select's condition in any block

  f.blocks.forEach((b, bi) => {
    for (const ins of b.instrs) {
      if (deadInstr.has(ins)) continue;
      const base = ins.op.split(".")[0]!;
      if (base === "load" || base === "store") {
        const a = alias[valueOps(ins)[0]!]!;
        if (blockOf[a] === bi) addrUses[a]!++;
        anyAddrUses[a]!++;
      }
      if (base === "select") {
        const c = alias[valueOps(ins)[0]!]!;
        if (blockOf[c] === bi) condUses[c]!++;
        anyCondUses[c]!++;
      }
    }
    if (b.term.k === "brif") {
      const c = alias[b.term.cond]!;
      if (blockOf[c] === bi) condUses[c]!++;
      anyCondUses[c]!++;
    }
  });
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (deadInstr.has(ins)) continue;
      const r = ins.res[0];
      if (r === undefined || alias[r] !== r) continue;
      const base = ins.op.split(".")[0]!;
      // addrUses counts only operand 0 of a load or store, so a gep also stored as a value is excluded.
      // -O1 and -O2 (D75): a constant offset from a register, used only as an address but in other blocks too, folds into
      // every access, which keeps the base live there instead: rematerialising an address costs nothing in the access.
      const anywhere =
        addresses &&
        base === "gep" &&
        uses[r] === anyAddrUses[r] &&
        remat[alias[valueOps(ins)[1]!]!]?.k === "int" &&
        remat[alias[valueOps(ins)[0]!]!] === undefined;
      if (base === "gep" && (uses[r] === addrUses[r] || anywhere) && uses[r]! > 0) {
        const vals = valueOps(ins);
        const nums = ins.ops.flatMap((o) => (o.t === "i" ? [Number(o.val)] : []));
        gep[r] = { base: alias[vals[0]!]!, idx: alias[vals[1]!]!, scale: nums[0]!, off: nums[1]! };
      }
      if ((base === "icmp" || base === "fcmp") && uses[r] === 1 && condUses[r] === 1) cmp[r] = true;
      else if (
        shaped &&
        (base === "icmp" || base === "fcmp") &&
        uses[r]! > 0 &&
        uses[r] === anyCondUses[r]
      ) {
        // -O1 and -O2 (D75): a compare only ever branched on, in other blocks or more than once, is computed again at each
        // branch from its operands, rather than kept as a value. With at most one operand in a register, that keeps no more
        // live than the value itself would.
        const inRegs = valueOps(ins).filter((v) => remat[alias[v]!] === undefined).length;
        if (inRegs <= 1) cmp[r] = true;
      }
    }
  }
  return { f, alias, remat, gep, cmp, dead, def, recomp: [] };
}

export function normalise(val: bigint, t: TirType): bigint {
  switch (t) {
    case "i8":
      return BigInt.asUintN(8, val);
    case "i16":
      return BigInt.asUintN(16, val);
    case "i32":
      return BigInt.asUintN(32, val);
    default:
      return BigInt.asUintN(64, val);
  }
}

/** Is this a call as far as registers go: does it clobber the caller-saved set? */
export function isCallOp(ins: Instr): boolean {
  if (ins.op === "call" || ins.op === "call.indirect") return true;
  if (ins.op.startsWith("frem.")) return true;
  if (ins.op === "intrinsic") {
    const n = ins.ops[0];
    if (n?.t !== "name") return true;
    return (
      n.name === "mem.fill" ||
      n.name === "mem.copy" ||
      n.name === "trap.code" ||
      n.name.startsWith("math.") ||
      n.name === "native.try"
    );
  }
  return false;
}

/** The values an instruction reads from registers, once folds and constants are seen through. */
export function regUses(s: Selection, ins: Instr, out: number[]): void {
  for (const o of ins.ops) if (o.t === "v") addUse(s, o.id, out);
}

export function addUse(s: Selection, v0: number, out: number[]): void {
  const v = s.alias[v0]!;
  if (s.remat[v] !== undefined) return;
  const g = s.gep[v];
  if (g !== undefined) {
    addUse(s, g.base, out);
    addUse(s, g.idx, out);
    return;
  }
  if (s.recomp[v] === true && s.staleFault === true) return;
  if (s.cmp[v] || s.recomp[v] === true) {
    const d = s.def[v]!;
    for (const o of d.ops) if (o.t === "v") addUse(s, o.id, out);
    return;
  }
  out.push(v);
}

export function skipInstr(s: Selection, ins: Instr): boolean {
  const r = ins.res[0];
  if (r === undefined) return false;
  if (ins.res.length !== 1) return false;
  if (s.dead[r] === true) return true;
  // A check still has to run, even though its result is only a rename.
  if (ins.op === "bounds.chk") return false;
  if (s.alias[r] !== r) return true;
  return (
    s.remat[r] !== undefined || s.gep[r] !== undefined || s.cmp[r] === true || s.recomp[r] === true
  );
}

export interface Allocation {
  loc: Int32Array; // location by value; renames and constants have NONE
  usedGp: number[]; // callee-saved registers used, ascending
  usedFp: number[];
  spillSlots: number; // 8-byte slots
  hasCall: boolean;
  outArea: number; // filled in by the emitter's scan of calls
  loopDepth: Int32Array; // by block position
  /**
   * R30: at each cold call, the registers the caller doesn't need kept that hold a value live across it, each stored to
   * its slot (counted from 0 after the spill slots) just before the call and loaded back just after.
   */
  coldSaves: Map<Instr, { loc: number; slot: number }[]>;
  saveSlots: number; // R30: 8-byte slots after the spill slots, one a value saved around a cold call
}

/** R30: how the allocator splits values around cold calls (-O1 and -O2), with its injected bugs (`OPT_FAULTS`). */
export interface ColdSplit {
  /** `r30-split-callee-free`: a callee-saved register taken for a value across cold calls only, and not saved */
  calleeFree: boolean;
  /** R35's `r35-save-block-only`: a value taken as live after a cold call only where its block reads it later */
  blockOnly?: boolean;
}

interface Interval {
  v: number;
  start: number;
  end: number;
  weight: number;
  crosses: boolean;
  coldCross?: boolean; // R30: across a cold call (and, unless `crosses`, no other)
  fp: boolean;
  hint: number; // a location it would like, or NONE
  hintValue: number; // a value whose location it would like, or NONE
  reg: number;
}

function loopDepths(f: Func): Int32Array {
  // Natural loops from back edges. Canonical TIR has its blocks in reverse postorder, so a back edge
  // goes to a position at or before its source.
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const preds: number[][] = f.blocks.map(() => []);
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) preds[index.get(e.block)!]!.push(i);
  });
  const depth = new Int32Array(f.blocks.length);
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) {
      const h = index.get(e.block)!;
      if (h > i) continue;
      const seen = new Set<number>([h]);
      const stack = [i];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const p of preds[x]!) stack.push(p);
      }
      for (const x of seen) depth[x]!++;
    }
  });
  return depth;
}

/** Where a function's arguments or results go: registers in order per class, then 8-byte stack slots. */
export function assignRegs(types: TirType[]): { locs: number[]; stack: number } {
  let gp = 0;
  let fp = 0;
  let stack = 0;
  const locs = types.map((t) => {
    if (isFloat(t)) {
      if (fp < 8) return FP_BASE + fp++;
    } else if (gp < 8) return gp++;
    return MEM_BASE + 8 * stack++;
  });
  return { locs, stack };
}

/**
 * Linear scan, and at -O1 and -O2 (`faults` given) rematerialisation (D75): a value the scan spilled that's cheap to compute
 * again from operands that got registers is computed again at each use instead, and the scan runs again without it, up to
 * three times. Cheap means a constant offset from a register (`gep`, `add`, `sub` with an immediate), a compare only ever
 * branched on (computed again at each branch, as selection folds one), or a class id's load (`.inv`) whose uses are all in
 * its block with no store or call between, so nothing can have changed or freed what it read. A value it's given as an
 * argument, an edge's or a call's, or returned, stays as it was: those go through parallel moves, which could overwrite an
 * operand first. If a later scan spills an operand, the value goes back to being allocated, so a recomputation only reads
 * registers, and needs no scratch register but the one its use names.
 */
export function allocate(
  s: Selection,
  faults: ReadonlySet<string> | null = null,
  frameRecords = false, // hosted targets (macos-arm64, D57): x29 is the frame pointer, never allocated
  split: ColdSplit | null = null, // R30: -O1 and -O2, values split around cold calls
): Allocation {
  const cold = split !== null ? coldCalls(s.f) : null;
  const allocateOnce = (sel: Selection, fr: boolean): Allocation =>
    allocateOnce0(sel, fr, cold, split);
  let a = allocateOnce(s, frameRecords);
  if (faults === null || a.spillSlots === 0) return a;
  const cand = rematCandidates(s);
  if (faults.has("b3-remat-stale")) s.staleFault = true;
  const madeCmp = new Set<number>();
  const on = (v: number): boolean => s.recomp[v] === true || madeCmp.has(v);
  const undo = (v: number): void => {
    s.recomp[v] = false;
    if (madeCmp.delete(v)) s.cmp[v] = false;
    cand.delete(v);
  };
  for (let round = 0; round < 3; round++) {
    let more = false;
    for (const v of cand) {
      if (on(v) || a.loc[v]! < MEM_BASE || !operandsInRegs(s, a, s.def[v]!)) continue;
      if (/^[if]cmp\./.test(s.def[v]!.op)) {
        s.cmp[v] = true;
        madeCmp.add(v);
      } else s.recomp[v] = true;
      more = true;
    }
    if (!more) break;
    a = allocateOnce(s, frameRecords);
  }
  // A recomputation reads only registers: one whose operand the last scan spilled is allocated again, until none is.
  for (let guard = 0; guard <= cand.size + 1; guard++) {
    const bad = [...cand].filter((v) => s.recomp[v] === true && !operandsInRegs(s, a, s.def[v]!));
    if (bad.length === 0) break;
    for (const v of bad) undo(v);
    a = allocateOnce(s, frameRecords);
  }
  return a;
}

function operandsInRegs(s: Selection, a: Allocation, d: Instr): boolean {
  const vals: number[] = [];
  for (const o of d.ops) if (o.t === "v") addUse(s, o.id, vals);
  return vals.every((v) => a.loc[v]! !== NONE && a.loc[v]! < MEM_BASE);
}

/** Values that may be computed again where they're used, by what they are and how they're used (see `allocate`). */
function rematCandidates(s: Selection): Set<number> {
  const f = s.f;
  const n = f.types.length;
  const plain = new Int32Array(n); // uses as an operand of an instruction that isn't a call, a branch's condition or a switch's value
  const all = new Int32Array(n);
  const useBlock = new Int32Array(n).fill(-2);
  const lastUse = new Int32Array(n).fill(-1);
  const defAt = new Int32Array(n).fill(-1);
  const dirtyAt: number[][] = f.blocks.map(() => []);
  const note = (v0: number, bi: number, ii: number, isPlain: boolean): void => {
    const v = s.alias[v0]!;
    all[v]!++;
    if (isPlain) plain[v]!++;
    useBlock[v] = useBlock[v] === -2 || useBlock[v] === bi ? bi : -1;
    lastUse[v] = Math.max(lastUse[v]!, ii);
  };
  f.blocks.forEach((b, bi) => {
    b.instrs.forEach((ins, ii) => {
      if (ins.res.length === 1 && s.dead[ins.res[0]!] === true) return;
      const call = isCallOp(ins);
      for (const o of ins.ops) if (o.t === "v") note(o.id, bi, ii, !call);
      for (const r of ins.res) defAt[r] = ii;
      const base = ins.op.split(".")[0]!;
      if (call || base === "store" || effectful(ins)) dirtyAt[bi]!.push(ii);
    });
    const t = b.term;
    const end = b.instrs.length;
    if (t.k === "brif") note(t.cond, bi, end, true);
    if (t.k === "switch") note(t.val, bi, end, true);
    if (t.k === "ret") for (const v of t.vals) note(v, bi, end, false);
    for (const e of edgesOf(t)) for (const v of e.args) note(v, bi, end, false);
  });
  const out = new Set<number>();
  const blockOfDef = new Int32Array(n).fill(-1);
  f.blocks.forEach((b, bi) =>
    b.instrs.forEach((ins) => ins.res.forEach((r) => (blockOfDef[r] = bi))),
  );
  const isReg = (v0: number): boolean => s.remat[s.alias[v0]!] === undefined;
  const imm12 = (v0: number): boolean => {
    const r = s.remat[s.alias[v0]!];
    if (r?.k !== "int") return false;
    const k = BigInt.asIntN(64, r.val);
    return k > -4096n && k < 4096n;
  };
  for (let v = 0; v < n; v++) {
    const d = s.def[v];
    if (d === undefined || d.res.length !== 1 || s.alias[v] !== v || all[v] === 0) continue;
    if (s.remat[v] !== undefined || s.gep[v] !== undefined || s.cmp[v] || s.dead[v]) continue;
    const p = d.op.split(".");
    const t = f.types[v]!;
    const vals = d.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    if (p[0] === "icmp" || p[0] === "fcmp") {
      // Only ever a condition: computed again at each branch, which is what folding does.
      if (plain[v] === all[v] && condOnly(s, v)) out.add(v);
      continue;
    }
    if (plain[v] !== all[v] || isFloat(t)) continue;
    if (p[0] === "gep") {
      const nums = d.ops.flatMap((o) => (o.t === "i" ? [Number(o.val)] : []));
      const idx = s.remat[s.alias[vals[1]!]!];
      if (!isReg(vals[0]!) || idx?.k !== "int") continue;
      const total = BigInt(nums[1]!) + BigInt.asIntN(64, idx.val) * BigInt(nums[0]!);
      if (total > -4096n && total < 4096n) out.add(v);
      continue;
    }
    if ((p[0] === "add" || p[0] === "sub") && p.length === 2 && (t === "i32" || is64(t))) {
      if (isReg(vals[0]!) && imm12(vals[1]!)) out.add(v);
      else if (p[0] === "add" && isReg(vals[1]!) && imm12(vals[0]!)) out.add(v);
      continue;
    }
    if (p[0] === "load" && p[2] === "inv") {
      // Its uses all in its block, after it, with nothing between that stores, calls or has an effect.
      const bi = blockOfDef[v]!;
      if (useBlock[v] !== bi) continue;
      if (dirtyAt[bi]!.some((ii) => ii > defAt[v]! && ii < lastUse[v]!)) continue;
      const a = s.alias[vals[0]!]!;
      const g = s.gep[a];
      if (g === undefined) {
        if (isReg(a)) out.add(v);
        continue;
      }
      const idx = s.remat[g.idx];
      if (!isReg(g.base) || idx?.k !== "int") continue;
      const off = g.off + Number(BigInt.asIntN(64, idx.val)) * g.scale;
      if (memImmOk(LOAD_OP[p[1]!]!, off)) out.add(v);
    }
  }
  return out;
}

/** A compare whose every use is a branch's condition or a select's. */
function condOnly(s: Selection, v: number): boolean {
  let n = 0;
  for (const b of s.f.blocks) {
    for (const ins of b.instrs) {
      const vals = ins.ops.flatMap((o) => (o.t === "v" ? [s.alias[o.id]!] : []));
      const k = vals.filter((x) => x === v).length;
      if (k === 0) continue;
      if (ins.op.split(".")[0] !== "select" || vals.indexOf(v) !== 0 || k !== 1) return false;
      n++;
    }
    if (b.term.k === "brif" && s.alias[b.term.cond] === v) n++;
  }
  return n > 0;
}

function effectful(ins: Instr): boolean {
  const base = ins.op.split(".")[0]!;
  return !PURE.has(base) && base !== "bounds" && base !== "range" && !ins.op.includes(".chk");
}

/**
 * R30: the function's cold calls. A call (anything that clobbers the registers a caller doesn't need kept, `isCallOp`) is cold
 * where its block isn't on every turn of its innermost loop (it doesn't dominate each of the loop's back edges' sources), or,
 * outside every loop, isn't on every way out of the function (it doesn't dominate each block that returns, but a quick way
 * out: one that only returns, reached by a conditional branch): a call made only on some paths, such as a slow path's or a
 * rare case's. `native.try` is never cold, and `trap.code`, which never comes back,
 * has nothing live across it to keep. Which calls are cold decides only what's saved where, never what's computed.
 */
export function coldCalls(f: Func): Set<Instr> {
  const out = new Set<Instr>();
  const nb = f.blocks.length;
  if (nb === 0) return out;
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const cfg = buildCfg(f);
  const dominates = (x: number, y0: number): boolean => {
    let y = y0;
    for (let guard = 0; guard <= nb; guard++) {
      if (y === x) return true;
      const up = cfg.idom.get(y);
      if (up === undefined || up === y) return false;
      y = up;
    }
    return false;
  };
  // natural loops by header: their blocks and the sources of their back edges
  const loops = new Map<number, { body: Set<number>; latches: number[] }>();
  f.blocks.forEach((b, i) => {
    if (!cfg.idom.has(i)) return;
    for (const e of edgesOf(b.term)) {
      const h = index.get(e.block)!;
      if (!dominates(h, i)) continue;
      const l = loops.get(h) ?? { body: new Set<number>([h]), latches: [] };
      loops.set(h, l);
      l.latches.push(i);
      const stack = [i];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (l.body.has(x)) continue;
        l.body.add(x);
        for (const p of cfg.preds[x]!) stack.push(p);
      }
    }
  });
  // The ways out: blocks that return, but a quick way out (a block that only returns, reached by a conditional branch, as
  // `if (lo >= hi) return;` is), which is taken rarely: a call past a guard like that is on every way through that does
  // the function's work (sort_i32's recursive calls were split around, 5% slower, before this).
  const all: number[] = [];
  f.blocks.forEach((b, i) => {
    if (b.term.k === "ret" && cfg.idom.has(i)) all.push(i);
  });
  // R31: a block that makes only the constants it returns is as quick (`if (count === 0) return 0;`): the JPEG decoder's
  // readBits and receiveExtend stored and loaded a value around the call past such a test on every call, and at -O1 the
  // decoder was 0.4% slower than with no split at all.
  const consts = !r31Off("split");
  const quick = (i: number): boolean =>
    f.blocks[i]!.instrs.every(
      (ins) => consts && (ins.op.startsWith("iconst.") || ins.op.startsWith("fconst.")),
    ) &&
    cfg.preds[i]!.length > 0 &&
    cfg.preds[i]!.every((p) => f.blocks[p]!.term.k === "brif");
  const rets = all.some((i) => !quick(i)) ? all.filter((i) => !quick(i)) : all;
  // R38: a throw is a way out of the turn. A block that sets the lowering's exception flag (`__exc_on`, set to 1) goes on
  // only to a handler or out of the function, so the ways on from it are left out of "every turn" and "every way out":
  // a call is hot where it's on every way that doesn't throw. Without this, a throw inlined into a loop (the printed
  // `strConcat`'s RangeError) met the caller's flag test, whose untaken side reached the loop's back edge, so every
  // call after it was cold (gen_finally_catch_finally_breakOuter, R37). Nothing changes in a function with no such block.
  const thrown = r38Off("cold") ? null : throwBlocks(f);
  const kept = thrown !== null && thrown.size > 0 ? keptDominators(f, index, thrown) : null;
  const keptDominates = (x: number, y0: number): boolean => {
    let y = y0;
    for (let guard = 0; guard <= nb; guard++) {
      if (y === x) return true;
      const up = kept![y]!;
      if (up < 0 || up === y) return false;
      y = up;
    }
    return false;
  };
  const reached = (i: number): boolean => kept !== null && kept[i]! >= 0;
  f.blocks.forEach((b, i) => {
    if (!cfg.idom.has(i)) return;
    let inner: { body: Set<number>; latches: number[] } | null = null;
    for (const l of loops.values())
      if (l.body.has(i) && (inner === null || l.body.size < inner.body.size)) inner = l;
    const every = inner !== null ? inner.latches : rets;
    let onEvery: boolean;
    if (kept === null) onEvery = every.every((x) => dominates(i, x));
    else {
      // R38: reached only by way of a throw, it's on no way that doesn't throw: cold
      const ways = every.filter(reached);
      onEvery = !reached(i)
        ? false
        : ways.length > 0
          ? ways.every((x) => keptDominates(i, x))
          : every.every((x) => dominates(i, x));
    }
    for (const ins of b.instrs) {
      if (!isCallOp(ins)) continue;
      const n = ins.ops[0];
      if (ins.op === "intrinsic" && n?.t === "name" && n.name === "native.try") continue;
      if (!onEvery) out.add(ins);
    }
  });
  return out;
}

/** R38: the blocks that set the lowering's exception flag: a store of 1 to `__exc_on`, both made in the block. */
function throwBlocks(f: Func): Set<number> {
  const out = new Set<number>();
  f.blocks.forEach((b, i) => {
    const flag = new Set<number>();
    const one = new Set<number>();
    for (const ins of b.instrs) {
      const o = ins.ops[0];
      if (ins.op === "globaladdr" && o?.t === "sym" && o.name === "__exc_on") flag.add(ins.res[0]!);
      else if (ins.op.startsWith("iconst.") && o?.t === "i" && o.val === 1n) one.add(ins.res[0]!);
      else if (ins.op.startsWith("store.")) {
        const [a, v] = ins.ops;
        if (a?.t === "v" && v?.t === "v" && flag.has(a.id) && one.has(v.id)) out.add(i);
      }
    }
  });
  return out;
}

/**
 * R38: each block's immediate dominator, by position, in the function's graph without the edges out of `cut` (-1 where
 * that graph doesn't reach it): Cooper, Harvey and Kennedy's iteration in reverse postorder, as buildCfg's.
 */
function keptDominators(f: Func, index: Map<number, number>, cut: Set<number>): Int32Array {
  const n = f.blocks.length;
  const succ = f.blocks.map((b, i) =>
    cut.has(i) ? [] : edgesOf(b.term).map((e) => index.get(e.block)!),
  );
  const seen = new Uint8Array(n);
  const post: number[] = [];
  const stack: { b: number; k: number }[] = [{ b: 0, k: 0 }];
  seen[0] = 1;
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const s = succ[top.b]!;
    if (top.k < s.length) {
      const to = s[top.k++]!;
      if (seen[to] === 0) {
        seen[to] = 1;
        stack.push({ b: to, k: 0 });
      }
    } else {
      post.push(top.b);
      stack.pop();
    }
  }
  const rpo = post.reverse();
  const at = new Int32Array(n).fill(-1);
  rpo.forEach((b, i) => (at[b] = i));
  const preds: number[][] = f.blocks.map(() => []);
  for (const b of rpo) for (const to of succ[b]!) preds[to]!.push(b);
  const dom = new Int32Array(n).fill(-1);
  dom[0] = 0;
  const meet = (a0: number, b0: number): number => {
    let a = a0;
    let b = b0;
    while (a !== b) {
      while (at[a]! > at[b]!) a = dom[a]!;
      while (at[b]! > at[a]!) b = dom[b]!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i]!;
      let best = -1;
      for (const p of preds[b]!) {
        if (dom[p]! < 0) continue;
        best = best < 0 ? p : meet(p, best);
      }
      if (best >= 0 && dom[b] !== best) {
        dom[b] = best;
        changed = true;
      }
    }
  }
  return dom;
}

/**
 * R38's coldness put back as R37 had it, for tools/r38-pins.ts' timing (`TMK_R38_OFF=cold`): the ways on from a throw count
 * as turns of the loop and ways out of the function. Machine code only.
 */
export function r38Off(part: string): boolean {
  return (globalThis.process?.env?.TMK_R38_OFF ?? "").split(",").includes(part);
}

/**
 * R31's coldness put back as R30 had it, for tools/r31-tests.ts (`TMK_R31_OFF=split`): only a block with no instructions a
 * quick way out.
 */
export function r31Off(part: string): boolean {
  return (globalThis.process?.env?.TMK_R31_OFF ?? "").split(",").includes(part);
}

/**
 * R35's backend part put back as R30 had it, for tools/r35-pins.ts' timing (`TMK_R35_OFF=saves`): every value whose interval
 * spans a cold call saved around it. Machine code only.
 */
export function r35Off(part: string): boolean {
  return (globalThis.process?.env?.TMK_R35_OFF ?? "").split(",").includes(part);
}

/**
 * R35: the values read after `call` in its block (by later instructions, the block's last word and its edges' arguments),
 * as the allocator names them: what of a cold call's saves is needed past it, with what's live out of the block.
 */
function liveAfter(s: Selection, b: Func["blocks"][number], call: Instr): Set<number> {
  const out = new Set<number>();
  const tmp: number[] = [];
  let past = false;
  for (const ins of b.instrs) {
    if (ins === call) {
      past = true;
      continue;
    }
    if (!past || skipInstr(s, ins)) continue;
    tmp.length = 0;
    regUses(s, ins, tmp);
    for (const v of tmp) out.add(v);
  }
  tmp.length = 0;
  const t = b.term;
  if (t.k === "brif") addUse(s, t.cond, tmp);
  if (t.k === "switch") addUse(s, t.val, tmp);
  if (t.k === "ret") for (const v of t.vals) addUse(s, v, tmp);
  for (const e of edgesOf(t)) for (const a of e.args) addUse(s, a, tmp);
  for (const v of tmp) out.add(v);
  return out;
}

/** `trap.code`: a call as far as registers go, but it never comes back, so nothing needs to be kept across it. */
function neverReturns(ins: Instr): boolean {
  const n = ins.ops[0];
  return ins.op === "intrinsic" && n?.t === "name" && n.name === "trap.code";
}

function allocateOnce0(
  s: Selection,
  frameRecords: boolean,
  cold: Set<Instr> | null,
  split: ColdSplit | null,
): Allocation {
  const GP_CALLEE = frameRecords ? GP_CALLEE_ALL.filter((r) => r !== 29) : GP_CALLEE_ALL;
  const f = s.f;
  const n = f.types.length;
  const nb = f.blocks.length;
  const words = (n + 31) >>> 5;
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));

  // Per-block use and def sets, and linear positions.
  const gen = new Uint32Array(nb * words);
  const kill = new Uint32Array(nb * words);
  const blockStart = new Int32Array(nb);
  const blockEnd = new Int32Array(nb);
  const start = new Int32Array(n).fill(-1);
  const end = new Int32Array(n).fill(-1);
  const uses = new Float64Array(n);
  const callPos: number[] = [];
  const coldAt: { pos: number; ins: Instr; bi: number }[] = []; // R30: cold calls, in order (R35: and their blocks)
  const depth = loopDepths(f);
  const hint = new Int32Array(n).fill(NONE);
  const hintValue = new Int32Array(n).fill(NONE);
  let pos = 0;
  const tmp: number[] = [];
  const has = (set: Uint32Array, b: number, v: number): boolean =>
    ((set[b * words + (v >>> 5)]! >>> (v & 31)) & 1) === 1;
  const put = (set: Uint32Array, b: number, v: number): void => {
    set[b * words + (v >>> 5)]! |= 1 << (v & 31);
  };
  const extend = (v: number, at: number): void => {
    if (start[v] === -1 || at < start[v]!) start[v] = at;
    if (at > end[v]!) end[v] = at;
  };
  const noteUse = (bi: number, v: number, at: number): void => {
    if (!has(kill, bi, v)) put(gen, bi, v);
    extend(v, at);
    uses[v]! += 10 ** Math.min(depth[bi]!, 5);
  };
  const noteDef = (bi: number, v: number, at: number): void => {
    put(kill, bi, v);
    extend(v, at);
    uses[v]! += 10 ** Math.min(depth[bi]!, 5);
  };

  const params = assignRegs(f.params.map((p) => f.types[p]!));
  f.params.forEach((p, i) => {
    noteDef(0, p, 0);
    const l = params.locs[i]!;
    if (l < MEM_BASE) hint[p] = l;
  });

  let hasCall = false;
  for (let bi = 0; bi < nb; bi++) {
    const b = f.blocks[bi]!;
    blockStart[bi] = pos;
    for (const p of b.params) noteDef(bi, p, pos);
    pos += 2;
    for (const ins of b.instrs) {
      if (skipInstr(s, ins)) continue;
      tmp.length = 0;
      regUses(s, ins, tmp);
      for (const v of tmp) noteUse(bi, v, pos);
      for (const r of ins.res) noteDef(bi, r, pos + 1);
      if (isCallOp(ins)) {
        // trap.code never returns, so nothing needs to survive it, but treating it as a call is safe. R30: with values split
        // around cold calls, a cold call's place is noted apart, and trap.code's not at all.
        hasCall = true;
        if (cold !== null && cold.has(ins)) {
          if (!neverReturns(ins)) coldAt.push({ pos, ins, bi });
        } else if (cold === null || !neverReturns(ins)) callPos.push(pos);
        const argVals: number[] = [];
        for (const o of ins.ops) if (o.t === "v") argVals.push(s.alias[o.id]!);
        const skip = ins.op === "call.indirect" ? 1 : 0;
        const a = assignRegs(argVals.slice(skip).map((v) => f.types[v]!));
        argVals.slice(skip).forEach((v, i) => {
          const l = a.locs[i]!;
          if (l < MEM_BASE && hint[v] === NONE) hint[v] = l;
        });
        const r = assignRegs(ins.res.map((v) => f.types[v]!));
        ins.res.forEach((v, i) => {
          const l = r.locs[i]!;
          if (l < MEM_BASE) hint[v] = l;
        });
      }
      pos += 2;
    }
    const t = b.term;
    tmp.length = 0;
    if (t.k === "brif") addUse(s, t.cond, tmp);
    if (t.k === "switch") addUse(s, t.val, tmp);
    if (t.k === "ret") for (const v of t.vals) addUse(s, v, tmp);
    for (const e of edgesOf(t)) {
      const target = f.blocks[index.get(e.block)!]!;
      e.args.forEach((a, i) => {
        addUse(s, a, tmp);
        const c = s.alias[a]!;
        const p = target.params[i]!;
        if (s.remat[c] === undefined) {
          // Argument and parameter want one register, whichever is allocated first.
          if (hintValue[c] === NONE) hintValue[c] = p;
          if (hintValue[p] === NONE) hintValue[p] = c;
        }
      });
    }
    for (const v of tmp) noteUse(bi, v, pos);
    if (t.k === "ret") {
      const r = assignRegs(f.rets);
      t.vals.forEach((v0, i) => {
        const v = s.alias[v0]!;
        const l = r.locs[i]!;
        if (l < MEM_BASE && hint[v] === NONE) hint[v] = l;
      });
    }
    blockEnd[bi] = pos;
    pos += 2;
  }

  // Liveness: iterate to a fixed point, backwards over reverse postorder.
  const liveIn = new Uint32Array(nb * words);
  const liveOut = new Uint32Array(nb * words);
  let changed = true;
  for (let round = 0; changed && round <= nb + 2; round++) {
    changed = false;
    for (let bi = nb - 1; bi >= 0; bi--) {
      for (const e of edgesOf(f.blocks[bi]!.term)) {
        const to = index.get(e.block)!;
        for (let w = 0; w < words; w++) {
          const add = liveIn[to * words + w]! & ~liveOut[bi * words + w]!;
          if (add !== 0) {
            liveOut[bi * words + w]! |= add;
            changed = true;
          }
        }
      }
      for (let w = 0; w < words; w++) {
        const val = gen[bi * words + w]! | (liveOut[bi * words + w]! & ~kill[bi * words + w]!);
        if (val >>> 0 !== liveIn[bi * words + w]) {
          liveIn[bi * words + w] = val;
          changed = true;
        }
      }
    }
  }
  for (let bi = 0; bi < nb; bi++) {
    for (let w = 0; w < words; w++) {
      let bits = liveIn[bi * words + w]!;
      while (bits !== 0) {
        const low = bits & -bits;
        const v = w * 32 + (31 - Math.clz32(low));
        extend(v, blockStart[bi]!);
        bits ^= low;
      }
      bits = liveOut[bi * words + w]!;
      while (bits !== 0) {
        const low = bits & -bits;
        const v = w * 32 + (31 - Math.clz32(low));
        extend(v, blockEnd[bi]!);
        bits ^= low;
      }
    }
  }

  const crossesCall = (a: number, b: number): boolean => {
    // Any call position strictly inside (a, b). Calls are sorted by construction.
    let lo = 0;
    let hi = callPos.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (callPos[mid]! <= a) lo = mid + 1;
      else hi = mid;
    }
    return lo < callPos.length && callPos[lo]! < b;
  };

  const intervals: Interval[] = [];
  for (let v = 0; v < n; v++) {
    if (start[v] === -1) continue;
    intervals.push({
      v,
      start: start[v]!,
      end: end[v]!,
      weight: uses[v]! / (end[v]! - start[v]! + 2),
      crosses: crossesCall(start[v]!, end[v]!),
      coldCross: coldAt.some((c) => c.pos > start[v]! && c.pos < end[v]!),
      fp: isFloat(f.types[v]!),
      hint: hint[v]!,
      hintValue: hintValue[v]!,
      reg: NONE,
    });
  }
  intervals.sort((a, b) => a.start - b.start || a.v - b.v);

  const loc = new Int32Array(n).fill(NONE);
  const active: Interval[] = [];
  const freeGp = new Set<number>([...GP_CALLER, ...GP_CALLEE]);
  const freeFp = new Set<number>([...FP_CALLER, ...FP_CALLEE]);
  const calleeGp = new Set(GP_CALLEE);
  const calleeFp = new Set(FP_CALLEE);
  let slots = 0;
  const usedGp = new Set<number>();
  const usedFp = new Set<number>();
  const spill = (it: Interval): void => {
    loc[it.v] = MEM_BASE + 8 * slots++;
    it.reg = NONE;
  };
  for (const it of intervals) {
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i]!;
      // The result of an instruction may share a register with an operand ending there.
      if (a.end <= it.start && a.start < it.start) {
        active.splice(i, 1);
        (a.fp ? freeFp : freeGp).add(a.reg);
      }
    }
    const free = it.fp ? freeFp : freeGp;
    const callee = it.fp ? calleeFp : calleeGp;
    const order = it.fp ? [...FP_CALLER, ...FP_CALLEE] : [...GP_CALLER, ...GP_CALLEE];
    let pick = NONE;
    const usable = (r: number): boolean => free.has(r) && (!it.crosses || callee.has(r));
    // the injected bug (`r30-split-callee-free`): a value across cold calls only takes a callee-saved register first, and
    // it's not recorded as used, so the prologue doesn't save it
    const calleeFree = split?.calleeFree === true && it.coldCross === true && !it.crosses;
    if (calleeFree) {
      for (const r of it.fp ? FP_CALLEE : GP_CALLEE)
        if (free.has(r)) {
          pick = r;
          break;
        }
    }
    // First a register already holding the other end of a block argument, then the call hint.
    if (it.hintValue !== NONE) {
      const l = loc[it.hintValue]!;
      const r = it.fp ? l - FP_BASE : l;
      if (l !== NONE && l < MEM_BASE && (it.fp ? l >= FP_BASE : l < FP_BASE) && usable(r)) pick = r;
    }
    if (pick === NONE && it.hint !== NONE) {
      const r = it.fp ? it.hint - FP_BASE : it.hint;
      if ((it.fp ? it.hint >= FP_BASE : it.hint < FP_BASE) && usable(r)) pick = r;
    }
    if (pick === NONE) {
      // Across a call only callee-saved will do. Otherwise caller-saved first: it costs no save.
      for (const r of order) {
        if (usable(r)) {
          pick = r;
          break;
        }
      }
    }
    if (pick === NONE) {
      // Evict the cheapest holder this interval could use, if it's cheaper than this one.
      let victim: Interval | null = null;
      for (const a of active) {
        if (a.fp !== it.fp) continue;
        if (it.crosses && !callee.has(a.reg)) continue;
        if (victim === null || a.weight < victim.weight) victim = a;
      }
      if (victim !== null && victim.weight < it.weight) {
        pick = victim.reg;
        active.splice(active.indexOf(victim), 1);
        spill(victim);
        free.add(pick);
      } else {
        spill(it);
        continue;
      }
    }
    free.delete(pick);
    it.reg = pick;
    loc[it.v] = it.fp ? FP_BASE + pick : pick;
    if (callee.has(pick) && !calleeFree) (it.fp ? usedFp : usedGp).add(pick);
    active.push(it);
  }
  // R30: at each cold call, what's in a register the caller doesn't need kept and live across it, a slot each value
  const coldSaves = new Map<Instr, { loc: number; slot: number }[]>();
  const slotOf = new Map<number, number>();
  const savesAll = r35Off("saves");
  for (const c of coldAt) {
    const list: { loc: number; slot: number }[] = [];
    // R35: what's live after the call, read later in its block or live out of it; `TMK_R35_OFF=saves` saves every value
    // whose interval spans the call, as R30 did
    const after = savesAll ? null : liveAfter(s, f.blocks[c.bi]!, c.ins);
    if (after !== null && split?.blockOnly !== true) {
      for (let w = 0; w < words; w++) {
        let bits = liveOut[c.bi * words + w]!;
        while (bits !== 0) {
          const low = bits & -bits;
          after.add(w * 32 + (31 - Math.clz32(low)));
          bits ^= low;
        }
      }
    }
    for (const it of intervals) {
      if (it.reg === NONE || !(it.start < c.pos && c.pos < it.end)) continue;
      if (after !== null && !after.has(it.v)) continue;
      if ((it.fp ? calleeFp : calleeGp).has(it.reg)) continue;
      let k = slotOf.get(it.v);
      if (k === undefined) slotOf.set(it.v, (k = slotOf.size));
      list.push({ loc: it.fp ? FP_BASE + it.reg : it.reg, slot: k });
    }
    if (list.length > 0) coldSaves.set(c.ins, list);
  }
  return {
    loc,
    usedGp: [...usedGp].sort((a, b) => a - b),
    usedFp: [...usedFp].sort((a, b) => a - b),
    spillSlots: slots,
    hasCall,
    outArea: 0,
    loopDepth: depth,
    coldSaves,
    saveSlots: slotOf.size,
  };
}
