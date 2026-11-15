// A64 instruction encodings, written from the Arm ARM's encoding tables (SPEC 4.4). Every function is
// pure and returns one 32-bit word. `sf` selects the 64-bit form. Registers are numbers 0 to 31, and
// 31 means XZR or SP as the instruction defines it. decode.ts checks this file from the other side,
// and tools/encoder-check.ts checks both against llvm-objdump and llvm-mc.

export const XZR = 31;
export const SP = 31;

export const Cond = {
  EQ: 0,
  NE: 1,
  HS: 2,
  LO: 3,
  MI: 4,
  PL: 5,
  VS: 6,
  VC: 7,
  HI: 8,
  LS: 9,
  GE: 10,
  LT: 11,
  GT: 12,
  LE: 13,
  AL: 14,
} as const;
export type Cond = number;

export function invert(c: Cond): Cond {
  return c ^ 1;
}

const sfBit = (sf: boolean): number => (sf ? 0x80000000 : 0);
const u32 = (x: number): number => x >>> 0;

function checkRange(v: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} out of range: ${v}`);
}

// --- add, subtract and logical

export type ArithOp = "add" | "sub" | "adds" | "subs";
const ARITH_REG: Record<ArithOp, number> = {
  add: 0x0b000000,
  sub: 0x4b000000,
  adds: 0x2b000000,
  subs: 0x6b000000,
};

/** add/sub with a shifted register. kind: 0 LSL, 1 LSR, 2 ASR. */
export function arithReg(
  op: ArithOp,
  sf: boolean,
  rd: number,
  rn: number,
  rm: number,
  kind = 0,
  amount = 0,
): number {
  checkRange(amount, 0, sf ? 63 : 31, "shift amount");
  return u32(
    ARITH_REG[op] + sfBit(sf) + (kind << 22) + (rm << 16) + (amount << 10) + (rn << 5) + rd,
  );
}

const ARITH_IMM: Record<ArithOp, number> = {
  add: 0x11000000,
  sub: 0x51000000,
  adds: 0x31000000,
  subs: 0x71000000,
};

/** add/sub with imm12, optionally shifted left by 12. rn and, for add/sub, rd may be SP. */
export function arithImm(
  op: ArithOp,
  sf: boolean,
  rd: number,
  rn: number,
  imm12: number,
  lsl12 = false,
): number {
  checkRange(imm12, 0, 4095, "imm12");
  return u32(ARITH_IMM[op] + sfBit(sf) + ((lsl12 ? 1 : 0) << 22) + (imm12 << 10) + (rn << 5) + rd);
}

/** add/sub with an extended register: option 3 is UXTX (LSL), 2 UXTW, 6 SXTW, 7 SXTX. */
export function arithExt(
  op: ArithOp,
  sf: boolean,
  rd: number,
  rn: number,
  rm: number,
  option: number,
  amount = 0,
): number {
  return u32(
    ARITH_REG[op] +
      sfBit(sf) +
      0x00200000 +
      (rm << 16) +
      (option << 13) +
      (amount << 10) +
      (rn << 5) +
      rd,
  );
}

export type LogicOp = "and" | "orr" | "eor" | "ands" | "bic" | "orn";
const LOGIC_REG: Record<LogicOp, number> = {
  and: 0x0a000000,
  orr: 0x2a000000,
  eor: 0x4a000000,
  ands: 0x6a000000,
  bic: 0x0a200000,
  orn: 0x2a200000,
};

export function logicReg(
  op: LogicOp,
  sf: boolean,
  rd: number,
  rn: number,
  rm: number,
  kind = 0,
  amount = 0,
): number {
  return u32(
    LOGIC_REG[op] + sfBit(sf) + (kind << 22) + (rm << 16) + (amount << 10) + (rn << 5) + rd,
  );
}

const LOGIC_IMM: Record<"and" | "orr" | "eor" | "ands", number> = {
  and: 0x12000000,
  orr: 0x32000000,
  eor: 0x52000000,
  ands: 0x72000000,
};

export function logicImm(
  op: "and" | "orr" | "eor" | "ands",
  sf: boolean,
  rd: number,
  rn: number,
  mask: { n: number; immr: number; imms: number },
): number {
  return u32(
    LOGIC_IMM[op] +
      sfBit(sf) +
      (mask.n << 22) +
      (mask.immr << 16) +
      (mask.imms << 10) +
      (rn << 5) +
      rd,
  );
}

/**
 * The bitmask-immediate encoding of `value`, or null if it has none: a run of ones, rotated, repeated
 * across the register in an element of 2, 4, 8, 16, 32 or 64 bits.
 */
export function bitmask(
  value: bigint,
  sf: boolean,
): { n: number; immr: number; imms: number } | null {
  const width = sf ? 64 : 32;
  const all = (1n << BigInt(width)) - 1n;
  let v = value & all;
  if (v === 0n || v === all) return null;
  if (!sf) v |= v << 32n; // treat a 32-bit value as its 64-bit repetition
  for (let size = 2; size <= 64; size *= 2) {
    const big = BigInt(size);
    const emask = size === 64 ? (1n << 64n) - 1n : (1n << big) - 1n;
    const e = v & emask;
    let repeats = true;
    for (let at = size; at < 64; at += size) {
      if (((v >> BigInt(at)) & emask) !== e) {
        repeats = false;
        break;
      }
    }
    if (!repeats) continue;
    // e must be one run of ones when read as a ring. Find a rotation that puts it at the bottom.
    let ones = 0;
    for (let i = 0; i < size; i++) if (((e >> BigInt(i)) & 1n) === 1n) ones++;
    if (ones === 0 || ones === size) continue;
    const run = (1n << BigInt(ones)) - 1n;
    for (let r = 0; r < size; r++) {
      const ur = BigInt(r);
      // Rotating `run` right by r gives e.
      const rotated = r === 0 ? run : ((run >> ur) | (run << (big - ur))) & emask;
      if (rotated === e) {
        const n = size === 64 ? 1 : 0;
        const imms = ((~(size * 2 - 1) & 0x3f) | (ones - 1)) & 0x3f;
        if (!sf && n === 1) return null;
        return { n, immr: r, imms };
      }
    }
    return null;
  }
  return null;
}

// --- moves of immediates

export function movz(sf: boolean, rd: number, imm16: number, hw = 0): number {
  return u32(0x52800000 + sfBit(sf) + (hw << 21) + (imm16 << 5) + rd);
}
export function movn(sf: boolean, rd: number, imm16: number, hw = 0): number {
  return u32(0x12800000 + sfBit(sf) + (hw << 21) + (imm16 << 5) + rd);
}
export function movk(sf: boolean, rd: number, imm16: number, hw = 0): number {
  return u32(0x72800000 + sfBit(sf) + (hw << 21) + (imm16 << 5) + rd);
}

// --- shifts, multiply, divide, bit counting

export type ShiftOp = "lsl" | "lsr" | "asr";
const SHIFT_REG: Record<ShiftOp, number> = { lsl: 0x1ac02000, lsr: 0x1ac02400, asr: 0x1ac02800 };

export function shiftReg(op: ShiftOp, sf: boolean, rd: number, rn: number, rm: number): number {
  return u32(SHIFT_REG[op] + sfBit(sf) + (rm << 16) + (rn << 5) + rd);
}

export function ubfm(sf: boolean, rd: number, rn: number, immr: number, imms: number): number {
  return u32((sf ? 0xd3400000 : 0x53000000) + (immr << 16) + (imms << 10) + (rn << 5) + rd);
}
export function sbfm(sf: boolean, rd: number, rn: number, immr: number, imms: number): number {
  return u32((sf ? 0x93400000 : 0x13000000) + (immr << 16) + (imms << 10) + (rn << 5) + rd);
}
export function bfm(sf: boolean, rd: number, rn: number, immr: number, imms: number): number {
  return u32((sf ? 0xb3400000 : 0x33000000) + (immr << 16) + (imms << 10) + (rn << 5) + rd);
}

export function shiftImm(op: ShiftOp, sf: boolean, rd: number, rn: number, s: number): number {
  const w = sf ? 64 : 32;
  checkRange(s, 0, w - 1, "shift");
  if (op === "lsl") return ubfm(sf, rd, rn, (w - s) % w, w - 1 - s);
  if (op === "lsr") return ubfm(sf, rd, rn, s, w - 1);
  return sbfm(sf, rd, rn, s, w - 1);
}

export function madd(sf: boolean, rd: number, rn: number, rm: number, ra: number): number {
  return u32(0x1b000000 + sfBit(sf) + (rm << 16) + (ra << 10) + (rn << 5) + rd);
}
export function msub(sf: boolean, rd: number, rn: number, rm: number, ra: number): number {
  return u32(0x1b008000 + sfBit(sf) + (rm << 16) + (ra << 10) + (rn << 5) + rd);
}
export function smull(rd: number, rn: number, rm: number): number {
  return u32(0x9b200000 + (rm << 16) + (XZR << 10) + (rn << 5) + rd);
}
export function umull(rd: number, rn: number, rm: number): number {
  return u32(0x9ba00000 + (rm << 16) + (XZR << 10) + (rn << 5) + rd);
}
export function smulh(rd: number, rn: number, rm: number): number {
  return u32(0x9b400000 + (rm << 16) + (XZR << 10) + (rn << 5) + rd);
}
export function umulh(rd: number, rn: number, rm: number): number {
  return u32(0x9bc00000 + (rm << 16) + (XZR << 10) + (rn << 5) + rd);
}
export function sdiv(sf: boolean, rd: number, rn: number, rm: number): number {
  return u32(0x1ac00c00 + sfBit(sf) + (rm << 16) + (rn << 5) + rd);
}
export function udiv(sf: boolean, rd: number, rn: number, rm: number): number {
  return u32(0x1ac00800 + sfBit(sf) + (rm << 16) + (rn << 5) + rd);
}
export function clz(sf: boolean, rd: number, rn: number): number {
  return u32(0x5ac01000 + sfBit(sf) + (rn << 5) + rd);
}

export function csel(sf: boolean, rd: number, rn: number, rm: number, c: Cond): number {
  return u32(0x1a800000 + sfBit(sf) + (rm << 16) + (c << 12) + (rn << 5) + rd);
}
export function csinc(sf: boolean, rd: number, rn: number, rm: number, c: Cond): number {
  return u32(0x1a800400 + sfBit(sf) + (rm << 16) + (c << 12) + (rn << 5) + rd);
}
/** CSET: rd = cond ? 1 : 0. */
export function cset(sf: boolean, rd: number, c: Cond): number {
  return csinc(sf, rd, XZR, XZR, invert(c));
}

// --- branches. Offsets are in bytes, relative to the instruction

function branchOffset(bytes: number, bits: number): number {
  checkRange(bytes % 4, 0, 0, "branch alignment");
  const words = bytes / 4;
  const lim = 2 ** (bits - 1);
  checkRange(words, -lim, lim - 1, "branch offset");
  return words < 0 ? words + 2 ** bits : words;
}

export function b(bytes: number): number {
  return u32(0x14000000 + branchOffset(bytes, 26));
}
export function bl(bytes: number): number {
  return u32(0x94000000 + branchOffset(bytes, 26));
}
export function bcond(c: Cond, bytes: number): number {
  return u32(0x54000000 + (branchOffset(bytes, 19) << 5) + c);
}
export function cbz(sf: boolean, rt: number, bytes: number): number {
  return u32(0x34000000 + sfBit(sf) + (branchOffset(bytes, 19) << 5) + rt);
}
export function cbnz(sf: boolean, rt: number, bytes: number): number {
  return u32(0x35000000 + sfBit(sf) + (branchOffset(bytes, 19) << 5) + rt);
}
export function br(rn: number): number {
  return u32(0xd61f0000 + (rn << 5));
}
export function blr(rn: number): number {
  return u32(0xd63f0000 + (rn << 5));
}
export const RET = 0xd65f03c0;
export const ERET = 0xd69f03e0;

/** ADR: rd = pc + bytes, within 1 MiB. */
export function adr(rd: number, bytes: number): number {
  const v = bytes < 0 ? bytes + 2 ** 21 : bytes;
  checkRange(bytes, -(2 ** 20), 2 ** 20 - 1, "adr offset");
  return u32(0x10000000 + ((v & 3) << 29) + (Math.floor(v / 4) << 5) + rd);
}
/** ADRP: rd = page(pc) + pages * 4096. */
export function adrp(rd: number, pages: number): number {
  checkRange(pages, -(2 ** 20), 2 ** 20 - 1, "adrp offset");
  const v = pages < 0 ? pages + 2 ** 21 : pages;
  return u32(0x90000000 + ((v & 3) << 29) + (Math.floor(v / 4) << 5) + rd);
}

// --- memory

/** The size-and-opcode base of each scalar access, in unsigned-offset form. */
export type MemOp =
  | "ldrb"
  | "ldrh"
  | "ldrw"
  | "ldrx"
  | "strb"
  | "strh"
  | "strw"
  | "strx"
  | "ldrs"
  | "ldrd"
  | "strs"
  | "strd"
  | "ldrq"
  | "strq"
  | "ldrsbw"
  | "ldrshw";

const MEM_BASE: Record<MemOp, { base: number; size: number }> = {
  ldrb: { base: 0x39400000, size: 1 },
  ldrh: { base: 0x79400000, size: 2 },
  ldrw: { base: 0xb9400000, size: 4 },
  ldrx: { base: 0xf9400000, size: 8 },
  strb: { base: 0x39000000, size: 1 },
  strh: { base: 0x79000000, size: 2 },
  strw: { base: 0xb9000000, size: 4 },
  strx: { base: 0xf9000000, size: 8 },
  ldrs: { base: 0xbd400000, size: 4 },
  ldrd: { base: 0xfd400000, size: 8 },
  strs: { base: 0xbd000000, size: 4 },
  strd: { base: 0xfd000000, size: 8 },
  ldrq: { base: 0x3dc00000, size: 16 },
  strq: { base: 0x3d800000, size: 16 },
  ldrsbw: { base: 0x39c00000, size: 1 },
  ldrshw: { base: 0x79c00000, size: 2 },
};

export function memSize(op: MemOp): number {
  return MEM_BASE[op].size;
}

/** Can this offset be written in the scaled unsigned form, or failing that in the unscaled one? */
export function memImmOk(op: MemOp, off: number): boolean {
  const s = MEM_BASE[op].size;
  if (off >= 0 && off % s === 0 && off / s < 4096) return true;
  return off >= -256 && off < 256;
}

export function memImm(op: MemOp, rt: number, rn: number, off: number): number {
  const { base, size } = MEM_BASE[op];
  if (off >= 0 && off % size === 0 && off / size < 4096) {
    return u32(base + ((off / size) << 10) + (rn << 5) + rt);
  }
  // LDUR/STUR: clear the unsigned-offset bit, and a 9-bit signed byte offset.
  checkRange(off, -256, 255, "memory offset");
  const imm9 = off < 0 ? off + 512 : off;
  return u32(base - 0x01000000 + (imm9 << 12) + (rn << 5) + rt);
}

/** [rn, rm, LSL #log2(size)] if scaled, else [rn, rm]. */
export function memReg(op: MemOp, rt: number, rn: number, rm: number, scaled: boolean): number {
  const { base } = MEM_BASE[op];
  return u32(
    base -
      0x01000000 +
      0x00200800 +
      (rm << 16) +
      (3 << 13) +
      ((scaled ? 1 : 0) << 12) +
      (rn << 5) +
      rt,
  );
}

export type PairOp = "stpx" | "ldpx" | "stpd" | "ldpd" | "stpq" | "ldpq";
export type PairMode = "offset" | "pre" | "post";
const PAIR: Record<PairOp, { base: number; size: number }> = {
  stpx: { base: 0xa8000000, size: 8 },
  ldpx: { base: 0xa8400000, size: 8 },
  stpd: { base: 0x6c000000, size: 8 },
  ldpd: { base: 0x6c400000, size: 8 },
  stpq: { base: 0xac000000, size: 16 },
  ldpq: { base: 0xac400000, size: 16 },
};
const PAIR_MODE: Record<PairMode, number> = {
  post: 0x00800000,
  offset: 0x01000000,
  pre: 0x01800000,
};

export function memPair(
  op: PairOp,
  mode: PairMode,
  rt: number,
  rt2: number,
  rn: number,
  off: number,
): number {
  const { base, size } = PAIR[op];
  const scaled = off / size;
  checkRange(scaled, -64, 63, "pair offset");
  const imm7 = scaled < 0 ? scaled + 128 : scaled;
  return u32(base + PAIR_MODE[mode] + (imm7 << 15) + (rt2 << 10) + (rn << 5) + rt);
}

/** PC-relative literal loads. */
export type LitOp = "ldrw" | "ldrx" | "ldrs" | "ldrd";
const LIT: Record<LitOp, number> = {
  ldrw: 0x18000000,
  ldrx: 0x58000000,
  ldrs: 0x1c000000,
  ldrd: 0x5c000000,
};
export function memLit(op: LitOp, rt: number, bytes: number): number {
  return u32(LIT[op] + (branchOffset(bytes, 19) << 5) + rt);
}

// --- floating point. `d` selects double precision

const ftype = (d: boolean): number => (d ? 0x00400000 : 0);

export type FBin = "fadd" | "fsub" | "fmul" | "fdiv" | "fmax" | "fmin";
const FBIN: Record<FBin, number> = {
  fmul: 0x1e200800,
  fdiv: 0x1e201800,
  fadd: 0x1e202800,
  fsub: 0x1e203800,
  fmax: 0x1e204800,
  fmin: 0x1e205800,
};
export function fbin(op: FBin, d: boolean, rd: number, rn: number, rm: number): number {
  return u32(FBIN[op] + ftype(d) + (rm << 16) + (rn << 5) + rd);
}

export type FUn = "fmov" | "fabs" | "fneg" | "fsqrt" | "frintn" | "frintp" | "frintm" | "frintz";
const FUN: Record<FUn, number> = {
  fmov: 0x1e204000,
  fabs: 0x1e20c000,
  fneg: 0x1e214000,
  fsqrt: 0x1e21c000,
  frintn: 0x1e244000,
  frintp: 0x1e24c000,
  frintm: 0x1e254000,
  frintz: 0x1e25c000,
};
export function fun(op: FUn, d: boolean, rd: number, rn: number): number {
  return u32(FUN[op] + ftype(d) + (rn << 5) + rd);
}

/** FMADD: rd = rn * rm + ra, rounded once. */
export function fmadd(d: boolean, rd: number, rn: number, rm: number, ra: number): number {
  return u32(0x1f000000 + ftype(d) + (rm << 16) + (ra << 10) + (rn << 5) + rd);
}

export function fcvtStoD(rd: number, rn: number): number {
  return u32(0x1e22c000 + (rn << 5) + rd);
}
export function fcvtDtoS(rd: number, rn: number): number {
  return u32(0x1e624000 + (rn << 5) + rd);
}
export function fcmp(d: boolean, rn: number, rm: number): number {
  return u32(0x1e202000 + ftype(d) + (rm << 16) + (rn << 5));
}
export function fcsel(d: boolean, rd: number, rn: number, rm: number, c: Cond): number {
  return u32(0x1e200c00 + ftype(d) + (rm << 16) + (c << 12) + (rn << 5) + rd);
}
/** FMOV between register files: Wd<-Sn, Sd<-Wn, Xd<-Dn, Dd<-Xn. */
export function fmovToGp(d: boolean, rd: number, rn: number): number {
  return u32((d ? 0x9e660000 : 0x1e260000) + (rn << 5) + rd);
}
export function fmovFromGp(d: boolean, rd: number, rn: number): number {
  return u32((d ? 0x9e670000 : 0x1e270000) + (rn << 5) + rd);
}
export function fmovImm(d: boolean, rd: number, imm8: number): number {
  return u32(0x1e201000 + ftype(d) + (imm8 << 13) + rd);
}
/** MOVI Dd, #0: the one zeroing form every core does cheaply. */
export function moviD0(rd: number): number {
  return u32(0x2f00e400 + rd);
}
/** scvtf or ucvtf. `sf` is the integer's width, `d` the float's. */
export function intToFloat(
  signed: boolean,
  sf: boolean,
  d: boolean,
  rd: number,
  rn: number,
): number {
  return u32((signed ? 0x1e220000 : 0x1e230000) + sfBit(sf) + ftype(d) + (rn << 5) + rd);
}
/** fcvtzs or fcvtzu: saturating, and NaN gives 0. */
export function floatToInt(
  signed: boolean,
  sf: boolean,
  d: boolean,
  rd: number,
  rn: number,
): number {
  return u32((signed ? 0x1e380000 : 0x1e390000) + sfBit(sf) + ftype(d) + (rn << 5) + rd);
}

/** The imm8 form of a float constant, or null if it has none: ±n/16 * 2^r, n in 16..31, r in -3..4. */
export function fpImm8(bits: bigint, d: boolean): number | null {
  if (d) {
    if ((bits & 0xffffffffffffn) !== 0n) return null;
    const hi = Number(bits >> 48n);
    const expTop = (hi >> 6) & 0x1ff; // bits 62..54
    if (expTop !== 0x100 && expTop !== 0x0ff) return null;
    const a = (hi >> 15) & 1;
    const b = (hi >> 14) & 1;
    if ((b === 1) !== (expTop === 0x0ff)) return null;
    return (a << 7) | (b << 6) | (hi & 0x3f);
  }
  if ((bits & 0x7ffffn) !== 0n) return null;
  const hi = Number(bits >> 19n);
  const expTop = (hi >> 6) & 0x1f; // bits 30..26
  if (expTop !== 0x10 && expTop !== 0x0f) return null;
  const a = (hi >> 12) & 1;
  const b = expTop === 0x0f ? 1 : 0;
  return (a << 7) | (b << 6) | (hi & 0x3f);
}

// --- system

export interface SysReg {
  op0: number;
  op1: number;
  crn: number;
  crm: number;
  op2: number;
}
const sys = (op0: number, op1: number, crn: number, crm: number, op2: number): SysReg => ({
  op0,
  op1,
  crn,
  crm,
  op2,
});
export const SCTLR_EL1 = sys(3, 0, 1, 0, 0);
export const CPACR_EL1 = sys(3, 0, 1, 0, 2);
export const TTBR0_EL1 = sys(3, 0, 2, 0, 0);
export const TCR_EL1 = sys(3, 0, 2, 0, 2);
export const SPSR_EL1 = sys(3, 0, 4, 0, 0);
export const ELR_EL1 = sys(3, 0, 4, 0, 1);
export const SP_EL0 = sys(3, 0, 4, 1, 0);
export const ESR_EL1 = sys(3, 0, 5, 2, 0);
export const FAR_EL1 = sys(3, 0, 6, 0, 0);
export const MAIR_EL1 = sys(3, 0, 10, 2, 0);
export const VBAR_EL1 = sys(3, 0, 12, 0, 0);
export const CNTFRQ_EL0 = sys(3, 3, 14, 0, 0);
export const CNTVCT_EL0 = sys(3, 3, 14, 0, 2);
export const FPCR = sys(3, 3, 4, 4, 0);
export const FPSR = sys(3, 3, 4, 4, 1);
export const ID_AA64MMFR0_EL1 = sys(3, 0, 0, 7, 0);

function sysField(r: SysReg): number {
  return (r.op0 << 19) + (r.op1 << 16) + (r.crn << 12) + (r.crm << 8) + (r.op2 << 5);
}
export function mrs(rt: number, r: SysReg): number {
  return u32(0xd5200000 + sysField(r) + rt);
}
export function msr(r: SysReg, rt: number): number {
  return u32(0xd5000000 + sysField(r) + rt);
}

export const NOP = 0xd503201f;
export const ISB = 0xd5033fdf;
export const DSB_SY = 0xd5033f9f;
export const DSB_ISH = 0xd5033b9f;
export const HVC_0 = 0xd4000002;
export const IC_IALLU = 0xd508751f;
export const TLBI_VMALLE1 = 0xd508871f;
export const MSR_DAIFSET_ALL = 0xd5034fdf; // msr daifset, #0xf
export const MSR_SPSEL_0 = 0xd50040bf; // msr spsel, #0
export const MSR_SPSEL_1 = 0xd50041bf; // msr spsel, #1
