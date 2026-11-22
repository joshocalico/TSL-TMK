// Constant folding and copy propagation (SPEC 4.3, D46). Folds an operation whose operands are constants into a constant,
// removes identities such as `x + 0`, removes a check whose constant operands prove it can't fire, and replaces a block
// parameter that's given the same value on every edge by that value. Every fold computes what the backend computes:
// nothing here folds a float to NaN, or an `ix` operation whose answer could differ between wasm32 and a 64-bit target.
import { edgesOf, ValMap, type Func, type Instr, type TirType } from "../ir.ts";
import {
  bitsOf,
  effectOf,
  intImm,
  newValue,
  opParts,
  signedConst,
  substitute,
  valueOps,
  r28Off,
} from "./util.ts";

type Const = { k: "int"; t: TirType; v: bigint } | { k: "float"; t: "f32" | "f64"; bits: bigint };

const F64 = new DataView(new ArrayBuffer(8));
function f64Of(bits: bigint): number {
  F64.setBigUint64(0, BigInt.asUintN(64, bits));
  return F64.getFloat64(0);
}
function bitsOfF64(x: number): bigint {
  F64.setFloat64(0, x);
  return F64.getBigUint64(0);
}
function f32Of(bits: bigint): number {
  F64.setUint32(0, Number(BigInt.asUintN(32, bits)));
  return F64.getFloat32(0);
}
function bitsOfF32(x: number): bigint {
  F64.setFloat32(0, x);
  return BigInt(F64.getUint32(0));
}

const SMALL = 1n << 31n;
/** An `ix` or `ptr` value the same on wasm32 and a 64-bit target, as a signed number. */
function portable(v: bigint): boolean {
  return v >= -SMALL && v < SMALL;
}
function portableUnsigned(v: bigint): boolean {
  return v >= 0n && v < SMALL;
}
// `tmk milestone pipe-d` box 17's injected bug: constants up to 2^33 taken as the same on both, which they aren't.
const U32_END = 1n << (process.env.TMK_TEST_TSL === "fold-u33" ? 33n : 32n);
/**
 * An `ix` or `ptr` value that unsigned compares read the same on wasm32 and a 64-bit target: from 0 to 2^32 - 1. A 64-bit
 * value in that range is its own low 32 bits, which is what wasm32 has, read unsigned (pipe-dispatch: `withTail`'s
 * size check against 2^32 - 1 folds, where it stayed).
 */
function portableU32(v: bigint): boolean {
  return v >= 0n && v < U32_END;
}
function wide(t: TirType): boolean {
  return t === "ix" || t === "ptr";
}

/** A finite or infinite number, but not NaN and not a subnormal, which the folds leave to the hardware. */
function plainFloat(x: number): boolean {
  if (Number.isNaN(x)) return false;
  if (x !== 0 && Number.isFinite(x) && Math.abs(x) < 2.2250738585072014e-308) return false;
  return true;
}
function plainF32(x: number): boolean {
  if (Number.isNaN(x)) return false;
  if (x !== 0 && Number.isFinite(x) && Math.abs(x) < 1.1754943508222875e-38) return false;
  return true;
}

export interface SimplifyStats {
  folded: number;
  identities: number;
  checks: number;
  params: number;
}

/** A fault put in on purpose, for `opt-a`'s check that the tests catch a bad fold (D46). */
export interface FoldFaults {
  wrongFold?: boolean; // add folds to a + b + 1
  dropCheck?: boolean; // a checked add that overflows is folded anyway
  selfCompare?: boolean; // an integer compared with itself folds as though they differed
  pow2Mask?: boolean; // an unsigned remainder by 2^k becomes an and with 2^k, not 2^k - 1 (R1f)
  shiftBack?: boolean; // a shift left and back is taken as lossless whatever the value's width (R1f)
  tagKeepWrong?: boolean; // `ref.addr (or x, tag)` keeps the tag and drops the address (R28)
}

export function simplifyFunc(f: Func, stats: SimplifyStats, faults: FoldFaults = {}): boolean {
  let changed = false;
  // Twice at most: a parameter made constant can fold what uses it. The pass manager's rounds do the rest.
  for (let round = 0; round < 2; round++) {
    const a = foldOnce(f, stats, faults);
    const b = simplifyParams(f, stats);
    if (!a && !b) break;
    changed = true;
  }
  return changed;
}

function foldOnce(f: Func, stats: SimplifyStats, faults: FoldFaults): boolean {
  // R36: by value number in arrays (ir.ts's ValMap), not Maps
  const consts = new ValMap<Const>(f.types.length);
  const defs = new ValMap<Instr>(f.types.length);
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      for (const r of ins.res) defs.set(r, ins);
      const r = ins.res[0];
      if (r === undefined) continue;
      const op = ins.op;
      const c0 = op.charCodeAt(0);
      // (R36: the first letter looked at before the name, as most operations are neither)
      if (c0 === 105 && op.startsWith("iconst."))
        consts.set(r, { k: "int", t: f.types[r]!, v: intImm(ins, 0) });
      else if (c0 === 102 && op.startsWith("fconst.")) {
        consts.set(r, { k: "float", t: f.types[r] as "f32" | "f64", bits: intImm(ins, 0) });
      }
    }
  }
  const subst = new Map<number, number>();
  let changed = false;
  const intConst = (v: number): bigint | undefined => {
    const c = consts.get(v);
    return c?.k === "int" ? c.v : undefined;
  };
  const toConst = (ins: Instr, t: TirType, v: bigint): void => {
    ins.op = `iconst.${t}`;
    ins.ops = [{ t: "i", val: signedConst(t, v) }];
    consts.set(ins.res[0]!, { k: "int", t, v: signedConst(t, v) });
    stats.folded++;
    changed = true;
  };
  const toFloat = (ins: Instr, t: "f32" | "f64", x: number): void => {
    const bits = t === "f64" ? bitsOfF64(x) : bitsOfF32(x);
    ins.op = `fconst.${t}`;
    ins.ops = [{ t: "i", val: bits }];
    consts.set(ins.res[0]!, { k: "float", t, bits });
    stats.folded++;
    changed = true;
  };
  const alias = (ins: Instr, to: number, kind: "identities" | "checks" | "folded"): void => {
    subst.set(ins.res[0]!, to);
    // Left for DCE: a pure instruction with no uses goes. A check proved safe becomes a rename it can remove.
    if (effectOf(ins) === "check") {
      ins.op = `bitcast.${f.types[ins.res[0]!]!}`;
      ins.ops = [{ t: "v", id: to }];
    }
    stats[kind]++;
    changed = true;
  };
  // A reference's pointer, once per block: a second `ref.addr` of one reference is the first (D64). Only TSL proper's
  // references have one, so lowered code's TIR doesn't move. It's pure, and the
  // pass manager's rounds see blocks that cfg has merged, so a loop body's reads of one reference share one mask.
  const optOff = process.env.TMK_TSL_OPT_OFF?.split(",");
  const mergeMasks = optOff?.includes("mask") !== true;
  for (const b of f.blocks) {
    // (R36: made for a block only once it has a `ref.addr`)
    let masked: Map<string, number> | null = null;
    for (let k = 0; k < b.instrs.length; k++) {
      const ins = b.instrs[k]!;
      if (ins.res.length !== 1) continue;
      const r = ins.res[0]!;
      const t = f.types[r]!;
      const p = opParts(ins.op);
      const base = p[0]!;
      if (base === "iconst" || base === "fconst") continue;
      // R28: a reference's pointer is its low 48 bits, so a tag or'd into the top 16 doesn't change it: `ref.addr (or x,
      // y)` is `ref.addr x` where y has no bit below 48 (a constant tag, as a static's 0xffff, or a value shifted left by
      // 48 or more, as a slot's generation is put on its address). The tag's own work is then left for DCE.
      if (
        ins.op === "ref.addr" &&
        ins.ops.length === 1 &&
        ins.ops[0]?.t === "v" &&
        !r28Off("tag")
      ) {
        const d = defs.get(ins.ops[0].id);
        if (d !== undefined && d.op === "or.i64" && d.ops.length === 2) {
          const [a, c] = valueOps(d) as [number, number];
          const high = (v: number): boolean => {
            const k = intConst(v);
            if (k !== undefined) return BigInt.asUintN(64, k) % (1n << 48n) === 0n;
            const s = defs.get(v);
            if (s === undefined || s.op !== "shl.i64") return false;
            const n = intConst(valueOps(s)[1]!);
            return n !== undefined && BigInt.asUintN(64, n) >= 48n && BigInt.asUintN(64, n) < 64n;
          };
          let keep = high(c) ? a : high(a) ? c : undefined;
          // the injected bug (R28): the tag kept and the address dropped
          if (keep !== undefined && faults.tagKeepWrong === true) keep = keep === a ? c : a;
          if (keep !== undefined) {
            ins.ops = [{ t: "v", id: keep }];
            stats.identities++;
            changed = true;
          }
        }
      }
      if (mergeMasks && ins.op === "ref.addr" && ins.ops.length === 1 && ins.ops[0]?.t === "v") {
        const key = `${ins.op} ${ins.ops[0].id}`;
        masked ??= new Map<string, number>();
        const had = masked.get(key);
        if (had !== undefined) {
          alias(ins, had, "identities");
          continue;
        }
        masked.set(key, r);
      }
      const eff = effectOf(ins);
      if (eff !== "pure" && eff !== "check") continue;
      // R36: the value operands looked at in place first, and their list made only for what may fold
      let nv = 0;
      let v0 = -1;
      let v1 = -1;
      let anyConst = false;
      for (const o of ins.ops) {
        if (o.t !== "v") continue;
        if (nv === 0) v0 = o.id;
        else if (nv === 1) v1 = o.id;
        nv++;
        if (consts.has(o.id)) anyConst = true;
      }
      // An integer or pointer compared with itself (pipe-h): `x !== x` on an `i32` is false, as JS's own NaN test is
      // printed for a value that's an integer.
      if (base === "icmp" && p.length === 3 && nv === 2 && v0 === v1) {
        const c = p[1]!;
        const same = c === "eq" || c.endsWith("le") || c.endsWith("ge");
        toConst(ins, t, same !== (faults.selfCompare === true) ? 1n : 0n);
        continue;
      }
      // Nothing to fold without a constant operand, but for these.
      if (
        !anyConst &&
        base !== "select" &&
        base !== "trunc" &&
        base !== "bitcast" &&
        base !== "gep" &&
        base !== "ref"
      )
        continue;
      const vals = valueOps(ins);
      const ints = vals.map(intConst);
      const allInt = vals.length > 0 && ints.every((x) => x !== undefined);
      const opT = vals.length > 0 ? f.types[vals[0]!]! : t;
      // --- strength reduction (R1f): a division or remainder by a power of two, a constant shift of a 64-bit integer
      // that needn't guard a count of 64 or more, and a shift left undone by a shift right that loses nothing
      if (!allInt) {
        const red = reduce(
          f,
          b.instrs,
          k,
          ins,
          p,
          vals,
          ints,
          t,
          defs,
          consts,
          faults,
          optOff ?? [],
        );
        if (red !== null) {
          stats.identities++;
          changed = true;
          if (typeof red === "number") {
            alias(ins, red, "identities");
            stats.identities--;
          } else k = red.at;
          continue;
        }
      }
      // --- checks
      if (eff === "check") {
        const folded = foldCheck(ins, p, ints, opT, faults);
        // x + 0, 0 + x, x - 0, x * 1 and 1 * x can't overflow, checked or not.
        if (folded === null && p[1] === "chk" && vals.length === 2) {
          const [ca, cb] = ints;
          const keep =
            base === "add"
              ? cb === 0n
                ? vals[0]
                : ca === 0n
                  ? vals[1]
                  : undefined
              : base === "sub"
                ? cb === 0n
                  ? vals[0]
                  : undefined
                : base === "mul"
                  ? cb === 1n
                    ? vals[0]
                    : ca === 1n
                      ? vals[1]
                      : undefined
                  : undefined;
          if (keep !== undefined) {
            alias(ins, keep, "checks");
            continue;
          }
        }
        if (folded === "safe") alias(ins, vals[0]!, "checks");
        else if (folded !== null) {
          // A checked operation that can't fire and has a constant answer: the constant, and the check is gone.
          ins.op = `iconst.${t}`;
          ins.ops = [{ t: "i", val: signedConst(t, folded) }];
          consts.set(r, { k: "int", t, v: signedConst(t, folded) });
          stats.checks++;
          changed = true;
        }
        continue;
      }
      // --- pure integer operations on constants
      if (allInt) {
        const v = foldInt(ins.op, p, ints as bigint[], opT, t, faults);
        if (v !== null) {
          toConst(ins, t, v);
          continue;
        }
      }
      // --- floats
      const fl = foldFloat(p, vals, consts, t);
      if (fl !== null) {
        if (fl.k === "float") toFloat(ins, t as "f32" | "f64", fl.x);
        else toConst(ins, t, fl.v);
        continue;
      }
      // --- select on a constant, or with both arms the same
      if (base === "select") {
        const c = ints[0];
        if (c !== undefined) alias(ins, c !== 0n ? vals[1]! : vals[2]!, "folded");
        else if (vals[1] === vals[2]) alias(ins, vals[1]!, "identities");
        continue;
      }
      // --- identities
      const id = identity(f, ins, p, vals, ints, defs);
      if (id !== null) {
        alias(ins, id, "identities");
        continue;
      }
      // --- gep of a gep at constant offsets, or at nothing
      if (base === "gep") {
        const idx = ints[1];
        const scale = intImm(ins, 0);
        const off = intImm(ins, 1);
        if (idx !== undefined && portable(idx)) {
          const total = idx * scale + off;
          if (total === 0n) {
            alias(ins, vals[0]!, "identities");
            continue;
          }
          const inner = defs.get(vals[0]!);
          if (inner?.op === "gep") {
            const iv = valueOps(inner);
            const ii = intConst(iv[1]!);
            if (ii !== undefined && portable(ii)) {
              const sum = ii * intImm(inner, 0) + intImm(inner, 1) + total;
              if (portable(sum)) {
                const zero = zeroIx(f, b.instrs, k, consts);
                if (b.instrs[k] !== ins) k++;
                ins.ops = [
                  { t: "v", id: iv[0]! },
                  { t: "v", id: zero },
                  { t: "i", val: 1n },
                  { t: "i", val: sum },
                ];
                stats.identities++;
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  substitute(f, subst);
  return changed;
}

/** An `iconst.ix 0` to use as a gep's index: one already defined just before, or a new one placed there. */
function zeroIx(f: Func, instrs: Instr[], i: number, consts: ValMap<Const>): number {
  const prev = instrs[i - 1];
  if (prev !== undefined && prev.op === "iconst.ix" && intImm(prev, 0) === 0n) return prev.res[0]!;
  const z = newValue(f, "ix");
  instrs.splice(i, 0, { op: "iconst.ix", ops: [{ t: "i", val: 0n }], res: [z] });
  consts.set(z, { k: "int", t: "ix", v: 0n });
  return z;
}

function foldCheck(
  ins: Instr,
  p: string[],
  ints: (bigint | undefined)[],
  opT: TirType,
  faults: FoldFaults,
): "safe" | bigint | null {
  const base = p[0]!;
  if (base === "gen") return null;
  if (base === "bounds") {
    const [i, n] = ints;
    if (i === undefined || n === undefined) return null;
    if (!portableU32(i) || !portableU32(n)) return null;
    return i < n ? "safe" : null;
  }
  if (base === "range") {
    const x = ints[0];
    if (x === undefined) return null;
    const signed = p[2] === "s";
    const t = p[3] as TirType;
    const imms = ins.ops.filter((o) => o.t === "i" || o.t === "ixmax");
    const loOp = imms[0];
    const hiOp = imms[1];
    if (loOp?.t !== "i" || hiOp === undefined) return null;
    let xv: bigint;
    let lo: bigint;
    let hi: bigint;
    if (wide(t)) {
      // Only where wasm32 and a 64-bit target read the same numbers: both ends and the value below 2^31.
      if (signed ? !portable(x) : !portableUnsigned(x)) return null;
      xv = x;
      lo = loOp.val;
      hi = hiOp.t === "ixmax" ? SMALL - 1n : hiOp.val;
      if (signed ? !portable(lo) || !portable(hi) : !portableUnsigned(lo) || !portableUnsigned(hi))
        return null;
    } else {
      const w = bitsOf(t);
      const read = (v: bigint): bigint => (signed ? BigInt.asIntN(w, v) : BigInt.asUintN(w, v));
      if (hiOp.t !== "i") return null;
      xv = read(x);
      lo = read(loOp.val);
      hi = read(hiOp.val);
    }
    return xv >= lo && xv <= hi ? "safe" : null;
  }
  // add.chk.s.T, sub.chk.u.T, mul.chk.s.T
  if (p[1] === "chk" && (base === "add" || base === "sub" || base === "mul")) {
    const [a0, b0] = ints;
    if (a0 === undefined || b0 === undefined) return null;
    const t = p[3] as TirType;
    const signed = p[2] === "s";
    let a: bigint;
    let b: bigint;
    let lo: bigint;
    let hi: bigint;
    if (wide(t)) {
      if (signed ? !portable(a0) || !portable(b0) : !portableUnsigned(a0) || !portableUnsigned(b0))
        return null;
      a = a0;
      b = b0;
      lo = signed ? -SMALL : 0n;
      hi = SMALL - 1n;
    } else {
      const w = bitsOf(t);
      a = signed ? BigInt.asIntN(w, a0) : BigInt.asUintN(w, a0);
      b = signed ? BigInt.asIntN(w, b0) : BigInt.asUintN(w, b0);
      lo = signed ? -(1n << BigInt(w - 1)) : 0n;
      hi = signed ? (1n << BigInt(w - 1)) - 1n : (1n << BigInt(w)) - 1n;
    }
    const v = base === "add" ? a + b : base === "sub" ? a - b : a * b;
    if (v < lo || v > hi) return faults.dropCheck === true ? v : null;
    return v;
  }
  // Division: a constant divisor that isn't zero, and for sdiv not MIN / -1.
  if (base === "sdiv" || base === "udiv" || base === "srem" || base === "urem") {
    const [a0, b0] = ints;
    if (a0 === undefined || b0 === undefined) return null;
    const t = p[1] as TirType;
    if (wide(t)) return null;
    const w = bitsOf(t);
    const signed = base === "sdiv" || base === "srem";
    const a = signed ? BigInt.asIntN(w, a0) : BigInt.asUintN(w, a0);
    const b = signed ? BigInt.asIntN(w, b0) : BigInt.asUintN(w, b0);
    if (b === 0n) return null;
    const min = -(1n << BigInt(w - 1));
    if (signed && a === min && b === -1n) return base === "srem" ? 0n : null;
    return base === "sdiv" || base === "udiv" ? a / b : a % b;
  }
  return null;
}

function foldInt(
  op: string,
  p: string[],
  xs: bigint[],
  opT: TirType,
  t: TirType,
  faults: FoldFaults,
): bigint | null {
  const base = p[0]!;
  const [a0, b0] = xs;
  const w = bitsOf(opT);
  // Ring operations agree modulo 2^32 and 2^64, so an ix answer is right on both targets as a signed 64-bit constant.
  const ring = (v: bigint): bigint => BigInt.asIntN(wide(opT) ? 64 : w, v);
  switch (op) {
    case "shl.js32":
      return BigInt.asIntN(32, a0! << (BigInt.asUintN(32, b0!) & 31n));
    case "lshr.js32":
      return BigInt.asIntN(32, BigInt.asUintN(32, a0!) >> (BigInt.asUintN(32, b0!) & 31n));
    case "ashr.js32":
      return BigInt.asIntN(32, BigInt.asIntN(32, a0!) >> (BigInt.asUintN(32, b0!) & 31n));
    default:
  }
  if (p.length === 2) {
    switch (base) {
      case "add":
        return ring(a0! + b0! + (faults.wrongFold === true ? 1n : 0n));
      case "sub":
        return ring(a0! - b0!);
      case "mul":
        return ring(a0! * b0!);
      case "and":
        return ring(a0! & b0!);
      case "or":
        return ring(a0! | b0!);
      case "xor":
        return ring(a0! ^ b0!);
      case "neg":
        return ring(-a0!);
      case "not":
        return ring(~a0!);
      case "shl":
      case "lshr":
      case "ashr": {
        const c = BigInt.asUintN(64, b0!);
        if (wide(opT)) {
          if (!portableUnsigned(a0!) || c >= 31n) return null;
          const v = base === "shl" ? a0! << c : a0! >> c;
          return portableUnsigned(v) ? v : null;
        }
        if (c >= BigInt(w)) return null;
        if (base === "shl") return ring(a0! << c);
        if (base === "lshr") return ring(BigInt.asUintN(w, a0!) >> c);
        return ring(BigInt.asIntN(w, a0!) >> c);
      }
      case "zext": {
        if (wide(opT)) return portableUnsigned(a0!) ? a0! : null;
        return BigInt.asUintN(w, a0!);
      }
      case "sext": {
        if (wide(opT)) return portable(a0!) ? a0! : null;
        return BigInt.asIntN(w, a0!);
      }
      case "trunc":
        // From ix to a narrower type takes the low bits, which are the same on both targets.
        return BigInt.asIntN(bitsOf(t), a0!);
      case "bitcast":
        if (t === "f32" || t === "f64" || opT === "f32" || opT === "f64") return null;
        if (wide(t) !== wide(opT) && !portable(a0!)) return null;
        if (bitsOf(t) !== bitsOf(opT)) return null;
        return a0!;
      default:
    }
  }
  if (base === "icmp" && p.length === 3) {
    const cond = p[1]!;
    let a: bigint;
    let b: bigint;
    const unsigned = cond.startsWith("u");
    if (wide(opT)) {
      if (cond === "eq" || cond === "ne") {
        a = BigInt.asUintN(64, a0!);
        b = BigInt.asUintN(64, b0!);
      } else {
        if (unsigned ? !portableU32(a0!) || !portableU32(b0!) : !portable(a0!) || !portable(b0!))
          return null;
        a = a0!;
        b = b0!;
      }
    } else {
      a =
        unsigned || cond === "eq" || cond === "ne" ? BigInt.asUintN(w, a0!) : BigInt.asIntN(w, a0!);
      b =
        unsigned || cond === "eq" || cond === "ne" ? BigInt.asUintN(w, b0!) : BigInt.asIntN(w, b0!);
    }
    const r = cmp(cond, a, b);
    return r === null ? null : r ? 1n : 0n;
  }
  return null;
}

function cmp(cond: string, a: bigint, b: bigint): boolean | null {
  switch (cond) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "slt":
    case "ult":
      return a < b;
    case "sle":
    case "ule":
      return a <= b;
    case "sgt":
    case "ugt":
      return a > b;
    case "sge":
    case "uge":
      return a >= b;
    default:
      return null;
  }
}

function foldFloat(
  p: string[],
  vals: number[],
  consts: ValMap<Const>,
  t: TirType,
): { k: "float"; x: number } | { k: "int"; v: bigint } | null {
  const base = p[0]!;
  // R36: nothing folds unless every operand is a float constant, or it's an integer constant's conversion: said before
  // anything is made
  if (vals.length === 0) return null;
  if (base !== "sitofp" && base !== "uitofp") {
    for (const v of vals) if (consts.get(v)?.k !== "float") return null;
  }
  const fl = vals.map((v) => {
    const c = consts.get(v);
    if (c?.k !== "float") return undefined;
    return c.t === "f64" ? f64Of(c.bits) : f32Of(c.bits);
  });
  const ints = vals.map((v) => {
    const c = consts.get(v);
    return c?.k === "int" ? c : undefined;
  });
  if (vals.length === 0) return null;
  const isF = t === "f32" || t === "f64";
  const plain = t === "f32" ? plainF32 : plainFloat;
  const round = (x: number): number => (t === "f32" ? Math.fround(x) : x);
  if (fl.every((x) => x !== undefined)) {
    const xs = fl as number[];
    const inT = consts.get(vals[0]!)!.t as "f32" | "f64";
    const inPlain = xs.every(inT === "f32" ? plainF32 : plainFloat);
    if (!inPlain) return null;
    let r: number | null = null;
    if (isF && p.length === 2) {
      switch (base) {
        case "fadd":
          r = round(xs[0]! + xs[1]!);
          break;
        case "fsub":
          r = round(xs[0]! - xs[1]!);
          break;
        case "fmul":
          r = round(xs[0]! * xs[1]!);
          break;
        case "fdiv":
          r = round(xs[0]! / xs[1]!);
          break;
        case "fsqrt":
          r = round(Math.sqrt(xs[0]!));
          break;
        case "fneg":
          r = -xs[0]!;
          break;
        case "fabs":
          r = Math.abs(xs[0]!);
          break;
        case "ffloor":
          r = Math.floor(xs[0]!);
          break;
        case "fceil":
          r = Math.ceil(xs[0]!);
          break;
        case "ftrunc":
          r = Math.trunc(xs[0]!);
          break;
        default:
      }
      if (r !== null && plain(r)) return { k: "float", x: r };
      return null;
    }
    if (base === "fpromote" && t === "f64") return { k: "float", x: xs[0]! };
    if (base === "fdemote" && t === "f32") {
      const x = Math.fround(xs[0]!);
      return plainF32(x) ? { k: "float", x } : null;
    }
    if (base === "fcmp" && p.length === 3) {
      const [a, b] = xs as [number, number];
      const c = p[1]!;
      const v =
        c === "eq"
          ? a === b
          : c === "ne"
            ? a !== b
            : c === "lt"
              ? a < b
              : c === "le"
                ? a <= b
                : c === "gt"
                  ? a > b
                  : c === "ge"
                    ? a >= b
                    : null;
      return v === null ? null : { k: "int", v: v ? 1n : 0n };
    }
    if (base === "js" && p[1] === "toint32") return { k: "int", v: BigInt(xs[0]! | 0) };
    return null;
  }
  if ((base === "sitofp" || base === "uitofp") && isF && ints[0] !== undefined) {
    const c = ints[0];
    if (wide(c.t) && !portable(c.v)) return null;
    const w = bitsOf(c.t);
    const n = base === "sitofp" ? BigInt.asIntN(w, c.v) : BigInt.asUintN(w, c.v);
    const lim = 1n << 53n;
    if (n >= lim || n <= -lim) return null;
    return { k: "float", x: round(Number(n)) };
  }
  return null;
}

/** `x + 0`, `x * 1`, `x | 0` and the like, a gep at nothing, and a conversion undone. */
function identity(
  f: Func,
  ins: Instr,
  p: string[],
  vals: number[],
  ints: (bigint | undefined)[],
  defs: ValMap<Instr>,
): number | null {
  const base = p[0]!;
  const t = f.types[ins.res[0]!]!;
  if (p.length === 2 && vals.length === 2) {
    const [a, b] = vals as [number, number];
    const [ca, cb] = ints;
    const w = bitsOf(t);
    const ones = (c: bigint | undefined): boolean =>
      c !== undefined && (wide(t) ? c === -1n : BigInt.asUintN(w, c) === (1n << BigInt(w)) - 1n);
    switch (base) {
      case "add":
      case "or":
      case "xor":
        if (cb === 0n) return a;
        if (ca === 0n) return b;
        return null;
      case "sub":
      case "shl":
      case "lshr":
      case "ashr":
        return cb === 0n ? a : null;
      case "mul":
        if (cb === 1n) return a;
        if (ca === 1n) return b;
        return null;
      case "and":
        if (ones(cb)) return a;
        if (ones(ca)) return b;
        return null;
      default:
    }
  }
  // A reference made from a frame slot's or a global's address has no generation bits: its pointer is that address.
  if (base === "ref" && vals.length === 1) {
    const inner = defs.get(vals[0]!);
    if (inner?.op === "bitcast.i64") {
      const src = valueOps(inner)[0];
      const d = src !== undefined ? defs.get(src) : undefined;
      if (d !== undefined && (d.op === "alloca" || d.op === "globaladdr")) return src!;
    }
    return null;
  }
  // trunc(zext x) and trunc(sext x) to x's own type, and a bitcast undone.
  if ((base === "trunc" || base === "bitcast") && vals.length === 1) {
    const inner = defs.get(vals[0]!);
    if (inner === undefined) return null;
    const ib = inner.op.split(".")[0]!;
    const src = valueOps(inner)[0];
    if (src === undefined) return null;
    if (base === "trunc" && (ib === "zext" || ib === "sext") && f.types[src] === t) return src;
    if (base === "bitcast" && ib === "bitcast" && f.types[src] === t) return src;
  }
  return null;
}

/**
 * The most bits an integer value can have set, counting up from bit 0, as far as its definition shows: a constant's own,
 * what an `and` keeps, a zero extension's or truncation's source's, what a right shift leaves; otherwise its type's width
 * (64 for `ix`, as wide as it can be). Only an upper bound is claimed.
 */
function maxBits(
  v: number,
  f: Func,
  defs: ValMap<Instr>,
  consts: ValMap<Const>,
  depth = 0,
): number {
  const t = f.types[v]!;
  const full = t === "i32" ? 32 : t === "i64" || t === "ix" ? 64 : 64;
  const c = consts.get(v);
  if (c?.k === "int") {
    const u = t === "i32" ? BigInt.asUintN(32, c.v) : BigInt.asUintN(64, c.v);
    return u.toString(2).length - (u === 0n ? 1 : 0);
  }
  const d = defs.get(v);
  if (d === undefined || depth > 8) return full;
  const p = opParts(d.op);
  const ops = valueOps(d);
  const sub = (x: number): number => Math.min(full, maxBits(x, f, defs, consts, depth + 1));
  switch (p[0]) {
    case "and":
      return p.length === 2 ? Math.min(sub(ops[0]!), sub(ops[1]!)) : full;
    case "zext":
    case "trunc":
      return sub(ops[0]!);
    case "lshr": {
      // not ix: wasm32 takes a count of 32 or more modulo 32
      if (p.length !== 2 || t === "ix") return full;
      const n = consts.get(ops[1]!);
      if (n?.k !== "int" || n.v < 0n || n.v >= BigInt(full)) return full;
      return Math.max(0, sub(ops[0]!) - Number(n.v));
    }
    default:
      return full;
  }
}

/**
 * Strength reduction (R1f, found by `tmk profile`): `urem x, 2^k` is `and x, 2^k - 1` and `udiv x, 2^k` is `lshr x, k`
 * (the divisor isn't zero, so neither can trap); a 64-bit shift whose count is a constant below 64 needs no guard for a
 * count of 64 or more (`lshr.big` to `lshr.i64`); and `lshr (shl x, c), c` is `x` when x has no more than 64 - c bits,
 * which is how a checked `<<` tests for bits lost, so that test folds away. Gives the value the instruction now is, or
 * where the loop goes on when it rewrote it in place; null if nothing applies.
 */
function reduce(
  f: Func,
  instrs: Instr[],
  k: number,
  ins: Instr,
  p: string[],
  vals: number[],
  ints: (bigint | undefined)[],
  t: TirType,
  defs: ValMap<Instr>,
  consts: ValMap<Const>,
  faults: FoldFaults,
  off: readonly string[],
): number | { at: number } | null {
  const base = p[0]!;
  const cb = ints[1];
  // `TMK_TSL_OPT_OFF=pow2,bigshift` turns them off, to measure each (M5's R1f record); read once a fold, by foldOnce (R36)
  const constAt = (ty: TirType, v: bigint): number => {
    const r = newValue(f, ty);
    instrs.splice(k, 0, { op: `iconst.${ty}`, ops: [{ t: "i", val: v }], res: [r] });
    consts.set(r, { k: "int", t: ty, v });
    return r;
  };
  if (
    !off.includes("pow2") &&
    (base === "urem" || base === "udiv") &&
    p.length === 2 &&
    (t === "i32" || t === "i64") &&
    cb !== undefined
  ) {
    const u = BigInt.asUintN(t === "i32" ? 32 : 64, cb);
    if (u < 2n || (u & (u - 1n)) !== 0n) return null;
    const sh = BigInt(u.toString(2).length - 1);
    const c = constAt(
      t,
      base === "urem" ? signedConst(t, faults.pow2Mask === true ? u : u - 1n) : sh,
    );
    ins.op = base === "urem" ? `and.${t}` : `lshr.${t}`;
    ins.ops = [
      { t: "v", id: vals[0]! },
      { t: "v", id: c },
    ];
    defs.set(c, instrs[k]!);
    return { at: k + 1 };
  }
  if (off.includes("bigshift")) return null;
  if (
    (base === "shl" || base === "lshr" || base === "ashr") &&
    p[1] === "big" &&
    cb !== undefined
  ) {
    if (cb < 0n || cb >= 64n) return null;
    ins.op = `${base}.i64`;
    return { at: k };
  }
  if (base === "lshr" && p.length === 2 && (t === "i64" || t === "i32") && cb !== undefined) {
    const inner = defs.get(vals[0]!);
    if (inner === undefined || inner.op !== `shl.${t}`) return null;
    const iv = valueOps(inner);
    const ic = consts.get(iv[1]!);
    if (ic?.k !== "int" || ic.v !== cb) return null;
    const w = t === "i32" ? 32 : 64;
    if (cb < 0n || cb >= BigInt(w)) return null;
    if (faults.shiftBack !== true && maxBits(iv[0]!, f, defs, consts) + Number(cb) > w) return null;
    return iv[0]!;
  }
  return null;
}

/** A block parameter given one value on every edge, or itself, is that value. Copy propagation for block parameters. */
function simplifyParams(f: Func, stats: SimplifyStats): boolean {
  // R36: nothing to do, and nothing made, where no block but the entry has a parameter
  let anyParams = false;
  for (let i = 1; i < f.blocks.length; i++)
    if (f.blocks[i]!.params.length > 0) {
      anyParams = true;
      break;
    }
  if (!anyParams) return false;
  const incoming = new Map<number, number[][]>(); // block id to, per edge, the args
  for (const b of f.blocks) {
    for (const e of edgesOf(b.term)) {
      let l = incoming.get(e.block);
      if (l === undefined) incoming.set(e.block, (l = []));
      l.push(e.args);
    }
  }
  const subst = new Map<number, number>();
  const drop = new Map<number, Set<number>>(); // block id to parameter positions to remove
  for (const b of f.blocks.slice(1)) {
    const edges = incoming.get(b.id) ?? [];
    if (edges.length === 0) continue;
    b.params.forEach((param, i) => {
      let only: number | null = null;
      for (const args of edges) {
        const a = args[i]!;
        if (a === param) continue;
        if (only === null) only = a;
        else if (only !== a) return;
      }
      if (only === null) return;
      subst.set(param, only);
      let s = drop.get(b.id);
      if (s === undefined) drop.set(b.id, (s = new Set()));
      s.add(i);
    });
  }
  if (subst.size === 0) return false;
  for (const b of f.blocks) {
    const d = drop.get(b.id);
    if (d !== undefined) b.params = b.params.filter((_, i) => !d.has(i));
    for (const e of edgesOf(b.term)) {
      const dd = drop.get(e.block);
      if (dd !== undefined) e.args = e.args.filter((_, i) => !dd.has(i));
    }
  }
  substitute(f, subst);
  stats.params += subst.size;
  return true;
}
