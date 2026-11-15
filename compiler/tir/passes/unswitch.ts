// Loop unswitching and peeling (SPEC 4.3, D73), both by copying a loop.
//
// Unswitching: a loop that branches on a value it doesn't change, a class test of an object it reads say, becomes two
// loops, one for each way, chosen once before it. Each copy's branches on that value are jumps, and folding and the cleanup
// take out what the other way needed, so what was loop-invariant only on one way (a string's length, behind its class test)
// moves out too. Nothing runs that didn't, and nothing in another order: the test was invariant, so it goes the same way on
// every turn, and the copy chosen is the loop as it would have run. The condition is a value computed before the loop,
// where licm.ts moved it, so testing it there runs nothing new.
//
// Peeling: a loop whose every turn loads something nothing in it writes, where the load can't move out because the loop
// may run no turn (licm.ts), has its first turn copied in front of it. The copy is the first turn exactly, and the loop
// runs the rest, so nothing runs that didn't. Every later turn finds what the first loaded already loaded, at the same
// address with nothing written since, and value numbering uses it, as it would for any load done before (gvn.ts): a chain
// walk's array lengths are read once a lookup, not once a step.
//
// Only a loop small enough is copied, and only so much in a function, at -O2: copies are code.
import {
  buildCfg,
  edgesOf,
  reversePostorder,
  type Block,
  type Cfg,
  type Edge,
  type Func,
  type Instr,
} from "../ir.ts";
import { dominates, ensurePreheader, findLoops, type Loop } from "./loops.ts";
import {
  addrOf,
  accessBytes,
  isInvariantLoad,
  isPlainLoad,
  memEffect,
  writeChanges,
  type Addr,
} from "./memory.ts";
import {
  cloneInstr,
  effectOf,
  instrCost,
  newBlockId,
  newValue,
  termCost,
  valueOps,
} from "./util.ts";

export interface UnswitchStats {
  loops: number; // loops unswitched
  peeled: number; // loops with their first turn copied in front
  cost: number; // what the copies cost, in D46's units
}

export interface UnswitchLimits {
  loopCost: number; // the most a loop may cost to be unswitched
  peelCost: number; // the most a loop may cost to be peeled
  funcGrowth: number; // the most copies may add to a function, in all
}

export interface CopyContext {
  deadAtO0: WeakSet<Instr>;
  readonly: ReadonlySet<string>;
  stats: UnswitchStats;
  limits: UnswitchLimits;
  unswitch: boolean;
  peel: boolean;
}

export function unswitchFunc(f: Func, ctx: CopyContext): boolean {
  let grown = 0;
  let changed = false;
  const peeled = new Set<number>(); // headers peeled already, by block id: the loop left behind has the same header
  for (let tries = 0; tries < 16; tries++) {
    const cfg = buildCfg(f);
    const loops = findLoops(f, cfg);
    let done = false;
    for (const l of loops) {
      const c = loopCost(f, l);
      if (grown + c > ctx.limits.funcGrowth) continue;
      if (ctx.unswitch && c <= ctx.limits.loopCost && unswitchLoop(f, l, ctx.deadAtO0)) {
        ctx.stats.loops++;
      } else if (
        ctx.peel &&
        c <= ctx.limits.peelCost &&
        !peeled.has(f.blocks[l.header]!.id) &&
        peelable(f, cfg, l, ctx) &&
        peelLoop(f, l, ctx.deadAtO0)
      ) {
        peeled.add(f.blocks[l.header]!.id);
        ctx.stats.peeled++;
      } else continue;
      grown += c;
      ctx.stats.cost += c;
      changed = true;
      done = true;
      break;
    }
    if (!done) break;
  }
  return changed;
}

function loopCost(f: Func, l: Loop): number {
  let c = 0;
  for (const at of l.blocks) {
    const b = f.blocks[at]!;
    for (const ins of b.instrs) c += instrCost(ins);
    c += termCost(b.term);
  }
  return c;
}

function definedIn(f: Func, blocks: Set<number>): Set<number> {
  const s = new Set<number>();
  for (const at of blocks) {
    const b = f.blocks[at]!;
    for (const p of b.params) s.add(p);
    for (const ins of b.instrs) for (const r of ins.res) s.add(r);
  }
  return s;
}

/**
 * What copying a loop needs to know: the region copied, which is the loop and the blocks after it that end the function (a
 * trap, a return) that only it reaches; the one block outside it that it jumps to, if any; and what it defines that's used
 * after it, which a merge block before the exit passes on, one parameter each.
 */
interface Region {
  index: Map<number, number>;
  blocks: Set<number>;
  defined: Set<number>;
  exit: number | null; // position
  shared: boolean; // the exit is reached from elsewhere too
  usedAfter: number[];
}

function regionOf(f: Func, l: Loop): Region | null {
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const preds: number[][] = f.blocks.map(() => []);
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) {
      const to = index.get(e.block);
      if (to !== undefined) preds[to]!.push(i);
    }
  });
  const blocks = new Set(l.blocks);
  for (const at of l.blocks) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const to = index.get(e.block)!;
      if (blocks.has(to)) continue;
      const b = f.blocks[to]!;
      if (edgesOf(b.term).length === 0 && preds[to]!.every((p) => l.blocks.has(p))) blocks.add(to);
    }
  }
  let exit: number | null = null;
  for (const at of blocks) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const to = index.get(e.block)!;
      if (blocks.has(to)) continue;
      if (exit !== null && exit !== to) return null;
      exit = to;
    }
  }
  // An exit reached from elsewhere too can't be dominated by anything the region defines, so nothing it defines is used
  // after it, and a copy's edges go straight there.
  const shared = exit !== null && !preds[exit]!.every((p) => blocks.has(p));
  const defined = definedIn(f, blocks);
  const usedAfter: number[] = [];
  const seen = new Set<number>();
  const use = (v: number): void => {
    if (defined.has(v) && !seen.has(v)) {
      seen.add(v);
      usedAfter.push(v);
    }
  };
  f.blocks.forEach((b, i) => {
    if (blocks.has(i)) return;
    for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "v") use(o.id);
    const t = b.term;
    if (t.k === "brif") use(t.cond);
    else if (t.k === "switch") use(t.val);
    else if (t.k === "ret") t.vals.forEach(use);
    for (const e of edgesOf(t)) e.args.forEach(use);
  });
  if (usedAfter.length > 0 && (exit === null || shared)) return null;
  return { index, blocks, defined, exit, shared, usedAfter };
}

/**
 * Copies the region. The copy's edges to the region's blocks go to their copies, except where `headerTo` says where the
 * copy's edges to the header go instead. Edges to the exit, from both, go through a merge block made here that passes on
 * what the region defines that's used after it, and those uses read the merge's parameters. Returns the copies, by the
 * original's block id. The caller adds an edge into the copy and pushes nothing: the blocks are added here.
 */
function copyRegion(
  f: Func,
  r: Region,
  header: number,
  deadAtO0: WeakSet<Instr>,
  headerTo: number | null,
): Map<number, Block> {
  const vmap = new Map<number, number>();
  for (const v of r.defined) vmap.set(v, newValue(f, f.types[v]!));
  const mv = (v: number): number => vmap.get(v) ?? v;
  const bmap = new Map<number, number>();
  let next = newBlockId(f);
  for (const at of r.blocks) bmap.set(f.blocks[at]!.id, next++);
  const headerId = f.blocks[header]!.id;
  const exitBlock = r.exit !== null ? f.blocks[r.exit]! : null;
  let merge: Block | null = null;
  if (exitBlock !== null && !r.shared) {
    const params = [
      ...exitBlock.params.map((p) => newValue(f, f.types[p]!)),
      ...r.usedAfter.map((v) => newValue(f, f.types[v]!)),
    ];
    merge = {
      id: next++,
      params,
      instrs: [],
      term: {
        k: "br",
        to: { block: exitBlock.id, args: params.slice(0, exitBlock.params.length) },
      },
    };
  }
  const toExit = (e: Edge, copy: boolean): void => {
    if (merge === null || e.block !== exitBlock!.id) return;
    e.block = merge.id;
    e.args = [...e.args, ...r.usedAfter.map((v) => (copy ? mv(v) : v))];
  };
  const copies = new Map<number, Block>();
  for (const at of [...r.blocks].sort((a, b) => a - b)) {
    const b = f.blocks[at]!;
    const instrs = b.instrs.map((ins) => {
      const c = cloneInstr(ins);
      for (const o of c.ops) if (o.t === "v") o.id = mv(o.id);
      c.res = c.res.map(mv);
      if (deadAtO0.has(ins)) deadAtO0.add(c);
      return c;
    });
    const t = structuredClone(b.term);
    if (t.k === "brif") t.cond = mv(t.cond);
    else if (t.k === "switch") t.val = mv(t.val);
    else if (t.k === "ret") t.vals = t.vals.map(mv);
    for (const e of edgesOf(t)) {
      e.args = e.args.map(mv);
      if (e.block === headerId && headerTo !== null) e.block = headerTo;
      else {
        const to = bmap.get(e.block);
        if (to !== undefined) e.block = to;
        else toExit(e, true);
      }
    }
    copies.set(b.id, { id: bmap.get(b.id)!, params: b.params.map(mv), instrs, term: t });
  }
  for (const at of r.blocks) for (const e of edgesOf(f.blocks[at]!.term)) toExit(e, false);
  if (merge !== null) {
    const sub = new Map<number, number>();
    r.usedAfter.forEach((v, i) => sub.set(v, merge.params[exitBlock!.params.length + i]!));
    f.blocks.forEach((b, i) => {
      if (r.blocks.has(i)) return;
      for (const ins of b.instrs)
        for (const o of ins.ops) if (o.t === "v") o.id = sub.get(o.id) ?? o.id;
      const t = b.term;
      if (t.k === "brif") t.cond = sub.get(t.cond) ?? t.cond;
      else if (t.k === "switch") t.val = sub.get(t.val) ?? t.val;
      else if (t.k === "ret") t.vals = t.vals.map((v) => sub.get(v) ?? v);
      for (const e of edgesOf(t)) e.args = e.args.map((v) => sub.get(v) ?? v);
    });
  }
  f.blocks.push(...copies.values());
  if (merge !== null) f.blocks.push(merge);
  return copies;
}

function dropUnreachable(f: Func): void {
  const live = new Set(reversePostorder(f));
  f.blocks = f.blocks.filter((_, i) => live.has(i));
}

function unswitchLoop(f: Func, l: Loop, deadAtO0: WeakSet<Instr>): boolean {
  const inLoop = definedIn(f, l.blocks);
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  // A branch in the loop on a value from outside it, or on one it computes purely from values from outside it (licm.ts
  // leaves a cheap compare, and its constant, in the loop): the first in block order.
  const defs = new Map<number, { ins: Instr; at: number }>();
  for (const at of l.blocks)
    for (const ins of f.blocks[at]!.instrs) for (const r of ins.res) defs.set(r, { ins, at });
  const memo = new Map<number, boolean>();
  const outside = (v: number, depth = 0): boolean => {
    if (!inLoop.has(v)) return true;
    const known = memo.get(v);
    if (known !== undefined) return known;
    const d = defs.get(v);
    const ok =
      depth < 8 &&
      d !== undefined &&
      effectOf(d.ins) === "pure" &&
      valueOps(d.ins).every((x) => outside(x, depth + 1));
    memo.set(v, ok);
    return ok;
  };
  let branchAt = -1;
  for (const at of [...l.blocks].sort((a, b) => a - b)) {
    const t = f.blocks[at]!.term;
    if (t.k !== "brif" || !outside(t.cond)) continue;
    const a = index.get(t.t.block);
    const b = index.get(t.f.block);
    // A branch with both ways leaving the loop is the loop's own exit, decided once anyway.
    if (a !== undefined && b !== undefined && !l.blocks.has(a) && !l.blocks.has(b)) continue;
    if (t.t.block === t.f.block) continue;
    branchAt = at;
    break;
  }
  if (branchAt < 0) return false;
  const r = regionOf(f, l);
  if (r === null) return false;
  const t0 = f.blocks[branchAt]!.term;
  if (t0.k !== "brif") return false;
  const cond = t0.cond;
  const header = f.blocks[l.header]!;
  const pre = ensurePreheader(f, buildCfg(f), l);
  const preBlock = f.blocks.find((b) => b.id === pre.id)!;
  // What the condition is computed from in the loop moves to the preheader first, in order: pure, of values from outside
  // it, so the preheader can test it, and it dominates every use in the loop from there.
  const chain: Instr[] = [];
  const seen = new Set<number>();
  const collect = (v: number): void => {
    if (!inLoop.has(v) || seen.has(v)) return;
    seen.add(v);
    const d = defs.get(v)!;
    for (const x of valueOps(d.ins)) collect(x);
    chain.push(d.ins);
  };
  collect(cond);
  const lifted = new Set(chain);
  for (const at of l.blocks) {
    const b = f.blocks[at]!;
    if (b.instrs.some((x) => lifted.has(x))) b.instrs = b.instrs.filter((x) => !lifted.has(x));
  }
  preBlock.instrs.push(...chain);
  for (const ins of chain) for (const res of ins.res) r.defined.delete(res);
  // What moved is the preheader's now, which dominates every use after the loop too: no merge passes it on (a value
  // numbered in the loop and used after it, a class test's tag shared by two loops, was, and the preheader's own copy of
  // it then read the merge's parameter: R1b, corpus/std/rc_tails.ts).
  r.usedAfter = r.usedAfter.filter((v) => r.defined.has(v));
  const copies = copyRegion(f, r, l.header, deadAtO0, null);
  // Each copy's branches on the condition are now jumps: the original's go the true way, the copy's the false way.
  for (const at of r.blocks) {
    const b = f.blocks[at]!;
    if (b.term.k === "brif" && b.term.cond === cond) b.term = { k: "br", to: b.term.t };
  }
  for (const b of copies.values()) {
    if (b.term.k === "brif" && b.term.cond === cond) b.term = { k: "br", to: b.term.f };
  }
  // The preheader chooses.
  const into = preBlock.term;
  if (into.k !== "br" || into.to.block !== header.id)
    throw new Error("unswitch: the preheader doesn't jump to the header");
  preBlock.term = {
    k: "brif",
    cond,
    t: into.to,
    f: { block: copies.get(header.id)!.id, args: [...into.to.args] },
  };
  dropUnreachable(f);
  return true;
}

/**
 * Worth peeling: a load in the loop that nothing in it may write, at an address from outside it, that ran at -O0, on every
 * way round (its block dominates every latch), which licm.ts couldn't move because the loop may run no turn.
 */
function peelable(f: Func, cfg: Cfg, l: Loop, ctx: CopyContext): boolean {
  const defs = new Map<number, Instr>();
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) defs.set(r, ins);
  const inLoop = definedIn(f, l.blocks);
  const stores: { addr: Addr; size: number }[] = [];
  let all = false;
  for (const at of l.blocks) {
    for (const ins of f.blocks[at]!.instrs) {
      const e = memEffect(ins, ctx.readonly);
      if (e === "all") all = true;
      else if (e === "store")
        stores.push({ addr: addrOf(defs, valueOps(ins)[0]!), size: accessBytes(ins.op) });
    }
  }
  // Invariant: from outside the loop, or a pure operation in it of invariant values (licm.ts leaves cheap ones there).
  const memo = new Map<number, boolean>();
  const invariant = (v: number, depth = 0): boolean => {
    if (!inLoop.has(v)) return true;
    const known = memo.get(v);
    if (known !== undefined) return known;
    const d = defs.get(v);
    const ok =
      depth < 8 &&
      d !== undefined &&
      effectOf(d) === "pure" &&
      valueOps(d).every((x) => invariant(x, depth + 1));
    memo.set(v, ok);
    return ok;
  };
  for (const at of l.blocks) {
    if (!l.latches.every((x) => dominates(cfg, at, x))) continue;
    for (const ins of f.blocks[at]!.instrs) {
      if (!isPlainLoad(ins) || ctx.deadAtO0.has(ins)) continue;
      const p = valueOps(ins)[0]!;
      if (!invariant(p)) continue;
      const a = addrOf(defs, p);
      if (a.ident) continue; // licm.ts moves those
      // A loop that writes everything leaves only a class id's load unwritten (memory.ts).
      const inv = isInvariantLoad(ins);
      if (all && !inv) continue;
      const s = accessBytes(ins.op);
      if (!stores.some((w) => writeChanges(a, s, inv, w))) return true;
    }
  }
  return false;
}

function peelLoop(f: Func, l: Loop, deadAtO0: WeakSet<Instr>): boolean {
  const r = regionOf(f, l);
  if (r === null) return false;
  const header = f.blocks[l.header]!;
  const pre = ensurePreheader(f, buildCfg(f), l);
  const preBlock = f.blocks.find((b) => b.id === pre.id)!;
  // The copy is the first turn: its way round goes on to the loop.
  const copies = copyRegion(f, r, l.header, deadAtO0, header.id);
  const into = preBlock.term;
  if (into.k !== "br" || into.to.block !== header.id)
    throw new Error("peel: the preheader doesn't jump to the header");
  into.to.block = copies.get(header.id)!.id;
  dropUnreachable(f);
  return true;
}
