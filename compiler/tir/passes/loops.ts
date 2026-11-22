// Natural loops, their preheaders and exits, for loop-invariant code motion and unswitching (SPEC 4.3, D73).
import { buildCfg, edgesOf, type Block, type Cfg, type Edge, type Func } from "../ir.ts";
import { newBlockId, newValue } from "./util.ts";

export interface Loop {
  header: number; // block position
  blocks: Set<number>; // block positions, the header included
  latches: number[]; // positions of the blocks with a back edge to the header
  depth: number; // 1 for an outermost loop
}

/** Whether block position `a` dominates position `b`. */
export function dominates(cfg: Cfg, a: number, b: number): boolean {
  let cur = b;
  for (let guard = 0; guard < 100000; guard++) {
    if (cur === a) return true;
    const up = cfg.idom.get(cur);
    if (up === undefined || up === cur) return false;
    cur = up;
  }
  return false;
}

/**
 * R36: whether the function may have a loop: some edge goes to a block at or before its own place in the list. Where every
 * edge goes later in the list the graph has no cycle, so no edge goes to a dominator (that would be a cycle: the dominator
 * reaches the block the edge leaves), and findLoops would find none; the passes that look for loops stop there.
 */
export function mayHaveLoop(f: Func): boolean {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  for (let i = 0; i < f.blocks.length; i++) {
    for (const e of edgesOf(f.blocks[i]!.term)) {
      const to = index.get(e.block);
      if (to === undefined || to <= i) return true;
    }
  }
  return false;
}

/** The natural loops, one per header, innermost first, then by header position. A back edge is an edge to a dominator. */
export function findLoops(f: Func, cfg: Cfg): Loop[] {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const byHeader = new Map<number, Loop>();
  for (const at of cfg.rpo) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const h = index.get(e.block);
      if (h === undefined || !dominates(cfg, h, at)) continue;
      let l = byHeader.get(h);
      if (l === undefined) {
        l = { header: h, blocks: new Set([h]), latches: [], depth: 1 };
        byHeader.set(h, l);
      }
      l.latches.push(at);
      // Everything that reaches the latch without passing the header.
      const stack = [at];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (l.blocks.has(x)) continue;
        l.blocks.add(x);
        for (const p of cfg.preds[x]!) stack.push(p);
      }
    }
  }
  const loops = [...byHeader.values()];
  for (const l of loops) {
    l.depth =
      loops.filter((o) => o !== l && o.blocks.has(l.header) && o.blocks.size > l.blocks.size)
        .length + 1;
  }
  loops.sort((a, b) => b.depth - a.depth || a.header - b.header);
  return loops;
}

/**
 * The loop's preheader: the one block outside it that jumps to its header, and only there. Made where there isn't one, as a
 * block taking the header's parameters, that the edges from outside go to instead. Returns the preheader's block id. The
 * caller rebuilds its CFG after a block is made.
 */
export function ensurePreheader(f: Func, cfg: Cfg, l: Loop): { id: number; made: boolean } {
  const h = f.blocks[l.header]!;
  const outside = cfg.preds[l.header]!.filter((p) => !l.blocks.has(p));
  const uniq = [...new Set(outside)];
  if (uniq.length === 1 && outside.length === 1) {
    const p = f.blocks[uniq[0]!]!;
    if (p.term.k === "br" && p.term.to.block === h.id) return { id: p.id, made: false };
  }
  const id = newBlockId(f);
  const params = h.params.map((v) => newValue(f, f.types[v]!));
  const pre: Block = {
    id,
    params,
    instrs: [],
    // Its own array: a pass changing the edge's arguments mustn't change the block's parameters.
    term: { k: "br", to: { block: h.id, args: [...params] } },
  };
  for (const at of uniq) {
    for (const e of edgesOf(f.blocks[at]!.term)) if (e.block === h.id) e.block = id;
  }
  f.blocks.push(pre);
  return { id, made: true };
}

/** Every edge leaving the loop, with the position of the block it leaves from. */
export function exitEdges(
  f: Func,
  l: Loop,
  index: Map<number, number>,
): { from: number; e: Edge }[] {
  const out: { from: number; e: Edge }[] = [];
  for (const at of l.blocks) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const to = index.get(e.block);
      if (to !== undefined && !l.blocks.has(to)) out.push({ from: at, e });
    }
  }
  return out;
}

export { buildCfg };
