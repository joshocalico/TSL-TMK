// Dominating conditions (SPEC 4.3, D44, D73; M5's R15 record): a test whose answer a test above it already gave goes. -O1's
// and -O2's, and cheap: one walk down the dominator tree, no intervals, no fixpoint.
//
// A fact comes from an edge: block T reached by one edge only, from P's `brif c, ...` whose two ways go to different blocks,
// knows which way c went, and so does every block T dominates (every path to them took that edge, and an SSA value never
// changes). Where c is an integer compare, `icmp.P a, b`, the fact is the relation too. And past a `bounds.chk i, n` in
// its block, and in every block that block dominates, `i < n` unsigned holds, or it trapped. With the facts in force at a
// point:
//
// - a `brif` on a value known there becomes a jump the way it goes;
// - an `icmp.Q x, y` of the same type the facts decide (the same operands, either way round, with Q implied by a relation
//   known or its opposite implied) becomes its constant, so a branch on it folds in turn;
// - a `bounds.chk i, n` where `i < n` unsigned is known becomes `i`.
//
// That is the lowering's check of an array read dominating `get`'s own check of the same read (R13's double check), and a
// null test made twice in one turn of a loop (the JPEG decoder's class printing, R15). Nothing moves: a test is removed
// where the answer is already known, or stays as it is. Floats aren't touched (NaN answers every ordered compare false).
import { buildCfg, type Func, type Instr } from "../ir.ts";
import { removeUnreachable } from "./cfg.ts";
import { opParts, substitute, valueOps } from "./util.ts";

export interface CondsStats {
  branches: number; // branches on a known value made jumps
  compares: number; // compares made constants
  bounds: number; // bounds checks removed
}

export interface CondsFaults {
  /** Injected (R15): a fact from an edge is taken where the edge's block is reached from elsewhere too, so doesn't dominate. */
  notDominating?: boolean;
}

// What a relation that holds also gives, and its opposite.
const IMPLIES: Record<string, readonly string[]> = {
  eq: ["eq", "sle", "sge", "ule", "uge"],
  ne: ["ne"],
  slt: ["slt", "sle", "ne"],
  sle: ["sle"],
  sgt: ["sgt", "sge", "ne"],
  sge: ["sge"],
  ult: ["ult", "ule", "ne"],
  ule: ["ule"],
  ugt: ["ugt", "uge", "ne"],
  uge: ["uge"],
};
const NOT: Record<string, string> = {
  eq: "ne",
  ne: "eq",
  slt: "sge",
  sge: "slt",
  sgt: "sle",
  sle: "sgt",
  ult: "uge",
  uge: "ult",
  ugt: "ule",
  ule: "ugt",
};
const SWAP: Record<string, string> = {
  eq: "eq",
  ne: "ne",
  slt: "sgt",
  sgt: "slt",
  sle: "sge",
  sge: "sle",
  ult: "ugt",
  ugt: "ult",
  ule: "uge",
  uge: "ule",
};

interface Rel {
  t: string; // the compare's type
  p: string; // a relation that holds: a p b
  a: number;
  b: number;
}

/** Removes the tests the tests above them answer. Returns whether anything changed. */
export function condsFunc(f: Func, stats: CondsStats, faults: CondsFaults = {}): boolean {
  // Only where there's a second test to find: a branch or bounds check after another.
  let tests = 0;
  for (const b of f.blocks) {
    if (b.term.k === "brif") tests++;
    for (const ins of b.instrs) if (ins.op === "bounds.chk") tests++;
  }
  if (tests < 2) return false;
  const cfg = buildCfg(f);
  const def = new Map<number, Instr>();
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) def.set(r, ins);
  // The dominator tree's children, in reverse postorder.
  const kids: number[][] = f.blocks.map(() => []);
  for (const at of cfg.rpo) {
    const up = cfg.idom.get(at);
    if (up !== undefined && up !== at) kids[up]!.push(at);
  }
  // What a block knows on entry, from the one edge into it. Not the entry block: a branch back to it would be the only
  // edge in, and the value it tested is the last turn's.
  const entry = (at: number): { c: number; v: 0 | 1 } | null => {
    if (at === cfg.rpo[0]) return null;
    const preds = cfg.preds[at]!;
    if (preds.length !== 1 && !(faults.notDominating === true && preds.length > 1)) return null;
    const t = f.blocks[preds[0]!]!.term;
    if (t.k !== "brif" || t.t.block === t.f.block) return null;
    return { c: t.cond, v: t.t.block === f.blocks[at]!.id ? 1 : 0 };
  };
  // The facts in force, as a stack undone on the way back up the tree.
  const known = new Map<number, 0 | 1>();
  const rels: Rel[] = [];
  const relOf = (c: number, v: 0 | 1): Rel | null => {
    const d = def.get(c);
    if (d === undefined) return null;
    const p = opParts(d.op);
    if (p[0] !== "icmp" || p.length !== 3) return null;
    const [a, b] = valueOps(d) as [number, number];
    return { t: p[2]!, p: v === 1 ? p[1]! : NOT[p[1]!]!, a, b };
  };
  // Whether x q y (of type t) is decided by the relations known: 1 true, 0 false, null not known.
  const decide = (t: string, q: string, x: number, y: number): 0 | 1 | null => {
    for (let i = rels.length - 1; i >= 0; i--) {
      const r = rels[i]!;
      if (r.t !== t) continue;
      let qq: string;
      if (r.a === x && r.b === y) qq = q;
      else if (r.a === y && r.b === x) qq = SWAP[q]!;
      else continue;
      const imp = IMPLIES[r.p]!;
      if (imp.includes(qq)) return 1;
      if (imp.includes(NOT[qq]!)) return 0;
    }
    return null;
  };
  const subst = new Map<number, number>();
  const gone = new Set<Instr>();
  let changed = false;
  let folded = false;
  // An explicit stack: generated functions can nest deeper than the JS stack allows.
  const stack: { at: number; enter: boolean; mark: number; facts: number[] }[] = [
    { at: cfg.rpo[0]!, enter: true, mark: 0, facts: [] },
  ];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (!top.enter) {
      rels.length = top.mark;
      for (const c of top.facts) known.delete(c);
      continue;
    }
    const at = top.at;
    const b = f.blocks[at]!;
    const mark = rels.length;
    const facts: number[] = [];
    const learn = (c: number, v: 0 | 1): void => {
      if (known.has(c)) return;
      known.set(c, v);
      facts.push(c);
      const r = relOf(c, v);
      if (r !== null) rels.push(r);
    };
    const e = entry(at);
    if (e !== null) learn(e.c, e.v);
    for (const ins of b.instrs) {
      const p = opParts(ins.op);
      if (ins.op === "bounds.chk") {
        const [i, n] = valueOps(ins) as [number, number];
        if (decide("ix", "ult", i, n) === 1) {
          subst.set(ins.res[0]!, i);
          gone.add(ins);
          stats.bounds++;
          changed = true;
        } else {
          rels.push({ t: "ix", p: "ult", a: i, b: n });
          rels.push({ t: "ix", p: "ult", a: ins.res[0]!, b: n });
        }
      } else if (p[0] === "icmp" && p.length === 3) {
        const [x, y] = valueOps(ins) as [number, number];
        const k = known.get(ins.res[0]!) ?? decide(p[2]!, p[1]!, x, y);
        if (k !== null) {
          ins.op = "iconst.i32";
          ins.ops = [{ t: "i", val: BigInt(k) }];
          stats.compares++;
          changed = true;
        }
      }
    }
    const t = b.term;
    if (t.k === "brif") {
      const k = known.get(t.cond);
      if (k !== undefined) {
        b.term = { k: "br", to: k === 1 ? t.t : t.f };
        stats.branches++;
        changed = true;
        folded = true;
      }
    }
    stack.push({ at, enter: false, mark, facts });
    const ks = kids[at]!;
    for (let i = ks.length - 1; i >= 0; i--)
      stack.push({ at: ks[i]!, enter: true, mark: 0, facts: [] });
  }
  if (gone.size > 0) for (const b of f.blocks) b.instrs = b.instrs.filter((x) => !gone.has(x));
  substitute(f, subst);
  // A way no branch takes now goes, so the function is one the verifier takes.
  if (folded) removeUnreachable(f);
  return changed;
}
