// TIR to AArch64 machine code, one function at a time (SPEC 4.4). The output depends only on the
// canonical TIR: nothing here reads a clock, a path or a hash order.
import { type Edge, type Func, type Instr, type Module, type TirType } from "../tir/ir.ts";
import * as E from "./encode.ts";
import { Cond, invert, type MemOp, XZR } from "./encode.ts";
import { implicitNullChecks, layoutBlocks, threadBranches } from "./shape.ts";
import {
  allocate,
  assignRegs,
  type Allocation,
  FP_BASE,
  is64,
  isCallOp,
  isFloat,
  MEM_BASE,
  NONE,
  type Remat,
  SCRATCH_D29,
  SCRATCH_D30,
  SCRATCH_D31,
  SCRATCH_X16,
  SCRATCH_X17,
  SCRATCH_X8,
  select,
  type Selection,
  skipInstr,
} from "./regalloc.ts";

const X8 = SCRATCH_X8;
const X16 = SCRATCH_X16;
const X17 = SCRATCH_X17;
const LR = 30;

export type FixKind = "b26" | "bl26" | "adrp" | "add12" | "ldr12x" | "lo12";
export interface Fixup {
  at: number; // word index
  kind: FixKind;
  sym: string;
  addend?: number; // bytes past the symbol: `adrp` and `lo12` only
}

/** One growing code buffer, shared by the hand-written runtime and every compiled function. */
export class Code {
  words: number[] = [];
  fixups: Fixup[] = [];
  symbols = new Map<string, number>(); // name to word index
  ranges: { name: string; from: number; to: number }[] = []; // words that are instructions

  get here(): number {
    return this.words.length;
  }
  emit(w: number): void {
    this.words.push(w >>> 0);
  }
  fix(kind: FixKind, sym: string): void {
    this.fixups.push({ at: this.words.length, kind, sym });
    this.words.push(0);
  }
  define(name: string): void {
    if (this.symbols.has(name)) throw new Error(`symbol ${name} defined twice`);
    this.symbols.set(name, this.words.length);
  }
  alignWords(n: number): void {
    while (this.words.length % n !== 0) this.words.push(E.NOP >>> 0);
  }
}

interface LabelFix {
  at: number;
  label: number;
  kind: "b" | "bcond" | "cbz" | "lit" | "adr";
}

export interface EmitContext {
  code: Code;
  m: Module;
  trapCode: Map<number, number>;
  funcs: Map<string, Func>;
  stats: { spilledValues: number; frames: number };
  /** The backend's -O1 and -O2 code shape for a function (D75), or null for -O0's, which is byte for byte as before. */
  shape?: (f: Func) => Shape | null;
  /**
   * R7: where each load standing for an explicit null check was emitted, as word indexes into `code`: the image lists them
   * (`__rt_null_pcs`), and a fault at one near address 0 is trap 6 (shape.ts's implicitNullChecks).
   */
  nullPcs?: { pc: number; off: number }[];
  /**
   * A hosted target (macos-arm64, D56, D57), not bare metal: x29 is the frame pointer and every function that calls builds
   * a frame record, and `native.putc` goes to the hosted runtime's buffered output (hosted.ts) instead of the PL011.
   * Unset, the code is exactly the bare-metal code.
   */
  hosted?: boolean;
}

/** What the -O1 and -O2 code shape is given: the bugs a test puts in (OPT_FAULTS), none in a real build. */
export interface Shape {
  faults: ReadonlySet<string>;
  /** Parts switched off by name (`TMK_OPT_DISABLE`, D46): `globals`, `thread`, `fuse`, `remat`, `layout`. */
  on: (part: BackendPart) => boolean;
}

export const BACKEND_PARTS = [
  "globals",
  "thread",
  "fuse",
  "remat",
  "layout",
  "nullchecks",
] as const;
export type BackendPart = (typeof BACKEND_PARTS)[number];

/** The backend's injected bugs, from the variable the optimiser's are named in (`TMK_OPT_FAULT`, D46, D75). */
export function backendFaults(): Shape {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  const list = (raw: string | undefined): string[] =>
    raw === undefined || raw.trim() === "" ? [] : raw.split(",").map((x) => x.trim());
  const off = new Set(list(env?.TMK_OPT_DISABLE));
  return {
    faults: new Set(list(env?.TMK_OPT_FAULT).filter((x) => x.startsWith("b3-"))),
    on: (part) => !off.has(part),
  };
}

/** The TIR name of the helper or libm function that implements an operation this target has no instruction for. */
export function mathSymbol(name: string): string {
  return `__${name}`;
}

const MEM_LOAD: Record<TirType, MemOp> = {
  i8: "ldrb",
  i16: "ldrh",
  i32: "ldrw",
  i64: "ldrx",
  ix: "ldrx",
  ptr: "ldrx",
  f32: "ldrs",
  f64: "ldrd",
};
const MEM_STORE: Record<TirType, MemOp> = {
  i8: "strb",
  i16: "strh",
  i32: "strw",
  i64: "strx",
  ix: "strx",
  ptr: "strx",
  f32: "strs",
  f64: "strd",
};
const ICOND: Record<string, Cond> = {
  eq: Cond.EQ,
  ne: Cond.NE,
  slt: Cond.LT,
  sle: Cond.LE,
  sgt: Cond.GT,
  sge: Cond.GE,
  ult: Cond.LO,
  ule: Cond.LS,
  ugt: Cond.HI,
  uge: Cond.HS,
};
const FCOND: Record<string, Cond> = {
  eq: Cond.EQ,
  ne: Cond.NE,
  lt: Cond.MI,
  le: Cond.LS,
  gt: Cond.GT,
  ge: Cond.GE,
};
const SWAPPED: Record<string, string> = {
  eq: "eq",
  ne: "ne",
  slt: "sgt",
  sle: "sge",
  sgt: "slt",
  sge: "sle",
  ult: "ugt",
  ule: "uge",
  ugt: "ult",
  uge: "ule",
};

type MoveSrc = { k: "loc"; loc: number } | { k: "remat"; r: Remat; t: TirType };
interface Move {
  dst: number;
  src: MoveSrc;
}

class FuncEmit {
  f: Func;
  ctx: EmitContext;
  code: Code;
  s: Selection;
  a: Allocation;
  index = new Map<number, number>();
  labels: number[] = []; // label to word index, -1 while unbound
  labelFixes: LabelFix[] = [];
  blockLabel: number[] = [];
  trapStubs = new Map<number, number>(); // trap code to its stub label
  constPool = new Map<string, number>(); // float bits to label
  deferred: (() => void)[] = [];
  frame = 0; // total bytes below the caller's SP
  saved: { gp: number[]; fp: number[]; size: number; lr: boolean };
  spillBase = 0;
  allocaOff = new Map<Instr, number>();
  rest = 0; // the part of the frame below the saved registers
  sh: Shape | null;
  order: number[] = []; // block positions in the order they're laid out
  next: Int32Array = new Int32Array(0); // a position's successor in that order, or -1
  // R7: loads (by result) that stand for a null check, with the offset each reads at, whose PCs the image lists
  nullLoads: ReadonlyMap<number, number> = new Map();

  constructor(f0: Func, ctx: EmitContext) {
    this.sh = ctx.shape?.(f0) ?? null;
    this.ctx = ctx;
    this.code = ctx.code;
    // R7: a null check whose next operation is a load through the same reference is left to the load's fault (-O1, -O2).
    // A load the selection then drops, or computes again at its uses, can't stand for it: its check is put back, and if
    // that loses another, every check in the function stays.
    const nulls = this.sh?.on("nullchecks") === true && ctx.nullPcs !== undefined;
    const build = (
      skip: ReadonlySet<number> | null,
    ): [Func, Selection, Allocation, Map<number, number>] => {
      const r =
        nulls && skip !== null
          ? implicitNullChecks(f0, ctx.trapCode, this.sh!.faults, skip)
          : { f: f0, loads: new Map<number, number>() };
      const g = this.sh?.on("thread") === true ? threadBranches(r.f, this.sh.faults) : r.f;
      const s = select(g, this.sh?.on("fuse") === true, this.sh?.on("remat") === true);
      const a = allocate(
        s,
        this.sh?.on("remat") === true ? this.sh.faults : null,
        ctx.hosted === true,
      );
      return [g, s, a, r.loads];
    };
    const lostOf = (s: Selection, loads: Map<number, number>): number[] =>
      [...loads.keys()].filter((v) => s.dead[v] === true || s.recomp[v] === true);
    let [f, s, a, loads] = build(new Set());
    const lost = lostOf(s, loads);
    if (lost.length > 0) {
      [f, s, a, loads] = build(new Set(lost));
      if (lostOf(s, loads).length > 0) [f, s, a, loads] = build(null);
    }
    this.s = s;
    this.a = a;
    this.nullLoads = loads;
    f.blocks.forEach((b, i) => this.index.set(b.id, i));
    this.f = f;
    this.blockLabel = f.blocks.map(() => this.newLabel());
    this.saved = { gp: [], fp: [], size: 0, lr: false };
  }

  newLabel(): number {
    this.labels.push(-1);
    return this.labels.length - 1;
  }
  bind(l: number): void {
    this.labels[l] = this.code.here;
  }
  emitBranch(kind: LabelFix["kind"], label: number, w: number): void {
    this.labelFixes.push({ at: this.code.here, label, kind });
    this.code.emit(w);
  }
  jump(label: number): void {
    this.emitBranch("b", label, E.b(0));
  }
  jcc(c: Cond, label: number): void {
    this.emitBranch("bcond", label, E.bcond(c, 0));
  }

  // --- the frame

  computeFrame(): void {
    const a = this.a;
    let outWords = 0;
    for (const b of this.f.blocks) {
      for (const ins of b.instrs) {
        if (!isCallOp(ins)) continue;
        const argTypes: TirType[] = [];
        for (const o of ins.ops) if (o.t === "v") argTypes.push(this.f.types[o.id]!);
        if (ins.op === "call.indirect") argTypes.shift();
        outWords = Math.max(
          outWords,
          assignRegs(argTypes).stack,
          assignRegs(ins.res.map((r) => this.f.types[r]!)).stack,
        );
      }
    }
    const outBytes = outWords * 8;
    this.spillBase = outBytes;
    // Spill slots were numbered from 0: from here on a memory location is its offset from SP.
    for (let v = 0; v < a.loc.length; v++) if (a.loc[v]! >= MEM_BASE) a.loc[v]! += outBytes;
    let at = outBytes + a.spillSlots * 8;
    for (const b of this.f.blocks) {
      for (const ins of b.instrs) {
        if (ins.op !== "alloca" || skipInstr(this.s, ins)) continue;
        const nums = ins.ops.flatMap((o) => (o.t === "i" ? [Number(o.val)] : []));
        const size = nums[0]!;
        const align = Math.max(nums[1]!, 8);
        if (align > 16) throw new Error(`@${this.f.name}: alloca aligned above 16`);
        if (this.a.loopDepth[this.index.get(b.id)!]! > 0) {
          throw new Error(`@${this.f.name}: alloca in a loop has no static slot`);
        }
        at = Math.ceil(at / align) * align;
        this.allocaOff.set(ins, at);
        at += size;
      }
    }
    this.rest = Math.ceil(at / 16) * 16;
    const lr = a.hasCall;
    // Hosted (D57): a function that calls saves x29 with x30, as a frame record at the bottom of its saves.
    let n = a.usedGp.length + (lr ? (this.ctx.hosted === true ? 2 : 1) : 0);
    n = (n + 1) & ~1;
    const fpn = (a.usedFp.length + 1) & ~1;
    this.saved = { gp: a.usedGp, fp: a.usedFp, size: (n + fpn) * 8, lr };
    this.frame = this.rest + this.saved.size;
    if (this.frame >= 1 << 20) {
      // The guard below the stack is 2 MiB, and a frame this size could step over it (SPEC 3.10).
      throw new Error(`@${this.f.name}: a frame of ${this.frame} bytes is too large`);
    }
  }

  prologue(): void {
    const c = this.code;
    const { fp, size, lr } = this.saved;
    if (size > 0) {
      const regs = this.savedRegs();
      if (regs.length % 2 === 1) regs.push(XZR);
      const fregs = [...fp];
      if (fregs.length % 2 === 1) fregs.push(31);
      // The first pair moves SP, and the others store above it.
      let off = 0;
      for (let i = 0; i < regs.length; i += 2) {
        if (i === 0) {
          c.emit(E.memPair("stpx", "pre", regs[0]!, regs[1]!, E.SP, -size));
          // Hosted: that pair is x29 and x30, the frame record, and x29 points at it (mov x29, sp).
          if (this.ctx.hosted === true && lr) c.emit(E.arithImm("add", true, 29, E.SP, 0));
        } else c.emit(E.memPair("stpx", "offset", regs[i]!, regs[i + 1]!, E.SP, off));
        off += 16;
      }
      for (let i = 0; i < fregs.length; i += 2) {
        if (i === 0 && regs.length === 0) {
          c.emit(E.memPair("stpd", "pre", fregs[0]!, fregs[1]!, E.SP, -size));
        } else c.emit(E.memPair("stpd", "offset", fregs[i]!, fregs[i + 1]!, E.SP, off));
        off += 16;
      }
    }
    this.adjustSp("sub", this.rest);
  }

  /** The integer registers the prologue saves, in order: hosted, a frame record (x29, x30) first. */
  savedRegs(): number[] {
    const { gp, lr } = this.saved;
    if (this.ctx.hosted === true && lr) return [29, LR, ...gp];
    return lr ? [...gp, LR] : [...gp];
  }

  adjustSp(op: "add" | "sub", bytes: number): void {
    if (bytes === 0) return;
    const c = this.code;
    if (bytes >= 4096) c.emit(E.arithImm(op, true, E.SP, E.SP, bytes >>> 12, true));
    if ((bytes & 4095) !== 0) c.emit(E.arithImm(op, true, E.SP, E.SP, bytes & 4095));
  }

  epilogue(): void {
    const c = this.code;
    this.adjustSp("add", this.rest);
    const { fp, size } = this.saved;
    if (size > 0) {
      const regs = this.savedRegs();
      if (regs.length % 2 === 1) regs.push(XZR);
      const fregs = [...fp];
      if (fregs.length % 2 === 1) fregs.push(31);
      // Slots mirror the prologue; the pair at the bottom restores last and moves SP back.
      let off = regs.length * 8;
      for (let i = 0; i < fregs.length; i += 2) {
        if (i > 0 || regs.length > 0) {
          c.emit(E.memPair("ldpd", "offset", fregs[i]!, fregs[i + 1]!, E.SP, off));
        }
        off += 16;
      }
      off = 16;
      for (let i = 2; i < regs.length; i += 2) {
        c.emit(E.memPair("ldpx", "offset", regs[i]!, regs[i + 1]!, E.SP, off));
        off += 16;
      }
      if (regs.length > 0) c.emit(E.memPair("ldpx", "post", regs[0]!, regs[1]!, E.SP, size));
      else c.emit(E.memPair("ldpd", "post", fregs[0]!, fregs[1]!, E.SP, size));
    }
    c.emit(E.RET);
  }

  // --- values

  /** A value's location, as an SP offset for memory, once its frame is known. */
  slotOffset(l: number): number {
    return l - MEM_BASE;
  }
  locOf(v0: number): number {
    return this.a.loc[this.s.alias[v0]!]!;
  }
  rematOf(v0: number): Remat | undefined {
    return this.s.remat[this.s.alias[v0]!];
  }

  /** Puts an integer value in a register: its own, or the scratch given. */
  gpr(v0: number, scratch: number): number {
    const v = this.s.alias[v0]!;
    const r = this.s.remat[v];
    if (r !== undefined) {
      if (r.k === "int") {
        if (r.val === 0n) return XZR;
        this.movImm(scratch, r.val);
        return scratch;
      }
      this.symAddr(scratch, r);
      return scratch;
    }
    if (this.s.recomp[v] === true) return this.recompute(v, scratch);
    const l = this.a.loc[v]!;
    if (l === NONE) throw new Error(`@${this.f.name}: %${v} has no location`);
    if (l < FP_BASE) return l;
    if (l >= MEM_BASE) {
      this.code.emit(E.memImm("ldrx", scratch, E.SP, this.slotOffset(l)));
      return scratch;
    }
    throw new Error(`@${this.f.name}: %${v} is a float where an integer was wanted`);
  }

  /**
   * A value the allocator chose to compute again at each use (D75, `allocate`), into the scratch register its use names: a
   * constant offset from a register, or a class id's load. Its operands are in registers, so nothing else is touched.
   */
  recompute(v: number, scratch: number): number {
    const d = this.s.def[v]!;
    const p = d.op.split(".");
    const vals = d.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    const c = this.code;
    if (p[0] === "gep") {
      const nums = d.ops.flatMap((o) => (o.t === "i" ? [Number(o.val)] : []));
      const idx = this.rematOf(vals[1]!) as { k: "int"; val: bigint };
      const total = nums[1]! + Number(BigInt.asIntN(64, idx.val)) * nums[0]!;
      this.addConst(scratch, this.gpr(vals[0]!, scratch), total);
      return scratch;
    }
    if (p[0] === "add" || p[0] === "sub") {
      const t = p[1] as TirType;
      const kFirst = this.rematOf(vals[0]!)?.k === "int";
      const r = this.gpr(kFirst ? vals[1]! : vals[0]!, scratch);
      const kv = this.rematOf(kFirst ? vals[0]! : vals[1]!) as { k: "int"; val: bigint };
      let k = Number(is64(t) ? BigInt.asIntN(64, kv.val) : BigInt.asIntN(32, kv.val));
      if (p[0] === "sub") k = -k;
      c.emit(E.arithImm(k < 0 ? "sub" : "add", is64(t), scratch, r, Math.abs(k)));
      return scratch;
    }
    // A class id's load: no store or call between its place and this use (`rematCandidates`).
    const op = MEM_LOAD[p[1] as TirType];
    const at = this.s.alias[vals[0]!]!;
    const g = this.s.gep[at];
    let off = 0;
    let base = at;
    if (g !== undefined) {
      const idx = this.rematOf(g.idx) as { k: "int"; val: bigint };
      off = g.off + Number(BigInt.asIntN(64, idx.val)) * g.scale;
      base = g.base;
    }
    c.emit(E.memImm(op, scratch, this.gpr(base, scratch), off));
    return scratch;
  }

  /** Puts a float value in a register: its own, or the scratch given. */
  fpr(v0: number, scratch: number): number {
    const v = this.s.alias[v0]!;
    const r = this.s.remat[v];
    if (r !== undefined) {
      if (r.k !== "float") throw new Error(`@${this.f.name}: %${v} isn't a float constant`);
      this.floatConst(scratch, r.bits, r.d);
      return scratch;
    }
    const l = this.a.loc[v]!;
    if (l === NONE) throw new Error(`@${this.f.name}: %${v} has no location`);
    if (l >= MEM_BASE) {
      this.code.emit(E.memImm("ldrd", scratch, E.SP, this.slotOffset(l)));
      return scratch;
    }
    if (l < FP_BASE)
      throw new Error(`@${this.f.name}: %${v} is an integer where a float was wanted`);
    return l - FP_BASE;
  }

  /** Where to compute an integer result: its register, or x8 to be stored by `commit`. */
  dst(v: number): number {
    const l = this.a.loc[v]!;
    if (l === NONE) return X8;
    return l >= MEM_BASE ? X8 : l;
  }
  commit(v: number, r: number): void {
    const l = this.a.loc[v]!;
    if (l >= MEM_BASE) this.code.emit(E.memImm("strx", r, E.SP, this.slotOffset(l)));
    else if (l !== NONE && l !== r) this.code.emit(E.logicReg("orr", true, l, XZR, r));
  }
  fdst(v: number): number {
    const l = this.a.loc[v]!;
    if (l === NONE || l >= MEM_BASE) return SCRATCH_D31;
    return l - FP_BASE;
  }
  fcommit(v: number, r: number): void {
    const l = this.a.loc[v]!;
    if (l >= MEM_BASE) this.code.emit(E.memImm("strd", r, E.SP, this.slotOffset(l)));
    else if (l !== NONE && l - FP_BASE !== r) this.code.emit(E.fun("fmov", true, l - FP_BASE, r));
  }

  /** Writes a constant, in as few instructions as this simple search finds. */
  movImm(rd: number, val: bigint): void {
    const c = this.code;
    const v = BigInt.asUintN(64, val);
    if (v <= 0xffffffffn) {
      const lo = Number(v & 0xffffn);
      const hi = Number(v >> 16n);
      if (hi === 0) {
        c.emit(E.movz(false, rd, lo));
        return;
      }
      if (lo === 0) {
        c.emit(E.movz(false, rd, hi, 1));
        return;
      }
      if (hi === 0xffff) {
        c.emit(E.movn(false, rd, ~lo & 0xffff));
        return;
      }
      if (lo === 0xffff) {
        c.emit(E.movn(false, rd, ~hi & 0xffff, 1));
        return;
      }
      const m = E.bitmask(v, false);
      if (m !== null) {
        c.emit(E.logicImm("orr", false, rd, XZR, m));
        return;
      }
      c.emit(E.movz(false, rd, lo));
      c.emit(E.movk(false, rd, hi, 1));
      return;
    }
    const m = E.bitmask(v, true);
    const parts = [0, 1, 2, 3].map((i) => Number((v >> BigInt(i * 16)) & 0xffffn));
    const zeros = parts.filter((p) => p === 0).length;
    const ones = parts.filter((p) => p === 0xffff).length;
    if (m !== null && zeros < 3 && ones < 3) {
      c.emit(E.logicImm("orr", true, rd, XZR, m));
      return;
    }
    if (ones === 4) {
      c.emit(E.movn(true, rd, 0));
      return;
    }
    if (ones > zeros) {
      let first = true;
      parts.forEach((p, i) => {
        if (p === 0xffff) return;
        if (first) c.emit(E.movn(true, rd, ~p & 0xffff, i));
        else c.emit(E.movk(true, rd, p, i));
        first = false;
      });
      return;
    }
    let first = true;
    parts.forEach((p, i) => {
      if (p === 0) return;
      if (first) c.emit(E.movz(true, rd, p, i));
      else c.emit(E.movk(true, rd, p, i));
      first = false;
    });
  }

  symAddr(rd: number, r: Remat): void {
    if (r.k !== "global" && r.k !== "func") throw new Error("not a symbol");
    const sym = r.k === "global" ? `g:${r.name}` : `f:${r.name}`;
    this.code.fix("adrp", sym);
    this.code.words[this.code.here - 1] = rd;
    this.code.fix("add12", sym);
    this.code.words[this.code.here - 1] = rd + (rd << 5);
  }

  floatConst(rd: number, bits: bigint, d: boolean): void {
    if (bits === 0n) {
      this.code.emit(E.moviD0(rd));
      return;
    }
    const imm8 = E.fpImm8(bits, d);
    if (imm8 !== null) {
      this.code.emit(E.fmovImm(d, rd, imm8));
      return;
    }
    const key = `${d ? "d" : "s"}${bits.toString(16)}`;
    let label = this.constPool.get(key);
    if (label === undefined) {
      label = this.newLabel();
      this.constPool.set(key, label);
    }
    this.emitBranch("lit", label, E.memLit(d ? "ldrd" : "ldrs", rd, 0));
  }

  trapStub(code: number): number {
    let l = this.trapStubs.get(code);
    if (l === undefined) {
      l = this.newLabel();
      this.trapStubs.set(code, l);
    }
    return l;
  }
  trapLabel(id: number): number {
    const code = this.ctx.trapCode.get(id);
    if (code === undefined) throw new Error(`@${this.f.name}: unknown trap t${id}`);
    return this.trapStub(code);
  }

  // --- parallel moves

  moveValue(dst: number, v0: number): Move | null {
    const v = this.s.alias[v0]!;
    const r = this.s.remat[v];
    if (r !== undefined) return { dst, src: { k: "remat", r, t: this.f.types[v0]! } };
    const l = this.a.loc[v]!;
    if (l === NONE) throw new Error(`@${this.f.name}: %${v} has no location`);
    return l === dst ? null : { dst, src: { k: "loc", loc: l } };
  }

  /** A raw 64-bit copy between any two locations. x16 carries memory-to-memory. */
  rawMove(dst: number, src: number): void {
    const c = this.code;
    const srcMem = src >= MEM_BASE;
    const dstMem = dst >= MEM_BASE;
    if (srcMem && dstMem) {
      c.emit(E.memImm("ldrx", X16, E.SP, this.slotOffset(src)));
      c.emit(E.memImm("strx", X16, E.SP, this.slotOffset(dst)));
    } else if (srcMem) {
      if (dst >= FP_BASE) c.emit(E.memImm("ldrd", dst - FP_BASE, E.SP, this.slotOffset(src)));
      else c.emit(E.memImm("ldrx", dst, E.SP, this.slotOffset(src)));
    } else if (dstMem) {
      if (src >= FP_BASE) c.emit(E.memImm("strd", src - FP_BASE, E.SP, this.slotOffset(dst)));
      else c.emit(E.memImm("strx", src, E.SP, this.slotOffset(dst)));
    } else if (src >= FP_BASE && dst >= FP_BASE) {
      c.emit(E.fun("fmov", true, dst - FP_BASE, src - FP_BASE));
    } else if (src < FP_BASE && dst < FP_BASE) {
      c.emit(E.logicReg("orr", true, dst, XZR, src));
    } else throw new Error(`@${this.f.name}: a move between register files`);
  }

  rematInto(dst: number, r: Remat): void {
    const c = this.code;
    if (dst >= MEM_BASE) {
      const off = this.slotOffset(dst);
      if (r.k === "float") {
        this.movImm(X16, r.bits);
      } else if (r.k === "int") this.movImm(X16, r.val);
      else this.symAddr(X16, r);
      c.emit(E.memImm("strx", X16, E.SP, off));
      return;
    }
    if (r.k === "float") this.floatConst(dst - FP_BASE, r.bits, r.d);
    else if (r.k === "int") this.movImm(dst, r.val);
    else this.symAddr(dst, r);
  }

  parallel(moves: Move[]): void {
    const pending: { dst: number; src: number }[] = [];
    const remats: { dst: number; r: Remat }[] = [];
    for (const m of moves) {
      if (m.src.k === "remat") remats.push({ dst: m.dst, r: m.src.r });
      else if (m.src.loc !== m.dst) pending.push({ dst: m.dst, src: m.src.loc });
    }
    const guardMax = pending.length * 2 + 4;
    for (let guard = 0; pending.length > 0; guard++) {
      if (guard > guardMax * guardMax) throw new Error(`@${this.f.name}: parallel move stuck`);
      let progressed = false;
      for (let i = 0; i < pending.length; i++) {
        const m = pending[i]!;
        if (!pending.some((o, j) => j !== i && o.src === m.dst)) {
          this.rawMove(m.dst, m.src);
          pending.splice(i, 1);
          progressed = true;
          i--;
        }
      }
      if (progressed || pending.length === 0) continue;
      // Only cycles are left: park one destination's old value in a scratch register.
      const m = pending[0]!;
      const temp = m.dst >= FP_BASE && m.dst < MEM_BASE ? FP_BASE + SCRATCH_D31 : X17;
      this.rawMove(temp, m.dst);
      for (const o of pending) if (o.src === m.dst) o.src = temp;
    }
    for (const r of remats) this.rematInto(r.dst, r.r);
  }

  edgeMoves(e: Edge): Move[] {
    const target = this.f.blocks[this.index.get(e.block)!]!;
    const out: Move[] = [];
    e.args.forEach((a, i) => {
      const p = target.params[i]!;
      const l = this.a.loc[p]!;
      if (l === NONE) return; // a parameter nothing reads
      const m = this.moveValue(l, a);
      if (m !== null) out.push(m);
    });
    return out;
  }

  // --- memory

  /** Addresses a load or store: returns the base and either an offset or an index. x16 and x17 are scratch. */
  address(
    v0: number,
    op: MemOp,
  ): { base: number; off: number; idx: number; scaled: boolean; lo12?: [string, number] } {
    const v = this.s.alias[v0]!;
    const g = this.s.gep[v];
    const size = E.memSize(op);
    if (this.sh?.on("globals") === true) {
      const at = this.globalAt(v0, size);
      if (at !== null) {
        // -O1 and -O2 (D75): the page by `adrp` and the rest in the access's own offset, two instructions, not three.
        this.code.fix("adrp", at[0]);
        this.code.words[this.code.here - 1] = X16;
        this.code.fixups[this.code.fixups.length - 1]!.addend = at[1];
        return { base: X16, off: 0, idx: -1, scaled: false, lo12: at };
      }
    }
    if (g === undefined)
      return { base: this.notSp(this.gpr(v0, X16), X16), off: 0, idx: -1, scaled: false };
    const idxR = this.rematOf(g.idx);
    if (idxR !== undefined && idxR.k === "int") {
      const total = BigInt(g.off) + BigInt.asIntN(64, idxR.val) * BigInt(g.scale);
      const off = Number(total);
      const base = this.notSp(this.gpr(g.base, X16), X16);
      if (Number.isSafeInteger(off) && E.memImmOk(op, off)) {
        return { base, off, idx: -1, scaled: false };
      }
      this.movImm(X17, total);
      return { base, off: 0, idx: X17, scaled: false };
    }
    const base = this.notSp(this.gpr(g.base, X16), X16);
    const idx = this.gpr(g.idx, X17);
    if (g.off === 0 && (g.scale === size || g.scale === 1)) {
      return { base, off: 0, idx, scaled: g.scale === size && size > 1 };
    }
    // The general form: compute it, in x16 so the base's own register is untouched.
    this.addScaled(X16, base, idx, g.scale);
    if (E.memImmOk(op, g.off)) return { base: X16, off: g.off, idx: -1, scaled: false };
    this.addConst(X16, X16, g.off);
    return { base: X16, off: 0, idx: -1, scaled: false };
  }

  /** Register 31 means SP as a base or in an add's immediate form, so a zero needs a real register. */
  notSp(r: number, scratch: number): number {
    return r === XZR ? this.zeroInto(scratch) : r;
  }

  addScaled(rd: number, base: number, idx: number, scale: number): void {
    const c = this.code;
    if ((scale & (scale - 1)) === 0 && scale > 0) {
      c.emit(E.arithReg("add", true, rd, base, idx, 0, 31 - Math.clz32(scale)));
      return;
    }
    // x8 is free here: the only instruction with three scratch needs stores its value last.
    this.movImm(X8, BigInt(scale));
    c.emit(E.madd(true, rd, idx, X8, base));
  }

  addConst(rd: number, rn: number, k: number): void {
    const c = this.code;
    if (k === 0) {
      if (rd !== rn) c.emit(E.logicReg("orr", true, rd, XZR, rn));
      return;
    }
    const abs = Math.abs(k);
    const op = k > 0 ? "add" : "sub";
    if (abs < 4096) c.emit(E.arithImm(op, true, rd, rn, abs));
    else if (abs < 1 << 24) {
      c.emit(E.arithImm(op, true, rd, rn, abs >>> 12, true));
      if ((abs & 4095) !== 0) c.emit(E.arithImm(op, true, rd, rd, abs & 4095));
    } else {
      const scratch = rd === X8 || rn === X8 ? X17 : X8;
      this.movImm(scratch, BigInt(abs));
      c.emit(E.arithReg(op, true, rd, rn, scratch));
    }
  }

  /** A global, or a constant offset into one, that a `lo12` offset of this access size can reach: aligned for it. */
  globalAt(v0: number, size: number): [string, number] | null {
    const v = this.s.alias[v0]!;
    let r = this.s.remat[v];
    let off = 0n;
    const g = this.s.gep[v];
    if (r === undefined && g !== undefined) {
      const idx = this.rematOf(g.idx);
      if (idx?.k !== "int") return null;
      r = this.rematOf(g.base);
      off = BigInt(g.off) + BigInt.asIntN(64, idx.val) * BigInt(g.scale);
    }
    if (r?.k !== "global") return null;
    const glob = this.globalByName().get(r.name);
    if (glob === undefined || off < 0n || off >= BigInt(glob.size) || glob.align < size)
      return null;
    const addend = Number(off) + (this.sh!.faults.has("b3-global-addend") ? 8 : 0);
    if (addend % size !== 0) return null;
    return [`g:${r.name}`, addend];
  }

  globals: Map<string, { size: number; align: number }> | null = null;
  globalByName(): Map<string, { size: number; align: number }> {
    if (this.globals === null) {
      this.globals = new Map();
      for (const g of this.ctx.m.globals)
        this.globals.set(g.name, { size: g.size, align: Math.max(g.align, 1) });
    }
    return this.globals;
  }

  memAccess(op: MemOp, rt: number, a: ReturnType<FuncEmit["address"]>): void {
    if (a.lo12 !== undefined) {
      this.code.fixups.push({
        at: this.code.here,
        kind: "lo12",
        sym: a.lo12[0],
        addend: a.lo12[1],
      });
      this.code.emit(E.memImm(op, rt, X16, 0));
      return;
    }
    if (a.idx >= 0) this.code.emit(E.memReg(op, rt, a.base, a.idx, a.scaled));
    else this.code.emit(E.memImm(op, rt, a.base, a.off));
  }

  // --- compares

  /** Sets the flags for a compare value, and returns the condition that means true. */
  compare(v0: number): Cond {
    const v = this.s.alias[v0]!;
    const ins = this.s.def[v]!;
    return this.compareInstr(ins);
  }

  compareInstr(ins: Instr): Cond {
    const c = this.code;
    const p = ins.op.split(".");
    const vals = ins.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    if (p[0] === "fcmp") {
      const d = p[2] === "f64";
      const a = this.fpr(vals[0]!, SCRATCH_D30);
      const b = this.fpr(vals[1]!, SCRATCH_D29);
      c.emit(E.fcmp(d, a, b));
      return FCOND[p[1]!]!;
    }
    let cond = p[1]!;
    const t = p[2] as TirType;
    const sf = is64(t);
    let a = vals[0]!;
    let b = vals[1]!;
    if (this.rematOf(a)?.k === "int" && this.rematOf(b)?.k !== "int") {
      const x = a;
      a = b;
      b = x;
      cond = SWAPPED[cond]!;
    }
    this.compareRegs(sf, a, b);
    return ICOND[cond]!;
  }

  compareRegs(sf: boolean, a: number, b: number): void {
    const c = this.code;
    const ra = this.notSp(this.gpr(a, X16), X16);
    const r = this.rematOf(b);
    if (r?.k === "int") {
      const k = sf ? BigInt.asIntN(64, r.val) : BigInt.asIntN(32, r.val);
      if (k >= 0n && k < 4096n) {
        c.emit(E.arithImm("subs", sf, XZR, ra, Number(k)));
        return;
      }
      if (k < 0n && k > -4096n) {
        c.emit(E.arithImm("adds", sf, XZR, ra, Number(-k)));
        return;
      }
    }
    const rb = this.gpr(b, X17);
    c.emit(E.arithReg("subs", sf, XZR, ra, rb));
  }

  /** A compare of an integer with the constant zero, for equality: the register to test, its width and which way. */
  zeroTest(v: number): { reg: number; sf: boolean; eq: boolean } | null {
    const ins = this.s.def[v]!;
    const p = ins.op.split(".");
    if (p[0] !== "icmp" || (p[1] !== "eq" && p[1] !== "ne")) return null;
    const vals = ins.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    const isZero = (x: number): boolean => {
      const r = this.rematOf(x);
      return r?.k === "int" && r.val === 0n;
    };
    const other = isZero(vals[1]!) ? vals[0]! : isZero(vals[0]!) ? vals[1]! : -1;
    if (other < 0) return null;
    return { reg: this.gpr(other, X16), sf: is64(p[2] as TirType), eq: p[1] === "eq" };
  }

  // --- terminators

  emitEdgeJump(from: number, e: Edge): void {
    this.parallel(this.edgeMoves(e));
    const to = this.index.get(e.block)!;
    // The bug put into layout (OPT_FAULTS, D75): falling through by position, as if blocks were still in their TIR order.
    const falls =
      this.sh?.faults.has("b3-layout-stale-next") === true
        ? to === from + 1
        : this.next[from] === to;
    if (!falls) this.jump(this.labelOf(to));
  }

  /** A label to branch to that performs an edge's moves first, if it has any. */
  edgeLabel(e: Edge): number {
    const to = this.index.get(e.block)!;
    const moves = this.edgeMoves(e);
    if (moves.length === 0) return this.labelOf(to);
    const l = this.newLabel();
    this.deferred.push(() => {
      this.bind(l);
      this.parallel(moves);
      this.jump(this.blockLabel[to]!);
    });
    return l;
  }

  /** Where a branch to a block goes: at -O1 and -O2 (layout), a block that only traps is skipped for its trap stub. */
  labelOf(to: number): number {
    if (this.sh?.on("layout") === true) {
      const b = this.f.blocks[to]!;
      if (to !== 0 && b.instrs.length === 0) {
        if (b.term.k === "trap") return this.trapLabel(b.term.id);
        if (b.term.k === "unreachable") return this.trapStub(0);
      }
    }
    return this.blockLabel[to]!;
  }

  emitTerm(at: number): void {
    const b = this.f.blocks[at]!;
    const t = b.term;
    switch (t.k) {
      case "br":
        this.emitEdgeJump(at, t.to);
        return;
      case "brif": {
        const tIdx = this.index.get(t.t.block)!;
        const fIdx = this.index.get(t.f.block)!;
        const tMoves = this.edgeMoves(t.t).length > 0;
        const fMoves = this.edgeMoves(t.f).length > 0;
        const cv = this.s.alias[t.cond]!;
        let branchIf: (taken: boolean, label: number) => void;
        const zero =
          this.sh?.on("fuse") === true && this.s.cmp[cv] === true ? this.zeroTest(cv) : null;
        if (zero !== null) {
          // -O1 and -O2 (D75): a test against zero is cbz or cbnz, with no compare. `eq`: true means the register is zero.
          const eq = zero.eq !== this.sh!.faults.has("b3-fuse-invert");
          const { reg: r, sf } = zero;
          branchIf = (taken, label) =>
            this.emitBranch("cbz", label, taken === eq ? E.cbz(sf, r, 0) : E.cbnz(sf, r, 0));
        } else if (this.s.cmp[cv] === true) {
          const cond = this.compare(cv);
          branchIf = (taken, label) => this.jcc(taken ? cond : invert(cond), label);
        } else {
          const k = this.rematOf(cv);
          if (k?.k === "int") {
            this.emitEdgeJump(at, k.val !== 0n ? t.t : t.f);
            return;
          }
          const reg = this.gpr(cv, X16);
          branchIf = (taken, label) => {
            if (taken) this.emitBranch("cbz", label, E.cbnz(false, reg, 0));
            else this.emitBranch("cbz", label, E.cbz(false, reg, 0));
          };
        }
        if (this.next[at] === tIdx && !tMoves) {
          branchIf(false, this.edgeLabel(t.f));
          return;
        }
        branchIf(true, this.edgeLabel(t.t));
        if (!(this.next[at] === fIdx && !fMoves)) this.emitEdgeJump(at, t.f);
        return;
      }
      case "switch": {
        const v = t.val;
        const sf = is64(this.f.types[v]!);
        const r = this.notSp(this.gpr(v, X8), X8);
        for (const k of t.cases) {
          const val = sf ? BigInt.asIntN(64, k.key) : BigInt.asIntN(32, k.key);
          if (val >= 0n && val < 4096n) {
            this.code.emit(E.arithImm("subs", sf, XZR, r, Number(val)));
          } else if (val < 0n && val > -4096n) {
            this.code.emit(E.arithImm("adds", sf, XZR, r, Number(-val)));
          } else {
            this.movImm(X17, sf ? BigInt.asUintN(64, val) : BigInt.asUintN(32, val));
            this.code.emit(E.arithReg("subs", sf, XZR, r, X17));
          }
          this.jcc(Cond.EQ, this.edgeLabel(k.to));
        }
        this.emitEdgeJump(at, t.def);
        return;
      }
      case "ret": {
        const r = assignRegs(this.f.rets);
        const moves: Move[] = [];
        t.vals.forEach((v, i) => {
          const l = r.locs[i]!;
          // A result past the registers goes to the caller's outgoing area, just above this frame.
          const dst = l >= MEM_BASE ? l + this.frame : l;
          const m = this.moveValue(dst, v);
          if (m !== null) moves.push(m);
        });
        this.parallel(moves);
        this.epilogue();
        return;
      }
      case "trap":
        this.jump(this.trapLabel(t.id));
        return;
      case "unreachable":
        this.jump(this.trapStub(0));
        return;
    }
  }

  // --- instructions

  emitInstr(ins: Instr): void {
    const c = this.code;
    const f = this.f;
    const p = ins.op.split(".");
    const base = p[0]!;
    const last = p[p.length - 1]! as TirType;
    const vals = ins.ops.flatMap((o) => (o.t === "v" ? [o.id] : []));
    const res = ins.res[0];
    const trapId = (): number => {
      for (const o of ins.ops) if (o.t === "trap") return o.id;
      throw new Error(`${ins.op}: no trap`);
    };
    switch (base) {
      case "load": {
        if (p[2] !== "na" && p[2] !== "inv") throw new Error(`no aarch64 lowering for ${ins.op}`);
        const t = p[1]! as TirType;
        const op = MEM_LOAD[t];
        const a = this.address(vals[0]!, op);
        // R7: a load standing for a null check is listed by the one instruction that can fault.
        const nullOff = this.nullLoads.get(res!);
        if (nullOff !== undefined) this.ctx.nullPcs!.push({ pc: this.code.here, off: nullOff });
        if (isFloat(t)) {
          const rd = this.fdst(res!);
          this.memAccess(op, rd, a);
          this.fcommit(res!, rd);
        } else {
          const rd = this.dst(res!);
          this.memAccess(op, rd, a);
          this.commit(res!, rd);
        }
        return;
      }
      case "store": {
        if (p[2] !== "na") throw new Error(`no aarch64 lowering for ${ins.op}`);
        const t = p[1]! as TirType;
        const op = MEM_STORE[t];
        const a = this.address(vals[0]!, op);
        const rt = isFloat(t) ? this.fpr(vals[1]!, SCRATCH_D31) : this.gpr(vals[1]!, X8);
        this.memAccess(op, rt, a);
        return;
      }
      case "gep": {
        const nums = ins.ops.flatMap((o) => (o.t === "i" ? [Number(o.val)] : []));
        const scale = nums[0]!;
        const off = nums[1]!;
        const rd = this.dst(res!);
        const idxR = this.rematOf(vals[1]!);
        if (idxR?.k === "int") {
          const total = Number(BigInt(off) + BigInt.asIntN(64, idxR.val) * BigInt(scale));
          const rb = this.gpr(vals[0]!, X16);
          if (Number.isSafeInteger(total) && Math.abs(total) < 1 << 24) {
            this.addConst(rd, rb === XZR ? this.zeroInto(X16) : rb, total);
          } else {
            this.movImm(X17, BigInt(total));
            c.emit(E.arithReg("add", true, rd, rb === XZR ? this.zeroInto(X16) : rb, X17));
          }
          this.commit(res!, rd);
          return;
        }
        const rb0 = this.gpr(vals[0]!, X16);
        const rb = rb0 === XZR ? this.zeroInto(X16) : rb0;
        const ri = this.gpr(vals[1]!, X17);
        this.addScaled(rd, rb, ri, scale);
        this.addConst(rd, rd, off);
        this.commit(res!, rd);
        return;
      }
      case "add":
      case "sub":
        if (p[1] === "chk") {
          this.checkedAddSub(base, p[2]!, last, vals, res!, trapId());
          return;
        }
        this.wrapAddSub(base, last, vals, res!);
        return;
      case "mul":
        if (p[1] === "chk") {
          this.checkedMul(p[2]!, last, vals, res!, trapId());
          return;
        }
        this.wrapMul(last, vals, res!);
        return;
      case "and":
      case "or":
      case "xor":
        this.logic(base, last, vals, res!);
        return;
      case "shl":
      case "lshr":
      case "ashr":
        this.shift(base, p[1]!, last, vals, res!);
        return;
      case "neg": {
        const rd = this.dst(res!);
        const ra = this.gpr(vals[0]!, X16);
        c.emit(E.arithReg("sub", is64(last), rd, XZR, ra));
        this.normaliseNarrow(rd, last);
        this.commit(res!, rd);
        return;
      }
      case "not": {
        const rd = this.dst(res!);
        const ra = this.gpr(vals[0]!, X16);
        c.emit(E.logicReg("orn", is64(last), rd, XZR, ra));
        this.normaliseNarrow(rd, last);
        this.commit(res!, rd);
        return;
      }
      case "sdiv":
      case "udiv":
      case "srem":
      case "urem":
        this.divide(base, last, vals, res!, trapId());
        return;
      case "range":
        this.rangeCheck(p[2]!, last, ins, vals[0]!, res!, trapId());
        return;
      case "bounds": {
        const trap = this.trapLabel(trapId());
        this.compareRegs(true, vals[0]!, vals[1]!);
        this.jcc(Cond.HS, trap);
        return;
      }
      case "ref": {
        // A reference's pointer: the low 48 bits (SPEC 3.5).
        const rd = this.dst(res!);
        c.emit(E.ubfm(true, rd, this.gpr(vals[0]!, X16), 0, 47));
        this.commit(res!, rd);
        return;
      }
      case "gen": {
        // gen.chk: the word before the object must match the reference's 16 generation bits, and a live
        // generation is odd, so anything with an even tag (a free slot's link, read stale) never passes.
        const trap = this.trapLabel(trapId());
        const rn = this.gpr(vals[0]!, X16);
        c.emit(E.shiftImm("lsr", true, X17, rn, 48));
        c.emit(E.ubfm(true, X8, rn, 0, 47));
        c.emit(E.logicImm("ands", false, E.XZR, X17, E.bitmask(1n, false)!));
        this.jcc(Cond.EQ, trap);
        c.emit(E.memImm("ldrw", X16, X8, -8));
        c.emit(E.logicReg("eor", false, X16, X16, X17));
        c.emit(E.logicImm("ands", false, E.XZR, X16, E.bitmask(0xffffn, false)!));
        this.jcc(Cond.NE, trap);
        const rd = this.dst(res!);
        c.emit(E.logicReg("orr", true, rd, E.XZR, X8));
        this.commit(res!, rd);
        return;
      }
      case "fadd":
      case "fsub":
      case "fmul":
      case "fdiv": {
        const d = last === "f64";
        const rd = this.fdst(res!);
        const ra = this.fpr(vals[0]!, SCRATCH_D30);
        const rb = this.fpr(vals[1]!, SCRATCH_D29);
        c.emit(E.fbin(base as E.FBin, d, rd, ra, rb));
        this.fcommit(res!, rd);
        return;
      }
      case "fmin":
      case "fmax": {
        // FMIN and FMAX match JS: either NaN gives NaN, and -0 is below +0.
        const d = last === "f64";
        const rd = this.fdst(res!);
        const ra = this.fpr(vals[0]!, SCRATCH_D30);
        const rb = this.fpr(vals[1]!, SCRATCH_D29);
        c.emit(E.fbin(base as E.FBin, d, rd, ra, rb));
        this.fcommit(res!, rd);
        return;
      }
      case "frem": {
        if (last !== "f64") throw new Error("frem.f32 has no helper");
        this.callSymbol("f:__frem.f64", vals, ins.res);
        return;
      }
      case "fneg":
      case "fabs":
      case "fsqrt":
      case "ffloor":
      case "fceil":
      case "ftrunc":
      case "fnearest": {
        const ops: Record<string, E.FUn> = {
          fneg: "fneg",
          fabs: "fabs",
          fsqrt: "fsqrt",
          ffloor: "frintm",
          fceil: "frintp",
          ftrunc: "frintz",
          fnearest: "frintn",
        };
        const rd = this.fdst(res!);
        const ra = this.fpr(vals[0]!, SCRATCH_D30);
        c.emit(E.fun(ops[base]!, last === "f64", rd, ra));
        this.fcommit(res!, rd);
        return;
      }
      case "fcopysign": {
        const d = last === "f64";
        const ra = this.fpr(vals[0]!, SCRATCH_D30);
        const rb = this.fpr(vals[1]!, SCRATCH_D29);
        c.emit(E.fmovToGp(d, X16, ra));
        c.emit(E.fmovToGp(d, X17, rb));
        const w = d ? 64 : 32;
        c.emit(E.shiftImm("lsr", d, X17, X17, w - 1));
        c.emit(E.bfm(d, X16, X17, 1, 0));
        const rd = this.fdst(res!);
        c.emit(E.fmovFromGp(d, rd, X16));
        this.fcommit(res!, rd);
        return;
      }
      case "icmp":
      case "fcmp": {
        const cond = this.compareInstr(ins);
        const rd = this.dst(res!);
        c.emit(E.cset(false, rd, cond));
        this.commit(res!, rd);
        return;
      }
      case "zext":
      case "sext":
      case "trunc":
        this.intConvert(base, f.types[vals[0]!]!, last, vals[0]!, res!);
        return;
      case "fpromote": {
        const rd = this.fdst(res!);
        c.emit(E.fcvtStoD(rd, this.fpr(vals[0]!, SCRATCH_D30)));
        this.fcommit(res!, rd);
        return;
      }
      case "fdemote": {
        const rd = this.fdst(res!);
        c.emit(E.fcvtDtoS(rd, this.fpr(vals[0]!, SCRATCH_D30)));
        this.fcommit(res!, rd);
        return;
      }
      case "sitofp":
      case "uitofp": {
        const from = f.types[vals[0]!]!;
        if (from === "i8" || from === "i16") throw new Error(`${ins.op} from ${from}`);
        const rd = this.fdst(res!);
        const ra = this.gpr(vals[0]!, X16);
        c.emit(E.intToFloat(base === "sitofp", is64(from), last === "f64", rd, ra));
        this.fcommit(res!, rd);
        return;
      }
      case "fptosi":
      case "fptoui": {
        if (last === "i8" || last === "i16") throw new Error(`no aarch64 lowering for ${ins.op}`);
        const from = f.types[vals[0]!]!;
        const rd = this.dst(res!);
        const ra = this.fpr(vals[0]!, SCRATCH_D30);
        c.emit(E.floatToInt(base === "fptosi", is64(last), from === "f64", rd, ra));
        this.commit(res!, rd);
        return;
      }
      case "js":
        this.toInt32(vals[0]!, res!);
        return;
      case "bitcast": {
        const from = f.types[vals[0]!]!;
        if (isFloat(from) && !isFloat(last)) {
          const rd = this.dst(res!);
          c.emit(E.fmovToGp(from === "f64", rd, this.fpr(vals[0]!, SCRATCH_D30)));
          this.commit(res!, rd);
        } else if (!isFloat(from) && isFloat(last)) {
          const rd = this.fdst(res!);
          c.emit(E.fmovFromGp(last === "f64", rd, this.gpr(vals[0]!, X16)));
          this.fcommit(res!, rd);
        } else throw new Error(`bitcast from ${from} to ${last}`);
        return;
      }
      case "select":
        this.selectValue(vals, last, res!);
        return;
      case "alloca": {
        const rd = this.dst(res!);
        this.addSpConst(rd, this.allocaOff.get(ins)!);
        this.commit(res!, rd);
        return;
      }
      case "globaladdr":
      case "funcaddr":
      case "iconst":
      case "fconst":
        // A constant the selection kept: only reached if a rename's types forced it.
        throw new Error(`@${f.name}: ${ins.op} wasn't folded`);
      case "call": {
        if (ins.op === "call") {
          const callee = ins.ops[0];
          if (callee?.t !== "sym") throw new Error("bad call");
          this.callSymbol(`f:${callee.name}`, vals, ins.res);
        } else {
          this.callIndirect(vals, ins.res);
        }
        return;
      }
      case "intrinsic":
        this.intrinsic(ins, vals);
        return;
      default:
        throw new Error(`no aarch64 lowering for ${ins.op}`);
    }
  }

  zeroInto(r: number): number {
    this.code.emit(E.movz(true, r, 0));
    return r;
  }

  addSpConst(rd: number, k: number): void {
    const c = this.code;
    if (k < 4096) c.emit(E.arithImm("add", true, rd, E.SP, k));
    else {
      c.emit(E.arithImm("add", true, rd, E.SP, k >>> 12, true));
      if ((k & 4095) !== 0) c.emit(E.arithImm("add", true, rd, rd, k & 4095));
    }
  }

  normaliseNarrow(rd: number, t: TirType): void {
    if (t === "i8") this.code.emit(E.logicImm("and", false, rd, rd, E.bitmask(0xffn, false)!));
    else if (t === "i16")
      this.code.emit(E.logicImm("and", false, rd, rd, E.bitmask(0xffffn, false)!));
  }

  wrapAddSub(base: "add" | "sub", t: TirType, vals: number[], res: number): void {
    const c = this.code;
    const sf = is64(t);
    const rd = this.dst(res);
    const k = this.smallImm(vals[1]!, sf);
    if (k !== null) {
      const ra = this.gpr(vals[0]!, X16);
      const neg = k < 0;
      const op = (base === "add") !== neg ? "add" : "sub";
      c.emit(E.arithImm(op, sf, rd, ra === XZR ? this.zeroInto(X16) : ra, Math.abs(k)));
    } else {
      const ra = this.gpr(vals[0]!, X16);
      const rb = this.gpr(vals[1]!, X17);
      c.emit(E.arithReg(base, sf, rd, ra, rb));
    }
    this.normaliseNarrow(rd, t);
    this.commit(res, rd);
  }

  /** A constant operand that fits add/sub's imm12, as a signed number, or null. */
  smallImm(v: number, sf: boolean): number | null {
    const r = this.rematOf(v);
    if (r?.k !== "int") return null;
    const k = sf ? BigInt.asIntN(64, r.val) : BigInt.asIntN(32, r.val);
    return k > -4096n && k < 4096n ? Number(k) : null;
  }

  wrapMul(t: TirType, vals: number[], res: number): void {
    const c = this.code;
    const sf = is64(t);
    const rd = this.dst(res);
    const r = this.rematOf(vals[1]!);
    if (r?.k === "int" && r.val !== 0n && (r.val & (r.val - 1n)) === 0n && r.val < 1n << 31n) {
      const ra = this.gpr(vals[0]!, X16);
      c.emit(E.shiftImm("lsl", sf, rd, ra, r.val.toString(2).length - 1));
    } else {
      const ra = this.gpr(vals[0]!, X16);
      const rb = this.gpr(vals[1]!, X17);
      c.emit(E.madd(sf, rd, ra, rb, XZR));
    }
    this.normaliseNarrow(rd, t);
    this.commit(res, rd);
  }

  logic(base: "and" | "or" | "xor", t: TirType, vals: number[], res: number): void {
    const c = this.code;
    const sf = is64(t);
    const ops = { and: "and", or: "orr", xor: "eor" } as const;
    const op = ops[base];
    const rd = this.dst(res);
    let a = vals[0]!;
    let b = vals[1]!;
    if (this.rematOf(a)?.k === "int" && this.rematOf(b)?.k !== "int") {
      const x = a;
      a = b;
      b = x;
    }
    const r = this.rematOf(b);
    const mask = r?.k === "int" ? E.bitmask(r.val, sf) : null;
    if (mask !== null) {
      c.emit(E.logicImm(op, sf, rd, this.gpr(a, X16), mask));
    } else {
      const ra = this.gpr(a, X16);
      const rb = this.gpr(b, X17);
      c.emit(E.logicReg(op, sf, rd, ra, rb));
    }
    this.commit(res, rd);
  }

  shift(
    base: "shl" | "lshr" | "ashr",
    mode: string,
    t: TirType,
    vals: number[],
    res: number,
  ): void {
    const c = this.code;
    const ops = { shl: "lsl", lshr: "lsr", ashr: "asr" } as const;
    const op = ops[base];
    if (mode === "big") {
      // A count of 64 or more is defined: 0, or the sign for ashr. x16, x17 and x8 hold the work, so
      // the result can share a register with an operand.
      const rv = this.gpr(vals[0]!, X16);
      const rc = this.gpr(vals[1]!, X17);
      c.emit(E.shiftReg(op, true, X8, rv, rc));
      c.emit(E.arithImm("subs", true, XZR, rc, 64));
      if (base === "ashr") {
        const sign = rv === X16 ? X17 : X16;
        c.emit(E.shiftImm("asr", true, sign, rv, 63));
        c.emit(E.csel(true, X8, sign, X8, Cond.HS));
      } else c.emit(E.csel(true, X8, XZR, X8, Cond.HS));
      this.commit(res, X8);
      return;
    }
    const sf = t === "i64" || t === "ix" || t === "ptr";
    const rd = this.dst(res);
    const r = this.rematOf(vals[1]!);
    if (r?.k === "int") {
      const w = sf ? 64 : 32;
      const s = Number(BigInt.asUintN(32, r.val) % BigInt(w));
      c.emit(E.shiftImm(op, sf, rd, this.gpr(vals[0]!, X16), s));
    } else {
      const ra = this.gpr(vals[0]!, X16);
      const rb = this.gpr(vals[1]!, X17);
      c.emit(E.shiftReg(op, sf, rd, ra, rb));
    }
    this.commit(res, rd);
  }

  checkedAddSub(
    base: "add" | "sub",
    sign: string,
    t: TirType,
    vals: number[],
    res: number,
    trapId: number,
  ): void {
    const c = this.code;
    const sf = is64(t);
    const trap = this.trapLabel(trapId);
    if (t === "i8" || t === "i16") throw new Error(`no aarch64 lowering for checked ${t}`);
    const op = base === "add" ? "adds" : "subs";
    const rd = this.dst(res);
    const k = this.smallImm(vals[1]!, sf);
    const ra0 = this.gpr(vals[0]!, X16);
    const ra = ra0 === XZR ? this.zeroInto(X16) : ra0;
    if (k !== null && k >= 0) {
      c.emit(E.arithImm(op, sf, rd, ra, k));
    } else {
      const rb = this.gpr(vals[1]!, X17);
      c.emit(E.arithReg(op, sf, rd, ra, rb));
    }
    if (sign === "s") this.jcc(Cond.VS, trap);
    else this.jcc(base === "add" ? Cond.HS : Cond.LO, trap);
    if (t === "ix") {
      if (sign === "s") throw new Error("no aarch64 lowering for checked signed ix");
      // SPEC 4.3: checked ix arithmetic traps at 2^53 on a 64-bit target.
      c.emit(E.shiftImm("lsr", true, X17, rd, 53));
      this.emitBranch("cbz", trap, E.cbnz(true, X17, 0));
    }
    this.commit(res, rd);
  }

  checkedMul(sign: string, t: TirType, vals: number[], res: number, trapId: number): void {
    const c = this.code;
    const trap = this.trapLabel(trapId);
    const ra = this.gpr(vals[0]!, X16);
    const rb = this.gpr(vals[1]!, X17);
    if (t === "i32") {
      // The product in 64 bits, in x8 so a result register can share with an operand.
      c.emit(sign === "s" ? E.smull(X8, ra, rb) : E.umull(X8, ra, rb));
      if (sign === "s") {
        c.emit(E.arithExt("subs", true, XZR, X8, X8, 6)); // cmp x8, w8, sxtw
        this.jcc(Cond.NE, trap);
      } else {
        c.emit(E.shiftImm("lsr", true, X16, X8, 32));
        this.emitBranch("cbz", trap, E.cbnz(true, X16, 0));
      }
      c.emit(E.logicReg("orr", false, X8, XZR, X8)); // zero-extend
      this.commit(res, X8);
      return;
    }
    if (t === "i64" || t === "ix") {
      if (t === "ix" && sign === "s") throw new Error("no aarch64 lowering for checked signed ix");
      // x8 takes the low part, and only then may a scratch operand be overwritten.
      c.emit(E.madd(true, X8, ra, rb, XZR));
      if (sign === "s") {
        c.emit(E.smulh(X16, ra, rb));
        c.emit(E.arithReg("subs", true, XZR, X16, X8, 2, 63));
        this.jcc(Cond.NE, trap);
      } else {
        c.emit(E.umulh(X16, ra, rb));
        this.emitBranch("cbz", trap, E.cbnz(true, X16, 0));
      }
      if (t === "ix") {
        c.emit(E.shiftImm("lsr", true, X16, X8, 53));
        this.emitBranch("cbz", trap, E.cbnz(true, X16, 0));
      }
      this.commit(res, X8);
      return;
    }
    throw new Error(`no aarch64 lowering for checked mul ${t}`);
  }

  divide(base: string, t: TirType, vals: number[], res: number, trapId: number): void {
    const c = this.code;
    const sf = is64(t);
    if (t === "i8" || t === "i16") throw new Error(`no aarch64 lowering for ${base}.${t}`);
    const trap = this.trapLabel(trapId);
    const ra = this.gpr(vals[0]!, X16);
    const rb0 = this.gpr(vals[1]!, X17);
    if (rb0 === XZR) {
      this.jump(trap);
      return;
    }
    const rb = rb0;
    this.emitBranch("cbz", trap, E.cbz(sf, rb, 0));
    const signed = base === "sdiv" || base === "srem";
    if (base === "sdiv") {
      // MIN / -1 overflows. NEGS sets V on exactly MIN.
      const skip = this.newLabel();
      c.emit(E.arithImm("adds", sf, XZR, rb, 1));
      this.jcc(Cond.NE, skip);
      c.emit(E.arithReg("subs", sf, XZR, XZR, ra));
      this.jcc(Cond.VS, trap);
      this.bind(skip);
    }
    const rd = this.dst(res);
    if (base === "sdiv" || base === "udiv") {
      c.emit(signed ? E.sdiv(sf, rd, ra, rb) : E.udiv(sf, rd, ra, rb));
    } else {
      // On this target MIN / -1 gives MIN, and the multiply-back then gives 0, as JS's % requires.
      c.emit(signed ? E.sdiv(sf, X8, ra, rb) : E.udiv(sf, X8, ra, rb));
      c.emit(E.msub(sf, rd, X8, rb, ra));
    }
    this.commit(res, rd);
  }

  rangeCheck(sign: string, t: TirType, ins: Instr, v: number, res: number, trapId: number): void {
    const c = this.code;
    const sf = is64(t);
    const trap = this.trapLabel(trapId);
    const nums = ins.ops.filter((o) => o.t === "i" || o.t === "ixmax");
    const IXMAX = (1n << 53n) - 1n;
    const asInt = (o: (typeof nums)[number]): bigint => (o.t === "i" ? o.val : IXMAX);
    const lo = asInt(nums[0]!);
    const hi = asInt(nums[1]!);
    const ra0 = this.gpr(v, X16);
    const ra = ra0 === XZR ? this.zeroInto(X16) : ra0;
    const check = (limit: bigint, cond: Cond): void => {
      const k = sf ? BigInt.asIntN(64, limit) : BigInt.asIntN(32, limit);
      if (k >= 0n && k < 4096n) c.emit(E.arithImm("subs", sf, XZR, ra, Number(k)));
      else if (k < 0n && k > -4096n) c.emit(E.arithImm("adds", sf, XZR, ra, Number(-k)));
      else {
        this.movImm(X17, sf ? BigInt.asUintN(64, limit) : BigInt.asUintN(32, limit));
        c.emit(E.arithReg("subs", sf, XZR, ra, X17));
      }
      this.jcc(cond, trap);
    };
    const skipLo = sign === "u" && lo === 0n;
    const width = sf ? 64 : 32;
    const skipHi = sign === "u" && hi >= (1n << BigInt(width)) - 1n;
    if (!skipLo) check(lo, sign === "s" ? Cond.LT : Cond.LO);
    if (!skipHi) check(hi, sign === "s" ? Cond.GT : Cond.HI);
    const rd = this.dst(res);
    if (rd !== ra) c.emit(E.logicReg("orr", sf, rd, XZR, ra));
    this.commit(res, rd);
  }

  intConvert(kind: string, from: TirType, to: TirType, v: number, res: number): void {
    const c = this.code;
    const rd = this.dst(res);
    if (kind === "trunc") {
      const ra = this.gpr(v, X16);
      if (to === "i8" || to === "i16") {
        c.emit(E.logicImm("and", false, rd, ra, E.bitmask(to === "i8" ? 0xffn : 0xffffn, false)!));
      } else if (to === "i32") c.emit(E.logicReg("orr", false, rd, XZR, ra));
      else throw new Error(`trunc from ${from} to ${to}`);
    } else if (kind === "zext") {
      // Only reached where selection kept it: a narrowing dressed as a widening is a bug upstream.
      throw new Error(`zext from ${from} to ${to}`);
    } else {
      const ra = this.gpr(v, X16);
      const sf = is64(to);
      if (from === "i8") c.emit(E.sbfm(sf, rd, ra, 0, 7));
      else if (from === "i16") c.emit(E.sbfm(sf, rd, ra, 0, 15));
      else if (from === "i32" && sf) c.emit(E.sbfm(true, rd, ra, 0, 31));
      else throw new Error(`sext from ${from} to ${to}`);
      if (to === "i8" || to === "i16") this.normaliseNarrow(rd, to);
    }
    this.commit(res, rd);
  }

  selectValue(vals: number[], t: TirType, res: number): void {
    const c = this.code;
    const cv = this.s.alias[vals[0]!]!;
    let cond: Cond;
    if (this.s.cmp[cv] === true) cond = this.compare(cv);
    else {
      const k = this.rematOf(cv);
      if (k?.k === "int") {
        // A constant condition: flags set so EQ holds, and pick by that.
        c.emit(E.logicReg("ands", false, XZR, XZR, XZR));
        cond = k.val !== 0n ? Cond.EQ : Cond.NE;
      } else {
        const rc = this.gpr(cv, X16);
        c.emit(E.arithImm("subs", false, XZR, rc, 0));
        cond = Cond.NE;
      }
    }
    if (isFloat(t)) {
      const d = t === "f64";
      const rd = this.fdst(res);
      const ra = this.fpr(vals[1]!, SCRATCH_D30);
      const rb = this.fpr(vals[2]!, SCRATCH_D29);
      c.emit(E.fcsel(d, rd, ra, rb, cond));
      this.fcommit(res, rd);
      return;
    }
    const sf = is64(t);
    const rd = this.dst(res);
    const ra = this.gprNoFlags(vals[1]!, X16);
    const rb = this.gprNoFlags(vals[2]!, X17);
    c.emit(E.csel(sf, rd, ra, rb, cond));
    this.commit(res, rd);
  }

  /** As gpr: constants and symbols are built with moves, which leave the flags alone. */
  gprNoFlags(v: number, scratch: number): number {
    return this.gpr(v, scratch);
  }

  toInt32(v: number, res: number): void {
    const c = this.code;
    const ra = this.fpr(v, SCRATCH_D30);
    const slow = this.newLabel();
    const join = this.newLabel();
    // Below 2^63 the low 32 bits of a truncation are ToInt32 exactly. Saturation means it wasn't.
    c.emit(E.floatToInt(true, true, true, X16, ra));
    c.emit(E.arithImm("adds", true, XZR, X16, 1));
    this.jcc(Cond.VS, slow);
    c.emit(E.arithImm("subs", true, XZR, X16, 1));
    this.jcc(Cond.VS, slow);
    this.bind(join);
    const rd = this.dst(res);
    c.emit(E.logicReg("orr", false, rd, XZR, X16));
    this.commit(res, rd);
    this.deferred.push(() => {
      this.bind(slow);
      c.emit(E.fmovToGp(true, X16, ra));
      this.emitBranch("adr", join, E.adr(X17, 0));
      c.fix("b26", "f:__rt_toint32");
    });
  }

  // --- calls

  argMoves(types: TirType[], vals: number[]): Move[] {
    const a = assignRegs(types);
    const moves: Move[] = [];
    vals.forEach((v, i) => {
      const l = a.locs[i]!;
      const m = this.moveValue(l, v);
      if (m !== null) moves.push(m);
    });
    return moves;
  }

  resultMoves(res: number[]): void {
    const r = assignRegs(res.map((v) => this.f.types[v]!));
    const moves: Move[] = [];
    res.forEach((v, i) => {
      const l = this.a.loc[v]!;
      if (l === NONE) return;
      const src = r.locs[i]!;
      if (src !== l) moves.push({ dst: l, src: { k: "loc", loc: src } });
    });
    this.parallel(moves);
  }

  callSymbol(sym: string, vals: number[], res: number[]): void {
    this.parallel(
      this.argMoves(
        vals.map((v) => this.f.types[v]!),
        vals,
      ),
    );
    this.code.fix("bl26", sym);
    this.resultMoves(res);
  }

  callIndirect(vals: number[], res: number[]): void {
    const args = vals.slice(1);
    const moves = this.argMoves(
      args.map((v) => this.f.types[v]!),
      args,
    );
    const target = this.moveValue(X8, vals[0]!);
    if (target !== null) moves.push(target);
    this.parallel(moves);
    this.code.emit(E.blr(X8));
    this.resultMoves(res);
  }

  intrinsic(ins: Instr, vals: number[]): void {
    const c = this.code;
    const n = ins.ops[0];
    if (n?.t !== "name") throw new Error("bad intrinsic");
    const res = ins.res[0];
    switch (n.name) {
      case "clz32": {
        const rd = this.dst(res!);
        c.emit(E.clz(false, rd, this.gpr(vals[0]!, X16)));
        this.commit(res!, rd);
        return;
      }
      case "trap.code":
        this.callSymbol("f:__rt_trap", vals, []);
        return;
      case "mem.base": {
        const rd = this.dst(res!);
        this.symAddr(X16, { k: "global", name: "__mem_base" });
        c.emit(E.memImm("ldrx", rd, X16, 0));
        this.commit(res!, rd);
        return;
      }
      case "mem.ensure": {
        const trap = this.trapStub(14);
        const rp = this.gpr(vals[0]!, X17);
        this.symAddr(X16, { k: "global", name: "__mem_limit" });
        c.emit(E.memImm("ldrx", X16, X16, 0));
        c.emit(E.arithReg("subs", true, XZR, rp, X16));
        this.jcc(Cond.HI, trap);
        return;
      }
      case "mem.fill": {
        // R18: a fill with zero of a constant size, a multiple of 4 up to 64 bytes (a stack object cleared before its
        // constructor, where scalar replacement couldn't take it), is stores of the zero register, 8 bytes each and the last
        // 4; anything else calls the runtime's, whose loop is a byte at a time.
        const z = this.s.remat[this.s.alias[vals[1]!]!];
        const n = this.s.remat[this.s.alias[vals[2]!]!];
        const size = n?.k === "int" ? Number(n.val) : -1;
        if (z?.k === "int" && z.val === 0n && size > 0 && size <= 64 && size % 4 === 0) {
          const rd = this.gpr(vals[0]!, X16);
          let off = 0;
          for (; off + 8 <= size; off += 8) c.emit(E.memImm("strx", XZR, rd, off));
          if (off < size) c.emit(E.memImm("strw", XZR, rd, off));
          return;
        }
        this.callSymbol("f:__rt_memset", vals, []);
        return;
      }
      case "mem.copy": {
        // A small copy of a constant size, a multiple of 8 up to 48 bytes (an object placed in its slot, R1b), is loads into
        // scratch registers and then stores, all loads first, so it's a memmove for overlapping bytes too. Anything else
        // calls the runtime's.
        const n = this.s.remat[this.s.alias[vals[2]!]!];
        const size = n?.k === "int" ? Number(n.val) : -1;
        // R4: and one of 4 bytes more than a multiple of 8, up to 44 (an object of an i32 field or three, as a lowered
        // `rc` program's make places it), its last 4 bytes through a float register's low word.
        const odd = size % 8 === 4 && size <= 44;
        if (
          size > 0 &&
          size <= 48 &&
          (size % 8 === 0 || odd) &&
          process.env.TMK_TEST_TSL !== "copy-call"
        ) {
          const rd = this.gpr(vals[0]!, X16);
          const rs = this.gpr(vals[1]!, X17);
          const parts: { op: "q" | "x" | "s"; off: number; reg: number }[] = [];
          let off = 0;
          for (const q of odd
            ? [SCRATCH_D29, SCRATCH_D30]
            : [SCRATCH_D29, SCRATCH_D30, SCRATCH_D31]) {
            if (size - off < 16) break;
            parts.push({ op: "q", off, reg: q });
            off += 16;
          }
          if (size - off >= 8) {
            parts.push({ op: "x", off, reg: X8 });
            off += 8;
          }
          // `tmk milestone opt-a`'s injected bug (R4): the last 4 bytes of such a copy left out. Never set otherwise.
          if (odd && process.env.TMK_TEST_TSL !== "copy-odd-short")
            parts.push({ op: "s", off, reg: SCRATCH_D31 });
          const ld = { q: "ldrq", x: "ldrx", s: "ldrs" } as const;
          const st = { q: "strq", x: "strx", s: "strs" } as const;
          for (const p of parts) c.emit(E.memImm(ld[p.op], p.reg, rs, p.off));
          for (const p of parts) c.emit(E.memImm(st[p.op], p.reg, rd, p.off));
          return;
        }
        this.callSymbol("f:__rt_memmove", vals, []);
        return;
      }
      case "native.fma": {
        const rn = this.fpr(vals[0]!, SCRATCH_D29);
        const rm = this.fpr(vals[1]!, SCRATCH_D30);
        const ra = this.fpr(vals[2]!, SCRATCH_D31);
        const rd = this.fdst(res!);
        c.emit(E.fmadd(true, rd, rn, rm, ra));
        this.fcommit(res!, rd);
        return;
      }
      case "native.putc": {
        const rv = this.gpr(vals[0]!, X16);
        if (this.ctx.hosted === true) {
          // The hosted runtime's __rt_putc: the byte in x16, the return address in x17, and nothing else changes (hosted.ts).
          if (rv !== X16) c.emit(E.logicReg("orr", true, X16, XZR, rv));
          c.emit(E.adr(X17, 8));
          c.fix("b26", "f:__rt_putc");
          return;
        }
        this.movImm(X17, 0x09000000n);
        c.emit(E.memImm("strw", rv, X17, 0));
        return;
      }
      case "native.counter": {
        const rd = this.dst(res!);
        c.emit(E.ISB);
        c.emit(E.mrs(rd, E.CNTVCT_EL0));
        this.commit(res!, rd);
        return;
      }
      case "native.sp": {
        const rd = this.dst(res!);
        c.emit(E.arithImm("add", true, rd, E.SP, 0));
        this.commit(res!, rd);
        return;
      }
      case "native.frequency": {
        const rd = this.dst(res!);
        c.emit(E.mrs(rd, E.CNTFRQ_EL0));
        this.commit(res!, rd);
        return;
      }
      case "native.off":
        c.fix("b26", "f:__rt_off");
        return;
      case "native.try":
        this.callSymbol("f:__rt_try", vals, ins.res);
        return;
      case "native.unwind":
        c.fix("b26", "f:__rt_unwind");
        return;
      default:
        if (n.name.startsWith("math.")) {
          this.callSymbol(`f:${mathSymbol(n.name)}`, vals, ins.res);
          return;
        }
        throw new Error(`no aarch64 lowering for intrinsic ${n.name}`);
    }
  }

  // --- the function

  run(): void {
    const c = this.code;
    const f = this.f;
    this.computeFrame();
    const from = c.here;
    c.define(`f:${f.name}`);
    this.prologue();
    // Incoming arguments, as one parallel move from the convention's places.
    const params = assignRegs(f.params.map((p) => f.types[p]!));
    const entry: Move[] = [];
    f.params.forEach((p, i) => {
      const l = this.a.loc[p]!;
      if (l === NONE) return;
      const src = params.locs[i]!;
      // A stack argument sits in the caller's outgoing area, above this whole frame.
      const fromLoc = src >= MEM_BASE ? src + this.frame : src;
      if (fromLoc !== l) entry.push({ dst: l, src: { k: "loc", loc: fromLoc } });
    });
    this.parallel(entry);
    this.order =
      this.sh?.on("layout") === true ? layoutBlocks(f, this.sh.faults) : f.blocks.map((_, i) => i);
    this.next = new Int32Array(f.blocks.length).fill(-1);
    for (let i = 0; i + 1 < this.order.length; i++) this.next[this.order[i]!] = this.order[i + 1]!;
    for (const at of this.order) {
      const b = f.blocks[at]!;
      this.bind(this.blockLabel[at]!);
      for (const ins of b.instrs) {
        if (!skipInstr(this.s, ins)) this.emitInstr(ins);
      }
      this.emitTerm(at);
    }
    // Out-of-line pieces can add more of themselves, so this is a worklist.
    for (let i = 0; i < this.deferred.length; i++) this.deferred[i]!();
    for (const [code, label] of this.trapStubs) {
      this.bind(label);
      this.movImm(0, BigInt(code));
      c.fix("bl26", "f:__rt_trap");
    }
    const codeEnd = c.here;
    c.ranges.push({ name: f.name, from, to: codeEnd });
    if (this.constPool.size > 0) {
      if (c.here % 2 === 1) c.emit(0);
      for (const [key, label] of this.constPool) {
        this.bind(label);
        const bits = BigInt(`0x${key.slice(1)}`);
        c.emit(Number(bits & 0xffffffffn));
        c.emit(Number((bits >> 32n) & 0xffffffffn));
      }
    }
    this.resolve();
    this.ctx.stats.spilledValues += this.a.spillSlots;
    this.ctx.stats.frames++;
  }

  resolve(): void {
    const w = this.code.words;
    for (const fix of this.labelFixes) {
      const to = this.labels[fix.label]!;
      if (to < 0) throw new Error(`@${this.f.name}: unbound label`);
      const bytes = (to - fix.at) * 4;
      const old = w[fix.at]!;
      switch (fix.kind) {
        case "b":
          w[fix.at] = E.b(bytes);
          break;
        case "bcond":
          w[fix.at] = E.bcond(old & 15, bytes);
          break;
        case "cbz": {
          // cbz and cbnz keep everything but the offset, which sits in bits 5 to 23.
          const probe = E.cbz(false, 0, bytes) & 0x00ffffe0;
          w[fix.at] = ((old & 0xff00001f) | probe) >>> 0;
          break;
        }
        case "lit": {
          const probe = E.memLit("ldrd", 0, bytes) & 0x00ffffe0;
          w[fix.at] = ((old & 0xff00001f) | probe) >>> 0;
          break;
        }
        case "adr":
          w[fix.at] = E.adr(old & 31, bytes);
          break;
      }
    }
  }
}

export function emitFunction(f: Func, ctx: EmitContext): void {
  new FuncEmit(f, ctx).run();
}
