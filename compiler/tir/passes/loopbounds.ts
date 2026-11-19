// -O1's bounds checks proved by their loop's own test (SPEC 4.3, D44, D73; M5's R7 record). A cheap, local form of what -O2's
// `checks` proves with range.ts's fixpoint: no intervals, only the shape `for (let i = 0; i < xs.length; i++) xs[i]`.
//
// A loop qualifies where its header ends in the test: `brif c, IN, OUT`, IN in the loop and OUT outside it, IN reached from
// the header alone (so IN dominates every block of the loop but the header), and `c` saying, on the way to IN, that the
// header's parameter `k` is below a value `m` (`k < m` signed or unsigned, either way round). A bounds
// check in the loop past the header, on an index `i` against a length `n`, can't fire where:
//
// - `i` is `k`, or `k` widened to `ix` (`zext`, or `sext` once `k` is known not negative), and `n` is `m`, or `m` is
//   `trunc.i32 n`: n's low 32 bits, never above n read unsigned; and
// - for a signed test, `k` is never negative: every value it enters the loop with is a constant at least 0, and every value a
//   latch gives it is `k` plus a constant at least 0, added with a signed overflow check (which traps rather than wraps), or
//   plainly where the constant is 1 (k is below m, so k + 1 is at most m, which fits).
//
// Then on every turn that reaches the check, `k < m` held for this turn's `k` (SSA: the value tested is the value used), so
// `i < n` unsigned, and the check is a no-op. A `bounds.chk` becomes its index; a compare and branch to a block that only
// traps (`icmp.uge.ix i, n`, how `JsArray.get` checks) becomes a jump to the other side. "The array and its length unchanged
// in the loop" is that the check's `n` is the very SSA value the test compared: the header dominates the test and every block
// past it, so in a turn both see the latest header's value. Where something between the test and the check can write the
// length (a push), value numbering keeps the check's load apart from the test's, and nothing matches. Nothing moves, and a
// check that stays is where it was.
import { buildCfg, edgesOf, type Block, type Func, type Instr } from "../ir.ts";
import { removeUnreachable } from "./cfg.ts";
import { findLoops, type Loop } from "./loops.ts";
import { opParts, r26Off, valueOps } from "./util.ts";

export interface LoopBoundsStats {
  bounds: number; // bounds.chk removed
  branches: number; // compares and branches to a trap removed
}

export interface LoopBoundsFaults {
  /** Injected (R7): a loop test `k <= m` taken for `k < m`, so a check that fires on the last turn goes. */
  inclusive?: boolean;
  /** Injected (R26): `k < c` taken as false for any constant `c`, not only 0. */
  r26Const?: boolean;
}

const LT: Record<string, { signed: boolean; flip: boolean } | undefined> = {
  slt: { signed: true, flip: false },
  ult: { signed: false, flip: false },
  sgt: { signed: true, flip: true }, // m > k
  ugt: { signed: false, flip: true },
};
const GE: Record<string, { signed: boolean; flip: boolean } | undefined> = {
  sge: { signed: true, flip: false },
  uge: { signed: false, flip: false },
  sle: { signed: true, flip: true }, // m <= k
  ule: { signed: false, flip: true },
};
// The injected bug's: `<=` read as `<`, and `>` as `>=`.
const LE_BUG: Record<string, { signed: boolean; flip: boolean } | undefined> = {
  sle: { signed: true, flip: false },
  ule: { signed: false, flip: false },
};
const GT_BUG: Record<string, { signed: boolean; flip: boolean } | undefined> = {
  sgt: { signed: true, flip: false },
  ugt: { signed: false, flip: false },
};

export interface Fact {
  k: number; // the header's parameter
  m: number; // what it's below
  signed: boolean;
  blocks: Set<number>; // the loop's block positions other than the header
}

/** Removes the bounds checks the loop's own test proves. Returns whether anything changed. */
export function loopBoundsFunc(
  f: Func,
  stats: LoopBoundsStats,
  faults: LoopBoundsFaults = {},
): boolean {
  // Only where there's a check: a bounds.chk, or a block that only traps.
  let worth = false;
  for (const b of f.blocks) {
    if (b.term.k === "trap" && b.instrs.length === 0) worth = true;
    else for (const ins of b.instrs) if (opParts(ins.op)[0] === "bounds") worth = true;
    if (worth) break;
  }
  if (!worth) return false;
  const cfg = buildCfg(f);
  const loops = findLoops(f, cfg);
  if (loops.length === 0) return false;
  const def = new Map<number, Instr>();
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) def.set(r, ins);
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const facts: Fact[] = [];
  for (const l of loops) {
    const fact = loopFact(f, l, cfg.preds, index, def, faults);
    if (fact !== null) facts.push(fact);
  }
  if (facts.length === 0) return false;
  // Whether `i < n` unsigned at block position `at`, by a fact whose loop holds it.
  const proved = (i: number, n: number, at: number): boolean => {
    for (const x of facts) {
      if (!x.blocks.has(at)) continue;
      let idx = i;
      const d = def.get(idx);
      if (d !== undefined && (d.op === "zext.ix" || (x.signed && d.op === "sext.ix")))
        idx = valueOps(d)[0]!;
      if (idx !== x.k) continue;
      if (n === x.m) return true;
      const md = def.get(x.m);
      if (md !== undefined && md.op === "trunc.i32" && valueOps(md)[0] === n) return true;
    }
    return false;
  };
  const isTrapBlock = (id: number): boolean => {
    const b = f.blocks[index.get(id)!]!;
    return b.term.k === "trap" && b.instrs.length === 0 && b.params.length === 0;
  };
  let changed = false;
  let branched = false;
  const subst = new Map<number, number>();
  // R26: a signed test's `k` is never negative (neverNegative), so in its loop `k < 0` is false and `k >= 0` true: the
  // test `charCodeAt` printed in integers makes of its index (emit-tsl.ts's intCodeAt).
  const notNegative = (v: number, at: number): boolean =>
    !r26Off("range") && facts.some((x) => x.signed && x.k === v && x.blocks.has(at));
  f.blocks.forEach((b: Block, at) => {
    for (const ins of b.instrs) {
      const p = opParts(ins.op);
      if (p[0] !== "icmp" || (p[1] !== "slt" && p[1] !== "sge")) continue;
      const [a, z] = valueOps(ins) as [number, number];
      const zd = def.get(z);
      if (zd === undefined || !zd.op.startsWith("iconst.") || zd.ops[0]?.t !== "i") continue;
      if ((zd.ops[0].val !== 0n && faults.r26Const !== true) || !notNegative(a, at)) continue;
      ins.op = "iconst.i32";
      ins.ops = [{ t: "i", val: p[1] === "slt" ? 0n : 1n }];
      stats.branches++;
      changed = true;
    }
  });
  f.blocks.forEach((b: Block, at) => {
    let removed = false;
    for (const ins of b.instrs) {
      if (ins.op !== "bounds.chk") continue;
      const [i, n] = valueOps(ins) as [number, number];
      if (!proved(i, n, at)) continue;
      subst.set(ins.res[0]!, i);
      (ins as Instr & { gone?: true }).gone = true;
      removed = true;
      stats.bounds++;
    }
    if (removed) b.instrs = b.instrs.filter((x) => (x as { gone?: true }).gone !== true);
    const t = b.term;
    if (t.k !== "brif") return;
    const c = def.get(t.cond);
    if (c === undefined) return;
    const p = opParts(c.op);
    if (p[0] !== "icmp" || p[2] !== "ix") return;
    const [a, z] = valueOps(c) as [number, number];
    // Which side traps if the check fires: `i >= n` (or `n <= i`) true, or `i < n` (or `n > i`) false.
    let keep: "t" | "f" | null = null;
    if ((p[1] === "uge" && proved(a, z, at)) || (p[1] === "ule" && proved(z, a, at)))
      keep = isTrapBlock(t.t.block) ? "f" : null;
    else if ((p[1] === "ult" && proved(a, z, at)) || (p[1] === "ugt" && proved(z, a, at)))
      keep = isTrapBlock(t.f.block) ? "t" : null;
    if (keep === null) return;
    b.term = { k: "br", to: keep === "t" ? t.t : t.f };
    stats.branches++;
    changed = true;
    branched = true;
  });
  // A trap no branch reaches now goes, so the function is one the verifier takes.
  if (branched) removeUnreachable(f);
  if (subst.size > 0) {
    changed = true;
    for (const b of f.blocks) {
      for (const ins of b.instrs)
        for (const o of ins.ops) if (o.t === "v") o.id = subst.get(o.id) ?? o.id;
      const t = b.term;
      if (t.k === "brif") t.cond = subst.get(t.cond) ?? t.cond;
      else if (t.k === "switch") t.val = subst.get(t.val) ?? t.val;
      else if (t.k === "ret") t.vals = t.vals.map((v) => subst.get(v) ?? v);
      for (const e of edgesOf(t)) e.args = e.args.map((v) => subst.get(v) ?? v);
    }
  }
  return changed;
}

/** What a loop's header test proves on the way into the loop, where it's the shape above; else null. */
export function loopFact(
  f: Func,
  l: Loop,
  preds: number[][],
  index: Map<number, number>,
  def: Map<number, Instr>,
  faults: LoopBoundsFaults,
): Fact | null {
  const h = f.blocks[l.header]!;
  const t = h.term;
  if (t.k !== "brif") return null;
  const tIn = l.blocks.has(index.get(t.t.block)!);
  const fIn = l.blocks.has(index.get(t.f.block)!);
  if (tIn === fIn) return null;
  const into = tIn ? t.t : t.f;
  const inAt = index.get(into.block)!;
  if (inAt === l.header || into.args.length > 0) return null;
  // IN is reached from the header alone, by that one edge.
  const inPreds = preds[inAt]!;
  if (inPreds.length !== 1 || inPreds[0] !== l.header) return null;
  const c = def.get(t.cond);
  if (c === undefined) return null;
  const p = opParts(c.op);
  if (p[0] !== "icmp") return null;
  const table = tIn
    ? faults.inclusive === true
      ? { ...LT, ...LE_BUG }
      : LT
    : faults.inclusive === true
      ? { ...GE, ...GT_BUG }
      : GE;
  const how = table[p[1]!];
  if (how === undefined) return null;
  const [a, b] = valueOps(c) as [number, number];
  const [k, m] = how.flip ? [b, a] : [a, b];
  const slot = h.params.indexOf(k);
  if (slot < 0) return null;
  // m needn't be outside the loop: it dominates the header's test, so every block past the header sees the value this
  // turn's test compared with (the latest header's), as it sees this turn's k.
  if (how.signed && !neverNegative(f, l, preds, k, slot, def)) return null;
  const blocks = new Set(l.blocks);
  blocks.delete(l.header);
  return { k, m, signed: how.signed, blocks };
}

/** Whether the header's parameter `k` (at `slot`) is never negative: constants from outside, k + c >= 0 from latches. */
function neverNegative(
  f: Func,
  l: Loop,
  preds: number[][],
  k: number,
  slot: number,
  def: Map<number, Instr>,
): boolean {
  const h = f.blocks[l.header]!;
  const signedConst = (v: number): bigint | null => {
    const d = def.get(v);
    const o = d?.ops[0];
    if (d === undefined || !d.op.startsWith("iconst.") || o?.t !== "i") return null;
    const w = BigInt(bitsOfOp(d.op));
    return BigInt.asIntN(Number(w), o.val);
  };
  for (const at of new Set(preds[l.header]!)) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      if (e.block !== h.id) continue;
      const v = e.args[slot]!;
      if (!l.blocks.has(at)) {
        const c = signedConst(v);
        if (c === null || c < 0n) return false;
        continue;
      }
      const d = def.get(v);
      if (d === undefined) return false;
      const p = opParts(d.op);
      const ops = valueOps(d);
      const other = ops[0] === k ? ops[1] : ops[1] === k ? ops[0] : undefined;
      if (other === undefined) return false;
      const c = signedConst(other);
      if (c === null || c < 0n) return false;
      const checked = p[0] === "add" && p[1] === "chk" && p[2] === "s";
      const plainOne = p[0] === "add" && p.length === 2 && c <= 1n;
      if (!checked && !plainOne) return false;
    }
  }
  return true;
}

function bitsOfOp(op: string): number {
  const t = op.split(".").at(-1)!;
  return t === "i8" ? 8 : t === "i16" ? 16 : t === "i32" ? 32 : 64;
}
