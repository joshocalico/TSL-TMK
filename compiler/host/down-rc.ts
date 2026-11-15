// `rc` (SPEC 3.5, 4.5, D39): counts, added to the finished tree of a down-lowered module. Nothing else in the compiler
// knows they exist, so `strict`, `leak` and `manual` don't change by a byte. It runs once, after the walk has settled, so
// which classes are counted is a whole-program fact by here.
//
// The convention, everywhere including across the native ABI: a function's arguments are borrowed, and the caller holds a
// count for the whole call. A result is owned: the caller gets one count. So an expression's value is either owned
// (it came from an allocation or a call, and someone must take or drop that count) or borrowed (it was read, and it's
// good until something overwrites where it came from). Stage A says which, and adds increments and temporaries. Stage B
// gives each counted local a scope, and releases it at the end of that scope and on every jump out of it.
//
// Soundness of what's left out rests on one fact. A value read from a slot stays alive until a slot on the path to it is
// overwritten, or the local at the root of that path changes. Dropping a private local can't do it: its count was its
// own. So a borrow may be kept across code that can't overwrite a counted slot, which is a whole-program fact per
// function (`overwriters`), and across nothing else.
import { findNode, layoutOf, liveNodes, sizeOf, type HeapNode, type Shape } from "./down-model.ts";
import {
  RC_CC_BUF,
  RC_CC_DESC_CYC,
  RC_CC_INS,
  RC_DESC_LEAF,
  RC_DESC_VEC_LEAF,
  RC_DESC_WEAK,
  RC_MAX_DESC_WORDS,
  type CcFault,
} from "./down-rt.ts";
import { T, type FuncInst, type Stmt, type TE, type TEK, type Ty, type Var } from "./types.ts";

export type Counted = Extract<Shape, { s: "arr" | "vec" | "obj" }>;

export interface RcOptions {
  check: boolean; // test build: every access through a counted reference checks its count
  account: boolean; // test build: the runtime keeps counters
  elide: boolean; // borrow elision; off only to measure what it removes
  omitInc?: number; // test build: leave out the n'th increment, to show the detector isn't vacuous
  omitDec?: number; // test build: leave out the n'th decrement
  probeInc?: number; // test build: the n'th increment site traps, so a test can say whether it's ever reached
  probeDec?: number; // test build: the same, for the n'th decrement site
  cycles: boolean; // the cycle collector (SPEC 3.5, D41). It's linked only if a type can be in a cycle
  budget?: number; // test build: another RC_BUDGET
  pace?: boolean; // test build: false runs the collector at every allocation
  ccFault?: CcFault; // test build: a mistake in the collector, to show the tests catch it
  noMoveTouch?: boolean; // test build: leave out the barrier on a moved reference
  cowProbe?: boolean; // a measurement: the test a copy-on-write array would need, before each element write
  rtFault?: string; // test build: a mistake in compiler/rt, to show the tests catch it (SPEC 4.5, D42)
  excFault?: string; // test build: a mistake on an exception's path, to show the tests catch it (D49)
  uncounted?: boolean; // the lowered tree with no counts placed: what the TSL route prints, for tslc to count (R2, D74)
}

export interface RcStats {
  incSites: number;
  decSites: number;
  argsBorrowed: number; // arguments passed with no count of their own
  argsHeld: number; // arguments a caller had to hold across the call
  localsBorrowed: number; // locals that hold no count
  localsCounted: number;
  functions: number;
  overwriters: number; // functions that can overwrite a counted slot
}

export interface RcResult {
  descs: number[];
  mapOn: boolean;
  stats: RcStats;
  cycles: boolean; // the collector's in this module: it's asked for, and some type can be in a cycle
  descOf: (n: HeapNode) => number;
}

export function countedOf(sh: unknown): Counted | null {
  const s = sh as Shape | undefined;
  if (s === undefined || (s.s !== "arr" && s.s !== "vec" && s.s !== "obj")) return null;
  return findNode(s.node).long ? s : null;
}

const REF: Ty = { k: "ref" };

function mk(ty: Ty, node: TEK, extra?: Partial<TE>): TE {
  return { ty, ...node, ...extra } as TE;
}

const nullRef = (): TE => mk(REF, { k: "lit", value: 0 });
const litIx = (v: number): TE => mk(T.usize, { k: "lit", value: v }, { range: [v, v] });
const lit32 = (v: number): TE => mk(T.i32, { k: "lit", value: v }, { range: [v, v] });

function nullOfSh(sh: Counted): TE {
  if (sh.s === "arr")
    return mk({ k: "arr", elem: sh.elem }, { k: "tuple", items: [nullRef(), litIx(0)] }, { sh });
  return mk(REF, { k: "lit", value: 0 }, { sh });
}

/** A rebuild of an expression with new children. Stage A and B both go through here. */
function mapKids(te: TE, f: (c: TE) => TE, g: (b: Stmt[]) => Stmt[]): TE {
  switch (te.k) {
    case "lit":
    case "var":
    case "global":
    case "fnref":
    case "gaddr":
    case "trapnow":
      return te;
    case "index":
      return { ...te, arr: f(te.arr), idx: f(te.idx) };
    case "len":
      return { ...te, arr: f(te.arr) };
    case "arith":
    case "farith":
    case "bit":
    case "cmp":
    case "logic":
      return { ...te, a: f(te.a), b: f(te.b) };
    case "bitnot":
    case "neg":
    case "not":
      return { ...te, a: f(te.a) };
    case "cond":
      return { ...te, c: f(te.c), a: f(te.a), b: f(te.b) };
    case "setvar":
      return { ...te, val: f(te.val) };
    case "seq":
      return { ...te, items: te.items.map(f), result: f(te.result) };
    case "call":
    case "builtin":
    case "rtcall":
    case "intrinsic":
    case "throwjs":
      return { ...te, args: te.args.map(f) };
    case "conv":
    case "f2ix":
    case "nonnull":
    case "slice":
      return { ...te, val: f(te.val) };
    case "tuple":
      return { ...te, items: te.items.map(f) };
    case "fload":
      return { ...te, base: f(te.base) };
    case "fstore":
      return { ...te, base: f(te.base), val: f(te.val) };
    case "elemaddr":
      return { ...te, base: f(te.base), idx: f(te.idx) };
    case "loadelem":
      return { ...te, ptr: f(te.ptr), idx: f(te.idx) };
    case "storeelem":
      return { ...te, ptr: f(te.ptr), idx: f(te.idx), val: f(te.val) };
    case "alloc":
      return { ...te, size: f(te.size) };
    case "callclo":
      return { ...te, clo: f(te.clo), args: te.args.map(f) };
    case "blockexpr":
      return { ...te, body: g(te.body), result: f(te.result) };
    default:
      throw new Error(`rc: a ${te.k} in a down-lowered tree`);
  }
}

/** Calls `f` on an expression's direct children, and `g` on any statements it holds. */
function eachKid(te: TE, f: (c: TE) => void, g: (b: Stmt[]) => void): void {
  mapKids(
    te,
    (c) => {
      f(c);
      return c;
    },
    (b) => {
      g(b);
      return b;
    },
  );
}

function eachStmtExpr(s: Stmt, f: (e: TE) => void, g: (b: Stmt[]) => void): void {
  switch (s.k) {
    case "let":
      if (s.init !== null) f(s.init);
      break;
    case "expr":
      f(s.e);
      break;
    case "if":
      f(s.c);
      g(s.a);
      if (s.b !== null) g(s.b);
      break;
    case "while":
      f(s.c);
      g(s.body);
      break;
    case "do":
      g(s.body);
      f(s.c);
      break;
    case "for":
      g(s.init);
      if (s.c !== null) f(s.c);
      s.step.forEach(f);
      g(s.body);
      break;
    case "switch":
      f(s.val);
      for (const c of s.clauses) g(c.body);
      break;
    case "block":
      g(s.body);
      break;
    case "label":
      eachStmtExpr(s.body, f, g);
      break;
    case "return":
      if (s.val !== null) f(s.val);
      break;
    case "break":
    case "continue":
      break;
    default:
      throw new Error(`rc: a ${s.k} statement in a down-lowered tree`);
  }
}

interface ListNode {
  parent: ListNode | null;
  depth: number;
  loops: number;
  stmts: Stmt[];
}

function lcaOf(a: ListNode | null, b: ListNode): ListNode {
  if (a === null) return b;
  let x: ListNode = a;
  let y: ListNode = b;
  while (x.depth > y.depth) x = x.parent!;
  while (y.depth > x.depth) y = y.parent!;
  while (x !== y) {
    x = x.parent!;
    y = y.parent!;
  }
  return x;
}

interface VarInfo {
  v: Var;
  sh: Counted | null;
  defs: TE[];
  sets: number;
  defLoops: number;
  occurrences: number;
  list: ListNode | null;
  param: boolean;
  alias: boolean;
  roots: Set<Var>;
}

type Out = { te: TE; st: "none" | "own" | "bor" | "null" };

class RcPass {
  opts: RcOptions;
  overwriters = new Set<FuncInst>();
  // The leaf descriptor; WeakRef's, one reference at offset 0; a vector with no references to visit.
  words: number[] = [0, 1 | (1 << 8), 0, 2, 0];
  descByNode = new Map<HeapNode, number>();
  descByKey = new Map<string, number>();
  stats: RcStats = {
    incSites: 0,
    decSites: 0,
    argsBorrowed: 0,
    argsHeld: 0,
    localsBorrowed: 0,
    localsCounted: 0,
    functions: 0,
    overwriters: 0,
  };
  incIndex = 0;
  decIndex = 0;
  // The cycle collector: what each type's strongly connected component is, if it's in one (SPEC 3.5, D41).
  scc = new Map<HeapNode, number>();
  // per function
  fn!: FuncInst;
  info = new Map<Var, VarInfo>();
  nextId = 0;
  managed = new Map<Var, Counted>();
  moved = new Set<Var>();
  paramOwned = new Set<Var>();
  overwriteMemo = new WeakMap<Stmt[], boolean>();

  constructor(opts: RcOptions) {
    this.opts = opts;
  }

  // --- descriptors

  /** Whether the collector follows a reference from this type to that one: only inside one component can it be a cycle. */
  traced(owner: HeapNode | null, sh: Counted): boolean {
    if (owner === null || sh.s === "arr") return false;
    const c = this.scc.get(findNode(owner));
    return c !== undefined && this.scc.get(findNode(sh.node)) === c;
  }

  /** A type a cycle can pass through. A site or a descriptor for any other type is what it always was. */
  cyclic(sh: Counted): boolean {
    return sh.s !== "arr" && this.scc.has(findNode(sh.node));
  }

  descFromRefs(refs: { off: number; arr: boolean; traced?: boolean }[]): number {
    if (refs.length === 0) return RC_DESC_LEAF;
    const key = refs
      .map((r) => `${r.off}${r.arr ? "a" : ""}${r.traced === true ? "t" : ""}`)
      .join(",");
    const hit = this.descByKey.get(key);
    if (hit !== undefined) return hit;
    const at = this.words.length;
    this.words.push(1 | (refs.length << 8));
    for (const r of refs)
      this.words.push(
        (r.off | (r.arr ? 0x80000000 : 0) | (r.traced === true ? 0x40000000 : 0)) >>> 0,
      );
    this.descByKey.set(key, at);
    return at;
  }

  descOfNode(n0: HeapNode): number {
    const n = findNode(n0);
    if (n.weakOf !== undefined) return RC_DESC_WEAK;
    const hit = this.descByNode.get(n);
    if (hit !== undefined) return hit;
    let at: number;
    if (n.kind === "vec") {
      const es = n.elem ?? ({ s: "void" } as Shape);
      const c = countedOf(es);
      if (c === null) at = RC_DESC_VEC_LEAF;
      else {
        at = this.words.length;
        this.words.push(2);
        this.words.push(
          (sizeOf(es) | (c.s === "arr" ? 0x80000000 : 0) | (this.traced(n, c) ? 0x40000000 : 0)) >>>
            0,
        );
      }
    } else {
      const layout = layoutOf(n);
      const refs: { off: number; arr: boolean; traced: boolean }[] = [];
      for (const [name, sh] of n.fields) {
        const c = countedOf(sh);
        if (c !== null)
          refs.push({ off: layout.offs.get(name)!, arr: c.s === "arr", traced: this.traced(n, c) });
      }
      at = this.descFromRefs(refs);
    }
    at |= this.scc.has(n) ? RC_CC_DESC_CYC : 0;
    this.descByNode.set(n, at);
    return at;
  }

  // --- the whole-program fact: which functions can overwrite a counted slot

  teOverwrites(te: TE): boolean {
    if (
      te.k === "fstore" &&
      te.rc !== "init" &&
      (te.rc === "move" || countedOf(te.val.sh) !== null)
    )
      return true;
    if (te.k === "callclo") return true;
    if (te.k === "call" && this.overwriters.has(te.inst)) return true;
    let found = false;
    eachKid(
      te,
      (c) => {
        if (!found && this.teOverwrites(c)) found = true;
      },
      (b) => {
        if (!found && this.listOverwrites(b)) found = true;
      },
    );
    return found;
  }

  listOverwrites(list: Stmt[]): boolean {
    const memo = this.overwriteMemo.get(list);
    if (memo !== undefined) return memo;
    let found = false;
    const stmt = (s: Stmt): void => {
      eachStmtExpr(
        s,
        (e) => {
          if (!found && this.teOverwrites(e)) found = true;
        },
        (b) => {
          if (!found && this.listOverwrites(b)) found = true;
        },
      );
    };
    for (const s of list) stmt(s);
    this.overwriteMemo.set(list, found);
    return found;
  }

  computeOverwriters(funcs: FuncInst[]): void {
    for (let guard = 0; guard < funcs.length + 2; guard++) {
      this.overwriteMemo = new WeakMap();
      let changed = false;
      for (const f of funcs) {
        if (!this.overwriters.has(f) && this.listOverwrites(f.body)) {
          this.overwriters.add(f);
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.overwriteMemo = new WeakMap();
    this.stats.overwriters = this.overwriters.size;
    this.stats.functions = funcs.length;
  }

  // --- what each variable is, in the original tree

  infoOf(v: Var): VarInfo {
    let i = this.info.get(v);
    if (i === undefined) {
      i = {
        v,
        sh: null,
        defs: [],
        sets: 0,
        defLoops: 0,
        occurrences: 0,
        list: null,
        param: false,
        alias: false,
        roots: new Set(),
      };
      this.info.set(v, i);
    }
    return i;
  }

  noteSh(v: Var, sh: unknown): void {
    const c = countedOf(sh);
    if (c !== null) this.infoOf(v).sh = c;
  }

  occurrence(v: Var, at: ListNode): void {
    const i = this.infoOf(v);
    i.occurrences++;
    i.list = lcaOf(i.list, at);
    if (v.id >= this.nextId) this.nextId = v.id + 1;
  }

  scanTE(te: TE, at: ListNode, loops: number): void {
    if (te.k === "var") {
      this.occurrence(te.v, at);
      this.noteSh(te.v, te.sh);
      return;
    }
    if (te.k === "setvar") {
      this.occurrence(te.v, at);
      this.noteSh(te.v, te.val.sh);
      const i = this.infoOf(te.v);
      i.defs.push(te.val);
      i.sets++;
      i.defLoops = Math.max(i.defLoops, loops);
    }
    if (te.k === "blockexpr") {
      this.scanList(te.body, at, loops);
      this.scanTE(te.result, at, loops); // the value leaves the block, so what it reads must too
      return;
    }
    eachKid(
      te,
      (c) => {
        this.scanTE(c, at, loops);
      },
      () => undefined,
    );
  }

  scanStmt(s: Stmt, at: ListNode, loops: number): void {
    switch (s.k) {
      case "let":
        this.occurrence(s.v, at);
        if (s.init !== null) {
          this.scanTE(s.init, at, loops);
          this.noteSh(s.v, s.init.sh);
          const i = this.infoOf(s.v);
          i.defs.push(s.init);
          i.defLoops = Math.max(i.defLoops, loops);
        }
        return;
      case "while":
        this.scanTE(s.c, at, loops + 1);
        this.scanList(s.body, at, loops + 1);
        return;
      case "do":
        this.scanList(s.body, at, loops + 1);
        this.scanTE(s.c, at, loops + 1);
        return;
      case "for":
        this.scanList(s.init, at, loops);
        if (s.c !== null) this.scanTE(s.c, at, loops + 1);
        for (const e of s.step) this.scanTE(e, at, loops + 1);
        this.scanList(s.body, at, loops + 1);
        return;
      case "label":
        this.scanStmt(s.body, at, loops);
        return;
      default:
        eachStmtExpr(
          s,
          (e) => {
            this.scanTE(e, at, loops);
          },
          (b) => {
            this.scanList(b, at, loops);
          },
        );
    }
  }

  scanList(list: Stmt[], parent: ListNode | null, loops: number): ListNode {
    const node: ListNode = {
      parent,
      depth: parent === null ? 0 : parent.depth + 1,
      loops,
      stmts: list,
    };
    for (const s of list) this.scanStmt(s, node, loops);
    return node;
  }

  /** What a value read from memory stays alive through: the locals at its root, or null if it isn't that simple. */
  rootsOf(te: TE, out: Set<Var>): boolean {
    switch (te.k) {
      case "var":
        out.add(te.v);
        return true;
      case "lit":
      case "gaddr":
        return true;
      case "fload":
        return this.rootsOf(te.base, out);
      case "elemaddr":
        return this.rootsOf(te.base, out);
      case "nonnull":
        return this.rootsOf(te.val, out);
      case "tuple":
        return te.items.every((x) => x.k === "lit") || this.rootsOf(te.items[0]!, out);
      case "cond":
        return this.rootsOf(te.a, out) && this.rootsOf(te.b, out);
      case "blockexpr": {
        for (const s of te.body) {
          if (s.k === "let" && countedOf(s.init?.sh) === null) continue;
          if (s.k === "expr" && s.e.k === "builtin") continue;
          return false;
        }
        return this.rootsOf(te.result, out);
      }
      default:
        return false;
    }
  }

  /** A local that needs no count of its own, because what it reads can't go away while it's in scope. */
  decideAliases(f: FuncInst): void {
    if (!this.opts.elide) return;
    // Parameters hold no count: the caller does. One that's assigned has no fixed value to rely on.
    const stable = (v: Var): boolean => {
      const i = this.infoOf(v);
      return i.sets === 0 && i.defs.length <= 1;
    };
    for (const i of this.info.values()) {
      if (i.sh === null || i.defs.length === 0) continue;
      if (i.list === null) continue;
      const roots = new Set<Var>();
      let simple = true;
      let plainCopy = i.defs.length === 1 && !i.param;
      for (const d of i.defs) {
        if (!this.rootsOf(d, roots)) simple = false;
        if (d.k !== "var") plainCopy = false;
      }
      if (!simple) continue;
      roots.delete(i.v);
      let ok = true;
      for (const r of roots) {
        const ri = this.infoOf(r);
        // The environment a closure was called with: its caller holds it, and what's in it doesn't change.
        if (ri.sh === null && r.name === "$env") continue;
        if (ri.sh === null) {
          ok = false;
          continue;
        }
        if (!stable(r) || ri.defLoops > i.list.loops) ok = false;
      }
      if (!ok) continue;
      if (!plainCopy && this.listOverwrites(i.list.stmts)) continue;
      i.alias = true;
      for (const r of roots) if (this.infoOf(r).sh !== null) i.roots.add(r);
    }
    void f;
  }

  // --- stage A: ownership

  newVar(ty: Ty, name: string): Var {
    return { id: this.nextId++, name, ty };
  }

  isManaged(v: Var): boolean {
    return this.managed.has(v);
  }

  /** Counts are inline in a release build. Test builds go through the runtime, to be counted and checked. */
  get inline(): boolean {
    return !this.opts.check && !this.opts.account;
  }

  countWord(read: TE): TE {
    return mk(T.i32, { k: "fload", base: read, mem: [{ t: "i32", off: -8 }] });
  }

  probe(): Stmt {
    return { k: "expr", e: mk(T.void, { k: "trapnow", kind: "rc", code: 999, loc: "probe" }) };
  }

  /** What a site for a type that can't be in a cycle promises, checked in a test build (SPEC 3.5, D41). */
  acyclicHere(read: TE, sh: Counted): Stmt[] {
    if (!this.opts.check || this.scc.size === 0 || sh.s === "arr" || this.cyclic(sh)) return [];
    return [{ k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_ac", args: [read] }) }];
  }

  metaWord(read: TE): TE {
    return mk(T.i32, { k: "fload", base: read, mem: [{ t: "i32", off: -4 }] });
  }

  metaBits(read: TE, bits: number): TE {
    return mk(T.i32, { k: "bit", op: "and", a: this.metaWord(read), b: lit32(bits) });
  }

  /** The barrier: a count that's about to go elsewhere, or that just changed, on an object a scan has reached. */
  touchIfScanned(read: TE): Stmt {
    return {
      k: "if",
      c: mk(T.bool, { k: "cmp", op: "ne", a: this.metaBits(read, RC_CC_INS), b: lit32(0) }),
      a: [{ k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_touch", args: [read] }) }],
      b: null,
    };
  }

  incOf(read: TE, sh: Counted): Stmt {
    const n = this.incIndex++;
    if (this.opts.omitInc === n) return { k: "block", body: [] };
    if (this.opts.probeInc === n) return this.probe();
    this.stats.incSites++;
    const check = this.acyclicHere(read, sh);
    if (check.length > 0) {
      return {
        k: "block",
        body: [
          ...check,
          { k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_inc", args: [read] }) },
        ],
      };
    }
    if (sh.s === "arr") {
      return {
        k: "expr",
        e: mk(T.void, {
          k: "rtcall",
          name: "__rc_arr_inc",
          args: [mk(REF, { k: "slice", val: read, from: 0, to: 1 })],
        }),
      };
    }
    if (!this.inline) {
      return { k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_inc", args: [read] }) };
    }
    const next = mk(T.i32, {
      k: "arith",
      op: "add",
      a: this.countWord(read),
      b: lit32(1),
      wrap: true,
      loc: "rc",
    });
    return {
      k: "if",
      c: mk(T.bool, { k: "cmp", op: "ne", a: read, b: nullRef() }),
      a: [
        {
          k: "expr",
          e: mk(T.i32, { k: "fstore", base: read, mem: [{ t: "i32", off: -8 }], val: next }),
        },
        ...(this.cyclic(sh) && this.opts.ccFault !== "no-touch" ? [this.touchIfScanned(read)] : []),
      ],
      b: null,
    };
  }

  decOf(read: TE, sh: Counted): Stmt {
    const n = this.decIndex++;
    if (this.opts.omitDec === n) return { k: "block", body: [] };
    if (this.opts.probeDec === n) return this.probe();
    this.stats.decSites++;
    const check = this.acyclicHere(read, sh);
    if (check.length > 0) {
      return {
        k: "block",
        body: [
          ...check,
          { k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_dec", args: [read] }) },
        ],
      };
    }
    if (sh.s === "arr") {
      return {
        k: "expr",
        e: mk(T.void, {
          k: "rtcall",
          name: "__rc_arr_dec",
          args: [mk(REF, { k: "slice", val: read, from: 0, to: 1 })],
        }),
      };
    }
    if (!this.inline) {
      return { k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_dec", args: [read] }) };
    }
    const left = this.newVar(T.i32, "$c");
    const leftRead = mk(T.i32, { k: "var", v: left });
    return {
      k: "if",
      c: mk(T.bool, { k: "cmp", op: "ne", a: read, b: nullRef() }),
      a: [
        {
          k: "let",
          v: left,
          init: mk(T.i32, {
            k: "arith",
            op: "sub",
            a: this.countWord(read),
            b: lit32(1),
            wrap: true,
            loc: "rc",
          }),
          constant: true,
        },
        {
          k: "expr",
          e: mk(T.i32, { k: "fstore", base: read, mem: [{ t: "i32", off: -8 }], val: leftRead }),
        },
        {
          k: "if",
          c: mk(T.bool, { k: "cmp", op: "eq", a: leftRead, b: lit32(0) }),
          a: [{ k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_zero", args: [read] }) }],
          // A count left above zero on a type that can be in a cycle: it's a candidate (SPEC 3.5, D41).
          b: this.cyclic(sh)
            ? [
                {
                  k: "if",
                  c: mk(T.bool, {
                    k: "cmp",
                    op: "ne",
                    a: this.metaBits(read, RC_CC_BUF | RC_CC_INS),
                    b: lit32(RC_CC_BUF),
                  }),
                  a: [
                    { k: "expr", e: mk(T.void, { k: "rtcall", name: "__rc_cand", args: [read] }) },
                  ],
                  b: null,
                },
              ]
            : null,
        },
      ],
      b: null,
    };
  }

  movedIn = new Map<Stmt[], Var[]>(); // a block's body, and the result it moves out when it ends

  rawTemp(te: TE, name: string, body: Stmt[]): TE {
    const v = this.newVar(te.ty, name);
    body.push({ k: "let", v, init: te, constant: true });
    return mk(te.ty, { k: "var", v }, te.sh !== undefined ? { sh: te.sh } : undefined);
  }

  /**
   * Bookkeeping around one value. Its statements aren't a scope: whatever a value here was read through has to outlive
   * all of it, so a temporary it uses lasts until the whole statement around it ends.
   */
  flat(ty: Ty, body: Stmt[], result: TE, extra?: Partial<TE>): TE {
    return mk(ty, { k: "blockexpr", body, result }, { ...extra, rcFlat: true });
  }

  /** The value with one count that's the receiver's to keep. */
  own(o: Out): TE {
    if (o.st !== "bor") return o.te;
    const sh = o.te.sh as Counted | undefined;
    if (sh === undefined) throw new Error(`rc: a counted ${o.te.k} with no shape`);
    if (o.te.k === "global") return o.te; // static bytes aren't counted
    const body: Stmt[] = [];
    const read = o.te.k === "var" ? o.te : this.rawTemp(o.te, "$b", body);
    body.push(this.incOf(read, sh));
    return this.flat(o.te.ty, body, read, o.te.k === "var" ? { sh, rcOwn: o.te.v } : { sh });
  }

  /** An owned value given a name for the rest of the statement, which then reads it. */
  hold(te: TE, sh: Counted): TE {
    const v = this.newVar(te.ty, "$h");
    this.managed.set(v, sh);
    this.stats.localsCounted++;
    const read = mk(te.ty, { k: "var", v }, { sh });
    return this.flat(
      te.ty,
      [{ k: "expr", e: mk(te.ty, { k: "setvar", v, val: te, rc: "assign" }, { sh }) }],
      read,
      { sh },
    );
  }

  /** A value only looked at: an owned one is kept until the statement ends. */
  sub(te: TE): TE {
    const o = this.x(te);
    if (o.st === "own") {
      if (te.sh === undefined) throw new Error(`rc: an owned ${te.k} with no shape`);
      return this.hold(o.te, te.sh as Counted);
    }
    return o.te;
  }

  /** The base of an access. */
  base(te: TE): TE {
    const b = this.sub(te);
    const sh = countedOf(b.sh ?? te.sh);
    if (this.opts.check && sh !== null && sh.s !== "arr") {
      return mk(REF, { k: "rtcall", name: "__rc_chk", args: [b] }, { sh });
    }
    return b;
  }

  /** What can't change a local of this frame. A later argument can: `f(x, (x = null, 1))`. */
  assignsVar(te: TE, v: Var): boolean {
    if (te.k === "setvar" && te.v === v) return true;
    let found = false;
    eachKid(
      te,
      (c) => {
        if (!found && this.assignsVar(c, v)) found = true;
      },
      (b) => {
        for (const s of b) {
          eachStmtExpr(
            s,
            (e) => {
              if (!found && this.assignsVar(e, v)) found = true;
            },
            (bb) => {
              if (!found && bb.some((y) => this.stmtAssigns(y, v))) found = true;
            },
          );
          if (s.k === "let" && s.v === v) found = true;
        }
      },
    );
    return found;
  }

  stmtAssigns(s: Stmt, v: Var): boolean {
    let found = s.k === "let" && s.v === v;
    eachStmtExpr(
      s,
      (e) => {
        if (!found && this.assignsVar(e, v)) found = true;
      },
      (b) => {
        if (!found && b.some((y) => this.stmtAssigns(y, v))) found = true;
      },
    );
    return found;
  }

  /** An argument: borrowed for the call, so the caller has to be sure it stays alive for the call. */
  arg(a: TE, later: TE[], calleeOverwrites: boolean): TE {
    const o = this.x(a);
    if (o.st === "none" || o.st === "null") return o.te;
    const sh = a.sh as Counted;
    if (o.st === "own") {
      this.stats.argsHeld++;
      return this.hold(o.te, sh);
    }
    if (this.opts.elide) {
      if (a.k === "var") {
        // A local of this frame: no callee can reach it, only a later argument.
        if (!later.some((x) => this.assignsVar(x, a.v))) {
          this.stats.argsBorrowed++;
          return o.te;
        }
      } else if (!calleeOverwrites && !later.some((x) => this.teOverwrites(x))) {
        // Read from a slot, and nothing in the call can overwrite one.
        this.stats.argsBorrowed++;
        return o.te;
      }
    }
    this.stats.argsHeld++;
    return this.hold(this.own(o), sh);
  }

  /** How many times this subtree mentions a variable, directly or through a local that relies on it. */
  mentions(te: TE, v: Var): number {
    let n = 0;
    const onTE = (x: TE): void => {
      if (x.k === "var" || x.k === "setvar") {
        if (x.v === v || this.info.get(x.v)?.roots.has(v) === true) n++;
      }
      eachKid(x, onTE, onList);
    };
    const onStmt = (s: Stmt): void => {
      if (s.k === "let" && (s.v === v || this.info.get(s.v)?.roots.has(v) === true)) n++;
      eachStmtExpr(s, onTE, onList);
    };
    const onList = (b: Stmt[]): void => {
      b.forEach(onStmt);
    };
    onTE(te);
    return n;
  }

  allOccurrences(v: Var): number {
    let n = this.info.get(v)?.occurrences ?? 0;
    for (const i of this.info.values()) if (i.roots.has(v)) n += i.occurrences;
    return n;
  }

  x(te: TE): Out {
    switch (te.k) {
      case "lit": {
        if (countedOf(te.sh) !== null && te.value === 0) return { te, st: "null" };
        return { te, st: "none" };
      }
      case "var": {
        if (countedOf(te.sh) === null && this.info.get(te.v)?.sh == null) return { te, st: "none" };
        const sh = (te.sh ?? this.info.get(te.v)!.sh) as Counted;
        return { te: { ...te, sh } as TE, st: "bor" };
      }
      case "global":
        return { te, st: countedOf(te.sh) !== null ? "bor" : "none" };
      case "gaddr":
        // A literal in static data: its count starts where nothing can take it to zero (SPEC 3.5).
        return { te, st: countedOf(te.sh) !== null ? "bor" : "none" };
      case "tuple": {
        const sh = countedOf(te.sh);
        if (sh === null)
          return {
            te: mapKids(
              te,
              (c) => this.sub(c),
              (b) => b,
            ),
            st: "none",
          };
        const first = te.items[0]!;
        if (first.k === "lit") return { te, st: "null" };
        if (first.k === "alloc") {
          const made = this.allocate(first, 1);
          return {
            te: { ...te, items: [made, this.sub(te.items[1]!)] } as TE,
            st: "own",
          };
        }
        return { te: { ...te, items: te.items.map((c) => this.sub(c)) } as TE, st: "bor" };
      }
      case "fload": {
        const b = this.base(te.base);
        return { te: { ...te, base: b } as TE, st: countedOf(te.sh) !== null ? "bor" : "none" };
      }
      case "fstore":
        return this.store(te);
      case "alloc": {
        if (te.long === undefined || te.long() === null) {
          return { te: { ...te, size: this.sub(te.size) } as TE, st: "none" };
        }
        return { te: this.allocate(te, 0), st: "own" };
      }
      case "call": {
        const over = this.overwriters.has(te.inst);
        const args = te.args.map((a, i) => this.arg(a, te.args.slice(i + 1), over));
        const out = { ...te, args } as TE;
        return { te: out, st: countedOf(te.sh) !== null ? "own" : "none" };
      }
      case "callclo": {
        const later = [...te.args];
        const clo = this.arg(te.clo, later, true);
        const args = te.args.map((a, i) => this.arg(a, te.args.slice(i + 1), true));
        return {
          te: {
            ...te,
            clo:
              this.opts.check && countedOf(te.clo.sh) !== null
                ? mk(REF, { k: "rtcall", name: "__rc_chk", args: [clo] }, { sh: te.clo.sh })
                : clo,
            args,
          } as TE,
          st: countedOf(te.sh) !== null ? "own" : "none",
        };
      }
      case "rtcall": {
        if (te.name === "__vec_new_rc") {
          const n = findNode((te.sh as Counted & { node: HeapNode }).node);
          return {
            te: {
              ...te,
              args: [...te.args.map((a) => this.sub(a)), lit32(this.descOfNode(n))],
            } as TE,
            st: "own",
          };
        }
        const args = te.args.map((a) => this.sub(a));
        const own = te.name === "__rc_weak_new" || te.name === "__rc_weak_deref";
        return { te: { ...te, args } as TE, st: own ? "own" : "none" };
      }
      case "cond": {
        const c = this.sub(te.c);
        const a = this.x(te.a);
        const b = this.x(te.b);
        const counted = a.st !== "none" || b.st !== "none";
        if (!counted) return { te: { ...te, c, a: a.te, b: b.te } as TE, st: "none" };
        if (a.st === "own" || b.st === "own") {
          return { te: { ...te, c, a: this.own(a), b: this.own(b) } as TE, st: "own" };
        }
        const st = a.st === "null" && b.st === "null" ? "null" : "bor";
        return { te: { ...te, c, a: a.te, b: b.te } as TE, st };
      }
      case "seq": {
        const items = te.items.map((i) => this.discard(i));
        const r = this.x(te.result);
        return { te: { ...te, items, result: r.te } as TE, st: r.st };
      }
      case "blockexpr":
        return this.blockexpr(te);
      case "setvar": {
        const i = this.info.get(te.v);
        if (i?.sh === null || i?.sh === undefined) {
          return { te: { ...te, val: this.sub(te.val) } as TE, st: "none" };
        }
        if (i.alias) {
          return { te: { ...te, val: this.x(te.val).te, sh: i.sh } as TE, st: "bor" };
        }
        const val = this.own(this.x(te.val));
        return {
          te: { ...te, val, sh: i.sh, rc: "assign" } as TE,
          st: "bor",
        };
      }
      case "elemaddr": {
        // An entry of the static table of one-character strings.
        const made = mapKids(
          te,
          (c) => this.sub(c),
          (b) => this.stmts(b),
        );
        return { te: made, st: countedOf(te.sh) !== null ? "bor" : "none" };
      }
      case "nonnull": {
        const v = this.x(te.val);
        return { te: { ...te, val: v.te } as TE, st: v.st };
      }
      case "slice": {
        const v = this.sub(te.val);
        const out = { ...te, val: v } as TE;
        if (this.opts.check && countedOf(te.val.sh)?.s === "arr" && te.from === 0 && te.to === 1) {
          return { te: mk(REF, { k: "rtcall", name: "__rc_chk_arr", args: [out] }), st: "none" };
        }
        return { te: out, st: "none" };
      }
      default:
        return {
          te: mapKids(
            te,
            (c) => this.sub(c),
            (b) => this.stmts(b),
          ),
          st: "none",
        };
    }
  }

  allocate(te: Extract<TE, { k: "alloc" }>, extra: number): TE {
    const sh = countedOf(te.sh);
    let desc: number = RC_DESC_LEAF;
    if (te.rcRefs !== undefined) {
      const owner = sh !== null && sh.s !== "arr" ? sh.node : null;
      const refs = te.rcRefs().flatMap((r) => {
        const c = countedOf(r.sh);
        return c === null
          ? []
          : [{ off: r.off, arr: c.s === "arr", traced: this.traced(owner, c) }];
      });
      desc = this.descFromRefs(refs);
      if (sh !== null && this.cyclic(sh)) desc |= RC_CC_DESC_CYC;
    } else if (sh !== null && sh.s !== "arr") desc = this.descOfNode(sh.node);
    const size0 = this.sub(te.size);
    // A subarray can end at the end of its array: one more byte keeps that pointer inside the block.
    const size =
      extra === 0
        ? size0
        : mk(T.usize, {
            k: "arith",
            op: "add",
            a: size0,
            b: litIx(extra),
            wrap: true,
            loc: te.loc,
          });
    return mk(
      REF,
      { k: "rtcall", name: "__rc_new", args: [size, lit32(desc)] },
      te.sh !== undefined ? { sh: te.sh } : undefined,
    );
  }

  /** Overwriting a counted slot: the new value's count first, then the store, then the old value's. */
  store(te: Extract<TE, { k: "fstore" }>): Out {
    const sh = countedOf(te.val.sh);
    if (te.rc === "move") {
      const raw = (x: TE): TE => {
        // A move changes no count: the slot's count goes with it.
        if (x.k === "fload") return { ...x, base: this.sub(x.base) } as TE;
        return this.x(x).te;
      };
      // A move changes no count, so the barrier on counts doesn't see it. A scan may have read the old slot.
      if (sh !== null && te.val.k !== "lit" && this.cyclic(sh) && this.opts.noMoveTouch !== true) {
        const body: Stmt[] = [];
        const b = this.rawTemp(this.sub(te.base), "$a", body);
        const v = this.rawTemp(raw(te.val), "$v", body);
        body.push({ k: "expr", e: { ...te, base: b, val: v } as TE });
        // An array's slot can be a hole.
        body.push({
          k: "if",
          c: mk(T.bool, { k: "cmp", op: "ne", a: v, b: nullRef() }),
          a: [this.touchIfScanned(v)],
          b: null,
        });
        return { te: this.flat(T.void, body, mk(T.void, { k: "tuple", items: [] })), st: "none" };
      }
      return { te: { ...te, base: this.sub(te.base), val: raw(te.val) } as TE, st: "none" };
    }
    if (sh === null) {
      const b = this.base(te.base);
      const v = this.x(te.val);
      if (v.st === "own" || v.st === "bor") {
        // Every counted store has to be seen here: a missed one is a count that's wrong forever.
        throw new Error(`rc: a counted ${te.val.k} stored with no shape, at ${this.fn.tirName}`);
      }
      return { te: { ...te, base: b, val: v.te } as TE, st: "none" };
    }
    const body: Stmt[] = [];
    const b = this.rawTemp(this.base(te.base), "$a", body);
    const n = this.rawTemp(this.own(this.x(te.val)), "$n", body);
    const nsh = { ...n, sh } as TE;
    if (te.rc === "init") {
      body.push({ k: "expr", e: { ...te, base: b, val: nsh } as TE });
      return { te: this.flat(te.val.ty, body, nsh, { sh }), st: "bor" };
    }
    const old = this.rawTemp(
      mk(te.val.ty, { k: "fload", base: b, mem: te.mem }, { sh }),
      "$o",
      body,
    );
    body.push({ k: "expr", e: { ...te, base: b, val: nsh } as TE });
    body.push(this.decOf(old, sh));
    return { te: this.flat(te.val.ty, body, nsh, { sh }), st: "bor" };
  }

  blockexpr(te: Extract<TE, { k: "blockexpr" }>): Out {
    const body = this.stmts(te.body);
    const r = this.x(te.result);
    if (r.st === "bor" && te.result.k === "var") {
      const v = te.result.v;
      // The block's own result, with nothing after it: its count moves out, with no increment and no decrement.
      if (
        this.isManaged(v) &&
        !this.paramOwned.has(v) &&
        !this.moved.has(v) &&
        this.mentions(te, v) === this.allOccurrences(v)
      ) {
        this.moved.add(v);
        const sh = this.managed.get(v)!;
        const reset: Stmt = {
          k: "expr",
          e: mk(te.result.ty, { k: "setvar", v, val: nullOfSh(sh), rc: "raw" }, { sh }),
        };
        const list = [reset, ...body];
        this.movedIn.set(list, [...(this.movedIn.get(list) ?? []), v]);
        return { te: { ...te, body: list, result: r.te } as TE, st: "own" };
      }
    }
    return { te: { ...te, body, result: r.te } as TE, st: r.st };
  }

  /** An expression whose value nobody takes. */
  discard(te: TE): TE {
    const o = this.x(te);
    if (o.st !== "own") return o.te;
    const sh = te.sh as Counted | undefined;
    if (sh === undefined) throw new Error(`rc: an owned ${te.k} with no shape, discarded`);
    const body: Stmt[] = [];
    const t = this.rawTemp(o.te, "$d", body);
    body.push(this.decOf(t, sh));
    return this.flat(T.void, body, mk(T.void, { k: "tuple", items: [] }));
  }

  stmts(list: Stmt[]): Stmt[] {
    return list.flatMap((s) => this.stmt(s));
  }

  stmt(s: Stmt): Stmt[] {
    switch (s.k) {
      case "let": {
        const i = this.info.get(s.v);
        if (i?.sh === null || i?.sh === undefined) {
          return [s.init !== null ? { ...s, init: this.sub(s.init) } : s];
        }
        if (s.init === null) return [s];
        if (i.alias) return [{ ...s, init: this.x(s.init).te }];
        const val = this.own(this.x(s.init));
        return [
          { k: "let", v: s.v, init: null, constant: false },
          { k: "expr", e: mk(s.init.ty, { k: "setvar", v: s.v, val, rc: "assign" }, { sh: i.sh }) },
        ];
      }
      case "expr":
        return [{ ...s, e: this.discard(s.e) }];
      case "if":
        return [
          { ...s, c: this.sub(s.c), a: this.stmts(s.a), b: s.b !== null ? this.stmts(s.b) : null },
        ];
      case "while":
        return [{ ...s, c: this.sub(s.c), body: this.stmts(s.body) }];
      case "do":
        return [{ ...s, body: this.stmts(s.body), c: this.sub(s.c) }];
      case "for":
        return [
          {
            ...s,
            init: this.stmts(s.init),
            c: s.c !== null ? this.sub(s.c) : null,
            step: s.step.map((e) => this.discard(e)),
            body: this.stmts(s.body),
          },
        ];
      case "switch":
        return [
          {
            ...s,
            val: this.sub(s.val),
            clauses: s.clauses.map((c) => ({ ...c, body: this.stmts(c.body) })),
          },
        ];
      case "block":
        return [{ ...s, body: this.stmts(s.body) }];
      case "label": {
        const inner = this.stmt(s.body);
        return [{ ...s, body: inner.length === 1 ? inner[0]! : { k: "block", body: inner } }];
      }
      case "return": {
        if (s.val === null) return [s];
        const sh = countedOf(s.val.sh);
        if (sh === null) return [{ ...s, val: this.sub(s.val) }];
        const v = s.val.k === "var" ? s.val.v : null;
        if (v !== null && this.isManaged(v) && !this.paramOwned.has(v)) {
          // Returning a local gives its count away.
          const body: Stmt[] = [];
          const m = this.rawTemp({ ...s.val, sh } as TE, "$m", body);
          body.push({
            k: "expr",
            e: mk(s.val.ty, { k: "setvar", v, val: nullOfSh(sh), rc: "raw" }, { sh }),
          });
          return [{ ...s, val: this.flat(s.val.ty, body, m, { sh }) }];
        }
        return [{ ...s, val: this.own(this.x(s.val)) }];
      }
      case "break":
      case "continue":
        return [s];
      default:
        throw new Error(`rc: a ${s.k} statement in a down-lowered tree`);
    }
  }

  // --- stage B: scopes

  frames: { list: Stmt[]; idx: number; loops: number }[] = [];
  scopeOf = new Map<
    Var,
    { prefix: { list: Stmt[]; max: number; loops: number }[]; assigns: number; assignLoops: number }
  >();
  scoped = new Map<Stmt[], { v: Var; sh: Counted; u: number }[]>();
  knownNull = new Set<Var>();
  finalMove = new Set<Var>();
  targets: { label: string | null; plain: boolean; loop: boolean; depth: number }[] = [];
  pending: string | null = null;

  useVar(v: Var, seen: Set<Var> = new Set()): void {
    if (seen.has(v)) return;
    seen.add(v);
    if (this.managed.has(v)) {
      let sc = this.scopeOf.get(v);
      if (sc === undefined) {
        sc = {
          prefix: this.frames.map((f) => ({ list: f.list, max: f.idx, loops: f.loops })),
          assigns: 0,
          assignLoops: 0,
        };
        this.scopeOf.set(v, sc);
      } else {
        let k = 0;
        while (
          k < sc.prefix.length &&
          k < this.frames.length &&
          sc.prefix[k]!.list === this.frames[k]!.list
        ) {
          sc.prefix[k]!.max = Math.max(sc.prefix[k]!.max, this.frames[k]!.idx);
          k++;
        }
        sc.prefix.length = k;
      }
    }
    const i = this.info.get(v);
    if (i !== undefined) for (const r of i.roots) this.useVar(r, seen);
  }

  b1TE(te: TE, loops: number): void {
    if (te.k === "var") {
      this.useVar(te.v);
      return;
    }
    if (te.k === "setvar") {
      this.useVar(te.v);
      if (te.rc === "assign") {
        const sc = this.scopeOf.get(te.v);
        if (sc !== undefined) {
          sc.assigns++;
          sc.assignLoops = Math.max(sc.assignLoops, loops);
        }
      }
    }
    if (te.k === "blockexpr") {
      if (te.rcFlat === true) for (const s of te.body) this.b1Stmt(s, loops);
      else this.b1List(te.body, loops);
      this.b1TE(te.result, loops);
      return;
    }
    eachKid(
      te,
      (c) => {
        this.b1TE(c, loops);
      },
      () => undefined,
    );
  }

  b1Stmt(s: Stmt, loops: number): void {
    switch (s.k) {
      case "let":
        this.useVar(s.v);
        if (s.init !== null) this.b1TE(s.init, loops);
        return;
      case "while":
        this.b1TE(s.c, loops + 1);
        this.b1List(s.body, loops + 1);
        return;
      case "do":
        this.b1List(s.body, loops + 1);
        this.b1TE(s.c, loops + 1);
        return;
      case "for":
        this.b1List(s.init, loops);
        if (s.c !== null) this.b1TE(s.c, loops + 1);
        for (const e of s.step) this.b1TE(e, loops + 1);
        this.b1List(s.body, loops + 1);
        return;
      case "label":
        this.b1Stmt(s.body, loops);
        return;
      default:
        eachStmtExpr(
          s,
          (e) => {
            this.b1TE(e, loops);
          },
          (b) => {
            this.b1List(b, loops);
          },
        );
    }
  }

  b1List(list: Stmt[], loops: number): void {
    const f = { list, idx: 0, loops };
    this.frames.push(f);
    list.forEach((s, k) => {
      f.idx = k;
      this.b1Stmt(s, loops);
    });
    this.frames.pop();
  }

  release(v: Var, sh: Counted): Stmt {
    return this.decOf(mk(v.ty, { k: "var", v }, { sh }), sh);
  }

  /** What has to be let go of on a jump out of every list deeper than `depth`. */
  exits(depth: number): Stmt[] {
    const out: Stmt[] = [];
    for (let i = this.frames.length - 1; i >= depth; i--) {
      const f = this.frames[i]!;
      for (const e of this.scoped.get(f.list) ?? []) {
        if (e.u >= f.idx && !this.moved.has(e.v)) out.push(this.release(e.v, e.sh));
      }
      // A block's result whose count moves out when the block ends: a jump out of the block means it never ends, and
      // nothing takes the count. An exception leaving a constructor or a callback mid-way is one (D49).
      for (const v of this.movedIn.get(f.list) ?? []) {
        if (this.opts.excFault !== "no-release-path")
          out.push(this.release(v, this.managed.get(v)!));
      }
    }
    return out;
  }

  b2TE(te: TE): TE {
    if (te.k === "setvar" && te.rc === "assign") {
      const val = this.b2TE(te.val);
      const sh = this.managed.get(te.v);
      if (sh === undefined) throw new Error(`rc: an assignment to an unmanaged ${te.v.name}`);
      if (this.knownNull.has(te.v)) return { ...te, val, rc: "raw" } as TE;
      const body: Stmt[] = [];
      const n = this.rawTemp({ ...val, sh } as TE, "$n", body);
      const old = this.rawTemp(mk(te.v.ty, { k: "var", v: te.v }, { sh }), "$o", body);
      body.push({ k: "expr", e: { ...te, val: n, rc: "raw" } as TE });
      body.push(this.decOf(old, sh));
      return this.flat(te.ty, body, n, { sh });
    }
    const loops = this.frames[this.frames.length - 1]?.loops ?? 0;
    if (te.k === "blockexpr" && te.rcFlat === true) {
      return {
        ...te,
        // A statement in here is part of a larger one: what's a last use is only known out there.
        body: te.body.flatMap((s) =>
          s.k === "expr" ? [{ ...s, e: this.b2TE(s.e) }] : this.b2Stmt(s, loops),
        ),
        result: this.b2TE(te.result),
      } as TE;
    }
    return mapKids(
      te,
      (c) => this.b2TE(c),
      (b) => this.b2List(b, loops),
    );
  }

  b2List(list: Stmt[], loops: number): Stmt[] {
    const scoped = this.scoped.get(list) ?? [];
    const out: Stmt[] = [];
    for (const e of scoped) {
      if (!this.paramOwned.has(e.v)) {
        out.push({ k: "let", v: e.v, init: nullOfSh(e.sh), constant: false });
      }
    }
    const f = { list, idx: 0, loops };
    this.frames.push(f);
    list.forEach((s, k) => {
      f.idx = k;
      out.push(...this.b2Stmt(s, loops));
      for (const e of scoped) {
        if (e.u === k && !this.moved.has(e.v) && !this.finalMove.has(e.v)) {
          out.push(this.release(e.v, e.sh));
        }
      }
    });
    this.frames.pop();
    return out;
  }

  /**
   * `h = c`, or `x.f = c`, as a statement directly in the list where `c` is scoped, with nothing after it that reads `c`.
   * The local's count can simply move: no increment here, and no decrement at the end of its scope. An exit before
   * this statement still has its count to release, and no exit can come after it, so this is only about this statement.
   */
  moveAtLastUse(e: TE): TE {
    const top = this.frames[this.frames.length - 1]!;
    const tryOwn = (own: TE): TE | null => {
      const c = own.rcOwn;
      if (c === undefined || own.k !== "blockexpr") return null;
      if (!this.managed.has(c) || this.paramOwned.has(c) || this.moved.has(c)) return null;
      const scope = (this.scoped.get(top.list) ?? []).find((x) => x.v === c);
      if (scope === undefined || scope.u !== top.idx) return null;
      return own.result;
    };
    if (e.k === "setvar" && e.rc === "assign" && e.val.rcOwn !== undefined) {
      const plain = tryOwn(e.val);
      if (plain === null) return e;
      const next = { ...e, val: plain } as TE;
      if (e.val.rcOwn === e.v || this.mentions(next, e.val.rcOwn) !== 1) return e;
      this.finalMove.add(e.val.rcOwn);
      this.stats.incSites--;
      this.stats.decSites--;
      return next;
    }
    if (e.k === "blockexpr") {
      const hit = e.body.findIndex(
        (x) => x.k === "let" && x.v.name === "$n" && x.init?.rcOwn !== undefined,
      );
      if (hit < 0) return e;
      const st = e.body[hit] as Extract<Stmt, { k: "let" }>;
      const plain = tryOwn(st.init!);
      if (plain === null) return e;
      const c = st.init!.rcOwn!;
      const next = {
        ...e,
        body: e.body.map((x, i) => (i === hit ? { ...st, init: plain } : x)),
      } as TE;
      if (this.mentions(next, c) !== 1) return e;
      this.finalMove.add(c);
      this.stats.incSites--;
      this.stats.decSites--;
      return next;
    }
    return e;
  }

  findTarget(label: string | null, needLoop: boolean): number {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== null ? t.label === label : !t.plain && (!needLoop || t.loop)) return t.depth;
    }
    throw new Error(`rc: no target for ${label ?? "break"}`);
  }

  b2Stmt(s: Stmt, loops: number): Stmt[] {
    const loopTarget = (loop: boolean): void => {
      this.targets.push({ label: this.pending, plain: false, loop, depth: this.frames.length });
      this.pending = null;
    };
    switch (s.k) {
      case "let":
        return [s.init !== null ? { ...s, init: this.b2TE(s.init) } : s];
      case "expr":
        return [{ ...s, e: this.b2TE(this.moveAtLastUse(s.e)) }];
      case "if":
        return [
          {
            ...s,
            c: this.b2TE(s.c),
            a: this.b2List(s.a, loops),
            b: s.b !== null ? this.b2List(s.b, loops) : null,
          },
        ];
      case "while": {
        loopTarget(true);
        const out: Stmt = { ...s, c: this.b2TE(s.c), body: this.b2List(s.body, loops + 1) };
        this.targets.pop();
        return [out];
      }
      case "do": {
        loopTarget(true);
        const body = this.b2List(s.body, loops + 1);
        const out: Stmt = { ...s, body, c: this.b2TE(s.c) };
        this.targets.pop();
        return [out];
      }
      case "for": {
        const label = this.pending;
        this.pending = null;
        const init = this.b2List(s.init, loops);
        this.pending = label;
        loopTarget(true);
        const out: Stmt = {
          ...s,
          init,
          c: s.c !== null ? this.b2TE(s.c) : null,
          step: s.step.map((e) => this.b2TE(e)),
          body: this.b2List(s.body, loops + 1),
        };
        this.targets.pop();
        return [out];
      }
      case "switch": {
        loopTarget(false);
        const out: Stmt = {
          ...s,
          val: this.b2TE(s.val),
          clauses: s.clauses.map((c) => ({ ...c, body: this.b2List(c.body, loops) })),
        };
        this.targets.pop();
        return [out];
      }
      case "block":
        return [{ ...s, body: this.b2List(s.body, loops) }];
      case "label": {
        const inner = s.body;
        if (inner.k === "while" || inner.k === "do" || inner.k === "for") {
          this.pending = s.name;
          const r = this.b2Stmt(inner, loops);
          return [{ ...s, body: r[0]! }];
        }
        this.targets.push({ label: s.name, plain: true, loop: false, depth: this.frames.length });
        const r = this.b2Stmt(inner, loops);
        this.targets.pop();
        return [{ ...s, body: r.length === 1 ? r[0]! : { k: "block", body: r } }];
      }
      case "break":
        return [...this.exits(this.findTarget(s.label, false)), s];
      case "continue":
        return [...this.exits(this.findTarget(s.label, true)), s];
      case "return": {
        const rel = this.exits(0);
        if (s.val === null) return [...rel, s];
        const val = this.b2TE(s.val);
        if (rel.length === 0 || s.val.ty.k === "never") return [{ ...s, val }];
        const body: Stmt[] = [];
        const t = this.rawTemp(val, "$rv", body);
        return [{ k: "block", body: [...body, ...rel, { ...s, val: t }] }];
      }
      default:
        throw new Error(`rc: a ${s.k} statement in a down-lowered tree`);
    }
  }

  // --- one function

  func(f: FuncInst): void {
    this.fn = f;
    this.info = new Map();
    this.managed = new Map();
    this.moved = new Set();
    this.movedIn = new Map();
    this.paramOwned = new Set();
    this.nextId = 1;
    for (const p of f.params) {
      this.infoOf(p).param = true;
      if (p.id >= this.nextId) this.nextId = p.id + 1;
    }
    this.scanList(f.body, null, 0);
    this.decideAliases(f);
    for (const i of this.info.values()) {
      if (i.sh === null || i.alias) {
        if (i.alias) this.stats.localsBorrowed++;
        continue;
      }
      if (i.param) {
        // A parameter nobody assigns stays borrowed. One that's assigned needs a count to give up on assignment.
        if (i.defs.length === 0) {
          this.stats.localsBorrowed++;
          continue;
        }
        this.paramOwned.add(i.v);
      }
      // Without elision, every local holds a count, parameters too, as a caller's own would.
      this.managed.set(i.v, i.sh);
      this.stats.localsCounted++;
    }
    const entry: Stmt[] = [];
    for (const p of this.paramOwned) {
      const sh = this.managed.get(p)!;
      entry.push(this.incOf(mk(p.ty, { k: "var", v: p }, { sh }), sh));
    }
    const a = [...entry, ...this.stmts(f.body)];
    // Stage B: where each counted local lives.
    this.frames = [];
    this.scopeOf = new Map();
    this.scoped = new Map();
    this.knownNull = new Set();
    this.finalMove = new Set();
    this.targets = [];
    this.pending = null;
    this.b1List(a, 0);
    for (const [v, sc] of this.scopeOf) {
      const sh = this.managed.get(v)!;
      const top = sc.prefix[sc.prefix.length - 1]!;
      const list = this.scoped.get(top.list) ?? [];
      list.push({ v, sh, u: top.max });
      this.scoped.set(top.list, list);
      if (sc.assigns <= 1 && sc.assignLoops <= top.loops && !this.paramOwned.has(v)) {
        this.knownNull.add(v);
      }
    }
    f.body = this.b2List(a, 0);
  }
}

/** What each environment an allocation makes can hold: the type graph's edges, from what's really allocated. */
function allocEdges(funcs: FuncInst[]): Map<HeapNode, Shape[]> {
  const out = new Map<HeapNode, Shape[]>();
  const onTE = (te: TE): void => {
    if (te.k === "alloc" && te.rcRefs !== undefined) {
      const sh = countedOf(te.sh);
      if (sh !== null && sh.s !== "arr") {
        const n = findNode(sh.node);
        const edges = out.get(n) ?? [];
        for (const r of te.rcRefs()) edges.push(r.sh as Shape);
        out.set(n, edges);
      }
    }
    eachKid(te, onTE, onList);
  };
  const onList = (list: Stmt[]): void => {
    for (const s of list) eachStmtExpr(s, onTE, onList);
  };
  for (const f of funcs) onList(f.body);
  return out;
}

export function applyRc(funcs: FuncInst[], opts: RcOptions): RcResult {
  const p = new RcPass(opts);
  if (opts.cycles) {
    cycleClasses(allocEdges(funcs)).forEach((comp, i) => {
      for (const n of comp) p.scc.set(n, i);
    });
  }
  p.computeOverwriters(funcs);
  for (const f of funcs) p.func(f);
  if (p.words.length > RC_MAX_DESC_WORDS) {
    throw new Error(
      `rc: ${p.words.length} words of descriptors is more than the collector can tag`,
    );
  }
  let mapOn = false;
  for (const n of liveNodes()) {
    if (n.parent === null && n.kind === "arr" && n.long) mapOn = true;
  }
  return {
    descs: p.words,
    // The collector's way to everything live, for what it had to forget, only at exhaustion: it's how `mapOn` pays here.
    mapOn: mapOn || p.scc.size > 0,
    stats: p.stats,
    cycles: p.scc.size > 0,
    descOf: (n) => p.descOfNode(n),
  };
}

/** The classes that can reach themselves, by strong references: what `rc` can leak (SPEC 3.5). */
export function cycleClasses(extra?: Map<HeapNode, Shape[]>): HeapNode[][] {
  const nodes = liveNodes().filter((n) => n.parent === null && n.long);
  const out = new Map<HeapNode, HeapNode[]>();
  for (const n of nodes) {
    const edges: HeapNode[] = [];
    const add = (sh: Shape | null): void => {
      if (sh === null) return;
      const inner = sh.s === "opt" ? sh.of : sh;
      if (inner.s === "arr" || inner.s === "vec" || inner.s === "obj") {
        const t = findNode(inner.node);
        if (t.long) edges.push(t);
      }
    };
    // A runtime class whose `next` only ever points at something newer has that edge in its type, not in any object.
    for (const [name, f] of n.fields) if (n.chainOnly !== true || name !== "next") add(f);
    add(n.elem);
    for (const c of n.caps) add(c);
    if (n.chainOnly !== true) for (const c of extra?.get(n) ?? []) add(c);
    out.set(n, edges);
  }
  // An `unknown` can hold anything that flowed into it.
  for (const n of nodes) {
    for (const t0 of n.dynTargets ?? []) {
      const t = findNode(t0);
      if (t.long && out.has(t)) out.get(n)!.push(t);
    }
  }
  // Tarjan's algorithm, on an explicit stack of frames would be overkill: type graphs are small.
  let index = 0;
  const idx = new Map<HeapNode, number>();
  const low = new Map<HeapNode, number>();
  const on = new Set<HeapNode>();
  const stack: HeapNode[] = [];
  const sccs: HeapNode[][] = [];
  const visit = (v: HeapNode): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: HeapNode[] = [];
      for (;;) {
        const w = stack.pop()!;
        on.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1 || (out.get(v) ?? []).includes(v)) sccs.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  // A scan only follows a slot to a type with the barrier, and an `unknown` in a cycle can hold any of its targets: they're
  // in its class (D49).
  for (const comp of sccs) {
    const members = comp.length;
    for (let i = 0; i < members; i++) {
      const n = comp[i]!;
      for (const t0 of n.dynTargets ?? []) {
        const t = findNode(t0);
        if (t.long && !comp.includes(t) && !sccs.some((c) => c.includes(t))) comp.push(t);
      }
    }
  }
  return sccs;
}
