// Check elimination (SPEC 4.3, D73): a check proved unable to fire goes, and a compare whose answer is proved becomes it.
// The proofs are range.ts's, from constants, induction variables bounded by a test, a mask below a length, the compares
// above a block, and a check already passed on the same value. Nothing is moved: a check is removed, or stays where it is.
//
// - `add.chk`, `sub.chk`, `mul.chk`: where the result can't leave the type, the operation without its check (the same
//   bits). An `ix` result is proved only below 2^32, where wasm32 traps, or where it's at most an `ix` value read unsigned,
//   a usize, which is never above 2^53 - 1 (D23).
// - `range.chk`: where the operand is in range, the operand.
// - `bounds.chk`: where the index is below the length, the index.
// - `icmp` and `fcmp`: where the answer is proved, the constant; then branch folding takes the branch away, with the
//   trap behind it, which is how a check written as a compare and a branch goes (an array's `get`, a string's index).
// - `js.toint32` of an i32 converted to a float, rounded or not: that i32.
// Divisions keep their checks: TIR has no division without one.
import type { Func, Instr, TirType } from "../ir.ts";
import { IX_PORTABLE, isTracked, Ranges } from "../range.ts";
import { opParts, substitute, valueOps } from "./util.ts";

export interface ChecksStats {
  overflow: number; // checked arithmetic made plain
  ranges: number; // range checks removed
  bounds: number; // bounds checks removed
  compares: number; // compares made constants
}

export interface ChecksFaults {
  /** Injected (D73): an index proved at most the length is taken for below it, so a bounds check that can fire goes. */
  dropBounds?: boolean;
  /** Injected (D73): a result proved at most one past the type's limit is taken for in range. */
  offByOne?: boolean;
}

const W: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64 };

export function checksFunc(f: Func, stats: ChecksStats, faults: ChecksFaults = {}): boolean {
  // Only where there's something to prove: a check, a branch to a trap (a check written as a compare), or a float compare.
  const worth = f.blocks.some(
    (b) =>
      b.term.k === "trap" ||
      b.instrs.some((ins) => {
        const p = opParts(ins.op);
        return p[1] === "chk" || p[0] === "bounds" || p[0] === "fcmp";
      }),
  );
  if (!worth) return false;
  const R = new Ranges(f);
  const slack = faults.offByOne === true ? 1n : 0n;
  const subst = new Map<number, number>();
  const removed = new Set<Instr>();
  let changed = false;
  for (const pos of R.cfg.rpo) {
    const b = f.blocks[pos]!;
    for (const ins of b.instrs) {
      if (!isCandidate(ins)) continue;
      const p = opParts(ins.op);
      const ops = valueOps(ins);
      const base = p[0]!;
      if (p[1] === "chk" && (base === "add" || base === "sub" || base === "mul")) {
        const t = p[3] as TirType;
        if (
          !isTracked(t) ||
          !overflowProved(R, base, p[2] === "s", t, ops[0]!, ops[1]!, pos, slack)
        )
          continue;
        ins.op = `${base}.${t}`;
        ins.ops = ins.ops.filter((o) => o.t !== "trap");
        stats.overflow++;
        changed = true;
      } else if (base === "range") {
        const t = p[3] as TirType;
        const x = R.at(ops[0]!, pos);
        if (x === null) continue;
        const imms = ins.ops.filter((o) => o.t === "i" || o.t === "ixmax");
        const lo = imms[0]?.t === "i" ? imms[0].val : 0n;
        const hi = imms[1]?.t === "i" ? imms[1].val : IX_PORTABLE;
        let ok: boolean;
        if (p[2] === "u") {
          const w = t === "ix" ? 64 : W[t]!;
          const L = BigInt.asUintN(w, lo);
          const H = imms[1]?.t === "ixmax" ? IX_PORTABLE : BigInt.asUintN(w, hi);
          ok = x.u.lo >= L && x.u.hi <= H + slack;
        } else {
          if (t === "ix") continue;
          ok = x.s.lo >= lo && x.s.hi <= hi + slack;
        }
        if (!ok) continue;
        subst.set(ins.res[0]!, ops[0]!);
        removed.add(ins);
        stats.ranges++;
        changed = true;
      } else if (base === "bounds") {
        const [i, n] = ops as [number, number];
        if (!R.le(i, n, -1n, pos, faults.dropBounds === true ? 1n : 0n)) continue;
        subst.set(ins.res[0]!, i);
        removed.add(ins);
        stats.bounds++;
        changed = true;
      } else if (ins.op === "js.toint32") {
        // An i32 converted to a float and back, through roundings that change nothing, is that i32.
        const src = R.intSource(ops[0]!);
        if (src === null) continue;
        subst.set(ins.res[0]!, src);
        removed.add(ins);
        stats.compares++;
        changed = true;
      } else if (base === "icmp" || base === "fcmp") {
        const k = R.decide(ins, pos);
        if (k === null) continue;
        ins.op = "iconst.i32";
        ins.ops = [{ t: "i", val: k }];
        stats.compares++;
        changed = true;
      }
    }
  }
  if (removed.size > 0)
    for (const b of f.blocks) b.instrs = b.instrs.filter((x) => !removed.has(x));
  substitute(f, subst);
  return changed;
}

function isCandidate(ins: Instr): boolean {
  const p = opParts(ins.op);
  const b = p[0]!;
  return (
    p[1] === "chk" || b === "bounds" || b === "icmp" || b === "fcmp" || ins.op === "js.toint32"
  );
}

/** Whether a checked add, subtract or multiply can't leave its type, where it is. */
function overflowProved(
  R: Ranges,
  base: string,
  signed: boolean,
  t: TirType,
  a: number,
  b: number,
  pos: number,
  slack: bigint,
): boolean {
  const x = R.at(a, pos)!;
  const y = R.at(b, pos)!;
  if (signed) {
    if (t === "ix") return false;
    const w = BigInt(W[t]!);
    const lo = -(1n << (w - 1n));
    const hi = (1n << (w - 1n)) - 1n;
    const r = corners(base, x.s.lo, x.s.hi, y.s.lo, y.s.hi);
    return r.lo >= lo - slack && r.hi <= hi + slack;
  }
  const hi = t === "ix" ? IX_PORTABLE : (1n << BigInt(W[t]!)) - 1n;
  const r = corners(base, x.u.lo, x.u.hi, y.u.lo, y.u.hi);
  if (r.lo >= -slack && r.hi <= hi + slack) return true;
  // Below a value of the same type: a + k <= n can't pass n's own limit, nor, for `ix`, a usize's (D23).
  if (base === "add") {
    const k = y.u.lo === y.u.hi ? y.u.lo : null;
    if (k !== null && R.belowValue(a, k - slack, pos, t)) return true;
    const k2 = x.u.lo === x.u.hi ? x.u.lo : null;
    if (k2 !== null && R.belowValue(b, k2 - slack, pos, t)) return true;
  }
  if (base === "sub") return R.le(b, a, slack, pos);
  return false;
}

function corners(
  base: string,
  alo: bigint,
  ahi: bigint,
  blo: bigint,
  bhi: bigint,
): { lo: bigint; hi: bigint } {
  if (base === "add") return { lo: alo + blo, hi: ahi + bhi };
  if (base === "sub") return { lo: alo - bhi, hi: ahi - blo };
  const c = [alo * blo, alo * bhi, ahi * blo, ahi * bhi];
  return { lo: c.reduce((p, q) => (q < p ? q : p)), hi: c.reduce((p, q) => (q > p ? q : p)) };
}
