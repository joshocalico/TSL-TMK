// The inliner (SPEC 4.3, D46). Bottom-up over the call graph: a function's callees are inlined into it and it's cleaned up
// before anything that calls it measures it. What it inlines, and why, is the cost model in D46:
//
//  - Never: a call into the caller's own cycle of the call graph (recursion, at any depth), `@tsl.noinline`, a function that
//    must stay a real function in the shape it was written (`export_c`, `section`), a callee without the caller's `noalloc`
//    or `nosleep`, or a callee with frame slots into a caller in a cycle, whose frames would grow at every level.
//  - Always, up to a hard cap: `@tsl.inline`.
//  - -O1: a callee no bigger than the call it replaces, and (B3) at a call in a loop one that calls nothing up to a cost of
//    16, so a caller grows by at most a few instructions a hot site, within the growth limit.
//  - -O2: a callee up to a threshold of 40, plus 20 for a leaf, 8 for each constant argument, doubled at a call in a loop,
//    and 400 for the one call site of a function nothing else can reach. The caller may grow to 4 times its size, or by
//    600, whichever is more.
//  - -O2, too big for that: its side-effect-free entry (checks, loads, arithmetic) and every path from there that makes no
//    call are inlined, and every other path calls the whole function from the start, which is correct because nothing done
//    before that point changed any state. This is how an allocator's or a counter's fast path is inlined and its slow path
//    isn't.
//
// An exported function keeps its body and its symbol: a copy is inlined, never the function. No function is removed here;
// the image linker drops what nothing reaches.
import { removeUnreachable } from "./cfg.ts";
import { buildCfg, edgesOf, type Block, type Func, type Instr, type Module } from "../ir.ts";
import {
  calleeOf,
  cloneInstr,
  cloneTerm,
  costOf,
  effectOf,
  instrCost,
  newBlockId,
  newValue,
  r26Off,
  r28Off,
  termCost,
  valueOps,
} from "./util.ts";

export type OptLevel = 0 | 1 | 2;

export interface Remark {
  caller: string;
  callee: string;
  how: "inlined" | "partial" | "not inlined" | "devirtualized";
  why: string;
  cost?: number;
  threshold?: number;
}

export interface InlineStats {
  sitesBefore: number;
  inlined: number;
  partial: number;
  devirtualized: number;
  refused: number;
}

export interface InlineFaults {
  swapArgs?: boolean; // the first two parameters of the same type swapped
  dropCheck?: boolean; // an inlined check becomes its operand, so its trap can't happen
  retOrder?: boolean; // a callee's results reversed
  impurePrefix?: boolean; // partial inlining treats stores as free of effects, so a bail runs them twice
  dropRcStore?: boolean; // the first store of an inlined `__rc_` function is left out: a count missed
  allocaPure?: boolean; // R20: a block with a frame slot taken as free of effects whatever comes after the slot
  dropAnyStore?: boolean; // R28: the bug above's means, set for that one copy
  shrinkStore?: boolean; // R28: a callee only the no-growth rule lets in copied without its first store
  inbAny?: boolean; // R29: a callee's leading bounds check taken out of every call's copy, not only a call proved in bounds
}

export interface InlineContext {
  level: OptLevel;
  remarks: Remark[];
  stats: InlineStats;
  cleanup: (f: Func) => void;
  afterInline?: (f: Func) => void;
  partial?: boolean;
  devirtualize?: boolean;
  /** Instructions the backend would have dropped at -O0, so a copy is marked the same (see keep.ts). */
  deadAtO0: WeakSet<Instr>;
  faults: InlineFaults;
  /** Calls partial inlining left for the slow path: inlining them again would only nest the fast path. */
  slowPath?: WeakSet<Instr>;
  /** For a call copied in by inlining, the functions whose copies it's inside: inlining any of them again is recursion. */
  chain?: WeakMap<Instr, readonly string[]>;
}

const NEVER_ATTRS = ["noinline", "export_c", "section"];
const HARD_CAP = 30_000; // a caller's cost, whatever the attributes say
const FRAME_CAP = 64 * 1024; // frame slots a caller may gain
const BASE = 16;
const LEAF_BONUS = 8;
const CONST_ARG_BONUS = 4;
const LOOP_FACTOR = 3;
const SINGLE_SITE = 200;
const GROWTH_FACTOR = 2;
const GROWTH_ADD = 150;
const FORCED = 2_000; // `@tsl.inline`: the callee's own size limit
const O1_LEAF = 16; // -O1: a callee that calls nothing, up to this cost (B3)

function callOverhead(g: Func): number {
  return 4 + g.params.length + g.rets.length;
}

function isLeaf(g: Func): boolean {
  for (const b of g.blocks)
    for (const ins of b.instrs) if (ins.op === "call" || ins.op === "call.indirect") return false;
  return true;
}

function allocaBytes(f: Func): number {
  let n = 0;
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op === "alloca") {
        const o = ins.ops[0];
        if (o?.t === "i") n += Number(o.val);
      }
    }
  }
  return n;
}

/** `call.indirect` through a pointer that is a known function's address becomes a direct call. */
export function devirtualize(
  m: Module,
  f: Func,
  byName: Map<string, Func>,
  ctx: InlineContext,
): boolean {
  const addr = new Map<number, string>();
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op === "funcaddr" && ins.ops[0]?.t === "sym") addr.set(ins.res[0]!, ins.ops[0].name);
    }
  }
  if (addr.size === 0) return false;
  let changed = false;
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op !== "call.indirect") continue;
      const s = ins.ops[0];
      const p = ins.ops[1];
      if (s?.t !== "sig" || p?.t !== "v") continue;
      const name = addr.get(p.id);
      if (name === undefined) continue;
      const g = byName.get(name);
      const sig = m.sigs[s.id];
      if (g === undefined || sig === undefined) continue;
      const params = g.params.map((x) => g.types[x]!);
      const same =
        params.length === sig.params.length &&
        params.every((t, i) => t === sig.params[i]) &&
        g.rets.length === sig.rets.length &&
        g.rets.every((t, i) => t === sig.rets[i]);
      if (!same) continue;
      ins.op = "call";
      ins.ops = [{ t: "sym", name }, ...ins.ops.slice(2)];
      ctx.stats.devirtualized++;
      ctx.remarks.push({
        caller: f.name,
        callee: name,
        how: "devirtualized",
        why: "the pointer is that function's address",
      });
      changed = true;
    }
  }
  return changed;
}

/** Strongly connected components of the direct call graph, callees' components before their callers'. */
export function callSccs(funcs: Func[]): Func[][] {
  const byName = new Map<string, number>();
  funcs.forEach((f, i) => byName.set(f.name, i));
  const succ: number[][] = funcs.map((f) => {
    const out: number[] = [];
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        const c = calleeOf(ins);
        const j = c !== undefined ? byName.get(c) : undefined;
        if (j !== undefined) out.push(j);
      }
    }
    return out;
  });
  // Tarjan's algorithm, with an explicit stack.
  const index = new Int32Array(funcs.length).fill(-1);
  const low = new Int32Array(funcs.length);
  const onStack = new Uint8Array(funcs.length);
  const stack: number[] = [];
  const out: Func[][] = [];
  let next = 0;
  for (let root = 0; root < funcs.length; root++) {
    if (index[root] !== -1) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const s = succ[top.v]!;
      if (top.i < s.length) {
        const w = s[top.i++]!;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          work.push({ v: w, i: 0 });
        } else if (onStack[w] === 1) low[top.v] = Math.min(low[top.v]!, index[w]!);
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.v;
          low[parent] = Math.min(low[parent]!, low[top.v]!);
        }
        if (low[top.v] === index[top.v]) {
          const comp: Func[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack[w] = 0;
            comp.push(funcs[w]!);
            if (w === top.v) break;
          }
          out.push(comp);
        }
      }
    }
  }
  return out;
}

/** Blocks inside a loop, by id: those on a cycle through a back edge to a dominating header. */
/**
 * -O1's cheap stand-in for loopBlocks (B3): a block between a backward edge's target and its source, in the blocks' order.
 * One pass and no dominators, as -O1 has to stay within 25% of -O0's compile time; where the order isn't reverse postorder
 * it only misjudges which calls are hot, never what's correct.
 */
function spannedBlocks(f: Func): Set<number> {
  const at = new Map<number, number>();
  f.blocks.forEach((b, i) => at.set(b.id, i));
  const delta = new Int32Array(f.blocks.length + 1);
  f.blocks.forEach((b, i) => {
    for (const e of edgesOf(b.term)) {
      const j = at.get(e.block)!;
      if (j <= i) {
        delta[j]!++;
        delta[i + 1]!--;
      }
    }
  });
  const out = new Set<number>();
  let depth = 0;
  f.blocks.forEach((b, i) => {
    depth += delta[i]!;
    if (depth > 0) out.add(b.id);
  });
  return out;
}

function loopBlocks(f: Func): Set<number> {
  const cfg = buildCfg(f);
  const out = new Set<number>();
  const dominates = (a: number, b: number): boolean => {
    let cur = b;
    for (let guard = 0; guard <= f.blocks.length; guard++) {
      if (cur === a) return true;
      const up = cfg.idom.get(cur);
      if (up === undefined || up === cur) return false;
      cur = up;
    }
    return false;
  };
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  for (const at of cfg.rpo) {
    for (const e of edgesOf(f.blocks[at]!.term)) {
      const h = index.get(e.block)!;
      if (!dominates(h, at)) continue;
      const seen = new Set<number>([h]);
      const stack = [at];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const p of cfg.preds[x]!) stack.push(p);
      }
      for (const x of seen) out.add(f.blocks[x]!.id);
    }
  }
  return out;
}

/** The part of a callee partial inlining copies, or null if there's no such split. */
interface PartialPlan {
  keep: Set<number>; // block ids copied
  cost: number;
}

/**
 * R20: whether partial inlining may take a callee whose entry gives a frame slot (`alloca`) that the paths it copies never
 * use: the slot is the slow path's (a counted object built on the stack before it's placed, in an `rc` class printing's
 * `make`), and a slot does nothing when it runs, so the copy leaves it out and the call that bails has its own. Off by
 * TMK_R20_OFF=alloca, for tools/r20-pins.ts: then a slot in the entry refuses partial inlining, as before R20.
 */
function allocaPrefix(): boolean {
  return !(process.env.TMK_R20_OFF ?? "").split(",").includes("alloca");
}

function blockIsPure(b: Block, faults: InlineFaults): boolean {
  for (const ins of b.instrs) {
    if (ins.op === "alloca") {
      if (!allocaPrefix()) return false;
      // R20's injected bug (manager.ts OPT_FAULTS): the block taken as free of effects at its first slot
      if (faults.allocaPure === true) return true;
      continue;
    }
    const e = effectOf(ins);
    if (e === "effect" && !(faults.impurePrefix === true && ins.op.startsWith("store.")))
      return false;
  }
  return true;
}

function hasCall(b: Block): boolean {
  for (const ins of b.instrs) {
    if (ins.op === "call" || ins.op === "call.indirect") return true;
    if (ins.op === "intrinsic" && effectOf(ins) === "effect") {
      const n = ins.ops[0];
      if (n?.t === "name" && (n.name === "native.try" || n.name === "native.unwind")) return true;
    }
  }
  return false;
}

export function partialPlan(g: Func, faults: InlineFaults = {}): PartialPlan | null {
  const byId = new Map<number, Block>();
  for (const b of g.blocks) byId.set(b.id, b);
  const entry = g.blocks[0]!;
  if (!blockIsPure(entry, faults)) return null;
  // The side-effect-free entry: blocks reached from the entry through such blocks only.
  const prefix = new Set<number>();
  const stack = [entry.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (prefix.has(id)) continue;
    prefix.add(id);
    for (const e of edgesOf(byId.get(id)!.term)) {
      const t = byId.get(e.block)!;
      if (!prefix.has(t.id) && blockIsPure(t, faults)) stack.push(t.id);
    }
  }
  const frontier: number[] = [];
  for (const id of prefix) {
    for (const e of edgesOf(byId.get(id)!.term)) {
      if (!prefix.has(e.block) && !frontier.includes(e.block)) frontier.push(e.block);
    }
  }
  if (frontier.length === 0) return null; // all of it is the prefix: inline it whole or not at all
  // A loop in the prefix means the decision isn't made once at the entry: its body would bail on every pass.
  for (const id of prefix) {
    const b = byId.get(id)!;
    for (const e of edgesOf(b.term)) if (e.block === entry.id) return null;
  }
  {
    const cfg = buildCfg(g);
    const index = new Map<number, number>();
    g.blocks.forEach((b, i) => index.set(b.id, i));
    for (const [at, preds] of cfg.preds.entries()) {
      const id = g.blocks[at]!.id;
      if (!prefix.has(id)) continue;
      for (const p of preds) {
        // A back edge into the prefix: the edge's source is dominated by its target.
        let cur = p;
        for (let guard = 0; guard <= g.blocks.length; guard++) {
          if (cur === at) return null;
          const up = cfg.idom.get(cur);
          if (up === undefined || up === cur) break;
          cur = up;
        }
      }
    }
  }
  const closure = (from: number): Set<number> => {
    const seen = new Set<number>();
    const st = [from];
    while (st.length > 0) {
      const id = st.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of edgesOf(byId.get(id)!.term)) st.push(e.block);
    }
    return seen;
  };
  const closures = new Map<number, Set<number>>();
  for (const x of frontier) closures.set(x, closure(x));
  // A path kept must make no call, must never come back to the prefix, and must never reach a path that calls instead.
  const kept = new Set<number>();
  for (const x of frontier) {
    const c = closures.get(x)!;
    let ok = true;
    for (const id of c) {
      if (prefix.has(id) || hasCall(byId.get(id)!)) ok = false;
    }
    if (ok) kept.add(x);
  }
  for (let guard = 0; guard <= frontier.length; guard++) {
    let moved = false;
    for (const x of kept) {
      for (const id of closures.get(x)!) {
        if (frontier.includes(id) && !kept.has(id)) {
          kept.delete(x);
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
  if (kept.size === frontier.length) return null; // nothing calls: it's whole inlining
  const keep = new Set(prefix);
  for (const x of kept) for (const id of closures.get(x)!) keep.add(id);
  // R20: a frame slot in what's copied is left out of the copy, so nothing copied may use it
  const slots = new Set<number>();
  for (const id of keep)
    for (const ins of byId.get(id)!.instrs)
      if (ins.op === "alloca") for (const r of ins.res) slots.add(r);
  if (slots.size > 0 && allocaPrefix())
    for (const id of keep) {
      const b = byId.get(id)!;
      for (const ins of b.instrs)
        for (const o of ins.ops) if (o.t === "v" && slots.has(o.id)) return null;
      const t = b.term;
      if (t.k === "ret" && t.vals.some((v) => slots.has(v))) return null;
      if (t.k === "brif" && slots.has(t.cond)) return null;
      if (t.k === "switch" && slots.has(t.val)) return null;
      for (const e of edgesOf(t)) if (e.args.some((v) => slots.has(v))) return null;
    }
  // It has to be a fast path: some way out of the function that doesn't call it after all.
  let returns = false;
  for (const id of keep) if (byId.get(id)!.term.k === "ret") returns = true;
  if (!returns) return null;
  let cost = 4 + g.params.length; // the call that's left, on the paths that bail
  for (const id of keep) {
    const b = byId.get(id)!;
    for (const ins of b.instrs) cost += instrCost(ins);
    cost += termCost(b.term);
  }
  return { keep, cost };
}

/**
 * Replaces `f.blocks[bi].instrs[ii]`, a call to `g`, by a copy of `g`'s body, or of the blocks `plan.keep` names with a call
 * to `g` on every edge out of them. The call's results become the parameters of the block after it.
 */
export function inlineAt(
  f: Func,
  bi: number,
  ii: number,
  g: Func,
  ctx: InlineContext,
  plan: PartialPlan | null,
): void {
  const b = f.blocks[bi]!;
  const call = b.instrs[ii]!;
  let args = valueOps(call);
  if (ctx.faults.swapArgs === true && args.length >= 2) {
    const ta = g.types[g.params[0]!];
    const tb = g.types[g.params[1]!];
    if (ta === tb) args = [args[1]!, args[0]!, ...args.slice(2)];
  }
  let next = newBlockId(f);
  const post: Block = {
    id: next++,
    params: [...call.res],
    instrs: b.instrs.slice(ii + 1),
    term: b.term,
  };
  b.instrs = b.instrs.slice(0, ii);
  // Values: the callee's parameters are the arguments, and everything else is new.
  const vmap = new Map<number, number>();
  g.params.forEach((p, i) => vmap.set(p, args[i]!));
  const val = (v: number): number => {
    let n = vmap.get(v);
    if (n === undefined) {
      n = newValue(f, g.types[v]!);
      vmap.set(v, n);
    }
    return n;
  };
  const bmap = new Map<number, number>();
  const copied = plan === null ? g.blocks : g.blocks.filter((x) => plan.keep.has(x.id));
  for (const gb of copied) bmap.set(gb.id, next++);
  let bail: Block | null = null;
  const bailId = (): number => {
    if (bail === null) {
      const res = g.rets.map((t) => newValue(f, t));
      const slow: Instr = {
        op: "call",
        ops: [{ t: "sym", name: g.name }, ...args.map((v) => ({ t: "v" as const, id: v }))],
        res,
      };
      (ctx.slowPath ??= new WeakSet()).add(slow);
      bail = {
        id: next++,
        params: [],
        instrs: [slow],
        term: { k: "br", to: { block: post.id, args: res } },
      };
    }
    return bail.id;
  };
  const entryAllocas: Instr[] = [];
  const blocks: Block[] = [];
  // R29 (D79): in a call proved in bounds, the length load the callee's leading check compared with. The receiver is one of
  // its object's arrays held in place (links.ts), so the load can't fault, and with the check gone nothing needs it run.
  const lenOfCheck = new Set<Instr>();
  if (call.inb === true) {
    const gdefs = new Map<number, Instr>();
    for (const gb of g.blocks)
      for (const ins of gb.instrs) for (const r of ins.res) gdefs.set(r, ins);
    const fromRecv = (v: number): boolean => {
      for (let cur = v, guard = 0; guard < 8; guard++) {
        if (cur === g.params[0]) return true;
        const d = gdefs.get(cur);
        if (d === undefined || (d.op !== "gep" && !d.op.startsWith("bitcast."))) return false;
        cur = valueOps(d)[0]!;
      }
      return false;
    };
    for (const gb of g.blocks)
      for (const ins of gb.instrs) {
        if (ins.chk === undefined || valueOps(ins)[0] !== g.params[ins.chk]) continue;
        const len = gdefs.get(valueOps(ins)[1]!);
        if (len !== undefined && len.op.startsWith("load.") && fromRecv(valueOps(len)[0]!))
          lenOfCheck.add(len);
      }
  }
  const chains = (ctx.chain ??= new WeakMap());
  const outer = [...(chains.get(call) ?? []), g.name];
  let droppedRcStore = false;
  for (const gb of copied) {
    const nb: Block = {
      id: bmap.get(gb.id)!,
      params: gb.params.map(val),
      instrs: [],
      term: { k: "unreachable" },
    };
    for (const ins of gb.instrs) {
      const c = cloneInstr(ins);
      if (c.op === "call") chains.set(c, outer);
      for (const o of c.ops) if (o.t === "v") o.id = val(o.id);
      c.res = c.res.map(val);
      if (ctx.deadAtO0.has(ins) || lenOfCheck.has(ins)) ctx.deadAtO0.add(c);
      if (
        ctx.faults.dropCheck === true &&
        effectOf(c) === "check" &&
        c.res.length === 1 &&
        c.op !== "gen.chk"
      ) {
        const src = c.ops.find((o) => o.t === "v");
        if (src?.t === "v" && f.types[src.id] === f.types[c.res[0]!]) {
          c.op = `bitcast.${f.types[c.res[0]!]!}`;
          c.ops = [src];
        }
      }
      if (
        (ctx.faults.dropRcStore === true || ctx.faults.dropAnyStore === true) &&
        !droppedRcStore &&
        (g.name.startsWith("__rc_") || ctx.faults.dropAnyStore === true) &&
        c.op.startsWith("store.")
      ) {
        droppedRcStore = true;
        continue;
      }
      // R29 (D79): a call tslc's table-links proof proved in bounds (`inb`, compiler/host/links.ts): the callee's leading
      // bounds check, the compare of that parameter noted `chk`, can't fire in this copy, so its test is false. Only the
      // compare of the callee's own parameter: a check something inlined into the callee brought isn't this call's.
      if (
        (call.inb === true || ctx.faults.inbAny === true) &&
        ins.chk !== undefined &&
        valueOps(ins)[0] === g.params[ins.chk] &&
        c.res.length === 1
      ) {
        c.op = `iconst.${f.types[c.res[0]!]!}`;
        c.ops = [{ t: "i", val: 0n }];
        delete c.chk;
      }
      // R20: a partial copy's frame slots are the slow path's, which the plan checked nothing copied uses: left out
      if (c.op === "alloca") {
        if (plan === null || !allocaPrefix()) entryAllocas.push(c);
      } else nb.instrs.push(c);
    }
    const t = cloneTerm(gb.term);
    if (t.k === "ret") {
      let vals = t.vals.map(val);
      if (ctx.faults.retOrder === true && vals.length >= 2) vals = [...vals].reverse();
      nb.term = { k: "br", to: { block: post.id, args: vals } };
    } else {
      if (t.k === "brif") t.cond = val(t.cond);
      if (t.k === "switch") t.val = val(t.val);
      for (const e of edgesOf(t)) {
        if (bmap.has(e.block)) {
          e.block = bmap.get(e.block)!;
          e.args = e.args.map(val);
        } else {
          e.block = bailId();
          e.args = [];
        }
      }
      nb.term = t;
    }
    blocks.push(nb);
  }
  b.term = { k: "br", to: { block: bmap.get(g.blocks[0]!.id)!, args: [] } };
  // Frame slots stay in the entry block, where the backend gives each its one place.
  f.blocks[0]!.instrs.unshift(...entryAllocas);
  f.blocks.splice(bi + 1, 0, ...blocks, ...(bail !== null ? [bail] : []), post);
  // A callee that never returns leaves the block after the call, and what only it reached, unreachable.
  removeUnreachable(f);
}

/** Inlines across the module, bottom-up. `ctx.cleanup` runs on each function before anything measures it. */
export function inlineModule(m: Module, ctx: InlineContext): void {
  const byName = new Map<string, Func>();
  for (const f of m.funcs) byName.set(f.name, f);
  for (const f of m.funcs) {
    for (const b of f.blocks)
      for (const ins of b.instrs)
        if (ins.op === "call" || ins.op === "call.indirect") ctx.stats.sitesBefore++;
  }
  const devirt = ctx.level >= 2 && ctx.devirtualize !== false;
  if (devirt) for (const f of m.funcs) devirtualize(m, f, byName, ctx);
  // Who can be reached other than by a direct call: an export, or a function whose address is taken.
  const addressTaken = new Set<string>();
  const directSites = new Map<string, number>();
  for (const f of m.funcs) {
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "funcaddr" && ins.ops[0]?.t === "sym") addressTaken.add(ins.ops[0].name);
        const c = calleeOf(ins);
        if (c !== undefined) directSites.set(c, (directSites.get(c) ?? 0) + 1);
      }
    }
  }
  const sccs = callSccs(m.funcs);
  const sccOf = new Map<string, number>();
  sccs.forEach((c, i) => {
    for (const f of c) sccOf.set(f.name, i);
  });
  const cyclic = new Set<string>();
  for (const c of sccs) {
    const self =
      c.length === 1 && c[0]!.blocks.some((b) => b.instrs.some((i) => calleeOf(i) === c[0]!.name));
    if (c.length > 1 || self) for (const f of c) cyclic.add(f.name);
  }
  for (const comp of sccs) {
    for (const f of comp) {
      ctx.cleanup(f);
      inlineInto(m, f, byName, ctx, { sccOf, cyclic, addressTaken, directSites });
    }
  }
}

interface Facts {
  sccOf: Map<string, number>;
  cyclic: Set<string>;
  addressTaken: Set<string>;
  directSites: Map<string, number>;
}

function inlineInto(
  m: Module,
  f: Func,
  byName: Map<string, Func>,
  ctx: InlineContext,
  facts: Facts,
): void {
  const initial = costOf(f);
  let cost = initial;
  const softCap = Math.max(initial * GROWTH_FACTOR, initial + GROWTH_ADD);
  let frame = 0;
  const considered = new WeakSet<Instr>();
  const keepLoops = !r26Off("inline");
  for (let sweep = 0; sweep < 3; sweep++) {
    const loops =
      ctx.level >= 2 ? loopBlocks(f) : ctx.level === 1 ? spannedBlocks(f) : new Set<number>();
    const constVals = ctx.level >= 2 ? constantValues(f) : new Set<number>();
    let any = false;
    for (let bi = 0; bi < f.blocks.length; bi++) {
      const b = f.blocks[bi]!;
      for (let ii = 0; ii < b.instrs.length; ii++) {
        const ins = b.instrs[ii]!;
        if (considered.has(ins) || ctx.slowPath?.has(ins) === true) continue;
        const name = calleeOf(ins);
        if (name === undefined) continue;
        considered.add(ins);
        const g = byName.get(name);
        const no = (why: string, c?: number, t?: number): void => {
          ctx.stats.refused++;
          ctx.remarks.push({
            caller: f.name,
            callee: name,
            how: "not inlined",
            why,
            ...(c !== undefined ? { cost: c } : {}),
            ...(t !== undefined ? { threshold: t } : {}),
          });
        };
        if (g === undefined) {
          no("it's outside the module");
          continue;
        }
        if (g === f || facts.sccOf.get(g.name) === facts.sccOf.get(f.name)) {
          no("recursive: it's in a cycle of calls with the caller");
          continue;
        }
        if (ctx.chain?.get(ins)?.includes(g.name) === true) {
          no("recursive: this call is inside a copy of it already");
          continue;
        }
        const never = g.attrs.find((a) => NEVER_ATTRS.includes(a));
        if (never !== undefined) {
          no(
            `it's ${never === "noinline" ? "@tsl.noinline" : `${never}, so it stays a real function`}`,
          );
          continue;
        }
        const lacking = ["noalloc", "nosleep"].find(
          (a) => f.attrs.includes(a) && !g.attrs.includes(a),
        );
        if (lacking !== undefined) {
          no(`the caller is ${lacking} and the callee doesn't say so`);
          continue;
        }
        const slots = allocaBytes(g);
        if (slots > 0 && facts.cyclic.has(f.name)) {
          no("it has frame slots, and the caller recurses, so every level's frame would grow");
          continue;
        }
        if (frame + slots > FRAME_CAP) {
          no("the caller's frame would grow past 64 KiB");
          continue;
        }
        const gc = costOf(g);
        const forced = g.attrs.includes("inline");
        let threshold: number;
        let reason: string;
        if (forced) {
          threshold = FORCED;
          reason = "@tsl.inline";
        } else if (ctx.level === 1) {
          threshold = callOverhead(g);
          reason = "no bigger than the call";
          // B3 (D46): a small leaf at a call in a loop too, whose call, frame and the spills around it cost about what its
          // copy adds.
          if (gc > threshold && gc <= O1_LEAF && loops.has(b.id) && isLeaf(g)) {
            threshold = O1_LEAF;
            reason = "a small leaf";
          }
        } else {
          threshold = BASE;
          const why: string[] = [];
          if (isLeaf(g)) {
            threshold += LEAF_BONUS;
            why.push("leaf");
          }
          const argVals = valueOps(ins);
          const consts = argVals.filter((v) => constVals.has(v)).length;
          if (consts > 0) {
            threshold += Math.min(3, consts) * CONST_ARG_BONUS;
            why.push(`${consts} constant argument${consts > 1 ? "s" : ""}`);
          }
          if (loops.has(b.id)) {
            threshold *= LOOP_FACTOR;
            why.push("in a loop");
          }
          const only =
            facts.directSites.get(g.name) === 1 &&
            !g.attrs.includes("export") &&
            !facts.addressTaken.has(g.name);
          if (only) {
            threshold = Math.max(threshold, SINGLE_SITE);
            why.push("its one call site");
          }
          reason = why.length > 0 ? why.join(", ") : "small";
        }
        const grown = cost + gc - callOverhead(g);
        if (gc <= threshold) {
          // R28: a callee no bigger than its call doesn't grow the caller, so the growth limit doesn't refuse it (forced
          // copies can take a caller past its soft limit, and then a three-instruction method was left a call)
          const shrinks = gc <= callOverhead(g) && !r28Off("grow");
          if (grown > HARD_CAP || (!forced && !shrinks && grown > softCap)) {
            no(
              `the caller would grow past its limit (${grown} > ${forced ? HARD_CAP : softCap})`,
              gc,
              threshold,
            );
            continue;
          }
          const had = keepLoops ? new Set(f.blocks.map((x) => x.id)) : null;
          // R28's injected bug: a callee only the no-growth rule let in, copied without its first store
          const onlyShrink = !forced && shrinks && grown > softCap;
          if (onlyShrink && ctx.faults.shrinkStore === true)
            inlineAt(f, bi, ii, g, { ...ctx, faults: { ...ctx.faults, dropAnyStore: true } }, null);
          else inlineAt(f, bi, ii, g, ctx, null);
          // R26: a call in a loop's block leaves that block split, its copy of the callee and the rest of the block new
          // blocks: they're in the loop as the block was, so a call after this one in the block is still a call in a loop
          if (had !== null && loops.has(b.id))
            for (const x of f.blocks) if (!had.has(x.id)) loops.add(x.id);
          ctx.afterInline?.(f);
          cost = grown;
          frame += slots;
          ctx.stats.inlined++;
          ctx.remarks.push({
            caller: f.name,
            callee: g.name,
            how: "inlined",
            why: reason,
            cost: gc,
            threshold,
          });
          any = true;
          break; // this block is now split: carry on from the copy
        }
        if (ctx.level >= 2 && ctx.partial !== false) {
          const plan = partialPlan(g, ctx.faults);
          if (plan !== null && plan.cost <= threshold) {
            const pgrown = cost + plan.cost - callOverhead(g);
            if (pgrown <= softCap && pgrown <= HARD_CAP) {
              const had = keepLoops ? new Set(f.blocks.map((x) => x.id)) : null;
              inlineAt(f, bi, ii, g, ctx, plan);
              if (had !== null && loops.has(b.id))
                for (const x of f.blocks) if (!had.has(x.id)) loops.add(x.id);
              ctx.afterInline?.(f);
              cost = pgrown;
              frame += slots;
              ctx.stats.partial++;
              ctx.remarks.push({
                caller: f.name,
                callee: g.name,
                how: "partial",
                why: `its side-effect-free entry and the paths with no call (${plan.cost} of ${gc}); ${reason}`,
                cost: plan.cost,
                threshold,
              });
              any = true;
              break;
            }
          }
        }
        no(
          `too big (${gc} > ${threshold}${ctx.level >= 2 ? ", and no fast path small enough to inline alone" : ""})`,
          gc,
          threshold,
        );
      }
    }
    if (!any) break;
    ctx.cleanup(f);
    cost = costOf(f);
    if (ctx.level >= 2 && ctx.devirtualize !== false) devirtualize(m, f, byName, ctx);
  }
}

function constantValues(f: Func): Set<number> {
  const out = new Set<number>();
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      const c =
        ins.op.startsWith("iconst.") ||
        ins.op.startsWith("fconst.") ||
        ins.op === "funcaddr" ||
        ins.op === "globaladdr";
      if (c) out.add(ins.res[0]!);
    }
  }
  return out;
}
