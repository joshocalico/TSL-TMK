// The per-call region for lowered code in `leak` and `manual` (R6, D62's third ruling, SPEC 3.5 and 4.5): tslc places a `new`
// that its escape analysis proves an export call outlives in a region the export's return gives back, as the direct route's
// call arena holds what the lowering bounds by the export call. No annotation says so: the printed TSL is what it was, it
// runs on V8 and JSC unchanged (where the host's collector frees everything), and this is tslc's decision alone, made on the
// typed tree of the package, as every other placement of its is (3.5).
//
// How it decides, class by class (a class instantiation: `JsArray<Node | null>` and `JsArray<f64>` are two): a class is
// *long* if one of its objects can be reached after an export call returns, and an object can only be reached then from
//   - module state (every global's type),
//   - what an export gives back or is given (each export's result and parameter types: what a caller passes in, it keeps,
//     and whatever is stored into it outlives the call),
//   - a field of an object of a long class (each field's type, and each type argument, as a generic library class keeps
//     values of its type arguments in its own memory: `JsArray<T>`'s buffer, `JsMap<K, V>`'s tables),
//   - or anything tslc can't follow: a reference given to the runtime, an intrinsic, a builtin or a conversion (raw
//     memory, an integer), other than a generic library class keeping a value of its own type argument.
// A `new` that escape analysis already put on the heap (it outlives its function), of a class that isn't long, goes in the
// region; everything else is where it was. A function value can't hold a reference past its scope (TSL3003), and an
// escaping closure of the source is an environment class, so it's a class like any other here.
//
// What it can't prove: anything finer than a class. One object of a class kept in module state makes every object of that
// class long, however short-lived the rest (the direct route's flow classes split a TS type by where its values flow, and
// class printing prints a flow class as a class, so the two mostly agree). An object of a class that some export takes or
// gives is long even where it never crosses. A class whose reference goes into raw memory is long.
//
// The region is the call arena the module already has (`__alloc`, over what `__arena_use` gave it): each export marks it at
// entry and gives back everything made since at every return (lower.ts), so what a region object is made in, an export
// call, is what frees it. A JsArray in the region takes its buffers from it too (`inCallRegion`, `callRegionBytes` in
// @tsl/unsafe), so an array's elements go where its header does, as the direct route's call-bounded vectors' do.
import type { ClassInst, FuncInst, TE, Ty, TypedModule, Var } from "./types.ts";
import { stmtBodies, stmtExprs } from "./walk.ts";
import { r13Off, r6Off, r9Off } from "./down-model.ts";

/** What placing gave: how many `new` sites are in the region, and the long classes, for tests and the report. */
export interface RegionPlan {
  sites: number;
  heapSites: number;
  long: Set<string>;
  why: Map<string, string>;
  // R13: `strict`'s call arena, where something takes bytes from it beside an object (`callRegionBytes`: the arena array)
  arenaBytes?: boolean;
}

const FLOW = new Set([
  // A reference's value only passes through these: whatever reads the result is looked at in its turn.
  "var",
  "setvar",
  "seq",
  "cond",
  "nonnull",
  "chkref",
  "cmp",
  "ofield",
  "osetfield",
  "call",
  "callclo",
  "callind",
  "new",
  "setglobal",
  "record",
  "tuple",
  "ulit",
  "field",
  "logic",
  "isundef",
  "optpayload",
  "optindex",
]);

/** The TEs directly under `te`, found by shape, so a kind walk.ts doesn't list isn't missed. */
function children(te: TE): TE[] {
  const out: TE[] = [];
  const isTE = (x: unknown): x is TE =>
    typeof x === "object" && x !== null && "k" in x && "ty" in x && typeof (x as TE).k === "string";
  for (const [key, v] of Object.entries(te)) {
    if (key === "ty" || key === "sh" || key === "deps") continue;
    if (isTE(v)) out.push(v);
    else if (Array.isArray(v)) {
      for (const x of v) {
        if (isTE(x)) out.push(x);
        else if (typeof x === "object" && x !== null && isTE((x as { val?: unknown }).val))
          out.push((x as { val: TE }).val);
      }
    } else if (typeof v === "object" && v !== null && isTE((v as { obj?: unknown }).obj))
      out.push((v as { obj: TE }).obj);
  }
  return out;
}

function eachTE(f: FuncInst, visit: (te: TE, parent: TE | null) => void): void {
  const seen = new Set<FuncInst>();
  const go = (te: TE, parent: TE | null): void => {
    for (const c of children(te)) go(c, te);
    if (te.k === "closure" && !seen.has(te.inst)) {
      seen.add(te.inst);
      body(te.inst.body);
    }
    visit(te, parent);
  };
  const body = (list: FuncInst["body"]): void => {
    for (const s of list) {
      for (const e of stmtExprs(s)) go(e, null);
      for (const b of stmtBodies(s)) body(b);
    }
  };
  body(f.body);
}

/** Whether `t` mentions `want` anywhere in it: a generic class keeping a value of one of its type arguments. */
function mentions(t: Ty, want: ClassInst, depth = 0): boolean {
  if (depth > 8) return false;
  switch (t.k) {
    case "cls":
      return (
        t.c === want || t.c.key === want.key || t.c.tyArgs.some((a) => mentions(a, want, depth + 1))
      );
    case "opt":
    case "ptr":
    case "elem":
      return mentions(t.of, want, depth + 1);
    default:
      return false;
  }
}

/** R9: what passes a view through unchanged (the view, or a range of its own elements) from its operand `child`. */
function viewThrough(te: TE, child: TE): boolean {
  switch (te.k) {
    case "setvar":
    case "nonnull":
    case "chkref":
      return true;
    case "seq":
    case "blockexpr":
      return te.result === child;
    case "cond":
      return te.a === child || te.b === child;
    case "builtin":
      return (te.name === "arr.subarray" || te.name === "arr.fill") && te.args[0] === child;
    case "slice": // @tsl/lowered's part: the view's pointer, which the lowering only ever reads and writes elements at
      return true;
    case "elemaddr":
      return te.base === child;
    default:
      return false;
  }
}

/** R9: what reads or writes a view's elements, or its length, and keeps nothing of it. */
function viewUsed(te: TE, child: TE): boolean {
  switch (te.k) {
    case "index":
    case "setindex":
    case "optindex":
      return te.arr === child;
    case "len":
      return true;
    case "builtin":
      return te.name === "arr.set" && (te.args[0] === child || te.args[1] === child);
    case "seq":
      return te.result !== child; // a value nothing uses
    case "cmp":
      return true;
    case "loadelem":
    case "storeelem":
      return te.ptr === child;
    case "fload":
    case "fstore":
      return te.base === child;
    default:
      return false;
  }
}

/**
 * R9: the classes a view of whose storage can outlive an export call, each given to `mark`. A view is made by reading an
 * object's array field or tail (`ofield` of a typed array); it flows through locals, parameters and results, a
 * conditional, `subarray` and `fill`, to the end of a fixed point over the package. Where it's only read, written or
 * measured, nothing outlives the call through it. Anywhere else (an export's result, module state, a field, a function
 * value's call, an integer made of its pointer, anything not listed) it may, and its class is long. Its pointer
 * taken by @tsl/lowered's `part` to read or write an element at is a use.
 */
function viewsEscaping(
  typed: TypedModule,
  mark: (c: ClassInst, why: string) => void,
  arena: boolean,
): Map<string, Set<ClassInst>> {
  const holds = new Map<Var | FuncInst, Set<ClassInst>>();
  // R13: in `strict`'s call arena, a view's pointer and length kept in a holder (R7's typed-array field, held in place,
  // `o.f.ptr = cast<usize>(part<Ref>(v, 0, 1))` then `o.f.len`, or one an array holds) is followed through it, by the
  // holder's class, not given up on as an integer: a view made again from a holder of that class
  // (`pack<T>(cast<Ref>(h.ptr), h.len)`) is any of the views kept in one, and the storage is long where that class is
  // (placeRegion). By the class, not the object: one holder of a class that's long makes every view kept in one long.
  const laundered = new Map<string, Set<ClassInst>>();
  const heldIn = (holderObj: TE): string | null =>
    holderObj.ty.k === "cls" ? holderObj.ty.c.key : null;
  const viewOfInt = (te: TE): TE | null => {
    let cur = te;
    for (let g = 0; g < 4 && (cur.k === "conv" || cur.k === "nonnull"); g++) cur = cur.val;
    return cur.k === "slice" || cur.k === "elemaddr" ? cur : null;
  };
  const origins = (te: TE): Set<ClassInst> => {
    switch (te.k) {
      case "ofield":
        return te.ty.k === "arr" ? new Set([te.c]) : new Set();
      case "var":
        return holds.get(te.v) ?? new Set();
      case "call":
        return holds.get(te.inst) ?? new Set();
      case "setvar":
      case "nonnull":
      case "chkref":
        return origins(te.val);
      case "seq":
      case "blockexpr":
        return origins(te.result);
      case "slice":
        // R13: in `strict`'s call arena, a view's length (its second leaf) is a number, which keeps nothing
        return arena && te.from >= 1 ? new Set() : origins(te.val);
      case "elemaddr":
        return origins(te.base);
      case "cond":
        return new Set([...origins(te.a), ...origins(te.b)]);
      case "builtin":
        return (te.name === "arr.subarray" || te.name === "arr.fill") && te.args[0] !== undefined
          ? origins(te.args[0])
          : new Set();
      case "tuple": {
        // R13: a view made again from a holder's pointer
        if (!arena || te.ty.k !== "arr" || te.items[0] === undefined) return new Set();
        let p = te.items[0];
        for (let g = 0; g < 4 && (p.k === "conv" || p.k === "nonnull"); g++) p = p.val;
        if (p.k !== "ofield") return new Set();
        const at = heldIn(p.obj);
        return at === null ? new Set() : new Set(laundered.get(at) ?? []);
      }
      default:
        return new Set();
    }
  };
  let changed = true;
  const add = (k: Var | FuncInst, s: Set<ClassInst>): void => {
    if (s.size === 0) return;
    const h = holds.get(k) ?? new Set<ClassInst>();
    for (const c of s)
      if (!h.has(c)) {
        h.add(c);
        changed = true;
      }
    holds.set(k, h);
  };
  const escaped = new Map<ClassInst, string>();
  const escape = (s: Set<ClassInst>, why: string): void => {
    // the injected `region-view-escaping` bug (R9): a view kept past the call not followed, so its class goes in the region
    if (process.env.TMK_TEST_TSL === "region-view-escaping") return;
    for (const c of s) if (!escaped.has(c)) escaped.set(c, why);
  };
  const stmts = (f: FuncInst, list: FuncInst["body"]): void => {
    for (const s of list) {
      if (s.k === "let" && s.init !== null) add(s.v, origins(s.init));
      if (s.k === "return" && s.val !== null) {
        const o = origins(s.val);
        add(f, o);
        // R13: in `strict`'s call arena an export's result is the caller's until it resets the arena (D36)
        if (f.exported && f.isClosure !== true && !arena)
          escape(o, `a view of its storage given back by the export ${f.jsName}`);
      }
      for (const b of stmtBodies(s)) stmts(f, b);
    }
  };
  for (let round = 0; changed && round < 256; round++) {
    changed = false;
    for (const f of typed.funcs) {
      stmts(f, f.body);
      eachTE(f, (te, parent) => {
        if (te.k === "setvar") add(te.v, origins(te.val));
        if (te.k === "call")
          te.args.forEach((a, i) => {
            const p = te.inst.params[i];
            if (p !== undefined) add(p, origins(a));
          });
        // R13: a view's pointer stored in a holder held in place in a field of a class (the printing's typed-array field)
        if (
          arena &&
          te.k === "conv" &&
          parent !== null &&
          parent.k === "osetfield" &&
          parent.val === te &&
          viewOfInt(te) !== null
        ) {
          const o = origins(viewOfInt(te)!);
          const at = heldIn(parent.obj);
          if (at !== null) {
            const h = laundered.get(at) ?? new Set<ClassInst>();
            for (const c of o)
              if (!h.has(c)) {
                h.add(c);
                changed = true;
              }
            laundered.set(at, h);
            return;
          }
        }
        for (const c of children(te)) {
          const o = origins(c);
          if (o.size === 0 || viewThrough(te, c) || viewUsed(te, c) || te.k === "call") continue;
          // R13: in `strict`'s call arena, an element copy or fill at a view's pointer (`set`, `slice`, `fill` of a
          // typed array) reads and writes its elements and keeps nothing of it
          if (arena && te.k === "intrinsic" && (te.name === "mem.copy" || te.name === "mem.fill"))
            continue;
          escape(
            o,
            `a view of its storage given to ${te.k}${te.k === "builtin" || te.k === "intrinsic" || te.k === "rtcall" ? ` ${(te as { name: string }).name}` : ""}`,
          );
        }
      });
    }
  }
  // A statement holding a view where it isn't a local's, a result or a loop's array: kept nowhere (an expression statement),
  // or anything else, which is a way out.
  for (const f of typed.funcs) {
    const visit = (list: FuncInst["body"]): void => {
      for (const s of list) {
        if (s.k === "using" && s.dispose !== null && origins(s.dispose).size > 0)
          escape(origins(s.dispose), "a view of its storage in a using");
        for (const b of stmtBodies(s)) visit(b);
      }
    };
    visit(f.body);
  }
  for (const [c, why] of escaped) mark(c, why);
  return laundered;
}

/** A type that holds memory: a reference, or a typed array (a view of an object's storage). */
function holdsMemory(t: Ty): boolean {
  return t.k === "cls" || t.k === "arr" || t.k === "ptr" || t.k === "opt";
}

/**
 * R13: in a lowered `strict` package, whose region is the caller's call arena (D36), the module's `__init` makes module
 * state before it commits the arena (`__arena_commit`), so what it makes stays below every reset; what anything makes after
 * is gone at the caller's next reset. So module state can hold what's in the arena only where nothing made after `__init`
 * is put where module state reaches: outside `__init`, no module state is set to anything but null or what module state
 * already held; no field of an object module state reaches is; no typed-array view is kept in one (R7's holder); and no
 * method of a library class is called on an object module state reaches with such a reference, or one that can grow it
 * (reaches `callRegionBytes`: an arena array's `push`). A value module state reaches is followed through locals,
 * parameters, results and fields, to a fixed point. Gives the first place that isn't so, or null. Not finer than this: a
 * function `__init` calls is checked as any other is.
 */
export function stateHazard(typed: TypedModule): string | null {
  const init = typed.funcs.find((f) => f.exported && f.jsName === "__init");
  // what can reach `callRegionBytes`, through calls and constructors
  const grows = new Set<FuncInst>();
  const callees = new Map<FuncInst, Set<FuncInst>>();
  for (const f of typed.funcs) {
    const out = new Set<FuncInst>();
    eachTE(f, (te) => {
      if (te.k === "builtin" && te.name === "unsafe.callRegionBytes") grows.add(f);
      if (te.k === "call") out.add(te.inst);
      if (te.k === "new" && te.ctor !== null) out.add(te.ctor);
    });
    callees.set(f, out);
  }
  for (let changed = true, round = 0; changed && round < 256; round++) {
    changed = false;
    for (const [f, out] of callees)
      if (!grows.has(f) && [...out].some((g) => grows.has(g))) {
        grows.add(f);
        changed = true;
      }
  }
  const st = new Set<Var | FuncInst>();
  const fs = (te: TE): boolean => {
    switch (te.k) {
      case "global":
        return holdsMemory(te.ty);
      case "var":
        return st.has(te.v);
      case "call":
        return (
          st.has(te.inst) ||
          (te.inst.owner !== undefined &&
            te.args[0] !== undefined &&
            holdsMemory(te.ty) &&
            fs(te.args[0]))
        );
      case "ofield":
        return fs(te.obj);
      case "setvar":
      case "nonnull":
      case "chkref":
      case "conv":
        return fs(te.val);
      case "seq":
      case "blockexpr":
        return fs(te.result);
      case "cond":
        return fs(te.a) || fs(te.b);
      case "slice":
        return fs(te.val);
      case "elemaddr":
        return fs(te.base);
      case "tuple":
        return te.items[0] !== undefined && fs(te.items[0]);
      default:
        return false;
    }
  };
  let changed = true;
  const add = (k: Var | FuncInst, te: TE): void => {
    if (st.has(k) || !fs(te)) return;
    st.add(k);
    changed = true;
  };
  const stmts = (f: FuncInst, list: FuncInst["body"]): void => {
    for (const s of list) {
      if (s.k === "let" && s.init !== null) add(s.v, s.init);
      if (s.k === "return" && s.val !== null) add(f, s.val);
      for (const b of stmtBodies(s)) stmts(f, b);
    }
  };
  for (let round = 0; changed && round < 256; round++) {
    changed = false;
    for (const f of typed.funcs) {
      stmts(f, f.body);
      eachTE(f, (te) => {
        if (te.k === "setvar") add(te.v, te.val);
        if (te.k === "call")
          te.args.forEach((a, i) => {
            const p = te.inst.params[i];
            if (p !== undefined) add(p, a);
          });
      });
    }
  }
  const nullLit = (te: TE): boolean => te.k === "lit" && Number(te.value) === 0;
  const fresh = (te: TE): boolean => holdsMemory(te.ty) && !nullLit(te) && !fs(te);
  const viewIn = (te: TE): TE | null => {
    let cur = te;
    for (let g = 0; g < 4 && (cur.k === "conv" || cur.k === "nonnull"); g++) cur = cur.val;
    return cur.k === "slice" || cur.k === "elemaddr" ? cur : null;
  };
  // the injected `arena-state-unchecked` bug (R13): module state set after `__init` not looked for
  if (process.env.TMK_TEST_TSL === "arena-state-unchecked") return null;
  for (const f of typed.funcs) {
    if (f === init) continue;
    let found: string | null = null;
    eachTE(f, (te) => {
      if (found !== null) return;
      if (te.k === "setglobal" && fresh(te.val))
        found = `module state ${te.g.jsName || te.g.name} set in ${f.jsName}, after __init`;
      else if (te.k === "osetfield" && fs(te.obj)) {
        const v = viewIn(te.val);
        if (fresh(te.val) || (v !== null && !fs(v)))
          found = `a field of ${te.c.name}, which module state reaches, set in ${f.jsName}, after __init`;
      } else if (
        te.k === "call" &&
        te.inst.owner !== undefined &&
        te.args[0] !== undefined &&
        fs(te.args[0])
      ) {
        if (grows.has(te.inst))
          found = `${te.inst.owner.name}, which module state reaches, grown in ${f.jsName}, after __init`;
        else if (te.args.slice(1).some(fresh))
          found = `${te.inst.owner.name}, which module state reaches, given something new in ${f.jsName}, after __init`;
      }
    });
    if (found !== null) return found;
  }
  return null;
}

/**
 * Places each heap `new` of a class no export call outlives in the per-call region (`heap: "region"`), and marks each export
 * of the package to give the region back at its returns. A package with no such `new` is what it was, byte for byte.
 */
export function placeRegion(typed: TypedModule, giveBack = true): RegionPlan {
  const plan: RegionPlan = { sites: 0, heapSites: 0, long: new Set(), why: new Map() };
  if (r6Off("region")) return plan;
  // R13: `strict`'s region is the caller's call arena (no export gives it back), which only the caller resets (D36): what an
  // export gives back, and what it's given and keeps in it, live until then, as the direct route's results do. So there,
  // only module state outlives it, and a class is long only where module state reaches it.
  const arena = !giveBack && !r13Off("arena");
  const work: ClassInst[] = [];
  const mark = (c: ClassInst, why: string): void => {
    if (plan.long.has(c.key)) return;
    plan.long.add(c.key);
    plan.why.set(c.key, why);
    work.push(c);
  };
  const ty = (t: Ty, why: string, depth = 0): void => {
    if (depth > 16) return;
    switch (t.k) {
      case "cls":
        mark(t.c, why);
        for (const m of t.c.iface?.set ?? []) mark(m, why);
        return;
      case "opt":
      case "ptr":
      case "elem":
        return ty(t.of, why, depth + 1);
      case "rec":
        for (const f of t.fields) ty(f.ty, why, depth + 1);
        return;
      case "union":
        for (const v of t.variants) for (const f of v.fields) ty(f.ty, why, depth + 1);
        return;
      case "fn":
        for (const p of t.params) ty(p, why, depth + 1);
        return ty(t.ret, why, depth + 1);
      default:
        return;
    }
  };
  // Module state, and what an export gives or is given.
  // R13: in `strict`'s call arena, module state is long only where something new can reach it after `__init` (stateHazard):
  // what `__init` makes is below the point it commits the arena to, which no reset passes.
  const hazard = arena ? stateHazard(typed) : null;
  for (const g of typed.globals) {
    if (arena && hazard === null) continue;
    const and = hazard !== null ? ` (${hazard})` : "";
    ty(g.ty, `module state ${g.jsName || g.name}${and}`);
    if (g.object !== undefined) mark(g.object.c, `a static object ${g.name}${and}`);
  }
  for (const f of typed.funcs) {
    if (!f.exported || f.isClosure === true || arena) continue;
    for (const p of f.params) ty(p.ty, `an argument of the export ${f.jsName}`);
    ty(f.ret, `the result of the export ${f.jsName}`);
  }
  // A reference tslc can't follow: given to the runtime, an intrinsic, a builtin or a conversion, unless it's a generic
  // library class's method keeping a value of its own type argument.
  for (const f of typed.funcs) {
    eachTE(f, (te, parent) => {
      if (te.ty.k !== "cls" || parent === null || FLOW.has(parent.k)) return;
      if (parent.k === "conv" && parent.ty.k === "cls") return;
      // Asking where an object is keeps nothing of it.
      if (parent.k === "builtin" && parent.name === "unsafe.inCallRegion") return;
      const c = te.ty.c;
      const owner = f.owner;
      if (owner !== undefined && owner.tyArgs.some((a) => mentions(a, c))) return;
      mark(
        c,
        `a reference given to ${parent.k}${parent.k === "builtin" || parent.k === "intrinsic" || parent.k === "rtcall" ? ` ${(parent as { name: string }).name}` : ""}`,
      );
    });
  }
  // R9: a typed array that's a view of an object's own storage (a layout class's `array(…)` field, or a tail, D69: how
  // printed TSL makes a typed array in a function) keeps that object's memory in use with no reference to it, so its
  // class is long wherever such a view can outlive the export call.
  const laundered = r9Off("regionviews")
    ? new Map<string, Set<ClassInst>>()
    : viewsEscaping(typed, mark, arena);
  // Everything a long object can reach; R13: and the storage of each view a long object's typed-array field holds.
  for (let i = 0; i < work.length && i < 100_000; i++) {
    const c = work[i]!;
    for (const fld of c.fields) ty(fld.ty, `a field of ${c.name}, which is long`);
    for (const a of c.tyArgs) ty(a, `a type argument of ${c.name}, which is long`);
    for (const s of laundered.get(c.key) ?? [])
      mark(s, `a view of its storage in a field of ${c.name}, which is long`);
  }
  // A class that keeps memory beside its objects where they are (one of its methods asks `inCallRegion(this)`: JsArray's
  // buffers): an object of it escape analysis put on the stack goes in the region instead, which outlives the stack frame,
  // so what it keeps beside it can go there too, as the direct route's call-bounded vectors keep their buffers in the call
  // arena. On the stack, its buffers would be the mode's heap's, never given back in `leak`.
  const beside = new Set<string>();
  for (const f of typed.funcs) {
    const c = f.owner;
    if (c === undefined || beside.has(c.key)) continue;
    eachTE(f, (te) => {
      if (te.k === "builtin" && te.name === "unsafe.inCallRegion") beside.add(c.key);
    });
  }
  // the injected `region-escaping` bug: a class kept in module state placed in the region all the same
  const fault = process.env.TMK_TEST_TSL === "region-escaping";
  for (const f of typed.funcs) {
    eachTE(f, (te) => {
      if (te.k !== "new" || te.into !== null) return;
      if (te.heap === undefined) {
        if (f.memory === undefined || !beside.has(te.c.key) || plan.long.has(te.c.key)) return;
        if (te.tail !== undefined || te.c.align > 8) return;
        te.heap = "region";
        plan.sites++;
        return;
      }
      // One aligned past 8 stays in the mode's heap: not built. An object with a tail (D69) goes in the region at its real
      // size since R9 (a typed array made in a function, `withTail(n, new Float64Array_n()).items`), unless R9's off.
      if ((te.tail !== undefined && r9Off("regiontails")) || te.c.align > 8) {
        plan.heapSites++;
        return;
      }
      if (
        plan.long.has(te.c.key) &&
        !(fault && plan.why.get(te.c.key)?.startsWith("module state"))
      ) {
        plan.heapSites++;
        return;
      }
      te.heap = "region";
      plan.sites++;
    });
  }
  // R13: in `strict`'s call arena, an arena array takes its buffers from it wherever its header is, the stack included
  if (arena)
    for (const f of typed.funcs)
      eachTE(f, (te) => {
        if (te.k === "builtin" && te.name === "unsafe.callRegionBytes") plan.arenaBytes = true;
      });
  // R12: in `strict` the region is the call arena as the direct route uses it, which the caller resets (D36): no export
  // gives it back at its return.
  if (plan.sites > 0 && giveBack) {
    // An export marks and gives back the region only where its call can reach a `new` placed there (through calls,
    // constructors and closures; a call through a function value can reach any function whose value is taken): one that
    // can't puts nothing in the region, and pays nothing for it.
    const placing = new Set<FuncInst>();
    const callees = new Map<FuncInst, Set<FuncInst>>();
    const taken = new Set<FuncInst>();
    const indirect = new Set<FuncInst>();
    for (const f of typed.funcs) {
      const out = new Set<FuncInst>();
      eachTE(f, (te) => {
        if (te.k === "new" && te.heap === "region") placing.add(f);
        if (te.k === "call") out.add(te.inst);
        if (te.k === "new" && te.ctor !== null) out.add(te.ctor);
        if (te.k === "fnref" || te.k === "closure") {
          out.add(te.inst);
          taken.add(te.inst);
        }
        if (te.k === "callind" || te.k === "callclo") indirect.add(f);
      });
      callees.set(f, out);
    }
    const reaches = (from: FuncInst): boolean => {
      const seen = new Set<FuncInst>([from]);
      const todo = [from];
      while (todo.length > 0) {
        const g = todo.pop()!;
        if (placing.has(g)) return true;
        const next = [...(callees.get(g) ?? []), ...(indirect.has(g) ? taken : [])];
        for (const h of next) {
          if (seen.has(h)) continue;
          seen.add(h);
          todo.push(h);
        }
      }
      return false;
    };
    for (const f of typed.funcs)
      if (f.exported && f.isClosure !== true && reaches(f)) f.regionMark = true;
  }
  return plan;
}
