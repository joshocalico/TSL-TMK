// Loop versioning (SPEC 4.3, D44, D73; M5's R15 record, pile item 10): a loop whose checks can't be proved where they are,
// but can be from what holds before it, becomes two loops: a fast copy with those checks gone, and the loop as it was, the
// fallback. A test before them, the guard, chooses: the fast copy only where the guard proves every removed check can't
// fire on any turn, else the original. -O2's, as unswitching and peeling are (copies are code).
//
// It's sound by construction. The original loop is untouched, so wherever the guard fails the program runs exactly as
// before. The guard reads only values from outside the loop (SSA values never change, so what it proves before the first
// turn holds on every turn), and computes only plain arithmetic and compares, which can't trap or write; a division's
// divisor is made at least 1 first. The fast copy is the loop instruction for instruction, but for the checks proved.
//
// What's proved, for a check in the loop on index `i` against length `n`, `n` from outside the loop:
//
// - `i` from outside the loop too: the guard is `i < n` (unsigned).
// - `i` the loop's counter. The loop is loopbounds.ts's shape (its header ends in `k < m`, signed or unsigned; a signed
//   counter never negative: it starts at a constant at least 0 and steps up by a constant), `m` from outside the loop,
//   and the check past the header, where on every turn `0 <= k < m` holds for this turn's `k`. With `k'` the counter
//   widened to `ix` (zext, or sext where it's never negative), `m'` likewise, and `B`, `S` from outside the loop:
//   - `i = k' + B` (or `k'`, B = 0): the guard is `B <= n && m' <= n - B`, so `k' + B < m' + B <= n`. `n - B` can't wrap,
//     as B <= n.
//   - `i = k' * S + B`: the guard is `B < n && (m' = 0 || m' - 1 <= (n - 1 - B) / max(S, 1))`. Where m' = 0 no turn runs
//     past the header. Otherwise k' <= m' - 1, so k' * S <= n - 1 - B (for S = 0, trivially), and i <= n - 1.
//   The checked `add` and `mul` making `i` lose their checks in the fast copy too: each result is at most i, below n, an
//   `ix` value, so below the type's limit (checks.ts's rule, D23).
//
// A check is a `bounds.chk`, or a compare and branch to a block that only traps (`JsArray.get`'s form), as loopbounds.ts
// reads them. A loop is versioned once (its copy and the original both carry its header's id in `done`), and only so big.
import { buildCfg, type Block, type Func, type Instr, type TirType } from "../ir.ts";
import { removeUnreachable } from "./cfg.ts";
import { loopFact } from "./loopbounds.ts";
import { ensurePreheader, findLoops, type Loop } from "./loops.ts";
import { copyRegion, definedIn, regionOf } from "./unswitch.ts";
import { instrCost, newValue, opParts, substitute, termCost, valueOps } from "./util.ts";

export interface VersionStats {
  loops: number; // loops versioned
  checks: number; // checks gone from the fast copies
  overflow: number; // checked add and mul made plain in them
  cost: number; // what the copies cost, in D46's units
}

export interface VersionFaults {
  /** Injected (R15): the guard allows one turn too many, `m' <= n - B + 1`. */
  offByOne?: boolean;
  /** Injected (R15): a length loaded in the loop is read once before it for the guard, as if nothing in the loop wrote it. */
  boundInLoop?: boolean;
  /** Injected (R15): every check's guard is against the first check's length. */
  wrongLength?: boolean;
}

export interface VersionContext {
  deadAtO0: WeakSet<Instr>;
  stats: VersionStats;
  limits: { loopCost: number; funcGrowth: number; guards: number };
  faults?: VersionFaults;
}

/** An index as the guard reads it: from outside the loop, or `k' * S + B` (S and B from outside, or absent: 1 and 0). */
type Index =
  | { k: "inv"; v: number }
  | { k: "iv"; s: number | null; b: number | null; plain: Instr[] };

interface Check {
  at: number; // block position
  ins: Instr | null; // a bounds.chk, or null for the block's branch to a trap
  keep: "t" | "f" | null; // the branch's way that doesn't trap
  idx: Index;
  n: number; // the length; with the injected boundInLoop, maybe a load in the loop, read again in the preheader
}

/** Versions the loops it can, innermost first. Returns whether anything changed. */
export function versionFunc(f: Func, ctx: VersionContext, done: Set<number>): boolean {
  let worth = false;
  for (const b of f.blocks) {
    if (b.term.k === "trap") worth = true;
    else for (const ins of b.instrs) if (ins.op === "bounds.chk") worth = true;
    if (worth) break;
  }
  if (!worth) return false;
  let grown = 0;
  let changed = false;
  for (let tries = 0; tries < 8; tries++) {
    const cfg = buildCfg(f);
    const loops = findLoops(f, cfg);
    let did = false;
    for (const l of loops) {
      const hid = f.blocks[l.header]!.id;
      if (done.has(hid)) continue;
      const c = loopCost(f, l);
      if (c > ctx.limits.loopCost || grown + c > ctx.limits.funcGrowth) continue;
      const copied = versionLoop(f, l, cfg.preds, ctx);
      if (copied === null) {
        done.add(hid);
        continue;
      }
      done.add(hid);
      done.add(copied);
      grown += c;
      ctx.stats.loops++;
      ctx.stats.cost += c;
      changed = true;
      did = true;
      break;
    }
    if (!did) break;
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

/** Versions one loop. Returns the fast copy's header id, or null where there's nothing to prove or it can't be copied. */
function versionLoop(f: Func, l: Loop, preds: number[][], ctx: VersionContext): number | null {
  const faults = ctx.faults ?? {};
  const index = new Map<number, number>();
  f.blocks.forEach((b, i) => index.set(b.id, i));
  const def = new Map<number, Instr>();
  const defAt = new Map<number, number>();
  f.blocks.forEach((b, at) => {
    for (const ins of b.instrs)
      for (const r of ins.res) {
        def.set(r, ins);
        defAt.set(r, at);
      }
  });
  const inLoop = definedIn(f, l.blocks);
  const inv = (v: number): boolean => !inLoop.has(v);
  const fact = loopFact(f, l, preds, index, def, {});
  // The injected boundInLoop: a value the loop computes by a load (widened, perhaps) from an address it computes from values
  // from outside it, taken as if nothing in the loop wrote there, to be read again before the loop for the guard. The
  // chain, in order, or null.
  const reread = (v: number): Instr[] | null => {
    if (faults.boundInLoop !== true) return null;
    const chain: Instr[] = [];
    const seen = new Set<number>();
    let loaded = false;
    const walk = (x: number, depth: number): boolean => {
      if (inv(x) || seen.has(x)) return true;
      const d = def.get(x);
      if (d === undefined || depth > 6) return false;
      const ok =
        /^load\.(ix|i32)\.(na|inv)$/.test(d.op) ||
        /^(zext\.ix|gep|bounds\.chk|iconst\.\w+)$/.test(d.op);
      if (!ok || !valueOps(d).every((y) => walk(y, depth + 1))) return false;
      if (d.op.startsWith("load")) loaded = true;
      seen.add(x);
      chain.push(d);
      return true;
    };
    return walk(v, 0) && loaded ? chain : null;
  };
  // The counter's facts hold past the header only, and only with a bound from outside the loop.
  const ivOk =
    fact !== null &&
    (inv(fact.m) || reread(fact.m) !== null) &&
    ["i32", "ix"].includes(f.types[fact.k]!);
  const pastHeader = (at: number): boolean => ivOk && fact.blocks.has(at);
  // The counter widened: k itself where it's ix, or its zext (sext where it's never negative, which a signed fact says).
  const isK = (v: number): boolean => {
    if (!ivOk) return false;
    if (v === fact.k) return f.types[v] === "ix";
    const d = def.get(v);
    if (d === undefined || f.types[fact.k] !== "i32") return false;
    if (d.op !== "zext.ix" && !(fact.signed && d.op === "sext.ix")) return false;
    return valueOps(d)[0] === fact.k;
  };
  // A checked add or mul in the index, made plain in the fast copy: past the header, in the loop.
  const chainOk = (d: Instr, v: number): boolean => {
    const at = defAt.get(v);
    return at !== undefined && pastHeader(at) && d.ops.length >= 2;
  };
  const indexOf = (i: number): Index | null => {
    if (inv(i)) return { k: "inv", v: i };
    if (isK(i)) return { k: "iv", s: null, b: null, plain: [] };
    const d = def.get(i);
    if (d === undefined) return null;
    const p = opParts(d.op);
    const ok =
      (p.length === 2 && p[1] === "ix") || (p[1] === "chk" && p[2] === "u" && p[3] === "ix");
    if (!ok || !chainOk(d, i)) return null;
    const [x, y] = valueOps(d) as [number, number];
    const plain = p[1] === "chk" ? [d] : [];
    if (p[0] === "mul") {
      if (isK(x) && inv(y)) return { k: "iv", s: y, b: null, plain };
      if (isK(y) && inv(x)) return { k: "iv", s: x, b: null, plain };
      return null;
    }
    if (p[0] !== "add") return null;
    const side = (a: number, b: number): Index | null => {
      if (!inv(b)) return null;
      if (isK(a)) return { k: "iv", s: null, b, plain };
      const da = def.get(a);
      if (da === undefined) return null;
      const pa = opParts(da.op);
      const okA =
        (pa.length === 2 && pa[1] === "ix") || (pa[1] === "chk" && pa[2] === "u" && pa[3] === "ix");
      if (pa[0] !== "mul" || !okA || !chainOk(da, a)) return null;
      const [u, w] = valueOps(da) as [number, number];
      const s = isK(u) && inv(w) ? w : isK(w) && inv(u) ? u : null;
      if (s === null) return null;
      return { k: "iv", s, b, plain: [...plain, ...(pa[1] === "chk" ? [da] : [])] };
    };
    return side(x, y) ?? side(y, x);
  };
  // A length from outside the loop; with the injected bug, a load in the loop from an address from outside it too.
  const lengthOk = (n: number): boolean => inv(n) || reread(n) !== null;
  const isTrapBlock = (id: number): boolean => {
    const b = f.blocks[index.get(id)!]!;
    return b.term.k === "trap" && b.instrs.length === 0 && b.params.length === 0;
  };
  const checks: Check[] = [];
  for (const at of [...l.blocks].sort((a, b) => a - b)) {
    const b = f.blocks[at]!;
    const take = (i: number, n: number, ins: Instr | null, keep: "t" | "f" | null): void => {
      const idx = indexOf(i);
      if (idx === null) return;
      if (idx.k === "iv" && !pastHeader(at)) return;
      if (!lengthOk(n)) return;
      checks.push({ at, ins, keep, idx, n });
    };
    for (const ins of b.instrs) {
      if (ins.op !== "bounds.chk") continue;
      const [i, n] = valueOps(ins) as [number, number];
      take(i, n, ins, null);
    }
    const t = b.term;
    if (t.k !== "brif") continue;
    const c = def.get(t.cond);
    if (c === undefined) continue;
    const p = opParts(c.op);
    if (p[0] !== "icmp" || p[2] !== "ix") continue;
    const [x, y] = valueOps(c) as [number, number];
    // Which way traps if the check fires: `i >= n` (or `n <= i`) true, or `i < n` (or `n > i`) false.
    if ((p[1] === "uge" || p[1] === "ule") && isTrapBlock(t.t.block) && !isTrapBlock(t.f.block))
      take(p[1] === "uge" ? x : y, p[1] === "uge" ? y : x, null, "f");
    else if (
      (p[1] === "ult" || p[1] === "ugt") &&
      isTrapBlock(t.f.block) &&
      !isTrapBlock(t.t.block)
    )
      take(p[1] === "ult" ? x : y, p[1] === "ult" ? y : x, null, "t");
  }
  if (checks.length === 0) return null;
  // The guards, each once.
  const key = (c: Check): string =>
    c.idx.k === "inv" ? `i${c.idx.v}<${c.n}` : `k${c.idx.s ?? "1"}+${c.idx.b ?? "0"}<${c.n}`;
  const guards = new Map<string, Check>();
  for (const c of checks) if (!guards.has(key(c))) guards.set(key(c), c);
  if (guards.size > ctx.limits.guards) return null;
  const r = regionOf(f, l);
  if (r === null) return null;
  const header = f.blocks[l.header]!;
  const pre = ensurePreheader(f, buildCfg(f), l);
  const preBlock = f.blocks.find((b) => b.id === pre.id)!;
  const into = preBlock.term;
  if (into.k !== "br" || into.to.block !== header.id) return null;
  // The guard, in the preheader: plain arithmetic and compares of values from outside the loop.
  const code: Instr[] = [];
  const op = (o: string, args: (number | bigint)[], t: TirType, trap?: number): number => {
    const v = newValue(f, t);
    const ops = args.map((a) =>
      typeof a === "bigint" ? { t: "i" as const, val: a } : { t: "v" as const, id: a },
    );
    if (trap !== undefined) ops.push({ t: "trap", id: trap } as never);
    code.push({ op: o, ops, res: [v] });
    return v;
  };
  const k = (t: TirType, val: bigint): number => op(`iconst.${t}`, [val], t);
  const wide = (v: number): number => (f.types[v] === "ix" ? v : op("zext.ix", [v], "ix"));
  // A value from outside the loop is itself; the injected bug's value from the loop is read again here.
  const before = new Map<number, number>();
  const outside = (v: number): number => {
    if (inv(v)) return v;
    const got = before.get(v);
    if (got !== undefined) return got;
    for (const d of reread(v)!) {
      if (before.has(d.res[0]!)) continue;
      const w = newValue(f, f.types[d.res[0]!]!);
      code.push({
        op: d.op,
        ops: d.ops.map((o) =>
          o.t === "v" ? { t: "v" as const, id: before.get(o.id) ?? o.id } : { ...o },
        ),
        res: [w],
      });
      before.set(d.res[0]!, w);
    }
    return before.get(v)!;
  };
  const lenFor = (c: Check): number => {
    const first = [...guards.values()][0]!;
    return outside(faults.wrongLength === true ? first.n : c.n);
  };
  const trapOfModule = (): number => {
    for (const b of f.blocks) {
      if (b.term.k === "trap") return b.term.id;
      for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "trap") return o.id;
    }
    throw new Error("version: no trap site to name");
  };
  let all: number | null = null;
  const and = (g: number): void => {
    all = all === null ? g : op("and.i32", [all, g], "i32");
  };
  const mWide = ivOk ? (): number => wide(outside(fact.m)) : (): number => -1;
  let mw = -1;
  for (const c of guards.values()) {
    const n = lenFor(c);
    if (c.idx.k === "inv") {
      and(op("icmp.ult.ix", [c.idx.v, n], "i32"));
      continue;
    }
    if (mw < 0) mw = mWide();
    const b = c.idx.b ?? k("ix", 0n);
    if (c.idx.s === null) {
      // B <= n && m' <= n - B
      const room = op("sub.ix", [n, b], "ix");
      const lim = faults.offByOne === true ? op("add.ix", [room, k("ix", 1n)], "ix") : room;
      and(op("icmp.ule.ix", [b, n], "i32"));
      and(op("icmp.ule.ix", [mw, lim], "i32"));
    } else {
      // B < n && (m' = 0 || m' - 1 <= (n - 1 - B) / max(S, 1))
      const one = k("ix", 1n);
      const zero = k("ix", 0n);
      const s0 = op("icmp.eq.ix", [c.idx.s, zero], "i32");
      const s1 = op("select.ix", [s0, one, c.idx.s], "ix");
      const room = op("sub.ix", [op("sub.ix", [n, one], "ix"), b], "ix");
      const q0 = op("udiv.ix", [room, s1], "ix", trapOfModule());
      const q = faults.offByOne === true ? op("add.ix", [q0, one], "ix") : q0;
      const none = op("icmp.eq.ix", [mw, zero], "i32");
      const fits = op("icmp.ule.ix", [op("sub.ix", [mw, one], "ix"), q], "i32");
      and(op("icmp.ult.ix", [b, n], "i32"));
      and(op("or.i32", [none, fits], "i32"));
    }
  }
  if (all === null) return null;
  preBlock.instrs.push(...code);
  // The fast copy, and the checks gone from it. copyRegion copies each block's instructions one for one, in order.
  const copies = copyRegion(f, r, l.header, ctx.deadAtO0, null);
  const fastOf = new Map<Instr, Instr>();
  for (const at of r.blocks) {
    const b = f.blocks[at]!;
    const c = copies.get(b.id)!;
    b.instrs.forEach((ins, i) => fastOf.set(ins, c.instrs[i]!));
  }
  const subst = new Map<number, number>();
  const gone = new Set<Instr>();
  const plain = new Set<Instr>();
  for (const c of checks) {
    if (c.ins !== null) {
      const x = fastOf.get(c.ins)!;
      subst.set(x.res[0]!, valueOps(x)[0]!);
      gone.add(x);
    } else {
      const fb: Block = copies.get(f.blocks[c.at]!.id)!;
      const t = fb.term;
      if (t.k === "brif") fb.term = { k: "br", to: c.keep === "t" ? t.t : t.f };
    }
    ctx.stats.checks++;
    // Only the fast copy's: an instruction of the chain is past the header, so in the region, so copied.
    if (c.idx.k === "iv")
      for (const d of c.idx.plain) {
        const x = fastOf.get(d);
        if (x !== undefined) plain.add(x);
      }
  }
  for (const x of plain) {
    const p = opParts(x.op);
    if (p[1] !== "chk") continue;
    x.op = `${p[0]}.${p[3]}`;
    x.ops = x.ops.filter((o) => o.t !== "trap");
    ctx.stats.overflow++;
  }
  for (const b of copies.values()) b.instrs = b.instrs.filter((x) => !gone.has(x));
  substitute(f, subst);
  const fastHeader = copies.get(header.id)!.id;
  preBlock.term = {
    k: "brif",
    cond: all,
    t: { block: fastHeader, args: [...into.to.args] },
    f: into.to,
  };
  removeUnreachable(f);
  return fastHeader;
}
