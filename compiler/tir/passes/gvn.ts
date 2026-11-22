// Value numbering (SPEC 4.3, D73): a computation already done gives the same value again, so it's done once.
//
// Walks the dominator tree with a scoped table of what's been computed. A pure operation with the same operation, operands
// and immediates as one that dominates it is replaced by it. So is a check (`*.chk`, `bounds.chk`, a division): where the
// first passed, the second, with the same operands, can't fire, whatever its trap. A plain load is replaced by a dominating
// load of the same type at the same address, or by the value a dominating store of that type put there, where nothing
// between them may have written those bytes (memory.ts). Between a block and its immediate dominator, "between" is every
// block on a path from one to the other, so a load after an if/else joins still sees what was loaded before it, unless an
// arm wrote there.
//
// A load whose value replaces another must have run at -O0 (keep.ts): the backend drops a plain load nothing uses, so a
// load -O0 dropped didn't run, and using its value now would make it run, earlier than the load it replaces, and fault
// where -O0 didn't, or before something -O0 did first. A load from a global or a frame slot can't fault, and is always
// fine. A load that ran at -O0, and whose value is now used in place of a later one's, faults exactly where -O0's first
// did; the later one, at the same address with nothing changed between, would never have.
//
// A class id's load (`load.T.inv`, memory.ts) is shared across more: only a plain store at its own base over its bytes changes
// what it reads, so it stands for a later load of the same object's id across stores elsewhere, calls and intrinsics. It
// stands only for another invariant load; a plain load of those bytes isn't taken from it.
import { buildCfg, ValMap, type Func, type Instr } from "../ir.ts";
import {
  accessAddr,
  accessBytes,
  isInvariantLoad,
  isPlainLoad,
  isPlainStore,
  memEffect,
  SEP_ANY,
  SEP_SIZE,
  sepValues,
  writeChanges,
  type Addr,
} from "./memory.ts";
import { effectOf, intImm, opParts, substitute, valueOps } from "./util.ts";

export interface GvnStats {
  pure: number; // pure operations replaced
  checks: number; // checks replaced by one that dominates them
  loads: number; // loads replaced by an earlier load or a store's value
  params: number; // block parameters given the same value on every edge as another
}

export interface GvnFaults {
  /** Injected (D73): a plain store is passed over, so loads either side of one that changes their bytes merge. */
  acrossStore?: boolean;
  /**
   * Injected (R36): the table of constants' keys kept from one function to the next, not made for each: the module's one
   * table, which every function's constants go into (made for each module, so a build is the same every time).
   */
  sharedConstKeys?: ValMap<string>;
}

export interface GvnContext {
  readonly: ReadonlySet<string>;
  /** R27 (D77): functions that write nothing but their frame and separated fields' blocks (memory.ts's writeSummaries). */
  sepOnly?: ReadonlySet<string>;
  deadAtO0: WeakSet<Instr>;
  stats: GvnStats;
  faults?: GvnFaults;
}

interface Avail {
  addr: Addr;
  size: number;
  key: string; // the load's type and the address's value number
  value: number;
  inv: boolean; // an invariant load's (a class id): only a store at its base over its bytes changes it
}

/** Most loads a block keeps track of at once: enough for a run of field reads, and a bound on the time it takes. */
const MAX_AVAIL = 64;
/** Most blocks between a join and its dominator looked at for writes; past that, nothing loaded before is reused. */
const MAX_REGION = 64;

const CONST_LIKE = new Set(["iconst", "fconst", "globaladdr", "funcaddr"]);
const COMMUTATIVE = new Set(["add", "mul", "and", "or", "xor"]);

export function gvnFunc(f: Func, ctx: GvnContext): boolean {
  let changed = mergeParams(f, ctx.stats);
  const cfg = buildCfg(f);
  const n = f.blocks.length;
  const defs = new ValMap<Instr>(f.types.length);
  const constKey = ctx.faults?.sharedConstKeys ?? new ValMap<string>(f.types.length);
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      for (const r of ins.res) defs.set(r, ins);
      const p = opParts(ins.op);
      if (p[0] === "iconst" || p[0] === "fconst")
        constKey.set(ins.res[0]!, `${ins.op}:${intImm(ins, 0)}`);
      else if (ins.op === "globaladdr" || ins.op === "funcaddr") {
        const s = ins.ops[0];
        constKey.set(ins.res[0]!, `${ins.op}:${s?.t === "sym" ? s.name : ""}`);
      }
    }
  }
  const subst = new Map<number, number>();
  const look = (v: number): number => {
    let c = v;
    for (let guard = 0; guard < 64; guard++) {
      const x = subst.get(c);
      if (x === undefined) return c;
      c = x;
    }
    return c;
  };
  const vkey = (v: number): string => constKey.get(v) ?? `%${look(v)}`;
  // R27: the addresses in separated fields' blocks (memory.ts)
  const sep = sepValues(f);

  // What each block writes: the stores' addresses, and whether anything in it writes everything.
  const writes: { all: boolean; stores: { addr: Addr; size: number }[] }[] = f.blocks.map((b) => {
    const out = { all: false, stores: [] as { addr: Addr; size: number }[] };
    for (const ins of b.instrs) {
      const e = memEffect(ins, ctx.readonly, ctx.sepOnly, sep);
      if (e === "all") out.all = true;
      else if (e === "sep") out.stores.push({ addr: SEP_ANY, size: SEP_SIZE });
      else if (e === "store" && ctx.faults?.acrossStore !== true)
        out.stores.push({ addr: accessAddr(defs, ins, sep), size: accessBytes(ins.op) });
    }
    return out;
  });

  // The dominator tree.
  const kids: number[][] = Array.from({ length: n }, () => []);
  for (const at of cfg.rpo) {
    const d = cfg.idom.get(at);
    if (d !== undefined && d !== at) kids[d]!.push(at);
  }
  const endState: (Avail[] | undefined)[] = Array.from({ length: n });
  const table = new Map<string, number>();
  const undo: { key: string; prev: number | undefined }[] = [];
  const removed = new Set<Instr>();

  const entryState = (at: number): Avail[] => {
    const d = cfg.idom.get(at);
    if (d === undefined || d === at) return [];
    const from = endState[d];
    if (from === undefined || from.length === 0) return [];
    // Every block on a path from the dominator to this one, the dominator itself left out.
    const region = new Set<number>();
    const stack = [...cfg.preds[at]!];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x === d || region.has(x)) continue;
      region.add(x);
      if (region.size > MAX_REGION) return [];
      for (const p of cfg.preds[x]!) stack.push(p);
    }
    let out = from;
    for (const x of region) {
      const w = writes[x]!;
      if (w.all) out = out.filter((a) => a.inv);
      if (w.stores.length === 0) continue;
      out = out.filter((a) => !w.stores.some((st) => writeChanges(a.addr, a.size, a.inv, st)));
    }
    return out === from ? [...from] : out;
  };

  // An explicit stack: preorder, with each scope undone after its subtree.
  const stack: { at: number; mark: number; entered: boolean }[] = [
    { at: cfg.rpo[0]!, mark: 0, entered: false },
  ];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.entered) {
      stack.pop();
      while (undo.length > top.mark) {
        const u = undo.pop()!;
        if (u.prev === undefined) table.delete(u.key);
        else table.set(u.key, u.prev);
      }
      continue;
    }
    top.entered = true;
    top.mark = undo.length;
    const b = f.blocks[top.at]!;
    let avail = entryState(top.at);
    for (const ins of b.instrs) {
      for (const o of ins.ops) if (o.t === "v") o.id = look(o.id);
      const p = opParts(ins.op);
      const eff = effectOf(ins);
      if ((eff === "pure" || (eff === "check" && p[0] !== "gen")) && ins.res.length === 1) {
        if (CONST_LIKE.has(p[0]!)) continue;
        const key = exprKey(ins, vkey);
        const hit = table.get(key);
        if (hit !== undefined) {
          subst.set(ins.res[0]!, hit);
          removed.add(ins);
          if (eff === "pure") ctx.stats.pure++;
          else ctx.stats.checks++;
          changed = true;
        } else {
          undo.push({ key, prev: table.get(key) });
          table.set(key, ins.res[0]!);
        }
        continue;
      }
      if (isPlainLoad(ins)) {
        const at = valueOps(ins)[0]!;
        const inv = isInvariantLoad(ins);
        const key = `load.${opParts(ins.op)[1]!}|${vkey(at)}`;
        const hit = avail.find((a) => a.key === key && (inv || !a.inv));
        if (hit !== undefined) {
          subst.set(ins.res[0]!, hit.value);
          removed.add(ins);
          ctx.stats.loads++;
          changed = true;
          continue;
        }
        const addr = accessAddr(defs, ins, sep);
        // Only a load that ran at -O0, or that can't fault, may stand for later ones.
        if (!ctx.deadAtO0.has(ins) || addr.ident) {
          avail = push(avail, { addr, size: accessBytes(ins.op), key, value: ins.res[0]!, inv });
        }
        continue;
      }
      const e = memEffect(ins, ctx.readonly, ctx.sepOnly, sep);
      if (e === "all") avail = avail.filter((a) => a.inv);
      else if (e === "sep")
        avail = avail.filter(
          (a) => !writeChanges(a.addr, a.size, a.inv, { addr: SEP_ANY, size: SEP_SIZE }),
        );
      else if (e === "store" && isPlainStore(ins) && ctx.faults?.acrossStore !== true) {
        const [at, val] = valueOps(ins) as [number, number];
        const addr = accessAddr(defs, ins, sep);
        const size = accessBytes(ins.op);
        avail = avail.filter((a) => !writeChanges(a.addr, a.size, a.inv, { addr, size }));
        // What a store wrote, a load of the same type there reads back.
        const t = opParts(ins.op)[1]!;
        avail = push(avail, { addr, size, key: `load.${t}|${vkey(at)}`, value: val, inv: false });
      }
    }
    endState[top.at] = avail;
    for (let i = kids[top.at]!.length - 1; i >= 0; i--)
      stack.push({ at: kids[top.at]![i]!, mark: 0, entered: false });
  }
  if (removed.size > 0) {
    for (const b of f.blocks) b.instrs = b.instrs.filter((ins) => !removed.has(ins));
  }
  substitute(f, subst);
  return changed;
}

function push(avail: Avail[], a: Avail): Avail[] {
  const out = avail.filter((x) => x.key !== a.key);
  out.push(a);
  if (out.length > MAX_AVAIL) out.shift();
  return out;
}

/** The operation, its operands' value numbers (in order, or sorted where the order doesn't matter), and its immediates but a trap. */
function exprKey(ins: Instr, vkey: (v: number) => string): string {
  const p = opParts(ins.op);
  // R36: the same text as before, `op(values)[immediates]`, made as it goes with no lists in between
  let vals = "";
  let imms = "";
  let nv = 0;
  let ni = 0;
  let v0 = "";
  let v1 = "";
  for (const o of ins.ops) {
    let k: string;
    if (o.t === "v") {
      k = vkey(o.id);
      if (nv === 0) v0 = k;
      else if (nv === 1) v1 = k;
      vals = nv === 0 ? k : `${vals},${k}`;
      nv++;
      continue;
    }
    if (o.t === "i") k = String(o.val);
    else if (o.t === "ixmax") k = "ixmax";
    else if (o.t === "sym" || o.t === "name") k = o.name;
    else if (o.t === "sig") k = `sig${o.id}`;
    else continue;
    imms = ni === 0 ? k : `${imms},${k}`;
    ni++;
  }
  const b = p[0]!;
  const commutes =
    (COMMUTATIVE.has(b) && (p.length === 2 || p[1] === "chk")) ||
    (b === "icmp" && (p[1] === "eq" || p[1] === "ne"));
  if (commutes && nv === 2 && v1 < v0) vals = `${v1},${v0}`;
  return `${ins.op}(${vals})[${imms}]`;
}

/** A block parameter given, on every edge, the same value as another parameter of its block, is that parameter. */
function mergeParams(f: Func, stats: GvnStats): boolean {
  const incoming = new Map<number, number[][]>();
  for (const b of f.blocks) {
    const t = b.term;
    const edges =
      t.k === "br"
        ? [t.to]
        : t.k === "brif"
          ? [t.t, t.f]
          : t.k === "switch"
            ? [...t.cases.map((c) => c.to), t.def]
            : [];
    for (const e of edges) {
      let l = incoming.get(e.block);
      if (l === undefined) incoming.set(e.block, (l = []));
      l.push(e.args);
    }
  }
  const subst = new Map<number, number>();
  for (const b of f.blocks.slice(1)) {
    if (b.params.length < 2) continue;
    const ins = incoming.get(b.id);
    if (ins === undefined || ins.length === 0) continue;
    for (let j = 1; j < b.params.length; j++) {
      const pj = b.params[j]!;
      if (subst.has(pj)) continue;
      for (let i = 0; i < j; i++) {
        const pi = b.params[i]!;
        if (subst.has(pi) || f.types[pi] !== f.types[pj]) continue;
        // A parameter given itself on a back edge counts as given the other's value there, when the other is given itself.
        if (ins.every((args) => args[i] === args[j] || (args[i] === pi && args[j] === pj))) {
          subst.set(pj, pi);
          stats.params++;
          break;
        }
      }
    }
  }
  substitute(f, subst);
  return subst.size > 0;
}
