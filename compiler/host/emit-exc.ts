// Class printing's own desugaring of exceptions (SPEC 4.5, D49, D68, design/pipeline.md section 0, item 3): `throw`, `try`,
// `catch` and `finally` in the lowered tree, before down-exc.ts saw it, made into the ordinary TSL that the printer then
// prints. It's the second implementation, written apart from down-exc.ts, so that the dual route compares two: the direct
// route's TIR comes from that one, and the TSL route's from this one, through tslc.
//
// The shape the owner approved, as it reads in the TSL:
//   - One exception in flight is two pieces of module state, `__exc_on: bool` and `__exc_val: Dyn | null`, the value as
//     the program's one class of `unknown` values (D68).
//   - `throw v` is `__exc_val = v; __exc_on = true;` and the way out: a `break` to the handler's label, or a return.
//   - After each call to a function that can throw, `if (__exc_on) …` takes the same way out. A call to one that can't
//     has nothing after it: which can is a fixed point over the call graph, with `try` taken into account.
//   - `try { … } catch (e) { … }` is a labelled block, `$try1: { … }`, which a throw in it breaks out of; after it,
//     `if (__exc_on) { const e = __exc_val; __exc_val = null; __exc_on = false; … }`.
//   - `finally` is a labelled block every way out of passes through, with a completion code: 0 done, 1 an exception
//     held in a local, and from 2 a `break`, `continue` or `return` that left it, taken again after the `finally` code,
//     where an outer `finally` can catch it in turn.
// A label on a plain block is TS and TSL as it is (tslc's checker takes `l: { … break l; }`), so no `do … while (false)`.
import type { ExcSource } from "./down.ts";
import { eachKidAll, eachStmt, mapKidsAll } from "./down-exc.ts";
import { newLoc } from "./down-model.ts";
import {
  T,
  leaves,
  type FuncInst,
  type Stmt,
  type TE,
  type TEK,
  type Ty,
  type Var,
} from "./types.ts";

/** Bugs put into this desugaring for the tests (TMK_TEST_EMIT), each of which the dual route has to catch. */
export const EXC_FAULTS: { name: string; what: string }[] = [
  {
    name: "exc-finally-late",
    what: "a finally run in the wrong order: the way out taken again before the finally code, not after it",
  },
  {
    name: "exc-no-check",
    what: "a missed flag check: nothing after the first call, in each program, to one of its own functions that throws",
  },
  {
    name: "exc-rethrow-lost",
    what: "a rethrow that loses the original value: an exception held across a finally thrown again as undefined",
  },
  {
    // pipe-h: the printer's `unknown` class shares storage between the classes it can hold (emit-tsl.ts, dynSlots).
    name: "dyn-slot-own",
    what: "an unknown's class sharing storage within one class it holds: two fields of one type of the same class in one field",
  },
];

const REF: Ty = { k: "ref" };
const VOID: TE = mk(T.void, { k: "tuple", items: [] });
/** Not a TIR intrinsic: class printing prints it as the stack test, the stack pointer against the caller's limit. */
export const STACK_LOW = "$exc.stackLow";
/** The module state and the native caller's functions that this desugaring prints (4.5's ABI, D36). */
export const EXC_STATE = ["__exc_on", "__exc_val", "__exc_mode", "__exc_stack_limit"];
export const EXC_ABI = ["__exc_catch_use", "__exc_stack_use", "__exc_pending", "__exc_take"];

function mk(ty: Ty, node: TEK, extra?: Partial<TE>): TE {
  return { ty, ...node, ...extra } as TE;
}

const gaddr = (name: string): TE => mk(REF, { k: "gaddr", name });

interface Target {
  label: string | null;
  loop: boolean;
  plain: boolean; // a labelled block: only a `break` naming it
  fins: number; // how many finally regions are around it
}

interface Fin {
  label: string;
  comp: Var;
  rv: Var | null;
  jumps: Stmt[]; // the way out for completion code i + 2, to take again after the finally code
  raised: boolean; // an exception can reach its end
}

interface Cx {
  handler: string | null; // the label an exception breaks to; null: out of the function
  fins: Fin[]; // innermost last
}

export interface ExcPrinted {
  funcs: FuncInst[];
  restore: () => void;
  stats: { throwing: number; checks: number; wrappers: number; recursive: number };
}

/** Which functions call which, directly. */
function calleesOf(funcs: FuncInst[]): Map<FuncInst, Set<FuncInst>> {
  const out = new Map<FuncInst, Set<FuncInst>>();
  for (const f of funcs) {
    const set = new Set<FuncInst>();
    const onStmt = (s: Stmt): void => eachStmt(s, onTE, (b) => b.forEach(onStmt));
    const onTE = (te: TE): void => {
      if (te.k === "call") set.add(te.inst);
      eachKidAll(te, onTE, (b) => b.forEach(onStmt));
    };
    f.body.forEach(onStmt);
    out.set(f, set);
  }
  return out;
}

/** Whether an exception can leave these statements uncaught, given which functions can let one out. */
function leaks(list: Stmt[], caught: boolean, can: Set<FuncInst>): boolean {
  for (const s of list) {
    if (s.k === "try") {
      if (leaks(s.body, caught || s.handler !== null, can)) return true;
      if (s.handler !== null && leaks(s.handler, caught, can)) return true;
      if (s.fin !== null && leaks(s.fin, caught, can)) return true;
      continue;
    }
    let found = false;
    const onTE = (te: TE): void => {
      if (found) return;
      if (te.k === "raise" && !caught) found = true;
      if (te.k === "call" && can.has(te.inst) && !caught) found = true;
      if ((te.k === "callclo" || te.k === "callind") && !caught) found = true;
      eachKidAll(te, onTE, (b) => {
        if (!found && leaks(b, caught, can)) found = true;
      });
    };
    eachStmt(s, onTE, (b) => {
      if (!found && leaks(b, caught, can)) found = true;
    });
    if (found) return true;
  }
  return false;
}

/** Whether a rebuilt node has the same children as the one it was made from, one level down. */
function sameKids(a: TE, b: TE): boolean {
  const same = (x: unknown, y: unknown): boolean => {
    if (x === y) return true;
    if (Array.isArray(x) && Array.isArray(y))
      return x.length === y.length && x.every((v, i) => same1(v, y[i]));
    return same1(x, y);
  };
  const same1 = (x: unknown, y: unknown): boolean => {
    if (x === y) return true;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (Array.isArray(x) || Array.isArray(y)) return false;
    const kx = Object.keys(x);
    return (
      kx.length === Object.keys(y).length &&
      kx.every((k) => (x as Record<string, unknown>)[k] === (y as Record<string, unknown>)[k])
    );
  };
  const ka = Object.keys(a) as (keyof TE)[];
  return ka.length === Object.keys(b).length && ka.every((k) => same(a[k], b[k]));
}

function hasRaise(list: Stmt[]): boolean {
  let found = false;
  const onStmt = (s: Stmt): void => eachStmt(s, onTE, (b) => b.forEach(onStmt));
  const onTE = (te: TE): void => {
    if (te.k === "raise") found = true;
    if (!found) eachKidAll(te, onTE, (b) => b.forEach(onStmt));
  };
  list.forEach(onStmt);
  return found;
}

function maxVarId(f: FuncInst): number {
  let m = 0;
  const v = (x: Var): void => {
    if (x.id > m) m = x.id;
  };
  f.params.forEach(v);
  const onStmt = (s: Stmt): void => {
    if (s.k === "let" || s.k === "forof") v(s.v);
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

function zero(ty: Ty): TE | null {
  if (ty.k === "void" || ty.k === "never") return null;
  if (ty.k === "ref") return mk(REF, { k: "lit", value: 0 });
  if (ty.k === "bool") return mk(T.bool, { k: "lit", value: false });
  if (ty.k === "int" || ty.k === "float") return mk(ty, { k: "lit", value: 0 });
  if (ty.k === "big") return mk(ty, { k: "lit", value: 0n });
  // Several leaves: what the lowering's tuples of leaves print as.
  const items = leaves(ty).map((t): TE =>
    t === "ptr"
      ? mk(REF, { k: "lit", value: 0 })
      : t === "ix"
        ? mk(T.usize, { k: "lit", value: 0 })
        : t === "i64"
          ? mk(T.i64, { k: "lit", value: 0n })
          : t === "f64"
            ? mk(T.f64, { k: "lit", value: 0 })
            : t === "f32"
              ? mk(T.f32, { k: "lit", value: 0 })
              : mk(T.i32, { k: "lit", value: 0 }),
  );
  return mk(ty, { k: "tuple", items });
}

/**
 * The program with its exceptions desugared, for class printing: each function as it was before down-exc.ts, rewritten,
 * and a wrapper for each export that can throw, as the native caller's ABI has (D36). `restore` puts back what the
 * direct route has, which the functions are shared with.
 */
export function desugarExc(src: ExcSource, fault: string | undefined): ExcPrinted {
  const saved = src.funcs.map((x) => ({ f: x.f, now: { ...x.f } }));
  const restore = (): void => {
    for (const s of saved) Object.assign(s.f, s.now);
  };
  for (const x of src.funcs)
    Object.assign(x.f, {
      body: x.pre.body,
      ret: x.pre.ret,
      tirName: x.pre.tirName,
      jsName: x.pre.jsName,
      exported: x.pre.exported,
      attrs: [...x.pre.attrs],
    });
  try {
    return { ...new Desugar(src, fault).run(), restore };
  } catch (e) {
    restore();
    throw e;
  }
}

class Desugar {
  src: ExcSource;
  fault: string | undefined;
  funcs: FuncInst[];
  can = new Set<FuncInst>();
  recursive = new Set<FuncInst>();
  own = new Set<FuncInst>(); // the program's own functions with a throw in them, for the missed-check bug
  missed = false;
  checks = 0;
  // Per function:
  f!: FuncInst;
  nextId = 0;
  nextLabel = 1;
  targets: Target[] = [];

  constructor(src: ExcSource, fault: string | undefined) {
    this.src = src;
    this.fault = fault;
    this.funcs = src.funcs.map((x) => x.f);
  }

  run(): Omit<ExcPrinted, "restore"> {
    const callees = calleesOf(this.funcs);
    // In a cycle of calls: tests the stack on entry, and throws V8's RangeError near its end (3.10).
    if (this.src.overflow !== null)
      for (const f of this.funcs) {
        if (f === this.src.overflow) continue;
        const seen = new Set<FuncInst>();
        const todo = [...(callees.get(f) ?? [])];
        while (todo.length > 0) {
          const g = todo.pop()!;
          if (g === f) {
            this.recursive.add(f);
            break;
          }
          if (seen.has(g) || !callees.has(g)) continue;
          seen.add(g);
          todo.push(...callees.get(g)!);
        }
      }
    for (const f of this.recursive) this.can.add(f);
    for (let round = 0, changed = true; changed; round++) {
      if (round > 1000) throw new Error("emit-exc: which functions can throw didn't settle");
      changed = false;
      for (const f of this.funcs)
        if (!this.can.has(f) && leaks(f.body, false, this.can)) {
          this.can.add(f);
          changed = true;
        }
    }
    for (const f of this.funcs)
      if (!f.key.includes("/compiler/rt/") && hasRaise(f.body)) this.own.add(f);
    // It returns when it throws, so it isn't `never` any more.
    for (const f of this.can) if (f.ret.k === "never") f.ret = T.void;
    for (const f of this.funcs) {
      this.f = f;
      this.nextId = maxVarId(f) + 1;
      this.targets = [];
      const body = this.list(f.body, { handler: null, fins: [] });
      f.body = this.recursive.has(f) ? [...this.stackTest(), ...body] : body;
    }
    const wrappers: FuncInst[] = [];
    for (const f of this.funcs) if (f.exported && this.can.has(f)) wrappers.push(this.wrapper(f));
    return {
      funcs: [...this.funcs, ...wrappers],
      stats: {
        throwing: this.can.size,
        checks: this.checks,
        wrappers: wrappers.length,
        recursive: this.recursive.size,
      },
    };
  }

  newVar(ty: Ty, name: string): Var {
    return { id: this.nextId++, name, ty };
  }

  // --- the module state

  on(): TE {
    return mk(
      T.bool,
      { k: "fload", base: gaddr("__exc_on"), mem: [{ t: "i32", off: 0 }] },
      { glob: { name: "__exc_on", sh: { s: "bool" } } },
    );
  }

  setOn(b: boolean): Stmt {
    const val = mk(T.bool, { k: "lit", value: b });
    return {
      k: "expr",
      e: mk(
        T.bool,
        { k: "fstore", base: gaddr("__exc_on"), mem: [{ t: "i32", off: 0 }], val },
        { glob: { name: "__exc_on", sh: { s: "bool" } } },
      ),
    };
  }

  val(): TE {
    return mk(
      REF,
      { k: "fload", base: gaddr("__exc_val"), mem: [{ t: "ptr", off: 0 }] },
      { sh: this.src.dynSh, glob: { name: "__exc_val", sh: this.src.dynSh } },
    );
  }

  setVal(v: TE): Stmt {
    return {
      k: "expr",
      e: mk(
        REF,
        { k: "fstore", base: gaddr("__exc_val"), mem: [{ t: "ptr", off: 0 }], val: v },
        { sh: this.src.dynSh, glob: { name: "__exc_val", sh: this.src.dynSh } },
      ),
    };
  }

  none(): TE {
    return mk(REF, { k: "lit", value: 0 }, { sh: this.src.dynSh });
  }

  /** `throw v`, once `v` is worked out: in flight, and out. */
  throwing(v: TE, cx: Cx): Stmt[] {
    return [this.setVal(v), this.setOn(true), ...this.out(cx)];
  }

  /** The way out for an exception from here, noting a finally region it reaches. */
  out(cx: Cx): Stmt[] {
    if (cx.handler === null) {
      const z = zero(this.f.ret);
      return [{ k: "return", val: z }];
    }
    for (const fin of cx.fins) if (fin.label === cx.handler) fin.raised = true;
    return [{ k: "break", label: cx.handler }];
  }

  /** The exception in flight, into a fresh local (or nowhere), and nothing in flight. */
  take(into: Var | null, fresh: boolean): Stmt[] {
    const out: Stmt[] = [];
    if (into !== null) {
      if (fresh) out.push({ k: "let", v: into, init: this.val(), constant: false });
      else
        out.push({
          k: "expr",
          e: mk(REF, { k: "setvar", v: into, val: this.val() }, { sh: this.src.dynSh }),
        });
    }
    // R11's injected `r11-catch-kept` bug: a caught value left in module state as well, so in `rc` it's never released
    if (this.fault === "r11-catch-kept" && into !== null) out.push(this.setOn(false));
    else out.push(this.setVal(this.none()), this.setOn(false));
    return out;
  }

  stackTest(): Stmt[] {
    const low = mk(T.bool, { k: "intrinsic", name: STACK_LOW, args: [] });
    const made = mk(REF, { k: "call", inst: this.src.overflow!, args: [] }, { sh: this.src.dynSh });
    return [{ k: "if", c: low, a: this.throwing(made, { handler: null, fins: [] }), b: null }];
  }

  label(kind: string): string {
    return `$${kind}${this.nextLabel++}`;
  }

  // --- expressions

  /** Each node rebuilt, to what it became: a string operation's operands are nodes of its expansion (D67). */
  remap = new Map<TE, TE>();

  x(te: TE, cx: Cx): TE {
    const out = this.x0(te, cx);
    if (out !== te) this.remap.set(te, out);
    return out;
  }

  x0(te: TE, cx: Cx): TE {
    if (te.k === "raise") {
      const v = this.x(te.val, cx);
      return mk(T.never, { k: "blockexpr", body: this.throwing(v, cx), result: VOID });
    }
    let made = mapKidsAll(
      te,
      (c) => this.x(c, cx),
      (b) => this.list(b, cx),
    );
    // Nothing in it changed: the node itself, which a string operation above it may name.
    if (sameKids(te, made)) made = te;
    else if (te.strop !== undefined)
      made = {
        ...made,
        strop: { ...te.strop, args: te.strop.args.map((a) => this.remap.get(a) ?? a) },
      } as TE;
    if (te.k !== "call" && te.k !== "callclo" && te.k !== "callind") return made;
    if (te.k === "call" && !this.can.has(te.inst)) return made;
    if (te.k !== "call") throw new Error("emit-exc: a call through a function value"); // class printing has no closures
    // The test build's missed check: the first call to one of the program's own throwing functions.
    if (this.fault === "exc-no-check" && !this.missed && this.own.has(te.inst)) {
      this.missed = true;
      return made;
    }
    this.checks++;
    const never = te.inst.ret.k === "never" || te.ty.k === "never";
    const body: Stmt[] = [];
    let result: TE = VOID;
    if (!never && te.ty.k !== "void" && leaves(te.ty).length > 0) {
      const r = this.newVar(te.ty, "$r");
      body.push({ k: "let", v: r, init: made, constant: true });
      const keep: Partial<TE> = {};
      if (te.sh !== undefined) keep.sh = te.sh;
      if (te.range !== undefined) keep.range = te.range;
      if (te.negz === true) keep.negz = true;
      result = mk(te.ty, { k: "var", v: r }, keep);
    } else body.push({ k: "expr", e: never ? ({ ...made, ty: T.void } as TE) : made });
    body.push({ k: "if", c: this.on(), a: this.out(cx), b: null });
    if (never) {
      // It came back, so it threw, and the test above has left.
      body.push({
        k: "expr",
        e: mk(T.never, { k: "trapnow", kind: "exc", code: 10, loc: "never returned" }),
      });
      return mk(T.never, { k: "blockexpr", body, result: VOID });
    }
    const keep: Partial<TE> = {};
    if (te.sh !== undefined) keep.sh = te.sh;
    if (te.range !== undefined) keep.range = te.range;
    return mk(te.ty, { k: "blockexpr", body, result }, keep);
  }

  // --- statements

  list(list: Stmt[], cx: Cx): Stmt[] {
    return list.flatMap((s) => this.stmt(s, cx));
  }

  within<R>(t: Target, f: () => R): R {
    this.targets.push(t);
    try {
      return f();
    } finally {
      this.targets.pop();
    }
  }

  target(label: string | null, loop: boolean): Target {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (label !== null ? t.label === label : !t.plain && (!loop || t.loop)) return t;
    }
    throw new Error(`emit-exc: nothing for ${label ?? "a break"} to leave in ${this.f.tirName}`);
  }

  /** A way out of a finally region: the completion code, and the region's end; taken again after its finally code. */
  leave(s: Stmt, cx: Cx, before: Stmt[]): Stmt[] {
    const fin = cx.fins[cx.fins.length - 1]!;
    fin.jumps.push(s);
    const code = mk(T.i32, { k: "lit", value: fin.jumps.length + 1 });
    return [
      ...before,
      { k: "expr", e: mk(T.i32, { k: "setvar", v: fin.comp, val: code }) },
      { k: "break", label: fin.label },
    ];
  }

  stmt(s: Stmt, cx: Cx): Stmt[] {
    const fins = cx.fins.length;
    const loop = (): Target => ({ label: null, loop: true, plain: false, fins });
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
          this.within(loop(), () => ({
            ...s,
            c: this.x(s.c, cx),
            body: this.list(s.body, cx),
          })),
        ];
      case "do":
        return [
          this.within(loop(), () => ({
            ...s,
            body: this.list(s.body, cx),
            c: this.x(s.c, cx),
          })),
        ];
      case "for": {
        const init = this.list(s.init, cx);
        return [
          this.within(loop(), () => ({
            ...s,
            init,
            c: s.c !== null ? this.x(s.c, cx) : null,
            step: s.step.map((e) => this.x(e, cx)),
            body: this.list(s.body, cx),
          })),
        ];
      }
      case "forof": {
        const arr = this.x(s.arr, cx);
        return [this.within(loop(), () => ({ ...s, arr, body: this.list(s.body, cx) }))];
      }
      case "switch": {
        const val = this.x(s.val, cx);
        return [
          this.within({ label: null, loop: false, plain: false, fins }, () => ({
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
        const isLoop =
          inner.k === "while" || inner.k === "do" || inner.k === "for" || inner.k === "forof";
        const t: Target = { label: s.name, loop: isLoop, plain: !isLoop, fins };
        const r = this.within(t, () => this.stmt(inner, cx));
        return [{ ...s, body: r.length === 1 ? r[0]! : { k: "block", body: r } }];
      }
      case "break":
      case "continue": {
        const t = this.target(s.label, s.k === "continue");
        return t.fins < fins ? this.leave(s, cx, []) : [s];
      }
      case "return": {
        if (fins === 0) return [{ ...s, val: s.val !== null ? this.x(s.val, cx) : null }];
        if (s.val === null) return this.leave(s, cx, []);
        const v = this.x(s.val, cx);
        if (v.ty.k === "never") return [{ k: "expr", e: v }];
        const fin = cx.fins[fins - 1]!;
        fin.rv ??= this.newVar(this.f.ret, "$result");
        const rv = fin.rv;
        const keep: Partial<TE> = v.sh !== undefined ? { sh: v.sh } : {};
        return this.leave({ k: "return", val: mk(rv.ty, { k: "var", v: rv }, keep) }, cx, [
          { k: "expr", e: mk(rv.ty, { k: "setvar", v: rv, val: v }, keep) },
        ]);
      }
      case "try":
        return s.fin === null ? this.tryCatch(s, cx) : this.tryFinally(s, cx);
      default:
        throw new Error(`emit-exc: a ${s.k} statement`);
    }
  }

  /** `try { … } catch (e) { … }`: the body's exceptions break to its label's end, where the handler takes the one in flight. */
  tryCatch(s: Extract<Stmt, { k: "try" }>, cx: Cx): Stmt[] {
    const lb = this.label("try");
    const body = this.list(s.body, { handler: lb, fins: cx.fins });
    // Where nothing in the body can throw, there's nothing to catch.
    if (!this.breaksTo(body, lb)) return [{ k: "block", body }];
    const out: Stmt[] = [{ k: "label", name: lb, body: { k: "block", body } }];
    if (s.handler !== null)
      out.push({
        k: "if",
        c: this.on(),
        a: [...this.take(s.cv, true), ...this.list(s.handler, cx)],
        b: null,
      });
    return out;
  }

  breaksTo(list: Stmt[], label: string): boolean {
    let found = false;
    const onStmt = (s: Stmt): void => {
      if (found) return;
      if (s.k === "break" && s.label === label) found = true;
      else eachStmt(s, onTE, (b) => b.forEach(onStmt));
    };
    const onTE = (te: TE): void => {
      if (!found) eachKidAll(te, onTE, (b) => b.forEach(onStmt));
    };
    list.forEach(onStmt);
    return found;
  }

  /** `try … finally`, with or without a `catch`. */
  tryFinally(s: Extract<Stmt, { k: "try" }>, cx: Cx): Stmt[] {
    const lf = this.label("finally");
    const comp = this.newVar(T.i32, "$completion");
    const fin: Fin = { label: lf, comp, rv: null, jumps: [], raised: false };
    const inner: Cx = { handler: lf, fins: [...cx.fins, fin] };
    // The region's own label is no target of a `break` in the source.
    const region: Stmt[] = [];
    if (s.handler !== null) {
      const lb = this.label("try");
      const body = this.list(s.body, { handler: lb, fins: inner.fins });
      if (this.breaksTo(body, lb)) {
        region.push({ k: "label", name: lb, body: { k: "block", body } });
        region.push({
          k: "if",
          c: this.on(),
          a: [...this.take(s.cv, true), ...this.list(s.handler, inner)],
          b: null,
        });
      } else region.push({ k: "block", body });
    } else region.push(...this.list(s.body, inner));
    const after = this.list(s.fin!, cx);
    const out: Stmt[] = [];
    if (!fin.raised && fin.jumps.length === 0) {
      // Nothing leaves early: the region, then the finally code.
      return [{ k: "block", body: region }, ...after];
    }
    const lit = (n: number): TE => mk(T.i32, { k: "lit", value: n });
    const is = (n: number): TE =>
      mk(T.bool, { k: "cmp", op: "eq", a: mk(T.i32, { k: "var", v: comp }), b: lit(n) });
    out.push({ k: "let", v: comp, init: lit(0), constant: false });
    let held: Var | null = null;
    if (fin.raised) {
      held = this.newVar(REF, "$thrown");
      out.push({ k: "let", v: held, init: this.none(), constant: false });
    }
    if (fin.rv !== null) out.push({ k: "let", v: fin.rv, init: null, constant: false });
    out.push({ k: "label", name: lf, body: { k: "block", body: region } });
    if (held !== null)
      out.push({
        k: "if",
        c: this.on(),
        a: [
          ...this.take(held, false),
          { k: "expr", e: mk(T.i32, { k: "setvar", v: comp, val: lit(1) }) },
        ],
        b: null,
      });
    const again: Stmt[] = [];
    if (held !== null) {
      const v =
        this.fault === "exc-rethrow-lost"
          ? this.none()
          : mk(REF, { k: "var", v: held }, { sh: this.src.dynSh });
      again.push({ k: "if", c: is(1), a: this.throwing(v, cx), b: null });
    }
    fin.jumps.forEach((j, i) => {
      again.push({ k: "if", c: is(i + 2), a: this.stmt(j, cx), b: null });
    });
    if (this.fault === "exc-finally-late") out.push(...again, ...after);
    else out.push(...after, ...again);
    return out;
  }

  /**
   * What a native caller calls (D36): the function, then, with an exception in flight and a caller that hasn't asked to
   * take it (`__exc_catch_use(1)`), the trap path, reported with the value's description, as the direct route's is.
   */
  wrapper(f: FuncInst): FuncInst {
    const name = f.tirName;
    const params = f.params.map((p, i): Var => ({ id: i + 1, name: p.name, ty: p.ty }));
    let next = params.length + 1;
    const theirs = this.src.wrappers.find((w) => w.tirName === name);
    const w: FuncInst = { ...f, params, attrs: [...f.attrs], body: [] };
    f.tirName = `${name}$x`;
    f.exported = false;
    f.attrs = f.attrs.filter((a) => a !== "export");
    // The shapes the lowering gave: the result's, for a string the caller reads, and the description's.
    let retSh: unknown;
    let thrown: Extract<TE, { k: "throwjs" }> | null = null;
    const look = (te: TE): void => {
      if (te.k === "call" && te.inst === f && retSh === undefined) retSh = te.sh;
      if (te.k === "throwjs") thrown = te;
      eachKidAll(te, look, (b) => b.forEach(onStmt));
    };
    const onStmt = (s: Stmt): void => eachStmt(s, look, (b) => b.forEach(onStmt));
    theirs?.body.forEach(onStmt);
    const call = mk(
      f.ret,
      { k: "call", inst: f, args: params.map((p) => mk(p.ty, { k: "var", v: p })) },
      retSh !== undefined ? { sh: retSh } : undefined,
    );
    const uncaught: Stmt[] = [];
    if (this.src.describe !== null) {
      const u: Var = { id: next++, name: "$uncaught", ty: REF };
      uncaught.push(...this.take(u, true));
      const t = thrown as Extract<TE, { k: "throwjs" }> | null;
      const text = mk(
        REF,
        {
          k: "call",
          inst: this.src.describe,
          args: [mk(REF, { k: "var", v: u }, { sh: this.src.dynSh })],
        },
        t?.args[0]?.sh !== undefined ? { sh: t.args[0].sh } : undefined,
      );
      uncaught.push({
        k: "expr",
        e: mk(T.never, {
          k: "throwjs",
          args: [text],
          msg: JSON.stringify({ ctor: "$uncaught", parts: [{ a: 0, k: "s" }] }),
          code: this.src.uncaughtCode,
          loc: "uncaught",
        }),
      });
    }
    const mode = mk(
      T.i32,
      { k: "fload", base: gaddr("__exc_mode"), mem: [{ t: "i32", off: 0 }] },
      { glob: { name: "__exc_mode", sh: { s: "num", loc: newLoc() } } },
    );
    const test = mk(T.bool, {
      k: "logic",
      op: "and",
      a: this.on(),
      b: mk(T.bool, { k: "cmp", op: "eq", a: mode, b: mk(T.i32, { k: "lit", value: 0 }) }),
    });
    if (f.ret.k === "void") {
      w.body = [
        { k: "expr", e: call },
        { k: "if", c: test, a: uncaught, b: null },
        { k: "return", val: null },
      ];
    } else {
      const r: Var = { id: next++, name: "$r", ty: f.ret };
      w.body = [
        { k: "let", v: r, init: call, constant: true },
        { k: "if", c: test, a: uncaught, b: null },
        {
          k: "return",
          val: mk(f.ret, { k: "var", v: r }, retSh !== undefined ? { sh: retSh } : undefined),
        },
      ];
    }
    return w;
  }
}
