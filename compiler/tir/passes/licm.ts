// Loop-invariant code motion (SPEC 4.3, D73): what computes the same thing on every turn of a loop is computed once,
// before it, in the loop's preheader.
//
// - A pure operation whose operands are defined outside the loop, or were moved out, moves out from anywhere in the loop.
//   It can't trap or fault, so running it where the loop runs no turn changes nothing but time.
// - A load moves out where its address is invariant and nothing in the loop may write its bytes (memory.ts): no store that
//   may alias it, and no call, atomic or anything else that may write anywhere. A load from a global or a frame slot can't
//   fault, and moves from anywhere in the loop. Any other load can fault, which is a trap (6), so it moves only where -O0
//   runs it first on entering the loop: on the path every first turn takes from the header, with nothing before it on that
//   path that can trap or has an effect, only pure operations and other loads (a fault is a fault, at either load). Then
//   the moved load faults where -O0's first would have, and every later turn's load, at the same address, would never.
//   A load -O0 dropped (keep.ts) isn't moved: it didn't run. A class id's load (`load.T.inv`) is written only by a store at
//   its own base over its bytes (memory.ts), so a loop's calls and other stores don't keep it in; where it may fault, it
//   moves by the same first-turn rule.
// - A check moves out the same way as such a load, with only pure operations before it on that path, so its trap is the
//   first thing that could happen, as at -O0, and where it passes once, with the same operands it passes every turn.
// The path every first turn takes goes on from a block through an unconditional jump, and through a branch whose way the
// caller proves from what holds on entering (`entry`), never past one it can't.
import { buildCfg, type Block, type Cfg, type Func, type Instr, type Term } from "../ir.ts";
import { ensurePreheader, findLoops, type Loop } from "./loops.ts";
import {
  addrOf,
  accessBytes,
  isInvariantLoad,
  isPlainLoad,
  memEffect,
  writeChanges,
  type Addr,
} from "./memory.ts";
import { effectOf, opParts, valueOps } from "./util.ts";

export interface LicmStats {
  pure: number;
  loads: number;
  checks: number;
}

export interface LicmFaults {
  /** Injected (D73): the loop's stores aren't seen, so a load the loop writes to moves out of it. */
  ignoreStores?: boolean;
  /** Injected (D73): the first-turn path goes on past the header's test, so a load that can fault moves above the guard. */
  pastGuard?: boolean;
}

export interface LicmContext {
  readonly: ReadonlySet<string>;
  deadAtO0: WeakSet<Instr>;
  stats: LicmStats;
  faults?: LicmFaults;
  /**
   * Which way a branch goes on the first turn, where that's proved from what holds on every edge into the loop: the block's
   * position of the branch's successor taken. Null where it isn't proved.
   */
  firstTurn?: (f: Func, cfg: Cfg, at: number, l: Loop) => number | null;
}

/** Most loops looked at in one function, and most blocks on a first turn's path: bounds on the time. */
const MAX_LOOPS = 200;
const MAX_PATH = 32;

export function licmFunc(f: Func, ctx: LicmContext): boolean {
  let changed = false;
  for (let li = 0; li < MAX_LOOPS; li++) {
    const cfg = buildCfg(f);
    const loops = findLoops(f, cfg);
    const l = loops[li];
    if (l === undefined) break;
    if (hoistLoop(f, l, ctx)) changed = true;
  }
  return changed;
}

function hoistLoop(f: Func, l0: Loop, ctx: LicmContext): boolean {
  // Is there anything to move? Nothing is made unless there is.
  const defs = new Map<number, Instr>();
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) defs.set(r, ins);
  const inLoop = new Set<number>();
  let all = false;
  const stores: { addr: Addr; size: number }[] = [];
  for (const at of l0.blocks) {
    const b = f.blocks[at]!;
    for (const p of b.params) inLoop.add(p);
    for (const ins of b.instrs) {
      for (const r of ins.res) inLoop.add(r);
      const e = memEffect(ins, ctx.readonly);
      if (e === "all") all = true;
      else if (e === "store" && ctx.faults?.ignoreStores !== true)
        stores.push({ addr: addrOf(defs, valueOps(ins)[0]!), size: accessBytes(ins.op) });
    }
  }
  const moved = new Set<number>();
  const invariant = (ins: Instr): boolean => {
    for (const o of ins.ops) if (o.t === "v" && inLoop.has(o.id) && !moved.has(o.id)) return false;
    return true;
  };
  const unwritten = (ins: Instr): boolean => {
    const inv = isInvariantLoad(ins);
    if (all && writeChanges(addrOf(defs, valueOps(ins)[0]!), 0, inv, "all")) return false;
    const a = addrOf(defs, valueOps(ins)[0]!);
    const s = accessBytes(ins.op);
    return !stores.some((w) => writeChanges(a, s, inv, w));
  };
  const pick: Instr[] = [];
  const take = (ins: Instr): void => {
    pick.push(ins);
    for (const r of ins.res) moved.add(r);
  };

  // The first turn's path, from the header, while only pure operations and loads have run on it.
  const cfg = buildCfg(f);
  const l = l0;
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  let at: number | null = l.header;
  let stage: "pure" | "loads" = "pure";
  const onPath = new Set<number>();
  for (let steps = 0; at !== null && steps < MAX_PATH; steps++) {
    onPath.add(at);
    const b: Block = f.blocks[at]!;
    let blocked = false;
    for (const ins of b.instrs) {
      const eff = effectOf(ins);
      if (eff === "pure") {
        if (invariant(ins)) take(ins);
        continue;
      }
      if (eff === "load" && isPlainLoad(ins)) {
        if (invariant(ins) && unwritten(ins) && !ctx.deadAtO0.has(ins)) {
          take(ins);
          ctx.stats.loads++;
        } else stage = "loads";
        continue;
      }
      if (eff === "check" && opParts(ins.op)[0] !== "gen" && stage === "pure" && invariant(ins)) {
        take(ins);
        ctx.stats.checks++;
        continue;
      }
      blocked = true;
      break;
    }
    if (blocked) break;
    const t: Term = b.term;
    let next: number | null = null;
    if (t.k === "br") next = index.get(t.to.block) ?? null;
    else if (t.k === "brif") {
      if (ctx.faults?.pastGuard === true) {
        const a = index.get(t.t.block);
        const c = index.get(t.f.block);
        next =
          a !== undefined && l.blocks.has(a) ? a : c !== undefined && l.blocks.has(c) ? c : null;
      } else if (ctx.firstTurn !== undefined && worthPast(f, t, index, l, invariant)) {
        next = ctx.firstTurn(f, cfg, at, l);
      }
    }
    if (next === null || !l.blocks.has(next) || next === l.header || onPath.has(next)) break;
    at = next;
  }

  // Pure operations from anywhere in the loop, in reverse postorder so an operand moves before what uses it; and loads that
  // can't fault, from a global or a frame slot.
  for (const pos of cfg.rpo) {
    if (!l.blocks.has(pos)) continue;
    for (const ins of f.blocks[pos]!.instrs) {
      if (moved.has(ins.res[0] ?? -1)) continue;
      const eff = effectOf(ins);
      if (eff === "pure" && ins.res.length > 0 && invariant(ins)) take(ins);
      else if (eff === "load" && isPlainLoad(ins) && invariant(ins) && unwritten(ins)) {
        if (addrOf(defs, valueOps(ins)[0]!).ident) {
          take(ins);
          ctx.stats.loads++;
        }
      }
    }
  }
  // A cheap pure operation moves only where something worth moving needs it: out of the loop it stays live across all of
  // it, and a register held for one instruction a turn spills others (the JPEG decoder's scan, MEASURED in M5's phase B
  // record). What's worth moving: a load, a check, and pure arithmetic dearer than one instruction.
  {
    const needed = new Set<Instr>();
    const defs2 = new Map<number, Instr>();
    for (const ins of pick) for (const r of ins.res) defs2.set(r, ins);
    const stack = pick.filter((ins) => !cheap(ins, defs));
    while (stack.length > 0) {
      const ins = stack.pop()!;
      if (needed.has(ins)) continue;
      needed.add(ins);
      for (const v of valueOps(ins)) {
        const d = defs2.get(v);
        if (d !== undefined) stack.push(d);
      }
    }
    for (let i = pick.length - 1; i >= 0; i--) if (!needed.has(pick[i]!)) pick.splice(i, 1);
  }
  if (pick.length === 0) return false;
  const pre = ensurePreheader(f, cfg, l);
  const picked = new Set(pick);
  for (const pos of l.blocks) {
    const b = f.blocks[pos]!;
    b.instrs = b.instrs.filter((ins) => !picked.has(ins));
  }
  // In the order taken: the first turn's path first, in its order, then the rest in reverse postorder. Each one's operands
  // were outside the loop or taken before it.
  const p = f.blocks.find((b) => b.id === pre.id)!;
  p.instrs.push(...pick);
  for (const ins of pick) if (effectOf(ins) === "pure") ctx.stats.pure++;
  return true;
}

/**
 * Whether going on past a branch could move anything: an in-loop way whose first instruction that isn't pure is a check or
 * a load with operands from outside the loop. The proof of which way the first turn goes isn't asked for otherwise.
 */
function worthPast(
  f: Func,
  t: Term,
  index: Map<number, number>,
  l: Loop,
  invariant: (ins: Instr) => boolean,
): boolean {
  if (t.k !== "brif") return false;
  for (const e of [t.t, t.f]) {
    const at = index.get(e.block);
    if (at === undefined || !l.blocks.has(at)) continue;
    for (const ins of f.blocks[at]!.instrs) {
      const eff = effectOf(ins);
      if (eff === "pure") continue;
      if ((eff === "check" || eff === "load") && invariant(ins)) return true;
      break;
    }
  }
  return false;
}

/**
 * A pure operation the backend does in one instruction or none: a constant, a rename, an address at a constant offset, a
 * compare, or arithmetic with a constant. Loads, checks, and other arithmetic aren't.
 */
function cheap(ins: Instr, defs: Map<number, Instr>): boolean {
  if (effectOf(ins) !== "pure") return false;
  const b = opParts(ins.op)[0]!;
  if (
    b === "iconst" ||
    b === "fconst" ||
    b === "globaladdr" ||
    b === "funcaddr" ||
    b === "bitcast" ||
    b === "zext" ||
    b === "sext" ||
    b === "trunc" ||
    b === "ref" ||
    b === "icmp" ||
    b === "gep"
  )
    return true;
  if (
    b === "add" ||
    b === "sub" ||
    b === "and" ||
    b === "or" ||
    b === "xor" ||
    b === "shl" ||
    b === "lshr" ||
    b === "ashr"
  ) {
    return valueOps(ins).some((v) => defs.get(v)?.op.startsWith("iconst.") === true);
  }
  return false;
}
