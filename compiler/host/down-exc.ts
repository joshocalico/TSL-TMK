// Exceptions in down-lowered code (SPEC 4.5, D49): `throw` of any value, `try`, `catch` and `finally`, turned into ordinary
// control flow before `rc` or TIR sees the tree, so neither knows exceptions exist.
//
// A thrown value is in flight in two words of module state: `__exc_on`, which says one is, and `__exc_val`, the `unknown` that
// was thrown, holding a count in `rc`. A function that throws, or lets a callee's exception through, stores those and
// returns zeros. Every call to a function that can throw is followed by a test of `__exc_on`, and a call to one that can't is
// followed by nothing: which can is a whole-program fixed point over the call graph, with `try` taken into account, so a
// function that catches everything it calls costs its callers nothing.
//
// A jump to the handler is a `break` to a label, and a propagation is a `return`, so `rc` releases what a frame holds on the
// way out, temporaries included, by the rules it already has for every jump. `finally` is a region every way out of passes
// through: a completion code says which way, the region runs, and the way out is taken again in the code around it, where
// an outer `finally` can catch it in turn.
import {
  T,
  type FuncInst,
  type Stmt,
  type TE,
  type TEK,
  type Ty,
  type Var,
  leaves,
} from "./types.ts";

export interface ExcOptions {
  // Test builds: a mistake, to show the tests catch it.
  fault?: "no-check" | "finally-late" | "no-release-path";
  faultAt?: number; // which site, for no-check
}

export interface ExcContext {
  dynSh: unknown; // the shape of an `unknown`
  /** Can a call through this closure value throw: any of the closures that can be here can. */
  closureThrows: (clo: TE, canThrow: Set<FuncInst>) => boolean;
  retShOf: (f: FuncInst) => unknown; // a function's result shape, for counts
  describe: FuncInst | null; // tmkExcDescribe, which an export reports an uncaught exception with
  overflow: FuncInst | null; // tmkStackOverflow: the RangeError a recursive function throws near the stack's end
  uncaughtCode: number; // the trap code an uncaught exception reports with, when the caller hasn't asked to take it
  opts: ExcOptions;
}

export interface ExcStats {
  functions: number; // that can throw
  checks: number; // tests of __exc_on after a call
  callsUnchecked: number; // calls to functions that can't throw: nothing after them
  wrappers: number; // exports that can throw, and so have a wrapper
  rounds: number;
  recursive?: number; // functions that test the stack on entry
}

export const EXC_GLOBALS = ["__exc_on", "__exc_val", "__exc_mode"];

const REF: Ty = { k: "ref" };

function mk(ty: Ty, node: TEK, extra?: Partial<TE>): TE {
  return { ty, ...node, ...extra } as TE;
}

const lit32 = (v: number): TE => mk(T.i32, { k: "lit", value: v }, { range: [v, v] });
const VOID: TE = mk(T.void, { k: "tuple", items: [] });
const gaddr = (name: string): TE => mk(REF, { k: "gaddr", name });

function zeroOf(ty: Ty): TE {
  const items = leaves(ty).map((t): TE => {
    switch (t) {
      case "ptr":
        return mk(REF, { k: "lit", value: 0 });
      case "ix":
        return mk(T.usize, { k: "lit", value: 0 });
      case "i64":
        return mk(T.i64, { k: "lit", value: 0n });
      case "f64":
        return mk(T.f64, { k: "lit", value: 0 });
      case "f32":
        return mk(T.f32, { k: "lit", value: 0 });
      default:
        return lit32(0);
    }
  });
  return mk(ty, { k: "tuple", items });
}

interface Target {
  label: string | null;
  loop: boolean;
  plain: boolean;
  fins: number; // how many `finally` regions enclose it
}

interface Fin {
  label: string; // breaking here leaves the region with the completion in `comp`
  comp: Var;
  rv: Var | null;
  rvSh: unknown;
  jumps: Stmt[]; // by completion code - 2: the way out, to take again after the region
  outer: Ctx;
}

interface Ctx {
  handler: string | null; // where an exception goes: a label, or null to propagate out of the function
  fins: Fin[]; // the `finally` regions this is in, innermost last
}

class Rewriter {
  fn: FuncInst;
  cx: ExcContext;
  canThrow: Set<FuncInst>;
  dry: boolean;
  propagates = false;
  nextId: number;
  nextLabel = 0;
  targets: Target[] = [];
  stats: ExcStats;
  site: { n: number };

  constructor(
    fn: FuncInst,
    cx: ExcContext,
    canThrow: Set<FuncInst>,
    dry: boolean,
    stats: ExcStats,
    site: { n: number },
  ) {
    this.fn = fn;
    this.cx = cx;
    this.canThrow = canThrow;
    this.dry = dry;
    this.stats = stats;
    this.site = site;
    this.nextId = maxVarId(fn) + 1;
  }

  newVar(ty: Ty, name: string): Var {
    return { id: this.nextId++, name, ty };
  }

  flag(): TE {
    return mk(T.i32, { k: "fload", base: gaddr("__exc_on"), mem: [{ t: "i32", off: 0 }] });
  }

  pending(): TE {
    return mk(T.bool, { k: "cmp", op: "ne", a: this.flag(), b: lit32(0) });
  }

  setFlag(v: number): Stmt {
    return {
      k: "expr",
      e: mk(T.i32, {
        k: "fstore",
        base: gaddr("__exc_on"),
        mem: [{ t: "i32", off: 0 }],
        val: lit32(v),
      }),
    };
  }

  /** Stores the thrown value: its count moves into module state. */
  setVal(val: TE): Stmt {
    return {
      k: "expr",
      e: mk(
        REF,
        { k: "fstore", base: gaddr("__exc_val"), mem: [{ t: "ptr", off: 0 }], val },
        { sh: this.cx.dynSh },
      ),
    };
  }

  readVal(): TE {
    return mk(
      REF,
      { k: "fload", base: gaddr("__exc_val"), mem: [{ t: "ptr", off: 0 }] },
      { sh: this.cx.dynSh },
    );
  }

  /** The exception in flight, into a local, and nothing in flight any more. */
  take(into: Var | null, out: Stmt[], fresh: boolean): void {
    if (into !== null) {
      const read = this.readVal();
      if (fresh) out.push({ k: "let", v: into, init: read, constant: false });
      else
        out.push({
          k: "expr",
          e: mk(REF, { k: "setvar", v: into, val: read }, { sh: this.cx.dynSh }),
        });
    }
    out.push(this.setVal(mk(REF, { k: "lit", value: 0 }, { sh: this.cx.dynSh })));
    out.push(this.setFlag(0));
  }

  /** Where an exception goes from here. */
  route(cx: Ctx): Stmt[] {
    if (cx.handler !== null) return [{ k: "break", label: cx.handler }];
    this.propagates = true;
    return [
      {
        k: "return",
        val: this.fn.ret.k === "void" || this.fn.ret.k === "never" ? null : zeroOf(this.fn.ret),
      },
    ];
  }

  /** At entry: below the caller's stack limit, throw what V8 throws. The limit is 0, and this never fires, unless set. */
  stackTest(): Stmt[] {
    const sp = mk(REF, { k: "intrinsic", name: "native.sp", args: [] });
    const limit = mk(REF, {
      k: "fload",
      base: gaddr("__exc_stack_limit"),
      mem: [{ t: "ptr", off: 0 }],
    });
    const make = mk(REF, { k: "call", inst: this.cx.overflow!, args: [] }, { sh: this.cx.dynSh });
    const body: Stmt[] = [
      this.setVal(make),
      this.setFlag(1),
      ...this.route({ handler: null, fins: [] }),
    ];
    return [{ k: "if", c: mk(T.bool, { k: "cmp", op: "lt", a: sp, b: limit }), a: body, b: null }];
  }

  callThrows(te: TE): boolean {
    if (te.k === "call") return this.canThrow.has(te.inst);
    if (te.k === "callclo") return this.cx.closureThrows(te.clo, this.canThrow);
    if (te.k === "callind") return true;
    return false;
  }

  // --- expressions

  x(te: TE, cx: Ctx): TE {
    switch (te.k) {
      case "raise": {
        const v = this.x(te.val, cx);
        const body: Stmt[] = [this.setVal(v), this.setFlag(1), ...this.route(cx)];
        return mk(T.never, { k: "blockexpr", body, result: VOID });
      }
      case "blockexpr":
        return { ...te, body: this.list(te.body, cx), result: this.x(te.result, cx) } as TE;
      case "call":
      case "callclo":
      case "callind": {
        const made = this.kids(te, cx);
        if (!this.callThrows(te)) {
          if (te.k === "call") this.stats.callsUnchecked++;
          return made;
        }
        if (!this.dry) this.stats.checks++;
        // A test build's missed check: the n'th call to a program's own function with a `throw` in it.
        if (te.k === "call" && direct.has(te.inst) && !this.dry) {
          const n = this.site.n++;
          if (this.cx.opts.fault === "no-check" && this.cx.opts.faultAt === n) {
            if (process.env.TMK_EXC_DEBUG !== undefined)
              console.error(
                `no-check at ${this.fn.tirName} -> ${te.k === "call" ? te.inst.tirName : ""}`,
              );
            return made;
          }
        }
        const never = te.k === "call" && te.inst.ret.k === "never";
        const body: Stmt[] = [];
        let result: TE = VOID;
        const leafy = leaves(te.ty).length > 0 && !never;
        if (leafy) {
          const v = this.newVar(te.ty, "$cr");
          body.push({ k: "let", v, init: made, constant: true });
          result = mk(
            te.ty,
            { k: "var", v },
            te.sh !== undefined ? { sh: te.sh, ...carry(te) } : carry(te),
          );
        } else body.push({ k: "expr", e: never ? ({ ...made, ty: T.void } as TE) : made });
        body.push({ k: "if", c: this.pending(), a: this.route(cx), b: null });
        if (never) {
          // It returned, so it threw: the test above has already left.
          body.push({
            k: "expr",
            e: mk(T.never, { k: "trapnow", kind: "exc", code: 10, loc: "never returned" }),
          });
          return mk(T.never, { k: "blockexpr", body, result: VOID });
        }
        return mk(te.ty, { k: "blockexpr", body, result }, carry(te));
      }
      default:
        return this.kids(te, cx);
    }
  }

  kids(te: TE, cx: Ctx): TE {
    return mapKidsAll(
      te,
      (c) => this.x(c, cx),
      (b) => this.list(b, cx),
    );
  }

  // --- statements

  list(list: Stmt[], cx: Ctx): Stmt[] {
    return list.flatMap((s) => this.stmt(s, cx));
  }

  findTarget(label: string | null, needLoop: boolean): Target {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== null ? t.label === label : !t.plain && (!needLoop || t.loop)) return t;
    }
    throw new Error(`exc: no target for ${label ?? "break"} in ${this.fn.tirName}`);
  }

  /** A way out that leaves a `finally` region: through the region, and taken again after it. */
  intercept(s: Stmt, cx: Ctx, pre: Stmt[]): Stmt[] {
    const fin = cx.fins[cx.fins.length - 1]!;
    fin.jumps.push(s);
    const code = fin.jumps.length + 1;
    return [
      ...pre,
      { k: "expr", e: mk(T.i32, { k: "setvar", v: fin.comp, val: lit32(code) }) },
      { k: "break", label: fin.label },
    ];
  }

  withTarget<R>(t: Target, f: () => R): R {
    this.targets.push(t);
    try {
      return f();
    } finally {
      this.targets.pop();
    }
  }

  stmt(s: Stmt, cx: Ctx): Stmt[] {
    const fins = cx.fins.length;
    switch (s.k) {
      case "let":
        return [s.init !== null ? { ...s, init: this.x(s.init, cx) } : s];
      case "expr":
        return [{ ...s, e: this.x(s.e, cx) }];
      case "if":
        return [
          {
            ...s,
            c: this.x(s.c, cx),
            a: this.list(s.a, cx),
            b: s.b !== null ? this.list(s.b, cx) : null,
          },
        ];
      case "while":
        return [
          this.withTarget({ label: null, loop: true, plain: false, fins }, () => ({
            ...s,
            c: this.x(s.c, cx),
            body: this.list(s.body, cx),
          })),
        ];
      case "do":
        return [
          this.withTarget({ label: null, loop: true, plain: false, fins }, () => ({
            ...s,
            body: this.list(s.body, cx),
            c: this.x(s.c, cx),
          })),
        ];
      case "for": {
        const init = this.list(s.init, cx);
        return [
          this.withTarget({ label: null, loop: true, plain: false, fins }, () => ({
            ...s,
            init,
            c: s.c !== null ? this.x(s.c, cx) : null,
            step: s.step.map((e) => this.x(e, cx)),
            body: this.list(s.body, cx),
          })),
        ];
      }
      case "forof":
        return [
          this.withTarget({ label: null, loop: true, plain: false, fins }, () => ({
            ...s,
            arr: this.x(s.arr, cx),
            body: this.list(s.body, cx),
          })),
        ];
      case "switch": {
        const val = this.x(s.val, cx);
        return [
          this.withTarget({ label: null, loop: false, plain: false, fins }, () => ({
            ...s,
            val,
            clauses: s.clauses.map((c) => ({ ...c, body: this.list(c.body, cx) })),
          })),
        ];
      }
      case "block":
        return [{ ...s, body: this.list(s.body, cx) }];
      case "label": {
        const inner = s.body;
        const loop =
          inner.k === "while" || inner.k === "do" || inner.k === "for" || inner.k === "forof";
        if (loop) {
          // The loop's own target carries the label.
          this.targets.push({ label: s.name, loop: true, plain: false, fins });
          const saved = this.targets.length;
          const r = this.stmt(inner, cx);
          void saved;
          this.targets.pop();
          // The loop pushed and popped its own unlabelled target inside; `continue label` found the labelled one.
          return [{ ...s, body: r.length === 1 ? r[0]! : { k: "block", body: r } }];
        }
        return [
          this.withTarget({ label: s.name, loop: false, plain: true, fins }, () => {
            const r = this.stmt(inner, cx);
            return { ...s, body: r.length === 1 ? r[0]! : ({ k: "block", body: r } as Stmt) };
          }),
        ];
      }
      case "break":
      case "continue": {
        const t = this.findTarget(s.label, s.k === "continue");
        if (t.fins < fins) return this.intercept(s, cx, []);
        return [s];
      }
      case "return": {
        if (fins === 0) return [{ ...s, val: s.val !== null ? this.x(s.val, cx) : null }];
        const fin = cx.fins[fins - 1]!;
        if (s.val === null) return this.intercept(s, cx, []);
        const v = this.x(s.val, cx);
        if (v.ty.k === "never") return [{ k: "expr", e: v }];
        if (fin.rv === null) {
          fin.rv = this.newVar(this.fn.ret, "$rv");
          fin.rvSh = v.sh;
        }
        const rv = fin.rv;
        const read = mk(rv.ty, { k: "var", v: rv }, v.sh !== undefined ? { sh: v.sh } : undefined);
        return this.intercept({ k: "return", val: read }, cx, [
          {
            k: "expr",
            e: mk(
              rv.ty,
              { k: "setvar", v: rv, val: v },
              v.sh !== undefined ? { sh: v.sh } : undefined,
            ),
          },
        ]);
      }
      case "try":
        return this.tryStmt(s, cx);
      default:
        throw new Error(`exc: a ${s.k} statement in a down-lowered tree`);
    }
  }

  label(kind: string): string {
    return `$ex${kind}${this.nextLabel++}`;
  }

  tryStmt(s: Extract<Stmt, { k: "try" }>, cx: Ctx): Stmt[] {
    const out: Stmt[] = [];
    if (s.fin === null) {
      // try/catch: the body's exceptions go to the end of its label, where the catch takes the one in flight.
      const lb = this.label("b");
      const before = this.propagates;
      const used = { hit: false };
      const body = this.withTarget(
        { label: lb, loop: false, plain: true, fins: cx.fins.length },
        () => this.list(s.body, { handler: lb, fins: cx.fins }),
      );
      used.hit = mentionsBreak(body, lb);
      this.propagates = before || this.propagates;
      out.push({ k: "label", name: lb, body: { k: "block", body } });
      if (used.hit && s.handler !== null) {
        const c: Stmt[] = [];
        this.take(s.cv, c, true);
        c.push(...this.list(s.handler, cx));
        out.push({ k: "if", c: this.pending(), a: c, b: null });
      }
      return out;
    }
    const comp = this.newVar(T.i32, "$comp");
    const held = this.newVar(REF, "$x");
    out.push({ k: "let", v: comp, init: lit32(0), constant: false });
    out.push({
      k: "let",
      v: held,
      init: mk(REF, { k: "lit", value: 0 }, { sh: this.cx.dynSh }),
      constant: false,
    });
    const lf = this.label("f");
    const fin: Fin = { label: lf, comp, rv: null, rvSh: undefined, jumps: [], outer: cx };
    const inner: Ctx = { handler: lf, fins: [...cx.fins, fin] };
    const region: Stmt[] = [];
    this.withTarget({ label: lf, loop: false, plain: true, fins: cx.fins.length }, () => {
      if (s.handler !== null) {
        const lb = this.label("b");
        const body = this.withTarget(
          { label: lb, loop: false, plain: true, fins: inner.fins.length },
          () => this.list(s.body, { handler: lb, fins: inner.fins }),
        );
        region.push({ k: "label", name: lb, body: { k: "block", body } });
        if (mentionsBreak(body, lb)) {
          const c: Stmt[] = [];
          this.take(s.cv, c, true);
          c.push(...this.list(s.handler, inner));
          region.push({ k: "if", c: this.pending(), a: c, b: null });
        }
      } else region.push(...this.list(s.body, inner));
    });
    if (fin.rv !== null) out.push({ k: "let", v: fin.rv, init: null, constant: false });
    out.push({ k: "label", name: lf, body: { k: "block", body: region } });
    const threw = mentionsBreak(region, lf) && regionCanRaise(region, lf);
    if (threw) {
      const t: Stmt[] = [];
      this.take(held, t, false);
      t.push({ k: "expr", e: mk(T.i32, { k: "setvar", v: comp, val: lit32(1) }) });
      out.push({ k: "if", c: this.pending(), a: t, b: null });
    }
    const finally_ = this.list(s.fin, cx);
    const dispatch: Stmt[] = [];
    if (threw) {
      dispatch.push({
        k: "if",
        c: mk(T.bool, { k: "cmp", op: "eq", a: mk(T.i32, { k: "var", v: comp }), b: lit32(1) }),
        a: [
          this.setVal(mk(REF, { k: "var", v: held }, { sh: this.cx.dynSh })),
          this.setFlag(1),
          ...this.route(cx),
        ],
        b: null,
      });
    }
    fin.jumps.forEach((j, i) => {
      dispatch.push({
        k: "if",
        c: mk(T.bool, { k: "cmp", op: "eq", a: mk(T.i32, { k: "var", v: comp }), b: lit32(i + 2) }),
        a: this.stmt(j, cx),
        b: null,
      });
    });
    if (this.cx.opts.fault === "finally-late") out.push(...dispatch, ...finally_);
    else out.push(...finally_, ...dispatch);
    return out;
  }
}

/** Whether a `break` to this label appears in these statements. */
function mentionsBreak(list: Stmt[], label: string): boolean {
  let found = false;
  const onStmt = (s: Stmt): void => {
    if (found) return;
    if (s.k === "break" && s.label === label) {
      found = true;
      return;
    }
    eachStmt(s, onTE, (b) => b.forEach(onStmt));
  };
  const onTE = (te: TE): void => {
    if (found) return;
    eachKidAll(te, onTE, (b) => b.forEach(onStmt));
  };
  list.forEach(onStmt);
  return found;
}

/** A `break` to the region's label that isn't a jump's: an exception's route, which leaves `__exc_on` set. */
function regionCanRaise(list: Stmt[], label: string): boolean {
  // Interception sets the completion code just before its break; every other break to the label is an exception's.
  let found = false;
  const onList = (b: Stmt[]): void => {
    b.forEach((s, i) => {
      if (found) return;
      if (s.k === "break" && s.label === label) {
        const prev = b[i - 1];
        const isJump = prev?.k === "expr" && prev.e.k === "setvar" && prev.e.v.name === "$comp";
        if (!isJump) found = true;
        return;
      }
      eachStmt(s, onTE, onList);
    });
  };
  const onTE = (te: TE): void => {
    if (!found) eachKidAll(te, onTE, onList);
  };
  onList(list);
  return found;
}

function carry(te: TE): Partial<TE> {
  const extra: Partial<TE> = {};
  if (te.sh !== undefined) extra.sh = te.sh;
  if (te.range !== undefined) extra.range = te.range;
  if (te.deps !== undefined) extra.deps = te.deps;
  if (te.negz === true) extra.negz = true;
  return extra;
}

function maxVarId(f: FuncInst): number {
  let m = 0;
  const v = (x: Var): void => {
    if (x.id > m) m = x.id;
  };
  f.params.forEach(v);
  const onStmt = (s: Stmt): void => {
    if (s.k === "let") v(s.v);
    if (s.k === "try" && s.cv !== null) v(s.cv);
    eachStmt(s, onTE, (b) => b.forEach(onStmt));
  };
  const onTE = (te: TE): void => {
    if (te.k === "var" || te.k === "setvar") v(te.v);
    eachKidAll(te, onTE, (b) => b.forEach(onStmt));
  };
  f.body.forEach(onStmt);
  return m;
}

// --- generic traversal, every kind a down-lowered tree has

export function mapKidsAll(te: TE, f: (c: TE) => TE, g: (b: Stmt[]) => Stmt[]): TE {
  switch (te.k) {
    case "lit":
    case "var":
    case "global":
    case "fnref":
    case "gaddr":
    case "trapnow":
    case "err":
    case "closure":
      return te;
    case "index":
    case "optindex":
      return { ...te, arr: f(te.arr), idx: f(te.idx) };
    case "len":
      return { ...te, arr: f(te.arr) };
    case "tableget":
      return { ...te, idx: f(te.idx) };
    case "arith":
    case "farith":
    case "bigshift":
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
    case "setglobal":
      return { ...te, val: f(te.val) };
    case "setindex":
      return { ...te, arr: f(te.arr), idx: f(te.idx), val: f(te.val) };
    case "seq":
      return { ...te, items: te.items.map(f), result: f(te.result) };
    case "call":
    case "builtin":
    case "rtcall":
    case "intrinsic":
    case "throwjs":
      return { ...te, args: te.args.map(f) };
    case "callind":
      return { ...te, fn: f(te.fn), args: te.args.map(f) };
    case "callclo":
      return { ...te, clo: f(te.clo), args: te.args.map(f) };
    case "conv":
    case "f2ix":
    case "nonnull":
    case "slice":
    case "isundef":
    case "optpayload":
    case "chkref":
      return { ...te, val: f(te.val) };
    case "raise":
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
    case "blockexpr":
      return { ...te, body: g(te.body), result: f(te.result) };
    case "record":
      return { ...te, fields: te.fields.map((x) => ({ ...x, val: f(x.val) })) };
    case "ulit":
      return { ...te, fields: te.fields.map((x) => ({ ...x, val: f(x.val) })) };
    case "field":
      return { ...te, obj: f(te.obj) };
    case "ofield":
      return { ...te, obj: f(te.obj) };
    case "osetfield":
      return { ...te, obj: f(te.obj), val: f(te.val) };
    case "new":
      return {
        ...te,
        args: te.args.map(f),
        init: te.init.map((i) => ({ ...i, val: f(i.val) })),
        into: te.into !== null ? { ...te.into, obj: f(te.into.obj) } : null,
      };
  }
}

export function eachKidAll(te: TE, f: (c: TE) => void, g: (b: Stmt[]) => void): void {
  mapKidsAll(
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

export function eachStmt(s: Stmt, f: (e: TE) => void, g: (b: Stmt[]) => void): void {
  switch (s.k) {
    case "let":
      if (s.init !== null) f(s.init);
      return;
    case "expr":
      f(s.e);
      return;
    case "using":
      if (s.dispose !== null) f(s.dispose);
      return;
    case "if":
      f(s.c);
      g(s.a);
      if (s.b !== null) g(s.b);
      return;
    case "while":
      f(s.c);
      g(s.body);
      return;
    case "do":
      g(s.body);
      f(s.c);
      return;
    case "for":
      g(s.init);
      if (s.c !== null) f(s.c);
      s.step.forEach(f);
      g(s.body);
      return;
    case "forof":
      f(s.arr);
      g(s.body);
      return;
    case "switch":
      f(s.val);
      for (const c of s.clauses) {
        c.keys.forEach(f);
        g(c.body);
      }
      return;
    case "block":
      g(s.body);
      return;
    case "label":
      g([s.body]);
      return;
    case "return":
      if (s.val !== null) f(s.val);
      return;
    case "try":
      g(s.body);
      if (s.handler !== null) g(s.handler);
      if (s.fin !== null) g(s.fin);
      return;
    default:
      return;
  }
}

/** Whether a tree has anything for this pass to do. */
export function usesExceptions(funcs: FuncInst[]): boolean {
  let found = false;
  const onStmt = (s: Stmt): void => {
    if (found) return;
    if (s.k === "try") {
      found = true;
      return;
    }
    eachStmt(s, onTE, (b) => b.forEach(onStmt));
  };
  const onTE = (te: TE): void => {
    if (found) return;
    if (te.k === "raise") {
      found = true;
      return;
    }
    eachKidAll(te, onTE, (b) => b.forEach(onStmt));
  };
  for (const f of funcs) f.body.forEach(onStmt);
  return found;
}

/**
 * Rewrites every function, and gives each export that can throw a wrapper: what a native caller calls (D36). With the
 * caller's `__exc_catch_use(1)`, it returns zeros with the exception in flight for `__exc_take`; otherwise an uncaught
 * exception is the trap path, as `throw` was before, reported with the value's description.
 */
/** The program's own functions with a `throw` in them, where a test build's missed check is put. */
const direct = new Set<FuncInst>();

export function applyExc(
  funcs: FuncInst[],
  cx: ExcContext,
): { funcs: FuncInst[]; stats: ExcStats } {
  direct.clear();
  for (const f of funcs) {
    if (f.key.includes("/compiler/rt/")) continue;
    let found = false;
    const onStmt = (s: Stmt): void => eachStmt(s, onTE, (b) => b.forEach(onStmt));
    const onTE = (te: TE): void => {
      if (te.k === "raise") found = true;
      eachKidAll(te, onTE, (b) => b.forEach(onStmt));
    };
    f.body.forEach(onStmt);
    if (found) direct.add(f);
  }
  const stats: ExcStats = { functions: 0, checks: 0, callsUnchecked: 0, wrappers: 0, rounds: 0 };
  const canThrow = new Set<FuncInst>();
  // Which functions can let an exception out: rises until it settles.
  for (let round = 1; round <= 1000; round++) {
    stats.rounds = round;
    let changed = false;
    for (const f of funcs) {
      if (canThrow.has(f)) continue;
      const r = new Rewriter(f, cx, canThrow, true, stats, { n: 0 });
      r.list(f.body, { handler: null, fins: [] });
      if (r.propagates) {
        canThrow.add(f);
        changed = true;
      }
    }
    if (!changed) break;
    if (round === 1000) throw new Error("exc: which functions can throw didn't settle");
  }
  // A function in a cycle of calls tests the stack on entry, and throws RangeError where V8 would (3.10).
  const recursive = cx.overflow !== null ? recursiveFuncs(funcs) : new Set<FuncInst>();
  recursive.delete(cx.overflow!);
  for (const f of recursive) canThrow.add(f);
  for (let round = 1; round <= 1000; round++) {
    let changed = false;
    for (const f of funcs) {
      if (canThrow.has(f)) continue;
      const r = new Rewriter(f, cx, canThrow, true, stats, { n: 0 });
      r.list(f.body, { handler: null, fins: [] });
      if (r.propagates) {
        canThrow.add(f);
        changed = true;
      }
    }
    if (!changed) break;
  }
  stats.functions = canThrow.size;
  stats.recursive = recursive.size;
  stats.callsUnchecked = 0;
  const site = { n: 0 };
  const out: FuncInst[] = [];
  for (const f of funcs) {
    const r = new Rewriter(f, cx, canThrow, false, stats, site);
    const body = r.list(f.body, { handler: null, fins: [] });
    f.body = recursive.has(f) ? [...r.stackTest(), ...body] : body;
    // It returns when it throws, so it isn't `never` any more.
    if (canThrow.has(f) && f.ret.k === "never") f.ret = T.void;
    out.push(f);
  }
  for (const f of funcs) {
    if (!f.exported || !canThrow.has(f)) continue;
    out.push(wrapper(f, cx));
    stats.wrappers++;
  }
  return { funcs: out, stats };
}

function wrapper(f: FuncInst, cx: ExcContext): FuncInst {
  const name = f.tirName;
  const params = f.params.map((p, i): Var => ({ id: i + 1, name: p.name, ty: p.ty }));
  let next = params.length + 1;
  const w: FuncInst = {
    ...f,
    tirName: name,
    params,
    attrs: [...f.attrs],
    body: [],
  };
  f.tirName = `${name}$x`;
  f.exported = false;
  f.attrs = f.attrs.filter((a) => a !== "export");
  const sh = cx.retShOf(f);
  const call = mk(
    f.ret,
    { k: "call", inst: f, args: params.map((p) => mk(p.ty, { k: "var", v: p })) },
    sh !== undefined ? { sh } : undefined,
  );
  const flag = mk(T.i32, { k: "fload", base: gaddr("__exc_on"), mem: [{ t: "i32", off: 0 }] });
  const mode = mk(T.i32, { k: "fload", base: gaddr("__exc_mode"), mem: [{ t: "i32", off: 0 }] });
  const uncaught: Stmt[] = [];
  if (cx.describe !== null) {
    const val = mk(
      REF,
      { k: "fload", base: gaddr("__exc_val"), mem: [{ t: "ptr", off: 0 }] },
      { sh: cx.dynSh },
    );
    // Taken out of flight first: describing it runs code that tests the flag after its own calls.
    const held: Var = { id: next++, name: "$u", ty: REF };
    uncaught.push(
      { k: "let", v: held, init: val, constant: true },
      {
        k: "expr",
        e: mk(
          REF,
          {
            k: "fstore",
            base: gaddr("__exc_val"),
            mem: [{ t: "ptr", off: 0 }],
            val: mk(REF, { k: "lit", value: 0 }, { sh: cx.dynSh }),
          },
          { sh: cx.dynSh },
        ),
      },
      {
        k: "expr",
        e: mk(T.i32, {
          k: "fstore",
          base: gaddr("__exc_on"),
          mem: [{ t: "i32", off: 0 }],
          val: lit32(0),
        }),
      },
    );
    const text = mk(
      REF,
      { k: "call", inst: cx.describe, args: [mk(REF, { k: "var", v: held }, { sh: cx.dynSh })] },
      { sh: cx.retShOf(cx.describe) },
    );
    uncaught.push({
      k: "expr",
      e: mk(T.never, {
        k: "throwjs",
        args: [text],
        msg: JSON.stringify({ ctor: "$uncaught", parts: [{ a: 0, k: "s" }] }),
        code: cx.uncaughtCode,
        loc: "uncaught",
      }),
    });
  }
  const test = mk(T.bool, {
    k: "logic",
    op: "and",
    a: mk(T.bool, { k: "cmp", op: "ne", a: flag, b: lit32(0) }),
    b: mk(T.bool, { k: "cmp", op: "eq", a: mode, b: lit32(0) }),
  });
  if (f.ret.k === "void") {
    w.body = [
      { k: "expr", e: call },
      { k: "if", c: test, a: uncaught, b: null },
      { k: "return", val: null },
    ];
  } else {
    const r: Var = { id: next++, name: "$r", ty: f.ret };
    const read = mk(f.ret, { k: "var", v: r }, sh !== undefined ? { sh } : undefined);
    w.body = [
      { k: "let", v: r, init: call, constant: true },
      { k: "if", c: test, a: uncaught, b: null },
      { k: "return", val: read },
    ];
  }
  return w;
}

/** Functions in a cycle of direct calls, the only way a lowered program recurses without a closure. */
function recursiveFuncs(funcs: FuncInst[]): Set<FuncInst> {
  const callees = new Map<FuncInst, Set<FuncInst>>();
  for (const f of funcs) {
    const out = new Set<FuncInst>();
    const onStmt = (s: Stmt): void => eachStmt(s, onTE, (b) => b.forEach(onStmt));
    const onTE = (te: TE): void => {
      if (te.k === "call") out.add(te.inst);
      eachKidAll(te, onTE, (b) => b.forEach(onStmt));
    };
    f.body.forEach(onStmt);
    callees.set(f, out);
  }
  const rec = new Set<FuncInst>();
  let index = 0;
  const idx = new Map<FuncInst, number>();
  const low = new Map<FuncInst, number>();
  const on = new Set<FuncInst>();
  const stack: FuncInst[] = [];
  const visit = (v: FuncInst): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of callees.get(v) ?? []) {
      if (!callees.has(w)) continue;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: FuncInst[] = [];
      for (;;) {
        const w = stack.pop()!;
        on.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1 || callees.get(v)!.has(v)) for (const c of comp) rec.add(c);
    }
  };
  for (const f of funcs) if (!idx.has(f)) visit(f);
  return rec;
}
