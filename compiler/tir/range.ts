// What a function's integer values can be, and how they compare, at each block: the proofs check elimination and the
// first turn of a loop use (SPEC 4.3, D73). A check goes only where this proves it can't fire.
//
// Each integer value has two intervals, its bits read unsigned and read signed. They come from constants, from what each
// operation can give from what its operands can be, from a checked operation having passed (its result is in range), and
// from the branches above a block: a block that only one edge of a two-way branch reaches knows the branch's test went that
// way, and so does every block it dominates. A block parameter can be anything any edge gives it; around a loop the
// intervals are found by going round until nothing grows, widening what still grows after a few rounds, then narrowing.
//
// Beside the intervals, facts of the form `a <= b + c`, read unsigned, which intervals can't say: an index is below a
// length the program loaded (from `i < n` above it, or a bounds check it passed), a masked value is at most its mask, the
// mask is the length less one. A proof follows a few of those from one value toward another.
//
// `ix` is 32 bits on wasm32 and 64 on a 64-bit target, and nothing here may differ between them: an `ix` interval holds on
// both, so a wrapping `ix` operation gives a known interval only where neither width wraps, and a checked one is proved
// only below 2^32, where wasm32 traps. One fact comes from the language rather than the TIR: a `usize` is never above
// 2^53 - 1 (D23), which is the 64-bit target's limit for checked `ix` arithmetic, and wasm32's `ix` can't pass its own.
// So `i + k` checked, where `i + k <= n` for an `ix` value `n` read unsigned, can't fire on either.
import { buildCfg, edgesOf, type Cfg, type Func, type Instr, type TirType } from "./ir.ts";
import { intImm, opParts, r26Off, valueOps } from "./passes/util.ts";

export interface Iv {
  lo: bigint;
  hi: bigint;
}

export interface Rng {
  u: Iv; // the bits read unsigned
  s: Iv; // read signed
}

const W: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, ix: 64 };
const P31 = 1n << 31n;
const P32 = 1n << 32n;
/** Checked `ix` arithmetic passes up to here on both targets: wasm32 traps at 2^32. */
export const IX_PORTABLE = P32 - 1n;
/** And no `ix` result of one that passed is above this on either (SPEC 4.3). */
const IX_CHECKED = (1n << 53n) - 1n;

/** R26's injected bugs (D73's fault rule), set by the pass manager for its run: tools/r26-tests.ts. */
let rangeFaults: { relAny?: boolean; fcmpSwap?: boolean } = {};
export function setRangeFaults(f: { relAny?: boolean; fcmpSwap?: boolean }): void {
  rangeFaults = f;
}

export function isTracked(t: TirType): boolean {
  return t in W;
}

const UMAX: Record<string, bigint> = {};
const SMIN: Record<string, bigint> = {};
const SMAX: Record<string, bigint> = {};
for (const [t, w] of Object.entries(W)) {
  UMAX[t] = (1n << BigInt(w)) - 1n;
  SMIN[t] = -(1n << BigInt(w - 1));
  SMAX[t] = (1n << BigInt(w - 1)) - 1n;
}
function umax(t: TirType): bigint {
  return UMAX[t]!;
}
function smin(t: TirType): bigint {
  return SMIN[t]!;
}
function smax(t: TirType): bigint {
  return SMAX[t]!;
}
/** The largest unsigned result a wrapping operation of this type gives the same on every target. */
function uportable(t: TirType): bigint {
  return t === "ix" ? IX_PORTABLE : umax(t);
}
function sportable(t: TirType): Iv {
  return t === "ix" ? { lo: -P31, hi: P31 - 1n } : { lo: smin(t), hi: smax(t) };
}

export function top(t: TirType): Rng {
  return { u: { lo: 0n, hi: umax(t) }, s: { lo: smin(t), hi: smax(t) } };
}

const isTopU = (t: TirType, r: Rng): boolean => r.u.lo === 0n && r.u.hi === umax(t);

/** Each reading tightened by the other, where one says the value is in the range both read alike. */
function norm(t: TirType, r: Rng): Rng {
  let { u, s } = r;
  const sm = t === "ix" ? P31 - 1n : smax(t);
  if (s.lo >= 0n && s.hi <= sm) u = meet(u, s);
  if (u.hi <= sm) s = meet(s, u);
  if (t === "ix" && !(u.hi <= sm)) s = top(t).s;
  return { u, s };
}

function meet(a: Iv, b: Iv): Iv {
  const lo = a.lo > b.lo ? a.lo : b.lo;
  const hi = a.hi < b.hi ? a.hi : b.hi;
  return lo <= hi ? { lo, hi } : a;
}
function join(a: Iv, b: Iv): Iv {
  return { lo: a.lo < b.lo ? a.lo : b.lo, hi: a.hi > b.hi ? a.hi : b.hi };
}
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const sameIv = (a: Iv, b: Iv): boolean => a.lo === b.lo && a.hi === b.hi;
const sameRng = (a: Rng, b: Rng): boolean => sameIv(a.u, b.u) && sameIv(a.s, b.s);

/** A fact `a <= b + c`, unsigned, in exact arithmetic. */
interface Rel {
  a: number;
  b: number;
  c: bigint;
}

interface BlockFacts {
  own: Map<number, Rng>; // intervals this block's own edge refines
  rels: Rel[]; // and the facts it gives
}

export class Ranges {
  readonly f: Func;
  readonly cfg: Cfg;
  private readonly val = new Map<number, Rng>();
  private readonly facts: (BlockFacts | null)[];
  private readonly defs = new Map<number, Instr>();
  private readonly defBlock = new Map<number, number>();
  /** `x -> v` facts that hold only where v is defined: v is x renamed, or x checked. */
  private readonly rev = new Map<number, { to: number; c: bigint }[]>();
  /** Float values that are integers, with their interval. */
  private readonly fint = new Map<number, Iv>();
  /** A float that's exactly a signed integer's conversion, and that integer: `sitofp`, then rounding that changes nothing. */
  private readonly fsrc = new Map<number, number>();
  /** While the intervals are being found, compares are decided by intervals only. */
  private solving = true;
  /** What each way of each branch says, by the branch's block and way: found once a round. */
  private edgeCache = new Map<number, Map<number, Rng>>();
  /** Each value's refinements, by the block's position: what `facts` holds, found by value. */
  private readonly refs = new Map<number, Map<number, Rng>>();
  /** The dominator tree's preorder and postorder numbers, by position: a dominates b where a's span holds b's. */
  private readonly pre: number[];
  private readonly post: number[];

  constructor(f: Func, cfg?: Cfg) {
    this.f = f;
    this.cfg = cfg ?? buildCfg(f);
    this.facts = f.blocks.map(() => null);
    this.pre = f.blocks.map(() => -1);
    this.post = f.blocks.map(() => -1);
    {
      const kids: number[][] = f.blocks.map(() => []);
      for (const at of this.cfg.rpo) {
        const d = this.cfg.idom.get(at);
        if (d !== undefined && d !== at) kids[d]!.push(at);
      }
      let n = 0;
      const stack: { at: number; i: number }[] = [{ at: this.cfg.rpo[0]!, i: 0 }];
      this.pre[this.cfg.rpo[0]!] = n++;
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const k = kids[top.at]![top.i++];
        if (k === undefined) {
          this.post[top.at] = n++;
          stack.pop();
        } else {
          this.pre[k] = n++;
          stack.push({ at: k, i: 0 });
        }
      }
    }
    f.blocks.forEach((b, i) => {
      for (const p of b.params) this.defBlock.set(p, i);
      for (const ins of b.instrs) {
        for (const r of ins.res) {
          this.defs.set(r, ins);
          this.defBlock.set(r, i);
        }
      }
    });
    for (const p of f.params) this.defBlock.set(p, this.cfg.rpo[0]!);
    this.solve();
    this.solving = false;
    for (const [v, ins] of this.defs) {
      for (const e of this.defEdges(v, ins, true)) {
        let l = this.rev.get(e.from);
        if (l === undefined) this.rev.set(e.from, (l = []));
        l.push({ to: v, c: e.c });
      }
    }
  }

  private type(v: number): TirType {
    return this.f.types[v]!;
  }

  /** The value's intervals as known in a block (by position). */
  at(v: number, pos: number): Rng | null {
    const t = this.type(v);
    if (!isTracked(t)) return null;
    // The refinement from the nearest block above that has one: each refines its dominator's, so it's the tightest.
    const m = this.refs.get(v);
    if (m !== undefined) {
      let best: Rng | null = null;
      let bestPre = -1;
      for (const [p, r] of m) {
        const pp = this.pre[p]!;
        if (pp > bestPre && pp <= this.pre[pos]! && this.post[pos]! <= this.post[p]!) {
          best = r;
          bestPre = pp;
        }
      }
      if (best !== null) return best;
    }
    return this.val.get(v) ?? top(t);
  }

  /** The i32 a float is exactly the conversion of, or null: `js.toint32` of it is that i32. */
  intSource(v: number): number | null {
    return this.fsrc.get(v) ?? null;
  }

  /** A float that's an integer, with its interval, or null. */
  intFloat(v: number): Iv | null {
    return this.fint.get(v) ?? null;
  }

  // --- intervals

  private solve(): void {
    const f = this.f;
    const rounds = new Map<number, number>();
    const header = new Set<number>();
    for (const at of this.cfg.rpo)
      for (const p of this.cfg.preds[at]!)
        if ((this.cfg.rpoIndex.get(p) ?? 0) >= (this.cfg.rpoIndex.get(at) ?? 0)) header.add(at);
    for (const p of f.params) if (isTracked(this.type(p))) this.val.set(p, top(this.type(p)));
    // Up to here, then the widened values are narrowed by going round again without widening.
    const WIDEN_AFTER = 3;
    for (let pass = 0, changed = true, narrowing = false, narrowLeft = 2; pass < 40; pass++) {
      if (!changed) {
        if (narrowing || narrowLeft === 0) break;
        narrowing = true;
      }
      changed = false;
      this.edgeCache.clear();
      for (const at of this.cfg.rpo) {
        const b = f.blocks[at]!;
        this.setFacts(at, this.edgeFacts(at));
        if (at !== this.cfg.rpo[0]) {
          b.params.forEach((p, i) => {
            const t = this.type(p);
            if (!isTracked(t)) {
              this.paramFloat(at, p, i);
              return;
            }
            let acc: Rng | null = null;
            for (const pr of new Set(this.cfg.preds[at]!)) {
              for (const e of edgesOf(f.blocks[pr]!.term)) {
                if (e.block !== b.id) continue;
                const a = this.argAt(pr, e, e.args[i]!, t);
                if (a === null) continue;
                acc = acc === null ? a : { u: join(acc.u, a.u), s: join(acc.s, a.s) };
              }
            }
            if (acc === null) return; // no edge known yet
            const old = this.val.get(p);
            let next = norm(t, acc);
            if (old !== undefined && header.has(at) && !narrowing) {
              const n = (rounds.get(p) ?? 0) + 1;
              rounds.set(p, n);
              if (n > WIDEN_AFTER) next = widen(t, old, next);
              else next = { u: join(old.u, next.u), s: join(old.s, next.s) };
            }
            if (old === undefined || !sameRng(old, next)) {
              this.val.set(p, next);
              changed = true;
            }
          });
        }
        for (const ins of b.instrs) {
          if (ins.res.length !== 1) continue;
          const r = ins.res[0]!;
          const t = this.type(r);
          if (!isTracked(t)) {
            this.floatOf(ins, r, at);
            continue;
          }
          const next = norm(t, this.transfer(ins, t, at));
          const old = this.val.get(r);
          if (old === undefined || !sameRng(old, next)) {
            this.val.set(r, next);
            changed = true;
          }
        }
      }
      if (narrowing) narrowLeft--;
      if (narrowing && narrowLeft <= 0) break;
      // With no loop, one round in reverse postorder is the answer.
      if (header.size === 0) break;
    }
  }

  private setFacts(at: number, fs: BlockFacts | null): void {
    const old = this.facts[at];
    if (old !== null && old !== undefined)
      for (const v of old.own.keys()) this.refs.get(v)?.delete(at);
    this.facts[at] = fs;
    if (fs === null) return;
    for (const [v, r] of fs.own) {
      let m = this.refs.get(v);
      if (m === undefined) this.refs.set(v, (m = new Map()));
      m.set(at, r);
    }
  }

  private paramFloat(at: number, p: number, i: number): void {
    let acc: Iv | null = null;
    let all = true;
    for (const pr of new Set(this.cfg.preds[at]!)) {
      for (const e of edgesOf(this.f.blocks[pr]!.term)) {
        if (e.block !== this.f.blocks[at]!.id) continue;
        const x = this.fint.get(e.args[i]!);
        if (x === undefined) all = false;
        else acc = acc === null ? x : join(acc, x);
      }
    }
    if (all && acc !== null && acc.hi - acc.lo < 1n << 52n) this.fint.set(p, acc);
    else this.fint.delete(p);
  }

  private floatOf(ins: Instr, r: number, at: number): void {
    const p = opParts(ins.op);
    const ops = valueOps(ins);
    const b = p[0]!;
    const LIM = 1n << 53n;
    if (b === "fconst" && p[1] === "f64") {
      const x = f64(intImm(ins, 0));
      if (Number.isInteger(x) && Math.abs(x) < 2 ** 53)
        this.fint.set(r, { lo: BigInt(x), hi: BigInt(x) });
    } else if ((b === "sitofp" || b === "uitofp") && p[1] === "f64") {
      const x = this.at(ops[0]!, at);
      if (x === null) return;
      const iv = b === "sitofp" ? x.s : x.u;
      if (iv.lo > -LIM && iv.hi < LIM) {
        this.fint.set(r, iv);
        if (b === "sitofp" && this.type(ops[0]!) === "i32") this.fsrc.set(r, ops[0]!);
      }
    } else if (
      (b === "ftrunc" || b === "ffloor" || b === "fceil" || b === "fnearest") &&
      p[1] === "f64"
    ) {
      const x = this.fint.get(ops[0]!);
      if (x !== undefined) this.fint.set(r, x);
      const src = this.fsrc.get(ops[0]!);
      if (src !== undefined) this.fsrc.set(r, src);
    }
  }

  /** The interval of an edge's argument, as known at the end of the block it leaves, and along that edge. */
  private argAt(
    pr: number,
    e: { block: number; args: number[] },
    v: number,
    t: TirType,
  ): Rng | null {
    // A value not reached yet, round a loop's back edge on the first round: the edge counts from the next round.
    if (!this.val.has(v)) return null;
    let r = this.at(v, pr) ?? top(t);
    const term = this.f.blocks[pr]!.term;
    if (term.k === "brif" && term.t.block !== term.f.block) {
      const truth = term.t === e;
      const key = pr * 2 + (truth ? 1 : 0);
      let ref = this.edgeCache.get(key);
      if (ref === undefined) this.edgeCache.set(key, (ref = this.refineBy(term.cond, truth, pr)));
      const x = ref.get(v);
      if (x !== undefined) r = x;
    }
    return r;
  }

  private transfer(ins: Instr, t: TirType, at: number): Rng {
    const p = opParts(ins.op);
    const b = p[0]!;
    const ops = valueOps(ins);
    const get = (i: number): Rng => this.at(ops[i]!, at) ?? top(this.type(ops[i]!));
    const T = top(t);
    const up = uportable(t);
    const sp = sportable(t);
    const iv = (lo: bigint, hi: bigint): Iv => ({ lo, hi });
    if (b === "iconst") {
      const v = intImm(ins, 0);
      const w = W[t]!;
      if (t === "ix") {
        const u = v >= 0n && v <= IX_PORTABLE ? iv(v, v) : T.u;
        const s = v >= -P31 && v < P31 ? iv(v, v) : T.s;
        return { u, s };
      }
      const u = BigInt.asUintN(w, v);
      const s = BigInt.asIntN(w, v);
      return { u: iv(u, u), s: iv(s, s) };
    }
    if (p[1] === "chk" && (b === "add" || b === "sub" || b === "mul")) {
      const x = get(0);
      const y = get(1);
      const lim = t === "ix" ? IX_CHECKED : umax(t);
      if (p[2] === "u") {
        if (b === "add") return { u: iv(x.u.lo + y.u.lo, min(x.u.hi + y.u.hi, lim)), s: T.s };
        if (b === "sub")
          return { u: iv(max(x.u.lo - y.u.hi, 0n), max(x.u.hi - y.u.lo, 0n)), s: T.s };
        return { u: iv(x.u.lo * y.u.lo, min(x.u.hi * y.u.hi, lim)), s: T.s };
      }
      if (t === "ix") return T;
      const r = arith(b, x.s, y.s);
      return { u: T.u, s: iv(max(r.lo, smin(t)), min(r.hi, smax(t))) };
    }
    switch (b) {
      case "add":
      case "sub":
      case "mul": {
        if (p.length !== 2) return T;
        const x = get(0);
        const y = get(1);
        let u = T.u;
        if (b !== "sub" || x.u.lo >= y.u.hi) {
          const r = arith(b, x.u, y.u);
          if (r.lo >= 0n && r.hi <= up) u = r;
        }
        let s = T.s;
        const rs = arith(b, x.s, y.s);
        if (rs.lo >= sp.lo && rs.hi <= sp.hi) s = rs;
        return { u, s };
      }
      case "and": {
        const x = get(0);
        const y = get(1);
        const u = iv(0n, min(x.u.hi, y.u.hi));
        const nn = x.s.lo >= 0n ? x.s.hi : y.s.lo >= 0n ? y.s.hi : null;
        return { u, s: nn !== null ? iv(0n, nn) : T.s };
      }
      case "or":
      case "xor": {
        const x = get(0);
        const y = get(1);
        const m = max(x.u.hi, y.u.hi);
        const hi = (1n << BigInt(m.toString(2).length)) - 1n;
        return { u: iv(b === "or" ? max(x.u.lo, y.u.lo) : 0n, min(hi, T.u.hi)), s: T.s };
      }
      case "shl": {
        const x = get(0);
        const c = this.constOf(ops[1]!);
        if (c === null) return T;
        const k = p[1] === "js32" ? c & 31n : c;
        if (k < 0n || k >= BigInt(W[t]!)) return T;
        const hi = x.u.hi << k;
        return hi <= up ? { u: iv(x.u.lo << k, hi), s: T.s } : T;
      }
      case "lshr": {
        const x = get(0);
        const c = this.constOf(ops[1]!);
        const k = c === null ? null : p[1] === "js32" ? c & 31n : c;
        if (k === null || k < 0n || k >= BigInt(W[t]!)) return { u: iv(0n, x.u.hi), s: T.s };
        return { u: iv(x.u.lo >> k, x.u.hi >> k), s: T.s };
      }
      case "ashr": {
        const x = get(0);
        if (x.s.lo < 0n) return T;
        const c = this.constOf(ops[1]!);
        const k = c === null ? null : p[1] === "js32" ? c & 31n : c;
        if (k === null || k < 0n || k >= BigInt(W[t]!))
          return { u: iv(0n, x.s.hi), s: iv(0n, x.s.hi) };
        return { u: iv(x.s.lo >> k, x.s.hi >> k), s: iv(x.s.lo >> k, x.s.hi >> k) };
      }
      case "zext":
      case "sext":
      case "trunc": {
        const x = get(0);
        // To `ix` from 64 bits is a truncation on wasm32: only what fits in 32 bits is the same number.
        if (t === "ix" && this.type(ops[0]!) === "i64")
          return x.u.hi <= IX_PORTABLE ? { u: x.u, s: T.s } : T;
        if (b === "zext") return { u: x.u, s: T.s };
        if (b === "sext") return { u: x.s.lo >= 0n ? x.s : T.u, s: x.s };
        if (x.u.hi <= uportable(t)) return { u: x.u, s: T.s };
        if (x.s.lo >= sportable(t).lo && x.s.hi <= sportable(t).hi) return { u: T.u, s: x.s };
        return T;
      }
      case "udiv": {
        const x = get(0);
        const y = get(1);
        return { u: iv(x.u.lo / max(y.u.hi, 1n), x.u.hi / max(y.u.lo, 1n)), s: T.s };
      }
      case "urem": {
        const x = get(0);
        const y = get(1);
        return { u: iv(0n, min(x.u.hi, max(y.u.hi - 1n, 0n))), s: T.s };
      }
      case "srem": {
        const x = get(0);
        const y = get(1);
        if (x.s.lo >= 0n && y.s.lo > 0n)
          return { u: iv(0n, min(x.s.hi, y.s.hi - 1n)), s: iv(0n, min(x.s.hi, y.s.hi - 1n)) };
        return T;
      }
      case "range": {
        const x = get(0);
        const imms = ins.ops.filter((o) => o.t === "i" || o.t === "ixmax");
        const lo = imms[0]?.t === "i" ? imms[0].val : 0n;
        const hi = imms[1]?.t === "i" ? imms[1].val : IX_CHECKED;
        if (p[2] === "u") {
          const w = W[t]!;
          return {
            u: meet(
              x.u,
              iv(
                BigInt.asUintN(w, lo),
                t === "ix" && imms[1]?.t === "ixmax" ? IX_CHECKED : BigInt.asUintN(w, hi),
              ),
            ),
            s: x.s,
          };
        }
        return { u: x.u, s: meet(x.s, iv(lo, hi)) };
      }
      case "bounds": {
        const x = get(0);
        const n = get(1);
        return { u: iv(x.u.lo, min(x.u.hi, max(n.u.hi - 1n, 0n))), s: T.s };
      }
      case "icmp":
      case "fcmp": {
        const k = this.decide(ins, at);
        return k === null ? { u: iv(0n, 1n), s: iv(0n, 1n) } : { u: iv(k, k), s: iv(k, k) };
      }
      case "select": {
        const c = this.constOf(ops[0]!);
        const x = get(1);
        const y = get(2);
        if (c !== null) return c !== 0n ? x : y;
        return { u: join(x.u, y.u), s: join(x.s, y.s) };
      }
      case "js": {
        const x = this.fint.get(ops[0]!);
        if (x !== undefined && x.lo >= smin("i32") && x.hi <= smax("i32")) return { u: T.u, s: x };
        return T;
      }
      case "intrinsic": {
        const n = ins.ops[0];
        if (n?.t === "name" && n.name === "clz32") return { u: iv(0n, 32n), s: iv(0n, 32n) };
        return T;
      }
      default:
        return T;
    }
  }

  private constOf(v: number): bigint | null {
    const d = this.defs.get(v);
    if (d === undefined || !d.op.startsWith("iconst.")) return null;
    return intImm(d, 0);
  }

  /** A compare's result where the intervals and facts decide it: 1n, 0n, or null. */
  decide(ins: Instr, at: number): bigint | null {
    const p = opParts(ins.op);
    const ops = valueOps(ins);
    if (p[0] === "fcmp") {
      const a = this.fint.get(ops[0]!);
      const b = this.fint.get(ops[1]!);
      if (a === undefined || b === undefined) return null;
      const byIv = cmpIv(p[1]!, a, b);
      if (byIv !== null || this.solving) return byIv;
      // Two converted i32s, neither negative, compare as the integers do, whose facts are unsigned.
      const x = this.fsrc.get(ops[0]!);
      const y = this.fsrc.get(ops[1]!);
      if (x === undefined || y === undefined) return null;
      if (r26Off("range")) {
        if (a.lo < 0n || b.lo < 0n) return null;
        return this.relCompare(p[1]!, x, y, at);
      }
      // R26: each as known where the compare is (a test above may say an i32 isn't negative), not as converted.
      const xs = this.at(x, at)!;
      const ys = this.at(y, at)!;
      // the injected `r26-fcmp-swap` bug: the integers compared the other way round
      const [u, w] = rangeFaults.fcmpSwap === true ? [y, x] : [x, y];
      const [us, ws] = rangeFaults.fcmpSwap === true ? [ys, xs] : [xs, ys];
      const byInt = cmpIv(p[1]!, us.s, ws.s);
      if (byInt !== null) return byInt;
      if ((a.lo < 0n && xs.s.lo < 0n) || (b.lo < 0n && ys.s.lo < 0n)) return null;
      return this.relCompare(p[1]!, u, w, at);
    }
    if (p[0] !== "icmp") return null;
    const t = this.type(ops[0]!);
    if (!isTracked(t)) return null;
    const x = this.at(ops[0]!, at)!;
    const y = this.at(ops[1]!, at)!;
    const pred = p[1]!;
    const signed = pred.startsWith("s");
    const byIv = cmpIv(pred.replace(/^[su]/, ""), signed ? x.s : x.u, signed ? y.s : y.u);
    if (byIv !== null || this.solving) return byIv;
    // Facts: unsigned compares, and signed ones where both are known not negative.
    if (signed && !(x.s.lo >= 0n && y.s.lo >= 0n && (t !== "ix" || (x.u.hi < P31 && y.u.hi < P31))))
      return null;
    const [a, b] = ops as [number, number];
    return this.relCompare(pred.replace(/^[su]/, ""), a, b, at);
  }

  /** A compare decided by the facts `a <= b + c`, its operands read unsigned. */
  private relCompare(base: string, a: number, b: number, at: number): bigint | null {
    if (base === "lt") return this.le(a, b, -1n, at) ? 1n : this.le(b, a, 0n, at) ? 0n : null;
    if (base === "le") return this.le(a, b, 0n, at) ? 1n : this.le(b, a, -1n, at) ? 0n : null;
    if (base === "gt") return this.le(b, a, -1n, at) ? 1n : this.le(a, b, 0n, at) ? 0n : null;
    if (base === "ge") return this.le(b, a, 0n, at) ? 1n : this.le(a, b, -1n, at) ? 0n : null;
    if (base === "eq") return this.le(a, b, -1n, at) || this.le(b, a, -1n, at) ? 0n : null;
    if (base === "ne") return this.le(a, b, -1n, at) || this.le(b, a, -1n, at) ? 1n : null;
    return null;
  }

  // --- edges and facts

  /** What one way of a two-way branch says about the values its test compares. */
  private refineBy(cond: number, truth: boolean, at: number): Map<number, Rng> {
    const out = new Map<number, Rng>();
    const d = this.defs.get(cond);
    const t = this.type(cond);
    if (d === undefined || !d.op.startsWith("icmp.")) {
      if (isTracked(t)) {
        const c = this.at(cond, at)!;
        if (truth && c.u.lo === 0n) out.set(cond, { u: { lo: 1n, hi: c.u.hi }, s: c.s });
        if (!truth) out.set(cond, { u: { lo: 0n, hi: 0n }, s: { lo: 0n, hi: 0n } });
      }
      return out;
    }
    const p = opParts(d.op);
    const [a, b] = valueOps(d) as [number, number];
    const ty = this.type(a);
    if (!isTracked(ty)) return out;
    let pred = p[1]!;
    if (!truth) pred = NEGATE[pred]!;
    const x = this.at(a, at)!;
    const y = this.at(b, at)!;
    const signed = pred.startsWith("s");
    // A signed `ix` compare reads 32 bits on wasm32 and 64 on a 64-bit target: alike only below 2^31.
    if (signed && ty === "ix" && !(x.u.hi < P31 && y.u.hi < P31)) return out;
    const X = signed ? x.s : x.u;
    const Y = signed ? y.s : y.u;
    let nx: Iv = X;
    let ny: Iv = Y;
    switch (pred.replace(/^[su]/, "")) {
      case "lt":
        nx = meet(X, { lo: X.lo, hi: Y.hi - 1n });
        ny = meet(Y, { lo: X.lo + 1n, hi: Y.hi });
        break;
      case "le":
        nx = meet(X, { lo: X.lo, hi: Y.hi });
        ny = meet(Y, { lo: X.lo, hi: Y.hi });
        break;
      case "gt":
        nx = meet(X, { lo: Y.lo + 1n, hi: X.hi });
        ny = meet(Y, { lo: Y.lo, hi: X.hi - 1n });
        break;
      case "ge":
        nx = meet(X, { lo: Y.lo, hi: X.hi });
        ny = meet(Y, { lo: Y.lo, hi: X.hi });
        break;
      case "eq":
        nx = meet(X, Y);
        ny = meet(Y, X);
        break;
      case "ne":
        if (Y.lo === Y.hi) nx = notPoint(X, Y.lo);
        if (X.lo === X.hi) ny = notPoint(Y, X.lo);
        break;
    }
    const put = (v: number, r: Rng, n: Iv): void => {
      out.set(v, norm(ty, signed ? { u: r.u, s: n } : { u: n, s: r.s }));
    };
    put(a, x, nx);
    put(b, y, ny);
    return out;
  }

  private edgeFacts(at: number): BlockFacts | null {
    const preds = this.cfg.preds[at]!;
    if (preds.length !== 1) return null;
    const pr = preds[0]!;
    const term = this.f.blocks[pr]!.term;
    const id = this.f.blocks[at]!.id;
    if (term.k === "brif" && term.t.block !== term.f.block) {
      const truth = term.t.block === id;
      const own = this.refineBy(term.cond, truth, pr);
      return { own, rels: this.relsOf(term.cond, truth, pr) };
    }
    if (term.k === "switch") {
      const hits = term.cases.filter((c) => c.to.block === id);
      if (hits.length === 1 && term.def.block !== id) {
        const t = this.type(term.val);
        if (!isTracked(t)) return null;
        const k = hits[0]!.key;
        const w = W[t]!;
        const r = norm(t, {
          u: { lo: BigInt.asUintN(w, k), hi: BigInt.asUintN(w, k) },
          s: { lo: BigInt.asIntN(w, k), hi: BigInt.asIntN(w, k) },
        });
        if (t === "ix" && (k < 0n || k > IX_PORTABLE)) return null;
        return { own: new Map([[term.val, r]]), rels: [] };
      }
    }
    return null;
  }

  /** A branch's test as facts `a <= b + c`. */
  private relsOf(cond: number, truth: boolean, at: number): Rel[] {
    const d = this.defs.get(cond);
    if (d === undefined || !d.op.startsWith("icmp.")) return [];
    const p = opParts(d.op);
    const [a, b] = valueOps(d) as [number, number];
    const t = this.type(a);
    if (!isTracked(t)) return [];
    let pred = p[1]!;
    if (!truth) pred = NEGATE[pred]!;
    if (pred.startsWith("s")) {
      const x = this.at(a, at)!;
      const y = this.at(b, at)!;
      if (t === "ix" && !(x.s.lo >= 0n && y.s.lo >= 0n && x.u.hi < P31 && y.u.hi < P31)) return [];
      // R26: a signed test reads as the unsigned one where its smaller side isn't negative: `a < b` (or `<=`) with `a >= 0`
      // puts `b` at or above `a`, so not negative either, and two values that aren't negative compare alike either way.
      const small = pred === "slt" || pred === "sle" ? x : y;
      // the injected `r26-rel-any` bug: neither side's sign asked
      const ok = r26Off("range")
        ? x.s.lo >= 0n && y.s.lo >= 0n
        : small.s.lo >= 0n || rangeFaults.relAny === true;
      if (!ok) return [];
    }
    switch (pred.replace(/^[su]/, "")) {
      case "lt":
        return [{ a, b, c: -1n }];
      case "le":
        return [{ a, b, c: 0n }];
      case "gt":
        return [{ a: b, b: a, c: -1n }];
      case "ge":
        return [{ a: b, b: a, c: 0n }];
      case "eq":
        return [
          { a, b, c: 0n },
          { a: b, b: a, c: 0n },
        ];
      default:
        return [];
    }
  }

  /** What a value's definition says: `from <= to + c` facts, either way. */
  private defEdges(
    v: number,
    ins: Instr,
    reverse: boolean,
  ): { from: number; to: number; c: bigint }[] {
    const p = opParts(ins.op);
    const b = p[0]!;
    const ops = valueOps(ins);
    const out: { from: number; to: number; c: bigint }[] = [];
    const fw = (to: number, c: bigint): void => {
      if (!reverse) out.push({ from: v, to, c });
    };
    const bw = (from: number, c: bigint): void => {
      if (reverse) out.push({ from, to: v, c });
    };
    const k1 = ops[1] !== undefined ? this.constOf(ops[1]) : null;
    const t = this.type(v);
    if (!isTracked(t)) return out;
    switch (b) {
      case "zext":
      case "range":
        if (b === "zext" && t === "ix" && this.type(ops[0]!) === "i64") break;
        fw(ops[0]!, 0n);
        bw(ops[0]!, 0n);
        break;
      case "js": {
        // js.toint32 of a converted i32 is that i32, where it's not negative (the facts read unsigned).
        const src = this.fsrc.get(ops[0]!);
        const x = src !== undefined ? this.val.get(src) : undefined;
        if (src !== undefined && x !== undefined && x.s.lo >= 0n) {
          fw(src, 0n);
          bw(src, 0n);
        }
        break;
      }
      case "trunc":
      case "and":
      case "lshr":
      case "udiv":
        fw(ops[0]!, 0n);
        if (b === "and") fw(ops[1]!, 0n);
        break;
      case "urem":
        fw(ops[1]!, -1n);
        break;
      case "bounds":
        fw(ops[1]!, -1n);
        fw(ops[0]!, 0n);
        bw(ops[0]!, 0n);
        break;
      case "add":
      case "sub": {
        const checked = p[1] === "chk" && p[2] === "u";
        // Where the operation is: a test above it may say it can't wrap (`n != 0` before `n - 1`).
        const db = this.defBlock.get(v);
        const x = db !== undefined ? (this.at(ops[0]!, db) ?? undefined) : this.val.get(ops[0]!);
        if (k1 !== null && k1 >= 0n) {
          // Checked, or wrapping where it can't wrap.
          const ok =
            checked ||
            (p.length === 2 &&
              x !== undefined &&
              (b === "add" ? x.u.hi + k1 <= uportable(t) : x.u.lo >= k1));
          if (ok) {
            fw(ops[0]!, b === "add" ? k1 : -k1);
            bw(ops[0]!, b === "add" ? -k1 : k1);
          }
        } else if (checked) {
          if (b === "add") {
            bw(ops[0]!, 0n);
            bw(ops[1]!, 0n);
          } else fw(ops[0]!, 0n);
        }
        break;
      }
    }
    return out;
  }

  /**
   * Whether `a <= b + c`, unsigned, holds in block `at`: from the facts, a few steps from `a` toward `b`, then from the
   * intervals of where they got to. `strict` is check elimination's injected fault (D73), which takes one more than proved.
   */
  le(a: number, b: number, c: bigint, at: number, slack = 0n): boolean {
    if (a === b) return c >= 0n;
    const yb = this.at(b, at);
    const blo = yb !== null ? yb.u.lo : 0n;
    // R26: `b` is the same number as what its own definition widens or range-checks (`zext n`, `range.chk n`), so reaching
    // that is reaching `b`: `b` is asked about where it's used, so its definition has run.
    const targets = this.sameAs(b);
    const seen = new Map<number, bigint>();
    const stack: { v: number; w: bigint; d: number }[] = [{ v: a, w: 0n, d: 0 }];
    let steps = 0;
    while (stack.length > 0 && steps++ < 200) {
      const { v, w, d } = stack.pop()!;
      const prev = seen.get(v);
      if (prev !== undefined && prev <= w) continue;
      seen.set(v, w);
      if (targets.has(v) && w <= c + slack) return true;
      const r = this.at(v, at);
      if (r !== null && r.u.hi + w <= blo + c + slack) return true;
      if (d >= 6) continue;
      for (const e of this.outEdges(v, at)) stack.push({ v: e.to, w: w + e.c, d: d + 1 });
    }
    return false;
  }

  /** `b`, and the values it's the same number as by its own definition, read unsigned: a `zext` or `range` check's operand. */
  private sameAs(b: number): Set<number> {
    const out = new Set<number>([b]);
    if (r26Off("range")) return out;
    let v = b;
    for (let d = 0; d < 4; d++) {
      const ins = this.defs.get(v);
      if (ins === undefined) break;
      const base = opParts(ins.op)[0];
      if (base !== "zext" && base !== "range") break;
      const src = valueOps(ins)[0]!;
      if (base === "zext" && this.type(v) === "ix" && this.type(src) === "i64") break;
      out.add(src);
      v = src;
    }
    return out;
  }

  /**
   * Whether `a + k` is at most another value, read unsigned, that's itself within `t`'s limit for checked arithmetic: one
   * of a type no wider, or, for `ix`, an `ix` value, a usize, which is never above 2^53 - 1 (D23), and on wasm32 never
   * above its own width. So `a + k` checked as `t` can't fire.
   */
  belowValue(a: number, k: bigint, at: number, t: TirType): boolean {
    const fits = (z: TirType): boolean =>
      t === "i64"
        ? isTracked(z)
        : t === "ix"
          ? z === "ix" || W[z]! <= 32
          : z !== "ix" && W[z]! <= W[t]!;
    const seen = new Map<number, bigint>();
    const stack: { v: number; w: bigint; d: number }[] = [{ v: a, w: 0n, d: 0 }];
    let steps = 0;
    while (stack.length > 0 && steps++ < 200) {
      const { v, w, d } = stack.pop()!;
      const prev = seen.get(v);
      if (prev !== undefined && prev <= w) continue;
      seen.set(v, w);
      if (v !== a && fits(this.type(v)) && w + k <= 0n) return true;
      if (d >= 6) continue;
      for (const e of this.outEdges(v, at)) stack.push({ v: e.to, w: w + e.c, d: d + 1 });
    }
    return false;
  }

  private outEdges(v: number, at: number): { to: number; c: bigint }[] {
    const out: { to: number; c: bigint }[] = [];
    const d = this.defs.get(v);
    if (d !== undefined) for (const e of this.defEdges(v, d, false)) out.push({ to: e.to, c: e.c });
    for (const e of this.rev.get(v) ?? []) {
      const db = this.defBlock.get(e.to);
      // Strictly: in the same block it may come after the point asked about, and a check would prove itself.
      if (db !== undefined && db !== at && this.dominates(db, at)) out.push(e);
    }
    for (let b: number | undefined = at, depth = 0; b !== undefined && depth < 64; depth++) {
      const fs = this.facts[b];
      if (fs !== null && fs !== undefined)
        for (const r of fs.rels) if (r.a === v) out.push({ to: r.b, c: r.c });
      const up = this.cfg.idom.get(b);
      if (up === undefined || up === b) break;
      b = up;
    }
    return out;
  }

  /**
   * Which way the two-way branch ending block `at` goes on a loop's first turn, by position, where intervals prove it: its
   * test's operands are the header's parameters, read as the edges into the loop give them, or values from before the
   * loop, read where the loop starts. Null where it isn't proved.
   */
  firstTurn(at: number, header: number, blocks: Set<number>): number | null {
    const f = this.f;
    const term = f.blocks[at]!.term;
    if (term.k !== "brif" || term.t.block === term.f.block) return null;
    const d = this.defs.get(term.cond);
    if (d === undefined || !d.op.startsWith("icmp.")) return null;
    const h = f.blocks[header]!;
    // On each edge into the loop: an argument for a header parameter, else the value itself, as that edge's branch leaves it.
    const entry = (v: number): Rng | null => {
      const t = this.type(v);
      if (!isTracked(t)) return null;
      const i = h.params.indexOf(v);
      if (i < 0) {
        const db = this.defBlock.get(v);
        if (db === undefined || blocks.has(db)) return null;
      }
      let acc: Rng | null = null;
      for (const pr of new Set(this.cfg.preds[header]!)) {
        if (blocks.has(pr)) continue;
        const term = f.blocks[pr]!.term;
        for (const e of edgesOf(term)) {
          if (e.block !== h.id) continue;
          const x = i >= 0 ? e.args[i]! : v;
          let r = this.at(x, pr);
          if (r === null) return null;
          if (term.k === "brif" && term.t.block !== term.f.block) {
            const ref = this.refineBy(term.cond, term.t === e, pr).get(x);
            if (ref !== undefined) r = ref;
          }
          acc = acc === null ? r : { u: join(acc.u, r.u), s: join(acc.s, r.s) };
        }
      }
      return acc;
    };
    const [a, b] = valueOps(d) as [number, number];
    const x = entry(a);
    const y = entry(b);
    if (x === null || y === null) return null;
    const pred = opParts(d.op)[1]!;
    const signed = pred.startsWith("s");
    if (signed && this.type(a) === "ix") return null;
    const k = cmpIv(pred.replace(/^[su]/, ""), signed ? x.s : x.u, signed ? y.s : y.u);
    if (k === null) return null;
    const to = k !== 0n ? term.t.block : term.f.block;
    const pos = f.blocks.findIndex((bb) => bb.id === to);
    return pos >= 0 ? pos : null;
  }

  dominates(a: number, b: number): boolean {
    if (this.pre[a]! >= 0 && this.pre[b]! >= 0)
      return this.pre[a]! <= this.pre[b]! && this.post[b]! <= this.post[a]!;
    let cur = b;
    for (let guard = 0; guard < 100000; guard++) {
      if (cur === a) return true;
      const up = this.cfg.idom.get(cur);
      if (up === undefined || up === cur) return false;
      cur = up;
    }
    return false;
  }
}

const NEGATE: Record<string, string> = {
  eq: "ne",
  ne: "eq",
  ult: "uge",
  ule: "ugt",
  ugt: "ule",
  uge: "ult",
  slt: "sge",
  sle: "sgt",
  sgt: "sle",
  sge: "slt",
};

function notPoint(x: Iv, k: bigint): Iv {
  if (x.lo === k && x.hi > k) return { lo: k + 1n, hi: x.hi };
  if (x.hi === k && x.lo < k) return { lo: x.lo, hi: k - 1n };
  return x;
}

function arith(b: string, x: Iv, y: Iv): Iv {
  if (b === "add") return { lo: x.lo + y.lo, hi: x.hi + y.hi };
  if (b === "sub") return { lo: x.lo - y.hi, hi: x.hi - y.lo };
  const c = [x.lo * y.lo, x.lo * y.hi, x.hi * y.lo, x.hi * y.hi];
  return { lo: c.reduce(min), hi: c.reduce(max) };
}

/** Grows what still grows to the type's limit, so going round a loop ends. */
function widen(t: TirType, old: Rng, next: Rng): Rng {
  const T = top(t);
  const w = (o: Iv, n: Iv, tt: Iv): Iv => ({
    lo: n.lo < o.lo ? tt.lo : o.lo,
    hi: n.hi > o.hi ? tt.hi : o.hi,
  });
  return norm(t, { u: w(old.u, next.u, T.u), s: w(old.s, next.s, T.s) });
}

/** A compare of two intervals: 1n where it holds for every pair, 0n where for none, else null. */
function cmpIv(pred: string, a: Iv, b: Iv): bigint | null {
  switch (pred) {
    case "lt":
      return a.hi < b.lo ? 1n : a.lo >= b.hi ? 0n : null;
    case "le":
      return a.hi <= b.lo ? 1n : a.lo > b.hi ? 0n : null;
    case "gt":
      return a.lo > b.hi ? 1n : a.hi <= b.lo ? 0n : null;
    case "ge":
      return a.lo >= b.hi ? 1n : a.hi < b.lo ? 0n : null;
    case "eq":
      return a.lo === a.hi && b.lo === b.hi && a.lo === b.lo
        ? 1n
        : a.hi < b.lo || b.hi < a.lo
          ? 0n
          : null;
    case "ne":
      return a.hi < b.lo || b.hi < a.lo
        ? 1n
        : a.lo === a.hi && b.lo === b.hi && a.lo === b.lo
          ? 0n
          : null;
    default:
      return null;
  }
}

const F64 = new DataView(new ArrayBuffer(8));
function f64(bits: bigint): number {
  F64.setBigUint64(0, BigInt.asUintN(64, bits));
  return F64.getFloat64(0);
}

export { isTopU };
