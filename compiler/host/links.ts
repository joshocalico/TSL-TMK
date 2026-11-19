// The table-links proof (SPEC 3.5, D79, R29): a class's claim that every link its tables hold is below its arrays' lengths,
// proved by tslc over every write to them, so a lookup that walks a chain needs no bounds check a step.
//
// A class C claims a group of its fields with `@tsl.links heads chain < keys chain` on its declaration: the fields before
// `<` are its link fields L, after it its bound fields B. Each is @tsl/jsrt's JsArray held in place (a link field's elements
// `u32`). A link is a `u32` from 2 to 2^31 - 1, and it names position link - 2; 0, 1 and anything from 2^31 up aren't links
// (a map's TOMB and END, and where its move put a position, MOVED | p). The claim, I(group): every link any L field's array
// holds, below its length, names a position below the length of every B field's array. A class may claim several groups
// (a map's table and the old one it empties while it grows).
//
// tslc proves I holds wherever C's code reads a link, by following C's methods statement by statement (`analyse`), each
// starting with I holding for each of its object's groups (a constructor with every array new, so empty of links), and
// requiring it again wherever it gives control to code that may assume it: its returns, a call to another of C's methods,
// a call to a group function, and a call to any code that may reach C's methods (whole-program: a callee reaches C if it or
// anything it calls is C's method, or makes an indirect call). Each L field is "empty" (no links: just made, trimmed,
// emptied, or its length set to 0), "valid" (I holds for it), or "broken". What breaks I, and what it needs:
//  - storing into an L field's element (`set`, `push`): the value must be 0, 1, anything from 2^31 up (`(c | x) >>> 0` with
//    c's top bit set), a value read from an L field of the same group since its B fields last got shorter, or `(p + 2) >>> 0`
//    where p is a position known below every B field's length;
//  - anything that can make a B field shorter (`setLength`, `trim`, `adopt` from it, a swap): every L field of its group
//    that isn't empty is broken, and what was known about positions and links of that group is forgotten;
//  - a run of statements that each swap one of C's fields with another (`swap`), which moves one group's arrays to the
//    other: each group keeps its state only where the run swaps every field of one group with the same place in the other.
// A position is known below a B field's length after a bounds-checked access of it there (`get`, `set`, `zero`, or a test
// `if (p >= f.length) trap(...)`), or where it's the length read before a `push` onto it, or where it's `(s - 2) >>> 0` for
// a value s read from the group's L field, under a test `p < 2^31 - 2` (so s was a link, as I says). Calls between forget
// what's known where the callee may reach C's methods.
// The fields themselves: only C's own methods (and its group functions, module functions every call of which passes one of
// its groups in the same places) may name them, as receivers of JsArray's methods, a local const naming one, an argument of
// C's own method taking an array (followed into it at each call), or of a group function, or what `adopt` takes from; no
// object of C, or holding one in place, is an element in place or viewed (as D77's rule 5). Anything else refuses C.
//
// What tslc then marks (`call.inb`): each call of JsArray's `get`, `set` or `zero` on one of the fields whose index it knows
// is below that field's length in every way it's reached; lowering notes it, and the optimiser's inliner takes that call's
// copy of the callee's leading bounds check (`if (i >= this.len) trap(Trap.Bounds)`, its compare noted `chk`) out. Nothing
// unchecked is added: a check goes only where this proves it can't fire, and anything the rule can't follow keeps its checks.
//
// What it rests on: JsArray's methods do what their SAFETY comments and D66 say (a bounds check traps past the length;
// `push` adds one; `setLength` keeps what's below and adds zeros; `trim` and `adopt` leave the array empty; `swap`
// exchanges two whole arrays; `reserve` changes no element); JsArray's buffer is reached only by its own methods (D77's
// separation, `JsArray.data`); C's private fields are written only by C's code (tslc's checks, and an object is moved whole,
// as D77's rule 5 has it); and in `manual`, nothing uses an object after `unsafeFree`.
import {
  tyKey,
  type ClassInst,
  type FuncInst,
  type Stmt,
  type TE,
  type TypedModule,
  type Var,
} from "./types.ts";
import { walkTE } from "./walk.ts";

/** What the rule found, for tests and `TMK_LINKS_DEBUG=1`. */
export interface LinksReport {
  /** each group proved, as `C: <claim>` */
  groups: string[];
  /** each class whose claim was refused, and why */
  refused: Record<string, string>;
  /** calls marked proved in bounds */
  sites: number;
  /** compares noted as a method's leading bounds check */
  checks: number;
}

/** R29's switch for the pins tool and the shapes test (tools/r29-pins.ts): `TMK_R29_OFF=links` proves nothing. */
export function r29Off(part: string): boolean {
  return (process.env.TMK_R29_OFF ?? "").split(",").includes(part);
}

/**
 * The injected bugs in this rule (tools/r29-tests.ts), each a hole a wrong proof would have: `r29-links-store` lets any value
 * be stored into a link field; `r29-links-shrink` misses a B field getting shorter; `r29-links-outside` misses a field named
 * outside its class.
 */
function fault(name: "r29-links-store" | "r29-links-shrink" | "r29-links-outside"): boolean {
  return process.env.TMK_TEST_TSL === name;
}

const LINKS_TOP = 0x7ffffffe; // (s - 2) >>> 0 below this: s is a link, 2 to 2^31 - 1

function isJsArray(c: ClassInst | undefined): boolean {
  return c !== undefined && c.key.startsWith("ex-jsrt-array.JsArray<");
}

/** A JsArray method's name, from its instance: `get`, `get:length`, `push`... */
function arrayMethod(inst: FuncInst): string | null {
  if (!isJsArray(inst.owner)) return null;
  const k = inst.key;
  const at = k.lastIndexOf(">.");
  return at < 0 ? null : k.slice(at + 2);
}

function unwrap(te: TE): TE {
  return te.k === "chkref" ? unwrap(te.val) : te;
}

function litOf(te: TE): bigint | null {
  if (te.k === "lit" && (typeof te.value === "number" || typeof te.value === "bigint"))
    return Number.isInteger(Number(te.value)) ? BigInt(te.value) : null;
  if (te.k === "global" && !te.g.mutable && typeof te.g.value === "number")
    return Number.isInteger(te.g.value) ? BigInt(te.g.value) : null;
  if (te.k === "conv") return litOf(te.val);
  return null;
}

function nonLinkConst(n: bigint): boolean {
  return n === 0n || n === 1n || (n >= 0x80000000n && n <= 0xffffffffn);
}

/** Marks every JsArray `get`, `set` and `zero` whose body starts with its bounds check: that compare is noted `chk`. */
function markLeadingChecks(funcs: FuncInst[]): number {
  let n = 0;
  for (const f of funcs) {
    const m = arrayMethod(f);
    if (m !== "get" && m !== "set" && m !== "zero") continue;
    const first = f.body[0];
    if (first === undefined || first.k !== "if" || first.b !== null || first.a.length !== 1)
      continue;
    const c = first.c;
    const t = first.a[0]!;
    if (t.k !== "expr" || t.e.k !== "builtin" || t.e.name !== "trap") continue;
    if (c.k !== "cmp" || c.op !== "ge" || c.a.k !== "var" || f.params[1] !== c.a.v) continue;
    const b = unwrap(c.b);
    if (b.k !== "ofield" || b.f.name !== "len" || b.obj.k !== "var" || b.obj.v !== f.params[0])
      continue;
    c.chk = 1;
    n++;
  }
  return n;
}

type LState = "E" | "V" | "X";

interface St {
  l: Map<string, LState>; // each L field of the context's groups
  facts: Set<string>; // pos:<var>:<field>, len:<var>:<field>, lp:<var>:<group>, lv:<var>:<group>, link:<var>:<group>, nl:<var>
  dead: boolean;
}

function copySt(s: St): St {
  return { l: new Map(s.l), facts: new Set(s.facts), dead: s.dead };
}

function joinSt(xs: St[]): St {
  const live = xs.filter((x) => !x.dead);
  if (live.length === 0) return { l: new Map(xs[0]?.l ?? []), facts: new Set(), dead: true };
  const out = copySt(live[0]!);
  for (const x of live.slice(1)) {
    for (const [k, v] of x.l) {
      const a = out.l.get(k) ?? "E";
      out.l.set(k, a === "X" || v === "X" ? "X" : a === "V" || v === "V" ? "V" : "E");
    }
    for (const f of out.facts) if (!x.facts.has(f)) out.facts.delete(f);
  }
  return out;
}

function sameSt(a: St, b: St): boolean {
  if (a.dead !== b.dead || a.facts.size !== b.facts.size) return false;
  for (const f of a.facts) if (!b.facts.has(f)) return false;
  for (const [k, v] of a.l) if (b.l.get(k) !== v) return false;
  return true;
}

/** What's known of a value. */
interface Info {
  member?: string; // it's one of the fields' arrays
  safe?: Set<number> | "all"; // storing it into an L field of these groups keeps I: a non-link, or a link valid there
  lp?: number; // (s - 2) >>> 0 for an s read from this group's L field
  pos?: Set<string>; // below these fields' lengths
  len?: string; // that field's length (or at most it)
}

class Refused extends Error {}

interface Group {
  l: string[];
  b: string[];
  members: string[]; // in order: L's, then B's not already in L
  text: string;
}

/** One class's analysis: its groups, and every function that names their fields. */
class ClassRule {
  readonly c: ClassInst;
  readonly cset: Set<string>; // every instance of C's declaration: they share their fields' names and group functions
  readonly groups: Group[];
  readonly groupOf = new Map<string, number>();
  readonly methods: FuncInst[];
  readonly own: Set<string>;
  readonly groupFns = new Map<string, { inst: FuncInst; params: Map<number, string> }>();
  readonly sites = new Map<TE, boolean>();
  why: string | null = null;
  readonly reaches: (f: FuncInst) => boolean;
  private readMemo = new Map<string, boolean>();
  /**
   * Whether a method of C only reads: it, and every method of C it calls, changes no array (no JsArray method but `get`,
   * `get:length` and `get:capacity`, no `new` but a plain one), calls no group function, and calls nothing that may run C's
   * methods. Calling it then changes nothing the rule knows.
   */
  readsOnly(inst: FuncInst, seen = new Set<string>()): boolean {
    const hit = this.readMemo.get(inst.key);
    if (hit !== undefined) return hit;
    if (seen.has(inst.key)) return true;
    seen.add(inst.key);
    let ok = true;
    walkTE(
      inst.body,
      (te) => {
        if (!ok) return;
        if (te.k === "call") {
          const am = arrayMethod(te.inst);
          if (am !== null) {
            if (am !== "get" && am !== "get:length" && am !== "get:capacity") ok = false;
          } else if (this.own.has(te.inst.key)) {
            if (!this.readsOnly(te.inst, seen)) ok = false;
          } else if (this.groupFns.has(te.inst.key) || this.reaches(te.inst)) ok = false;
        } else if (te.k === "callind" || te.k === "callclo" || te.k === "closure") ok = false;
        else if (
          te.k === "new" &&
          (te.into !== null || (te.ctor !== null && this.reaches(te.ctor)))
        )
          ok = false;
        else if (te.k === "builtin" && te.info?.fns !== undefined) ok = false;
      },
      true,
    );
    if (seen.size === 1 || !ok) this.readMemo.set(inst.key, ok);
    return ok;
  }

  /** whether a function value of this type may run C's methods */
  reachesValue: (t: TE["ty"]) => boolean = () => true;

  constructor(
    c: ClassInst,
    cset: Set<string>,
    groups: Group[],
    methods: FuncInst[],
    reaches: (f: FuncInst) => boolean,
  ) {
    this.reaches = reaches;
    this.c = c;
    this.cset = cset;
    this.groups = groups;
    groups.forEach((g, i) => {
      for (const m of g.members) this.groupOf.set(m, i);
    });
    this.methods = methods;
    this.own = new Set(methods.map((m) => m.key));
  }

  refuse(why: string): never {
    throw new Refused(why);
  }

  isL(f: string): boolean {
    const g = this.groupOf.get(f);
    return g !== undefined && this.groups[g]!.l.includes(f);
  }

  isB(f: string): boolean {
    const g = this.groupOf.get(f);
    return g !== undefined && this.groups[g]!.b.includes(f);
  }

  /** Every L field E (a constructor) or V. */
  entry(ctor: boolean, only?: Set<string>): St {
    const l = new Map<string, LState>();
    for (const g of this.groups)
      for (const f of g.l) if (only === undefined || only.has(f)) l.set(f, ctor ? "E" : "V");
    return { l, facts: new Set(), dead: false };
  }

  /** I must hold here: no L field broken (of `group` only, if given). */
  needI(st: St, where: string, group?: number): void {
    if (st.dead) return;
    for (const [f, v] of st.l)
      if (v === "X" && (group === undefined || this.groupOf.get(f) === group))
        this.refuse(`${this.c.name}.${f}'s links may be past a bound ${where}`);
  }

  /** A field's array may have got shorter: what was known below its length isn't any more. */
  dropLength(st: St, f: string): void {
    for (const fact of st.facts) {
      const p = fact.split(":");
      if ((p[0] === "pos" || p[0] === "len") && p[2] === f) st.facts.delete(fact);
    }
  }

  /** A B field may have got shorter: its group's links are only known where its L fields are empty. */
  shorter(st: St, f: string): void {
    if (fault("r29-links-shrink")) return;
    const g = this.groupOf.get(f)!;
    for (const x of this.groups[g]!.l) if (st.l.get(x) === "V") st.l.set(x, "X");
    for (const fact of st.facts) {
      const p = fact.split(":");
      if ((p[0] === "pos" || p[0] === "len") && p[2] === f) st.facts.delete(fact);
      if ((p[0] === "lp" || p[0] === "lv" || p[0] === "link") && p[2] === String(g))
        st.facts.delete(fact);
    }
  }

  /** Code that may reach C's methods ran: I holds again, as they keep it, but nothing more is known. */
  reached(st: St): void {
    for (const [f, v] of st.l) if (v === "E") st.l.set(f, "V");
    for (const fact of st.facts) if (!fact.startsWith("nl:")) st.facts.delete(fact);
  }

  setVar(st: St, v: Var, info: Info): void {
    for (const fact of st.facts) if (fact.split(":")[1] === String(v.id)) st.facts.delete(fact);
    const id = v.id;
    for (const f of info.pos ?? []) st.facts.add(`pos:${id}:${f}`);
    if (info.len !== undefined) st.facts.add(`len:${id}:${info.len}`);
    if (info.lp !== undefined) st.facts.add(`lp:${id}:${info.lp}`);
    if (info.safe === "all") st.facts.add(`nl:${id}`);
    else for (const g of info.safe ?? []) st.facts.add(`lv:${id}:${g}`);
  }

  varInfo(st: St, v: Var): Info {
    const out: Info = {};
    const pos = new Set<string>();
    const safe = new Set<number>();
    for (const fact of st.facts) {
      const p = fact.split(":");
      if (p[1] !== String(v.id)) continue;
      if (p[0] === "pos") pos.add(p[2]!);
      else if (p[0] === "len") out.len = p[2]!;
      else if (p[0] === "lp") out.lp = Number(p[2]);
      else if (p[0] === "lv" || p[0] === "link") safe.add(Number(p[2]));
      else if (p[0] === "nl") out.safe = "all";
    }
    if (pos.size > 0) out.pos = pos;
    if (out.safe === undefined && safe.size > 0) out.safe = safe;
    return out;
  }
}

/** One function's walk under a class's rule: who `this` is, and which variables name which fields. */
interface Ctx {
  rule: ClassRule;
  thisVars: Set<Var>;
  alias: Map<Var, string>; // a local const naming a field, or a parameter bound to one
  ctor: boolean;
  inGroupFn: boolean;
  stack: string[]; // the C methods followed into, against recursion
  breaks: St[][];
  conts: St[][];
}

function noMember(ctx: Ctx, i: Info, where: string): void {
  if (i.member !== undefined)
    ctx.rule.refuse(`${ctx.rule.c.name}.${i.member} is given to ${where}`);
}

function memberOf(ctx: Ctx, te: TE): string | null {
  const t = unwrap(te);
  if (t.k === "var") return ctx.alias.get(t.v) ?? null;
  if (
    t.k === "ofield" &&
    ctx.rule.cset.has(t.c.key) &&
    ctx.rule.groupOf.has(t.f.name) &&
    unwrap(t.obj).k === "var" &&
    ctx.thisVars.has((unwrap(t.obj) as { v: Var }).v)
  )
    return t.f.name;
  return null;
}

function safeFor(i: Info, g: number): boolean {
  return i.safe === "all" || (i.safe !== undefined && i.safe.has(g));
}

function meet(a: Info, b: Info): Info {
  const out: Info = {};
  if (a.safe === "all") out.safe = b.safe;
  else if (b.safe === "all") out.safe = a.safe;
  else if (a.safe !== undefined && b.safe !== undefined)
    out.safe = new Set([...a.safe].filter((g) => (b.safe as Set<number>).has(g)));
  if (a.pos !== undefined && b.pos !== undefined)
    out.pos = new Set([...a.pos].filter((f) => b.pos!.has(f)));
  if (a.lp !== undefined && a.lp === b.lp) out.lp = a.lp;
  if (a.len !== undefined && a.len === b.len) out.len = a.len;
  return out;
}

/** The state where `c` is `truth`: what a test of a position tells. */
function assume(ctx: Ctx, st: St, c: TE, truth: boolean): void {
  if (st.dead) return;
  if (c.k === "not") return assume(ctx, st, c.a, !truth);
  if (c.k === "logic") {
    if ((c.op === "and") === truth) {
      assume(ctx, st, c.a, truth);
      assume(ctx, st, c.b, truth);
    }
    return;
  }
  if (c.k !== "cmp") return;
  // normalise to `x < y` (true) on unsigned values
  let op = c.op;
  let a = c.a;
  let b = c.b;
  if (!truth) {
    const neg: Record<string, typeof op> = {
      lt: "ge",
      ge: "lt",
      le: "gt",
      gt: "le",
      eq: "ne",
      ne: "eq",
    };
    op = neg[op]!;
  }
  if (op === "gt" || op === "ge") {
    [a, b] = [b, a];
    op = op === "gt" ? "lt" : "le";
  }
  if (op !== "lt" && op !== "le") return;
  const x = unwrapConv(a);
  if (x.k !== "var") return;
  const rule = ctx.rule;
  const n = litOf(b);
  if (n !== null) {
    // (s - 2) >>> 0 below 2^31 - 2: s was a link, so I says its position is below every B field's length
    const lim = op === "lt" ? n : n + 1n;
    if (lim <= BigInt(LINKS_TOP)) {
      const xi = rule.varInfo(st, x.v);
      if (xi.lp !== undefined)
        for (const f of rule.groups[xi.lp]!.b) st.facts.add(`pos:${x.v.id}:${f}`);
    }
    return;
  }
  // x < f.length: below that field's length
  if (op === "lt") {
    let y = unwrap(b);
    // at most the length: wrapU32 of it
    if (y.k === "builtin" && y.name === "wrapU32" && y.args[0] !== undefined) y = unwrap(y.args[0]);
    if (y.k === "call" && arrayMethod(y.inst) === "get:length") {
      const m = memberOf(ctx, y.args[0]!);
      if (m !== null) st.facts.add(`pos:${x.v.id}:${m}`);
    }
  }
}

function unwrapConv(te: TE): TE {
  return te.k === "conv" ? unwrapConv(te.val) : te;
}

/** Evaluates a value in order, its effects on the state included. */
function ev(ctx: Ctx, st: St, te: TE): Info {
  const rule = ctx.rule;
  if (st.dead) return {};
  switch (te.k) {
    case "lit":
    case "global": {
      const n = litOf(te);
      return n !== null && nonLinkConst(n) ? { safe: "all" } : {};
    }
    case "err":
    case "fnref":
    case "tuple":
      return {};
    case "var": {
      const m = ctx.alias.get(te.v);
      if (m !== undefined) return { member: m };
      return rule.varInfo(st, te.v);
    }
    case "chkref": {
      const i = ev(ctx, st, te.val);
      return i;
    }
    case "conv": {
      const i = ev(ctx, st, te.val);
      noMember(ctx, i, "a conversion");
      // only an unsigned value keeps what's known of it widened
      const from = te.val.ty;
      if (
        from.k === "int" &&
        (from.name === "u32" || from.name === "usize" || from.name === "u16" || from.name === "u8")
      )
        return i;
      return {};
    }
    case "ofield": {
      const m = memberOf(ctx, te);
      if (m !== null) return { member: m };
      if (rule.cset.has(te.c.key) && rule.groupOf.has(te.f.name))
        rule.refuse(
          `${rule.c.name}.${te.f.name} is named on another object than the one a method runs on`,
        );
      const o = ev(ctx, st, te.obj);
      noMember(ctx, o, "a field read");
      return {};
    }
    case "osetfield": {
      const o = ev(ctx, st, te.obj);
      noMember(ctx, o, "a field write");
      if (rule.cset.has(te.c.key) && rule.groupOf.has(te.f.name))
        rule.refuse(`${rule.c.name}.${te.f.name} is written whole`);
      const v = ev(ctx, st, te.val);
      noMember(ctx, v, "a field");
      return {};
    }
    case "setvar": {
      const v = ev(ctx, st, te.val);
      if (ctx.alias.has(te.v)) rule.refuse(`a variable naming ${rule.c.name}'s field is assigned`);
      noMember(ctx, v, "a variable that's assigned");
      rule.setVar(st, te.v, v);
      return v;
    }
    case "seq": {
      for (const x of te.items) ev(ctx, st, x);
      return ev(ctx, st, te.result);
    }
    case "cond": {
      const c = ev(ctx, st, te.c);
      noMember(ctx, c, "a test");
      const sa = copySt(st);
      assume(ctx, sa, te.c, true);
      const a = ev(ctx, sa, te.a);
      const sb = copySt(st);
      assume(ctx, sb, te.c, false);
      const b = ev(ctx, sb, te.b);
      noMember(ctx, a, "a conditional");
      noMember(ctx, b, "a conditional");
      const j = joinSt([sa, sb]);
      st.l = j.l;
      st.facts = j.facts;
      st.dead = j.dead;
      if (sa.dead) return b;
      if (sb.dead) return a;
      return meet(a, b);
    }
    case "logic": {
      const a = ev(ctx, st, te.a);
      noMember(ctx, a, "a test");
      const sb = copySt(st);
      assume(ctx, sb, te.a, te.op === "and");
      const b = ev(ctx, sb, te.b);
      noMember(ctx, b, "a test");
      const j = joinSt([st, sb]);
      st.l = j.l;
      st.facts = j.facts;
      return {};
    }
    case "cmp":
    case "not":
    case "neg":
    case "bitnot":
    case "farith":
    case "bigshift":
    case "isundef":
    case "optpayload":
    case "nonnull":
    case "len":
    case "index":
    case "optindex":
    case "setindex":
    case "tableget":
    case "setglobal":
    case "record":
    case "field": {
      for (const x of childrenOf(te)) noMember(ctx, ev(ctx, st, x), te.k);
      return {};
    }
    case "arith": {
      const a = ev(ctx, st, te.a);
      const b = ev(ctx, st, te.b);
      noMember(ctx, a, "arithmetic");
      noMember(ctx, b, "arithmetic");
      const k = litOf(te.b);
      // s - 2, s read from a link field: a candidate position
      if (
        te.op === "sub" &&
        k === 2n &&
        a.safe !== undefined &&
        a.safe !== "all" &&
        a.safe.size === 1
      )
        return { lp: [...a.safe][0]! };
      // p + 2, p below every B field's length: a link valid for that group
      if (te.op === "add" && k === 2n && a.pos !== undefined) {
        const safe = new Set<number>();
        rule.groups.forEach((g, gi) => {
          if (g.b.every((f) => a.pos!.has(f))) safe.add(gi);
        });
        if (safe.size > 0) return { safe };
      }
      return {};
    }
    case "bit": {
      const a = ev(ctx, st, te.a);
      const b = ev(ctx, st, te.b);
      noMember(ctx, a, "a bit operation");
      noMember(ctx, b, "a bit operation");
      // x >>> 0: the same value, as a u32
      if (te.op === "ushr" && litOf(te.b) === 0n) return a;
      // c | x with c's top bit set: at least 2^31, not a link
      if (te.op === "or") {
        const ca = litOf(te.a);
        const cb = litOf(te.b);
        if (
          (ca !== null && (ca & 0x80000000n) !== 0n) ||
          (cb !== null && (cb & 0x80000000n) !== 0n)
        )
          return { safe: "all" };
      }
      return {};
    }
    case "builtin": {
      const args = te.args.map((x) => ev(ctx, st, x));
      for (const a of args) noMember(ctx, a, te.name);
      if (te.name === "trap") {
        st.dead = true;
        return {};
      }
      // a value made at most what it was: what was below a length still is
      if (te.name === "wrapU32" || te.name === "toUsize") {
        const a = args[0] ?? {};
        return {
          ...(a.pos !== undefined ? { pos: a.pos } : {}),
          ...(a.len !== undefined ? { len: a.len } : {}),
          ...(te.name === "toUsize" && a.safe !== undefined ? { safe: a.safe } : {}),
          ...(te.name === "toUsize" && a.lp !== undefined ? { lp: a.lp } : {}),
        };
      }
      if (te.info?.fns !== undefined && te.info.fns.some((f) => rule.reaches(f))) {
        rule.needI(st, `where ${te.name} may run ${rule.c.name}'s methods`);
        rule.reached(st);
      }
      return {};
    }
    case "new": {
      if (te.ctor !== null && rule.reaches(te.ctor)) {
        rule.needI(st, `where ${te.c.name}'s constructor may run ${rule.c.name}'s methods`);
        rule.reached(st);
      }
      if (te.into !== null) {
        const o = unwrap(te.into.obj);
        const m =
          o.k === "var" && ctx.thisVars.has(o.v) && rule.groupOf.has(te.into.f.name)
            ? te.into.f.name
            : null;
        if (m === null && o.k !== "var") noMember(ctx, ev(ctx, st, te.into.obj), "a new object");
        for (const x of te.args) noMember(ctx, ev(ctx, st, x), "a new object");
        if (m !== null) {
          if (!ctx.ctor || !isJsArray(te.c))
            rule.refuse(`${rule.c.name}.${m} is made again outside its constructor`);
          // a new array: every element zero, so no link; its length is any
          rule.dropLength(st, m);
          if (rule.isB(m)) rule.shorter(st, m);
          if (rule.isL(m)) st.l.set(m, "E");
        }
        return {};
      }
      for (const x of te.args) noMember(ctx, ev(ctx, st, x), "a new object");
      for (const x of te.init) noMember(ctx, ev(ctx, st, x.val), "a new object");
      if (te.tail !== undefined) ev(ctx, st, te.tail);
      return {};
    }
    case "trapnow": {
      st.dead = true;
      return {};
    }
    case "call":
      return evCall(ctx, st, te);
    case "callind": {
      const f = ev(ctx, st, te.fn);
      noMember(ctx, f, "a function value");
      for (const a of te.args) noMember(ctx, ev(ctx, st, a), "a function value");
      if (rule.reachesValue(te.fn.ty)) {
        rule.needI(st, "where a function value that may run its methods is called");
        rule.reached(st);
      }
      return {};
    }
    case "closure":
      return rule.refuse(`${rule.c.name}'s code makes a closure`);
    default:
      return rule.refuse(`${rule.c.name}'s code holds ${te.k}, which the rule doesn't follow`);
  }
}

function childrenOf(te: TE): TE[] {
  const out: TE[] = [];
  for (const [k, v] of Object.entries(te)) {
    if (k === "ty" || k === "deps" || k === "sh" || k === "fld" || k === "glob" || k === "strop")
      continue;
    if (v !== null && typeof v === "object" && "k" in (v as object) && "ty" in (v as object))
      out.push(v as TE);
    else if (Array.isArray(v))
      for (const x of v) {
        if (x !== null && typeof x === "object" && "k" in x && "ty" in x) out.push(x as TE);
        else if (
          x !== null &&
          typeof x === "object" &&
          "val" in x &&
          (x as { val: TE }).val?.k !== undefined
        )
          out.push((x as { val: TE }).val);
      }
  }
  return out;
}

function noteSite(ctx: Ctx, te: TE, proved: boolean): void {
  const was = ctx.rule.sites.get(te);
  ctx.rule.sites.set(te, (was ?? true) && proved);
}

function evCall(ctx: Ctx, st: St, te: Extract<TE, { k: "call" }>): Info {
  const rule = ctx.rule;
  const inst = te.inst;
  const am = arrayMethod(inst);
  const recv = te.args[0] !== undefined ? memberOf(ctx, te.args[0]) : null;
  if (am !== null && recv !== null) {
    const rest = te.args.slice(1).map((a) => ev(ctx, st, a));
    const g = rule.groupOf.get(recv)!;
    const idxVar = (): Var | null => {
      const x = te.args[1] !== undefined ? unwrapConv(te.args[1]) : null;
      return x !== null && x.k === "var" ? x.v : null;
    };
    const posHere = (rest[0]?.pos ?? new Set<string>()).has(recv);
    switch (am) {
      case "get:length":
        return { len: recv };
      case "get:capacity":
        return {};
      case "get":
      case "zero":
      case "set": {
        noteSite(ctx, te, posHere);
        if (am === "set" && rule.isL(recv)) {
          const v = rest[1] ?? {};
          noMember(ctx, v, "an element");
          if (!safeFor(v, g) && !fault("r29-links-store"))
            rule.refuse(`${rule.c.name}.${recv} is given a value that may be a link past a bound`);
          if (st.l.get(recv) === "E" && v.safe !== "all") st.l.set(recv, "V");
        }
        // the check traps past the length, so after it the index is below it
        const iv = idxVar();
        if (iv !== null && !st.dead) st.facts.add(`pos:${iv.id}:${recv}`);
        if (am === "get" && rule.isL(recv) && st.l.get(recv) !== "X") return { safe: new Set([g]) };
        return {};
      }
      case "push": {
        const v = rest[0] ?? {};
        noMember(ctx, v, "an element");
        if (rule.isL(recv)) {
          if (!safeFor(v, g) && !fault("r29-links-store"))
            rule.refuse(`${rule.c.name}.${recv} is given a value that may be a link past a bound`);
          if (st.l.get(recv) === "E" && v.safe !== "all") st.l.set(recv, "V");
        }
        // a length read before it is now a position below it
        for (const fact of st.facts) {
          const p = fact.split(":");
          if (p[0] === "len" && p[2] === recv) st.facts.add(`pos:${p[1]}:${recv}`);
        }
        return {};
      }
      case "reserve":
      case "tryReserve":
        return {};
      case "setLength": {
        const n = te.args[1] !== undefined ? litOf(te.args[1]) : null;
        rule.dropLength(st, recv);
        if (rule.isL(recv) && n === 0n) st.l.set(recv, "E");
        // what's below stays, what's added is zero: an L field keeps its state
        if (rule.isB(recv)) rule.shorter(st, recv);
        return {};
      }
      case "trim": {
        rule.dropLength(st, recv);
        if (rule.isL(recv)) st.l.set(recv, "E");
        if (rule.isB(recv)) rule.shorter(st, recv);
        return {};
      }
      default:
        return rule.refuse(
          `${rule.c.name}.${recv} takes JsArray's ${am}, which the rule doesn't follow`,
        );
    }
  }
  const args = te.args.map((a) => ev(ctx, st, a));
  const members = args.map((a, i) => (a.member !== undefined ? i : -1)).filter((i) => i >= 0);
  // `x.adopt(field)`: the field's array is left empty
  if (am === "adopt" && members.length === 1 && members[0] === 1) {
    const m = args[1]!.member!;
    rule.dropLength(st, m);
    if (rule.isL(m)) st.l.set(m, "E");
    if (rule.isB(m)) rule.shorter(st, m);
    return {};
  }
  const recvThis =
    te.args[0] !== undefined &&
    unwrap(te.args[0]).k === "var" &&
    ctx.thisVars.has((unwrap(te.args[0]) as { v: Var }).v);
  if (rule.own.has(inst.key)) {
    if (!recvThis)
      rule.refuse(`${rule.c.name}'s method is called on another object from its own code`);
    const takesArray = inst.params.slice(1).some((p) => p.ty.k === "cls" && isJsArray(p.ty.c));
    if (members.length > 0 || takesArray) {
      // a method of C taking an array: followed into, with its parameters naming the fields given
      if (ctx.stack.includes(inst.key))
        rule.refuse(`${rule.c.name}'s ${inst.key} is followed into itself`);
      const inner: Ctx = {
        rule,
        thisVars: new Set([...ctx.thisVars, inst.params[0]!]),
        alias: new Map(ctx.alias),
        ctor: ctx.ctor,
        inGroupFn: false,
        stack: [...ctx.stack, inst.key],
        breaks: [],
        conts: [],
      };
      for (const i of members) inner.alias.set(inst.params[i]!, args[i]!.member!);
      const exits: St[] = [];
      const fall = stmts(inner, copySt(st), inst.body, exits);
      const j = joinSt([fall, ...exits]);
      st.l = j.l;
      st.facts = new Set(
        [...j.facts].filter((f) => !inst.params.some((p) => f.split(":")[1] === String(p.id))),
      );
      st.dead = j.dead;
      if (inst.ret.k === "never") st.dead = true;
      return {};
    }
    rule.needI(st, `where ${rule.c.name}'s ${inst.display ?? inst.key} is called`);
    // a method that only reads leaves everything as it was; any other keeps I, but nothing more is known after it
    if (!rule.readsOnly(inst)) rule.reached(st);
    if (inst.ret.k === "never") st.dead = true;
    return {};
  }
  const gf = rule.groupFns.get(inst.key);
  if (gf !== undefined && members.length > 0) {
    // a group function: its parameters name one group's fields, in the places every call gives them
    let g: number | null = null;
    for (const i of members) {
      const m = args[i]!.member!;
      const gi = rule.groupOf.get(m)!;
      if (g !== null && g !== gi) rule.refuse(`${inst.key} is given two groups' fields`);
      g = gi;
      const role = rule.groups[gi]!.members.indexOf(m);
      const want = gf.params.get(i);
      if (want === undefined || rule.groups[0]!.members.indexOf(want) !== role)
        rule.refuse(`${inst.key} is given ${m} where another call gives another field`);
    }
    rule.needI(st, `where ${inst.key} is called`, g!);
    for (const f of rule.groups[g!]!.l) if (st.l.get(f) === "E") st.l.set(f, "V");
    if (rule.reaches(inst)) {
      rule.needI(st, `where ${inst.key} may run ${rule.c.name}'s methods`);
      rule.reached(st);
    }
    if (inst.ret.k === "never") st.dead = true;
    return {};
  }
  for (const i of members)
    rule.refuse(`${rule.c.name}.${args[i]!.member} is given to ${inst.display ?? inst.key}`);
  if (rule.reaches(inst)) {
    rule.needI(st, `where ${inst.display ?? inst.key} may run ${rule.c.name}'s methods`);
    rule.reached(st);
  }
  if (inst.ret.k === "never") st.dead = true;
  return {};
}

/** A run of statements from `at`, each a swap of two of C's fields: their pairs, or null if `at` doesn't start one. */
function swapRun(
  ctx: Ctx,
  list: Stmt[],
  at: number,
): { pairs: [string, string][]; end: number } | null {
  const pairs: [string, string][] = [];
  let i = at;
  let any = false;
  for (; i < list.length; i++) {
    const s = list[i]!;
    if (s.k !== "expr" || s.e.k !== "call" || arrayMethod(s.e.inst) !== "swap") break;
    const a = memberOf(ctx, s.e.args[0]!);
    const b = memberOf(ctx, s.e.args[1]!);
    if ((a === null) !== (b === null))
      ctx.rule.refuse(`${ctx.rule.c.name}'s field is swapped with another array`);
    if (a !== null && b !== null) {
      pairs.push([a, b]);
      any = true;
    }
  }
  return any ? { pairs, end: i } : null;
}

function applySwaps(ctx: Ctx, st: St, pairs: [string, string][]): void {
  const rule = ctx.rule;
  const touched = new Map<string, Set<number>>(); // "ga,gb": roles swapped
  for (const [a, b] of pairs) {
    const ga = rule.groupOf.get(a)!;
    const gb = rule.groupOf.get(b)!;
    const ra = rule.groups[ga]!.members.indexOf(a);
    const rb = rule.groups[gb]!.members.indexOf(b);
    const key = ga < gb ? `${ga},${gb}` : `${gb},${ga}`;
    if (ga === gb || ra !== rb || !sameShape(rule.groups[ga]!, rule.groups[gb]!)) {
      touched.set(key, new Set([-1]));
      continue;
    }
    let s = touched.get(key);
    if (s === undefined) touched.set(key, (s = new Set()));
    if (s.has(ra)) s.add(-1);
    s.add(ra);
  }
  for (const [key, roles] of touched) {
    const [ga, gb] = key.split(",").map(Number) as [number, number];
    const A = rule.groups[ga]!;
    const B = rule.groups[gb]!;
    const whole = !roles.has(-1) && roles.size === A.members.length;
    if (whole) {
      for (let r = 0; r < A.l.length; r++) {
        const x = st.l.get(A.l[r]!)!;
        st.l.set(A.l[r]!, st.l.get(B.l[r]!)!);
        st.l.set(B.l[r]!, x);
      }
    } else {
      for (const f of [...A.l, ...B.l]) if (st.l.get(f) !== "E") st.l.set(f, "X");
      if (fault("r29-links-shrink"))
        for (const f of [...A.l, ...B.l]) st.l.set(f, st.l.get(f) === "X" ? "V" : st.l.get(f)!);
    }
    for (const fact of st.facts) {
      const p = fact.split(":");
      if (
        (p[0] === "pos" || p[0] === "len") &&
        (A.members.includes(p[2]!) || B.members.includes(p[2]!))
      )
        st.facts.delete(fact);
      if (
        (p[0] === "lp" || p[0] === "lv" || p[0] === "link") &&
        (p[2] === String(ga) || p[2] === String(gb))
      )
        st.facts.delete(fact);
    }
  }
}

function sameShape(a: Group, b: Group): boolean {
  if (a.l.length !== b.l.length || a.b.length !== b.b.length) return false;
  const shape = (g: Group) => [...g.l, ...g.b].map((f) => g.members.indexOf(f)).join(",");
  return shape(a) === shape(b);
}

/** A statement list from `st`: the state after it; each return's state goes to `exits`. */
function stmts(ctx: Ctx, st: St, list: Stmt[], exits: St[]): St {
  for (let i = 0; i < list.length; i++) {
    if (st.dead) return st;
    const run = swapRun(ctx, list, i);
    if (run !== null) {
      for (let j = i; j < run.end; j++) {
        const s = list[j] as Extract<Stmt, { k: "expr" }>;
        const e = s.e as Extract<TE, { k: "call" }>;
        // only fields and other arrays: nothing to evaluate but the receivers
        if (memberOf(ctx, e.args[0]!) === null) ev(ctx, st, e);
      }
      applySwaps(ctx, st, run.pairs);
      i = run.end - 1;
      continue;
    }
    st = stmt(ctx, st, list[i]!, exits);
  }
  return st;
}

function loop(
  ctx: Ctx,
  st: St,
  c: TE | null,
  body: Stmt[],
  step: TE[],
  exits: St[],
  doFirst: boolean,
): St {
  let head = copySt(st);
  let out: St = { ...copySt(st), dead: true };
  for (let round = 0; round < 32; round++) {
    ctx.breaks.push([]);
    ctx.conts.push([]);
    let s = copySt(head);
    let exit: St = { ...copySt(s), dead: true };
    if (!doFirst && c !== null) {
      noMember(ctx, ev(ctx, s, c), "a test");
      exit = copySt(s);
      assume(ctx, exit, c, false);
      assume(ctx, s, c, true);
    }
    s = stmts(ctx, s, body, exits);
    s = joinSt([s, ...ctx.conts.pop()!]);
    for (const x of step) ev(ctx, s, x);
    if (doFirst && c !== null) {
      noMember(ctx, ev(ctx, s, c), "a test");
      exit = copySt(s);
      assume(ctx, exit, c, false);
      assume(ctx, s, c, true);
    }
    const breaks = ctx.breaks.pop()!;
    out = joinSt([exit, ...breaks]);
    const next = joinSt([st, s]);
    if (sameSt(next, head)) return out;
    head = next;
    doFirst = false;
  }
  return ctx.rule.refuse(`a loop in ${ctx.rule.c.name}'s code didn't settle`);
}

function stmt(ctx: Ctx, st: St, s: Stmt, exits: St[]): St {
  const rule = ctx.rule;
  switch (s.k) {
    case "let": {
      if (s.init === null) {
        rule.setVar(st, s.v, {});
        return st;
      }
      const m = memberOf(ctx, s.init);
      if (m !== null) {
        if (!s.constant) rule.refuse(`a variable naming ${rule.c.name}.${m} isn't const`);
        ctx.alias.set(s.v, m);
        return st;
      }
      const i = ev(ctx, st, s.init);
      noMember(ctx, i, "a variable");
      rule.setVar(st, s.v, i);
      return st;
    }
    case "expr":
      ev(ctx, st, s.e);
      return st;
    case "if": {
      noMember(ctx, ev(ctx, st, s.c), "a test");
      const a = copySt(st);
      assume(ctx, a, s.c, true);
      const b = copySt(st);
      assume(ctx, b, s.c, false);
      const ea = stmts(ctx, a, s.a, exits);
      const eb = s.b !== null ? stmts(ctx, b, s.b, exits) : b;
      return joinSt([ea, eb]);
    }
    case "while":
      return loop(ctx, st, s.c, s.body, [], exits, false);
    case "do":
      return loop(ctx, st, s.c, s.body, [], exits, true);
    case "for": {
      const after = stmts(ctx, st, s.init, exits);
      return loop(ctx, after, s.c, s.body, s.step, exits, false);
    }
    case "block":
      return stmts(ctx, st, s.body, exits);
    case "return": {
      if (s.val !== null) noMember(ctx, ev(ctx, st, s.val), "a result");
      if (!st.dead) exits.push(copySt(st));
      return { ...st, dead: true };
    }
    case "break":
    case "continue": {
      if (s.label !== null) rule.refuse(`a labelled ${s.k} in ${rule.c.name}'s code`);
      const to = s.k === "break" ? ctx.breaks : ctx.conts;
      if (to.length === 0) rule.refuse(`a ${s.k} the rule can't place`);
      to[to.length - 1]!.push(copySt(st));
      return { ...st, dead: true };
    }
    case "switch": {
      noMember(ctx, ev(ctx, st, s.val), "a switch");
      ctx.breaks.push([]);
      let fall: St = { ...copySt(st), dead: true };
      const ends: St[] = [];
      for (const cl of s.clauses) {
        for (const k of cl.keys) ev(ctx, st, k);
        const start = joinSt([copySt(st), fall]);
        fall = stmts(ctx, start, cl.body, exits);
      }
      ends.push(fall);
      if (!s.clauses.some((c) => c.isDefault)) ends.push(copySt(st));
      return joinSt([...ends, ...ctx.breaks.pop()!]);
    }
    default:
      return rule.refuse(`${rule.c.name}'s code holds a ${s.k}, which the rule doesn't follow`);
  }
}

/** Marks what the table-links proof proves (`call.inb`), and the leading bounds checks it can take out (`cmp.chk`). */
export function markLinkedChecks(typed: TypedModule): LinksReport {
  const report: LinksReport = { groups: [], refused: {}, sites: 0, checks: 0 };
  if (r29Off("links")) return report;
  const funcs = typed.funcs;
  report.checks = markLeadingChecks(funcs);
  const classes = new Map<string, ClassInst>();
  const note = (c: ClassInst | undefined): void => {
    if (c !== undefined && c.links !== undefined && !classes.has(c.key)) classes.set(c.key, c);
  };
  for (const f of funcs) {
    note(f.owner);
    walkTE(
      f.body,
      (te) => {
        if (te.k === "ofield" || te.k === "osetfield" || te.k === "new") note(te.c);
      },
      true,
    );
  }
  if (classes.size === 0) return report;

  // Who calls whom, and who may reach each class's methods. A function value is called only as its type says, so an
  // indirect call reaches the functions of its type taken as values (`fnref`) or made as closures; a down-lowered closure's
  // call (`callclo`) may reach anything.
  const valuesOf = new Map<string, FuncInst[]>();
  for (const f of funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.k === "fnref" || te.k === "closure") {
          const k = tyKey(te.ty);
          let l = valuesOf.get(k);
          if (l === undefined) valuesOf.set(k, (l = []));
          l.push(te.inst);
        }
      },
      true,
    );
  const callees = new Map<string, FuncInst[]>();
  const indirect = new Set<string>();
  for (const f of funcs) {
    const out: FuncInst[] = [];
    walkTE(
      f.body,
      (te) => {
        if (te.k === "call") out.push(te.inst);
        if (te.k === "callind") out.push(...(valuesOf.get(tyKey(te.fn.ty)) ?? []));
        if (te.k === "callclo") indirect.add(f.key);
        if (te.k === "builtin" && te.info?.fns !== undefined) out.push(...te.info.fns);
      },
      false,
    );
    callees.set(f.key, out);
  }
  // whole program, per class: which functions may run C's methods, settled from none up
  const reachesClass = (cset: Set<string>): ((f: FuncInst) => boolean) => {
    const yes = new Set<string>();
    for (const f of funcs)
      if ((f.owner !== undefined && cset.has(f.owner.key)) || indirect.has(f.key)) yes.add(f.key);
    for (let changed = true; changed;) {
      changed = false;
      for (const f of funcs)
        if (!yes.has(f.key) && (callees.get(f.key) ?? []).some((g) => yes.has(g.key))) {
          yes.add(f.key);
          changed = true;
        }
    }
    return (f: FuncInst): boolean =>
      yes.has(f.key) || (callees.get(f.key) ?? []).some((g) => yes.has(g.key));
  };

  const byDecl = new Map<unknown, ClassInst[]>();
  for (const c of classes.values()) {
    let l = byDecl.get(c.decl);
    if (l === undefined) byDecl.set(c.decl, (l = []));
    l.push(c);
  }
  for (const insts of byDecl.values()) {
    const c = insts[0]!;
    const cset = new Set(insts.map((x) => x.key));
    const why = (w: string): void => {
      report.refused[c.name] ??= w;
    };
    // The claim's shape: each field one of C's, a JsArray held in place, an L field's of u32.
    const groups: Group[] = [];
    let bad: string | null = null;
    for (const g of c.links!) {
      const members = [...g.l, ...g.b.filter((f) => !g.l.includes(f))];
      for (const name of members)
        for (const x of insts) {
          const f = x.fields.find((y) => y.name === name);
          if (f === undefined) bad ??= `${c.name} has no field ${name}`;
          else if (f.store !== "inline" || f.ty.k !== "cls" || !isJsArray(f.ty.c))
            bad ??= `${c.name}.${name} isn't a JsArray held in place`;
          else if (g.l.includes(name) && f.ty.c.key !== "ex-jsrt-array.JsArray<u32>")
            bad ??= `${c.name}.${name} holds links, and isn't a JsArray of u32`;
        }
      if (g.l.length === 0 || g.b.length === 0)
        bad ??= `${c.name}'s claim ${g.text} has an empty side`;
      groups.push({ l: g.l, b: g.b, members, text: g.text });
    }
    const all = groups.flatMap((g) => g.members);
    if (new Set(all).size !== all.length) bad ??= `${c.name} claims a field in two groups`;
    if (bad !== null) {
      why(bad);
      continue;
    }
    const memberSet = new Set(all);
    const methods = funcs.filter((f) => f.owner !== undefined && cset.has(f.owner.key));
    const own = new Set(methods.map((m) => m.key));
    // Whole program: the fields named only in C's methods and its group functions; group functions found; objects of C
    // whole (D77's rule 5).
    const groupCalls = new Map<
      string,
      { inst: FuncInst; params: Map<number, string>; ok: boolean }
    >();
    const values = new Set<string>(); // module functions taken as values
    const isMemberTE = (te: TE): string | null => {
      const t = unwrap(te);
      return t.k === "ofield" && cset.has(t.c.key) && memberSet.has(t.f.name) ? t.f.name : null;
    };
    for (const fn of funcs) {
      const inC = own.has(fn.key);
      walkTE(
        fn.body,
        (te) => {
          if (
            (te.k === "ofield" || te.k === "osetfield") &&
            cset.has(te.c.key) &&
            memberSet.has(te.f.name) &&
            !inC
          )
            if (!fault("r29-links-outside"))
              bad ??= `${c.name}.${te.f.name} is named outside ${c.name}'s methods`;
          if (
            te.k === "call" &&
            inC &&
            te.inst.owner === undefined &&
            te.args.some((a) => isMemberTE(a) !== null)
          )
            groupCalls.set(te.inst.key, { inst: te.inst, params: new Map(), ok: true });
          if (te.k === "fnref") values.add(te.inst.key);
          const ty = te.ty;
          if (
            (ty.k === "ptr" || ty.k === "elem") &&
            ty.elem.mode === "inline" &&
            ty.of.k === "cls" &&
            insts.some((x) => holdsIn((ty.of as { c: ClassInst }).c, x))
          )
            bad ??= `an object holding a ${c.name} in place is an element`;
          if (
            te.k === "builtin" &&
            (te.name === "unsafe.viewAt" || te.name === "unsafe.staticView") &&
            te.info?.c !== undefined &&
            insts.some((x) => holdsIn(te.info!.c!, x))
          )
            bad ??= `an object holding a ${c.name} is viewed at an address`;
        },
        true,
      );
    }
    // a group function's every call is in C's methods, with fields in the same places (the same roles, of one group or the
    // other); it's never a value or exported
    const roleOf = (f: string): number =>
      groups.find((g) => g.members.includes(f))!.members.indexOf(f);
    for (const fn of funcs)
      walkTE(
        fn.body,
        (te) => {
          if (te.k !== "call") return;
          const g = groupCalls.get(te.inst.key);
          if (g === undefined) return;
          if (!own.has(fn.key)) {
            bad ??= `${te.inst.key} is called from outside ${c.name}`;
            return;
          }
          const params = new Map<number, string>();
          te.args.forEach((a, i) => {
            const m = isMemberTE(a);
            if (m !== null) params.set(i, m);
          });
          const roles = (p: Map<number, string>) =>
            [...p].map(([i, f]) => `${i}=${roleOf(f)}`).join(",");
          if (g.params.size === 0 && g.ok) g.params = params;
          else if (roles(g.params) !== roles(params)) g.ok = false;
        },
        true,
      );
    for (const [key, g] of groupCalls)
      if (!g.ok || g.inst.exported || g.params.size === 0 || values.has(key))
        bad ??= `${key} is given ${c.name}'s fields in more than one way, or is exported or a value`;
    if (bad !== null) {
      why(bad);
      continue;
    }
    const reach = reachesClass(cset);
    const rule = new ClassRule(c, cset, groups, methods, reach);
    rule.reachesValue = (t) =>
      (valuesOf.get(tyKey(t)) ?? []).some(
        (f) => (f.owner !== undefined && cset.has(f.owner.key)) || reach(f),
      );
    // group functions' parameters, named for group 0's fields in the same places
    for (const [key, g] of groupCalls) {
      const params = new Map<number, string>();
      for (const [i, f] of g.params) {
        const gi = groups.findIndex((x) => x.members.includes(f));
        params.set(i, groups[0]!.members[groups[gi]!.members.indexOf(f)]!);
      }
      rule.groupFns.set(key, { inst: g.inst, params });
    }
    try {
      for (const m of methods) {
        const isCtor = m.owner!.ctor !== null && m.key === m.owner!.ctor.key;
        const ctx: Ctx = {
          rule,
          thisVars: new Set([m.params[0]!]),
          alias: new Map(),
          ctor: isCtor,
          inGroupFn: false,
          stack: [m.key],
          breaks: [],
          conts: [],
        };
        const exits: St[] = [];
        const fall = stmts(ctx, rule.entry(isCtor), m.body, exits);
        for (const x of [fall, ...exits]) rule.needI(x, `where ${m.display ?? m.key} returns`);
      }
      for (const [, g] of rule.groupFns) {
        const ctx: Ctx = {
          rule,
          thisVars: new Set(),
          alias: new Map([...g.params].map(([i, f]) => [g.inst.params[i]!, f])),
          ctor: false,
          inGroupFn: true,
          stack: [g.inst.key],
          breaks: [],
          conts: [],
        };
        // only group 0's fields are named in it, so only its group is followed, valid on entry
        const exits: St[] = [];
        const fall = stmts(ctx, rule.entry(false, new Set(groups[0]!.l)), g.inst.body, exits);
        for (const x of [fall, ...exits]) rule.needI(x, `where ${g.inst.key} returns`);
      }
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      why(e.message);
      continue;
    }
    for (const g of groups) report.groups.push(`${c.name}: ${g.text}`);
    for (const [te, ok] of rule.sites)
      if (ok && te.k === "call") {
        te.inb = true;
        report.sites++;
      }
  }
  report.groups.sort();
  if (process.env.TMK_LINKS_DEBUG === "1") console.error(`links: ${JSON.stringify(report)}`);
  return report;
}

/** Whether objects of `x` hold an object of `c` in place, or are `c`'s. */
function holdsIn(x: ClassInst, c: ClassInst, seen = new Set<string>()): boolean {
  if (x.key === c.key) return true;
  if (seen.has(x.key)) return false;
  seen.add(x.key);
  return x.fields.some((f) => f.store === "inline" && f.ty.k === "cls" && holdsIn(f.ty.c, c, seen));
}

/** For tools/r29-tests.ts: the leading checks' compares and the proved calls, found again in a typed module. */
export function linksMarks(typed: TypedModule): { inb: number; chk: number } {
  let inb = 0;
  let chk = 0;
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.k === "call" && te.inb === true) inb++;
        if (te.k === "cmp" && te.chk !== undefined) chk++;
      },
      true,
    );
  return { inb, chk };
}
