// Branch folding and block merging (SPEC 4.3, D46): a branch on a constant becomes a jump, unreachable blocks go, a block
// with one predecessor that jumps to it joins it, and an empty block that only jumps on is jumped past. Each keeps the graph
// reducible, so the Wasm backend's structured control flow still applies, and never makes the entry block a target.
import { edgesOf, type Block, type Edge, type Func } from "../ir.ts";
import { bitsOf, intImm, substitute, useCounts } from "./util.ts";

export interface CfgStats {
  branches: number;
  merged: number;
  forwarded: number;
  removed: number;
}

export function cfgFunc(f: Func, stats: CfgStats): boolean {
  let changed = false;
  for (let round = 0; round < 8; round++) {
    let any = foldBranches(f, stats);
    any = removeUnreachable(f, stats) || any;
    any = mergeBlocks(f, stats) || any;
    any = forwardEmpty(f, stats) || any;
    if (!any) break;
    changed = true;
  }
  return changed;
}

/** The constants among the values branches test (R36: only those, and none looked for where no branch tests a value). */
function constants(f: Func): Map<number, bigint> {
  const m = new Map<number, bigint>();
  const tested = new Uint8Array(f.types.length);
  let any = false;
  for (const b of f.blocks) {
    const t = b.term;
    if (t.k === "brif") tested[t.cond] = 1;
    else if (t.k === "switch") tested[t.val] = 1;
    else continue;
    any = true;
  }
  if (!any) return m;
  for (const b of f.blocks)
    for (const ins of b.instrs) {
      const r = ins.res[0];
      if (r !== undefined && tested[r] === 1 && ins.op.startsWith("iconst."))
        m.set(r, intImm(ins, 0));
    }
  return m;
}

const sameEdge = (a: Edge, b: Edge): boolean =>
  a.block === b.block && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);

function foldBranches(f: Func, stats: CfgStats): boolean {
  const k = constants(f);
  let changed = false;
  for (const b of f.blocks) {
    const t = b.term;
    if (t.k === "brif") {
      const c = k.get(t.cond);
      if (c !== undefined) {
        b.term = { k: "br", to: BigInt.asUintN(32, c) !== 0n ? t.t : t.f };
        stats.branches++;
        changed = true;
      } else if (sameEdge(t.t, t.f)) {
        b.term = { k: "br", to: t.t };
        stats.branches++;
        changed = true;
      }
    } else if (t.k === "switch") {
      const c = k.get(t.val);
      if (c !== undefined) {
        // Keys are compared at the value's width, as the backends do. An ix value is folded only where wasm32 and a
        // 64-bit target read the same number.
        const vt = f.types[t.val]!;
        const portable = (v: bigint): boolean => v >= -(1n << 31n) && v < 1n << 31n;
        if (
          (vt === "ix" || vt === "ptr") &&
          (!portable(c) || t.cases.some((x) => !portable(x.key)))
        )
          continue;
        const w = bitsOf(vt);
        const hit = t.cases.find((x) => BigInt.asUintN(w, x.key) === BigInt.asUintN(w, c));
        b.term = { k: "br", to: hit !== undefined ? hit.to : t.def };
        stats.branches++;
        changed = true;
      } else if (t.cases.every((x) => sameEdge(x.to, t.def))) {
        b.term = { k: "br", to: t.def };
        stats.branches++;
        changed = true;
      }
    }
  }
  return changed;
}

export function removeUnreachable(f: Func, stats?: CfgStats): boolean {
  // By block id in arrays, not a Map and a Set, and the edges read off each terminator without making a list of them: the
  // inliner asks after every site, so this is a tenth of a large compile (T2). What it removes, and the order kept, are
  // as they were.
  let top = 0;
  for (const b of f.blocks) if (b.id > top) top = b.id;
  const byId: (Block | undefined)[] = [];
  for (const b of f.blocks) byId[b.id] = b;
  const seen = new Uint8Array(top + 1);
  let reached = 0;
  const stack = [f.blocks[0]!.id];
  const push = (id: number): void => {
    if (seen[id] !== 1) stack.push(id);
  };
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen[id] === 1) continue;
    seen[id] = 1;
    reached++;
    const t = byId[id]!.term;
    switch (t.k) {
      case "br":
        push(t.to.block);
        break;
      case "brif":
        push(t.t.block);
        push(t.f.block);
        break;
      case "switch":
        for (const c of t.cases) push(c.to.block);
        push(t.def.block);
        break;
      default:
        break;
    }
  }
  if (reached === f.blocks.length) return false;
  const before = f.blocks.length;
  f.blocks = f.blocks.filter((b) => seen[b.id] === 1);
  if (stats !== undefined) stats.removed += before - f.blocks.length;
  return true;
}

function predCount(f: Func): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of f.blocks)
    for (const e of edgesOf(b.term)) m.set(e.block, (m.get(e.block) ?? 0) + 1);
  return m;
}

/** R36: whether a terminator has an edge to the block, said with no list of its edges made. */
function targets(t: Block["term"], id: number): boolean {
  switch (t.k) {
    case "br":
      return t.to.block === id;
    case "brif":
      return t.t.block === id || t.f.block === id;
    case "switch":
      return t.def.block === id || t.cases.some((c) => c.to.block === id);
    default:
      return false;
  }
}

/** B ends `br C(args)` and C has no other predecessor: C's parameters are those args, and its body follows B's. */
function mergeBlocks(f: Func, stats: CfgStats): boolean {
  const entry = f.blocks[0]!.id;
  const preds = predCount(f);
  const byId = new Map<number, Block>();
  for (const b of f.blocks) byId.set(b.id, b);
  const gone = new Set<number>();
  const subst = new Map<number, number>();
  for (const b of f.blocks) {
    if (gone.has(b.id)) continue;
    // Merging moves C's terminator into B, which may jump to another such block: keep going.
    for (let guard = 0; guard < f.blocks.length; guard++) {
      const t = b.term;
      if (t.k !== "br") break;
      const c = byId.get(t.to.block)!;
      if (c === b || c.id === entry || preds.get(c.id) !== 1 || gone.has(c.id)) break;
      c.params.forEach((p, i) => subst.set(p, t.to.args[i]!));
      for (const ins of c.instrs) b.instrs.push(ins);
      b.term = c.term;
      gone.add(c.id);
      stats.merged++;
    }
  }
  if (gone.size === 0) return false;
  f.blocks = f.blocks.filter((x) => !gone.has(x.id));
  substitute(f, subst);
  return true;
}

/**
 * X has no instructions and ends `br Y(args)`: an edge into X can go straight to Y, with X's parameters replaced by what
 * that edge passes. Not where a two-way branch would then have both edges into Y with different arguments.
 */
function forwardEmpty(f: Func, stats: CfgStats): boolean {
  const entry = f.blocks[0]!.id;
  const byId = new Map<number, Block>();
  for (const b of f.blocks) byId.set(b.id, b);
  let changed = false;
  // R36: nothing to do, and no counting, where no block but the entry is empty and only jumps on
  if (!f.blocks.some((x) => x.id !== entry && x.instrs.length === 0 && x.term.k === "br"))
    return false;
  // Counts from before any edge here changes: one gone stale can only make a later block look used more, never less.
  const uses = useCounts(f);
  for (const x of f.blocks) {
    if (x.id === entry || x.instrs.length > 0 || x.term.k !== "br") continue;
    const out = x.term.to;
    if (out.block === x.id || out.block === entry) continue;
    // X's parameters may be used in blocks X dominates, which would lose them: only where X's jump is their one use.
    if (x.params.some((p) => uses[p]! !== out.args.filter((a) => a === p).length)) continue;
    const pos = new Map<number, number>();
    x.params.forEach((p, i) => pos.set(p, i));
    for (const p of f.blocks) {
      if (p === x || !targets(p.term, x.id)) continue;
      const edges = edgesOf(p.term);
      for (const e of edges) {
        if (e.block !== x.id) continue;
        const args = out.args.map((a) => {
          const i = pos.get(a);
          return i === undefined ? a : e.args[i]!;
        });
        if (p.term.k !== "br") {
          // Two edges of one branch into one block are allowed only with the same arguments.
          const clash = edges.some(
            (o) =>
              o !== e &&
              o.block === out.block &&
              !(o.args.length === args.length && o.args.every((v, i) => v === args[i])),
          );
          if (clash) continue;
        }
        e.block = out.block;
        e.args = args;
        stats.forwarded++;
        changed = true;
      }
    }
  }
  return changed;
}
