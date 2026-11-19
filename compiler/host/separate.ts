// Fresh-allocation separation (SPEC 3.5, D77, R27): which of a class's fields hold only blocks of memory that no object can
// be in, as a whole-program fact, so the optimiser may take a write into such a block as unable to change any object's field,
// and an object's field's write as unable to change the block (compiler/tir/passes/memory.ts).
//
// A field F of a class C is separated when all of this holds:
//  1. F is a `u64` held by value, of a class that isn't a layout class and has no tail;
//  2. only C's own methods (its constructor among them) read or write F, on any object of C;
//  3. every value C's methods store in F is 0, a fresh block (the global allocator's `Heap.allocBytes`, the per-call region's
//     `callRegionBytes`), or a value read from a separated field of C (a block moving between C's objects, as `adopt` and
//     `swap` move one), through locals, conditionals and arithmetic: C's methods are followed value by value from where such
//     a value is made (a "block value"), and each use of one must be one of these, or the class has no separated field:
//     - an address for C's own element reads and writes (`ptrAt(e, x)`, `.add(i)`, `.read()`, `.write(v)`, `.addr`), of an
//       element that isn't an object in place (`inlineOf`);
//     - a copy's or a fill's address (`copyBytes`, `bytesAt(x, n).fill`, a byte slice's elements), `addrInCallRegion`, or
//       the allocator's `Heap.freeBytes`, which takes a block back;
//     - a compare;
//     - a store into a separated field of C, or a local of C's method; an argument of one of C's own methods, or a result of
//       one called only from C's own methods;
//     and never: a store anywhere else (another field, a global, memory), a result C gives to code outside it, an argument
//     to any other function, nor an address an object is made, placed or viewed at (`placeObject`, `placeTail`,
//     `objectAt`, `viewAt`): a block value never leaves C's methods, so no other code can reach the block, and no object is
//     ever in one;
//  4. C's methods use no other @tsl/unsafe operation that names memory (`addrOf`, `slotOf`, `tailAddr`, `viewAt`, ...),
//     make no closure, and no code takes one of C's methods as a value;
//  5. no object of C, or holding one in place, is made at an address or viewed (`viewAt`, `staticView`, `inlineOf`): an
//     object of C is made by `new` and moved whole (`placeObject`'s copy into a slot, which tslc's moves rule leaves no use
//     of the copy behind).
//
// What it rests on: the allocators give a block no live object or other live block shares, until it's given back; C's own
// unsafe code keeps its SAFETY comments, so an address it works out from a block stays in that block and a block goes back
// only once no separated field holds it; and @tsl/unsafe's object operations move whole objects (3.8). Then a block a
// separated field holds is reachable only through C's methods, no object is in it, and nothing but those methods writes it:
// a store into it can't change any object's field, and no field's store can change it. In a lowered package nothing can
// import @tsl/unsafe (TSL1023), so only the libraries' classes (@tsl/jsrt's JsArray) can have one.
import type { ClassInst, ClsField, FuncInst, Stmt, TE, TypedModule, Var } from "./types.ts";
import { stmtBodies, stmtExprs, teChildren, walkTE } from "./walk.ts";

/** What the rule found, for tests and `TMK_SEP_DEBUG=1`: each separated field, and why each candidate class was refused. */
export interface SepReport {
  fields: string[];
  refused: Record<string, string>;
}

/** R27's switch for the pins tool (tools/r27-pins.ts): `TMK_R27_OFF=sep` leaves every field unseparated. */
export function r27Off(part: string): boolean {
  return (process.env.TMK_R27_OFF ?? "").split(",").includes(part);
}

/**
 * The injected bug in this rule (tools/r27-tests.ts): a block value leaving C's methods is let through, stored in another
 * field or a global, or given to code outside C as a method's result.
 */
function escapeFault(): boolean {
  return process.env.TMK_TEST_TSL === "r27-sep-escape";
}

/** The global allocator's taking and giving back of a block: @tsl/alloc's Heap (packages/tsl-alloc/ex-heap.ts). */
function heapMethod(inst: FuncInst, name: "allocBytes" | "freeBytes"): boolean {
  const o = inst.owner;
  if (o === undefined || o.name !== "Heap") return false;
  if (!/(^|\/)packages\/tsl-alloc\/ex-heap\.ts(:|$)/.test(inst.at ?? "")) return false;
  return inst.display === `Heap.${name}` || inst.jsName === name || inst.key.endsWith(`.${name}`);
}

/** Builtins C's methods may use at all: element reads and writes, copies and fills, and the per-call region's two. */
const BUILTINS_OK = new Set([
  "ptr.add",
  "ptr.read",
  "ptr.write",
  "unsafe.copy",
  "unsafe.slice",
  "unsafe.addrInCallRegion",
  "unsafe.inCallRegion",
  "unsafe.callRegionBytes",
  "arr.fill",
  "arr.subarray",
  "arr.set",
]);

/** TE kinds the rule follows values through; any other in C's methods refuses C. */
const KINDS_OK = new Set([
  "err",
  "lit",
  "var",
  "global",
  "index",
  "optindex",
  "len",
  "arith",
  "farith",
  "bigshift",
  "bit",
  "bitnot",
  "neg",
  "not",
  "cmp",
  "logic",
  "cond",
  "setvar",
  "setglobal",
  "setindex",
  "seq",
  "call",
  "callind",
  "builtin",
  "ofield",
  "osetfield",
  "new",
  "chkref",
  "conv",
  "isundef",
  "optpayload",
  "nonnull",
  "trapnow",
  "fnref",
  "tableget",
]);

function isZero(te: TE): boolean {
  if (te.k === "lit") return te.value === 0 || te.value === 0n;
  if (te.k === "conv") return isZero(te.val);
  return false;
}

/** Whether objects of `x` hold an object of `c` in place, or are `c`'s. */
function holds(x: ClassInst, c: ClassInst, seen = new Set<string>()): boolean {
  if (x.key === c.key) return true;
  if (seen.has(x.key)) return false;
  seen.add(x.key);
  return x.fields.some((f) => f.store === "inline" && f.ty.k === "cls" && holds(f.ty.c, c, seen));
}

/**
 * Marks the separated fields' reads (`ofield.sep`), which lowering notes for the optimiser outside the canonical text, as it
 * notes a class id's (D73). Returns what it found.
 */
export function markSeparatedFields(typed: TypedModule): SepReport {
  const report: SepReport = { fields: [], refused: {} };
  if (r27Off("sep")) return report;
  const funcs: FuncInst[] = typed.funcs;
  // Candidates: classes with a u64 field held by value.
  const classes = new Map<string, ClassInst>();
  const noteClass = (c: ClassInst | undefined): void => {
    if (c !== undefined && !classes.has(c.key)) classes.set(c.key, c);
  };
  for (const f of funcs) noteClass(f.owner);
  const cand = new Map<string, Set<string>>();
  for (const c of classes.values()) {
    if (c.layout || c.tail !== undefined || c.iface !== undefined) continue;
    const fs = c.fields.filter(
      (f: ClsField) => f.store === "value" && f.ty.k === "big" && f.ty.name === "u64",
    );
    if (fs.length > 0) cand.set(c.key, new Set(fs.map((f) => f.name)));
  }
  if (cand.size === 0) return report;
  const refuse = (key: string, why: string): void => {
    if (!cand.has(key)) return;
    cand.delete(key);
    report.refused[classes.get(key)?.name ?? key] = why;
  };
  const isCand = (c: ClassInst, f: ClsField): boolean => cand.get(c.key)?.has(f.name) === true;

  // Whole-program conditions (2, 4's method values, 5), and who calls each method.
  const callers = new Map<string, Set<string>>(); // a method's key: the owners' keys of its callers ("" for none)
  for (const fn of funcs) {
    const own = fn.owner?.key ?? "";
    walkTE(
      fn.body,
      (te) => {
        if ((te.k === "ofield" || te.k === "osetfield") && cand.has(te.c.key) && own !== te.c.key)
          if (isCand(te.c, te.f))
            refuse(te.c.key, `${te.c.name}.${te.f.name} is used outside ${te.c.name}'s methods`);
        if (te.k === "new" && cand.has(te.c.key))
          for (const i of te.init)
            if (cand.get(te.c.key)!.has(i.f.name) && !isZero(i.val))
              refuse(te.c.key, `${te.c.name}.${i.f.name} is given a value where an object is made`);
        if (te.k === "fnref" && te.inst.owner !== undefined)
          refuse(te.inst.owner.key, `a method of ${te.inst.owner.name} is taken as a value`);
        if (te.k === "call") {
          let s = callers.get(te.inst.key);
          if (s === undefined) callers.set(te.inst.key, (s = new Set()));
          s.add(own);
        }
        // 5: an object of a candidate, or holding one in place, made at an address or viewed
        const ty = te.ty;
        if ((ty.k === "ptr" || ty.k === "elem") && ty.elem.mode === "inline" && ty.of.k === "cls")
          for (const key of cand.keys())
            if (holds(ty.of.c, classes.get(key)!))
              refuse(key, `an object holding a ${classes.get(key)!.name} in place is an element`);
        if (
          te.k === "builtin" &&
          (te.name === "unsafe.viewAt" || te.name === "unsafe.staticView") &&
          te.info?.c !== undefined
        )
          for (const key of cand.keys())
            if (holds(te.info.c, classes.get(key)!))
              refuse(key, `an object holding a ${classes.get(key)!.name} is viewed at an address`);
      },
      true,
    );
  }

  // Each candidate's methods, followed value by value (3, 4).
  for (const [key, names] of cand) {
    const c = classes.get(key)!;
    const methods = funcs.filter((f) => f.owner?.key === key);
    const why = followClass(c, names, methods, callers);
    if (why !== null) refuse(key, why);
  }
  for (const [key, names] of cand) {
    const c = classes.get(key)!;
    for (const n of [...names].sort()) report.fields.push(`${c.name}.${n}`);
  }
  report.fields.sort();
  // The separated fields' reads, noted for lowering.
  if (cand.size > 0)
    for (const fn of funcs)
      walkTE(
        fn.body,
        (te) => {
          if (te.k === "ofield" && isCand(te.c, te.f)) te.sep = true;
        },
        true,
      );
  if (process.env.TMK_SEP_DEBUG === "1") console.error(`separated: ${JSON.stringify(report)}`);
  return report;
}

/**
 * Follows block values through C's methods to a fixpoint, then checks every use (3, 4). Null if C's candidate fields are
 * separated, or why not.
 */
function followClass(
  c: ClassInst,
  names: Set<string>,
  methods: FuncInst[],
  callers: Map<string, Set<string>>,
): string | null {
  const own = new Set(methods.map((m) => m.key));
  const taintedVars = new Set<Var>();
  const taintedRets = new Set<string>();
  let why: string | null = null;
  let checking = false;
  const fail = (msg: string): void => {
    if (checking && why === null) why = msg;
  };
  const isField = (te: { c: ClassInst; f: ClsField }): boolean =>
    te.c.key === c.key && names.has(te.f.name);
  // Whether a value is a block value; in the checking pass, a use that isn't allowed fails.
  const val = (te: TE): boolean => {
    if (!KINDS_OK.has(te.k)) {
      fail(`${c.name}'s methods hold ${te.k}, which the rule doesn't follow`);
      for (const x of teChildren(te)) val(x);
      return false;
    }
    switch (te.k) {
      case "lit":
      case "global":
      case "err":
      case "fnref":
      case "trapnow":
        return false;
      case "var":
        return taintedVars.has(te.v);
      case "ofield": {
        if (val(te.obj)) fail(`a block value used as an object in ${c.name}`);
        return isField(te);
      }
      case "osetfield": {
        if (val(te.obj)) fail(`a block value used as an object in ${c.name}`);
        const t = val(te.val);
        if (isField(te)) {
          if (!t && !isZero(te.val))
            fail(
              `${c.name}.${te.f.name} is given something that isn't a fresh block, 0 or a block value`,
            );
        } else if (t && !escapeFault()) fail(`a block value stored in ${te.c.name}.${te.f.name}`);
        return t;
      }
      case "setvar": {
        const t = val(te.val);
        if (t && !taintedVars.has(te.v)) {
          taintedVars.add(te.v);
          changed = true;
        }
        return t;
      }
      case "setglobal": {
        if (val(te.val) && !escapeFault()) fail(`a block value stored in a global by ${c.name}`);
        return false;
      }
      case "conv": {
        const t = val(te.val);
        if (t && te.ty.k === "ptr" && te.ty.elem.mode === "inline")
          fail(`an object in place at a block value in ${c.name}`);
        return t;
      }
      case "arith":
      case "bigshift":
      case "bit":
        return [val(te.a), val(te.b)].some((x) => x);
      case "farith":
        if ([val(te.a), val(te.b)].some((x) => x)) fail(`a block value as a float in ${c.name}`);
        return false;
      case "neg":
      case "bitnot":
        return val(te.a);
      case "not":
        val(te.a);
        return false;
      case "cmp":
      case "logic":
        val(te.a);
        val(te.b);
        return false;
      case "cond": {
        val(te.c);
        const a = val(te.a);
        const b = val(te.b);
        return a || b;
      }
      case "seq": {
        for (const x of te.items) val(x);
        return val(te.result);
      }
      case "index":
      case "optindex": {
        val(te.arr);
        if (val(te.idx)) fail(`a block value as an index in ${c.name}`);
        return false;
      }
      case "len":
        val(te.arr);
        return false;
      case "setindex": {
        val(te.arr);
        if (val(te.idx) || val(te.val)) fail(`a block value stored in an element by ${c.name}`);
        return false;
      }
      case "isundef":
      case "optpayload":
      case "nonnull":
      case "chkref": {
        if (val(te.val)) fail(`a block value as a reference in ${c.name}`);
        return false;
      }
      case "tableget":
        if (val(te.idx)) fail(`a block value as an index in ${c.name}`);
        return false;
      case "callind": {
        const ts = [val(te.fn), ...te.args.map(val)];
        if (ts.some((x) => x)) fail(`a block value given to a function value by ${c.name}`);
        return false;
      }
      case "new": {
        const ts = teChildren(te).map(val);
        if (ts.some((x) => x)) fail(`a block value given to a new object by ${c.name}`);
        return false;
      }
      case "call": {
        const ts = te.args.map(val);
        const inst = te.inst;
        if (own.has(inst.key)) {
          ts.forEach((t, i) => {
            const p = inst.params[i];
            if (t && p !== undefined && !taintedVars.has(p)) {
              taintedVars.add(p);
              changed = true;
            }
          });
          return taintedRets.has(inst.key);
        }
        if (heapMethod(inst, "allocBytes")) {
          if (ts.slice(1).some((x) => x)) fail(`a block value as a size in ${c.name}`);
          return true;
        }
        if (heapMethod(inst, "freeBytes")) {
          if (ts[0] === true || ts[2] === true) fail(`a block value as a size in ${c.name}`);
          return false;
        }
        if (ts.some((x) => x))
          fail(`a block value given to ${inst.display ?? inst.key} by ${c.name}`);
        return false;
      }
      case "builtin": {
        const ts = te.args.map(val);
        if (te.name.startsWith("unsafe.") && !BUILTINS_OK.has(te.name)) {
          fail(`${c.name}'s methods use ${te.name}`);
          return false;
        }
        const mode = te.info?.elem?.mode;
        switch (te.name) {
          case "ptr.add":
            if (ts[1] === true) fail(`a block value as a count in ${c.name}`);
            return ts[0] === true;
          case "ptr.read":
            if (ts[0] === true && mode === "inline")
              fail(`an object in place in a block in ${c.name}`);
            return false;
          case "ptr.write":
            if (ts[0] === true && mode === "inline")
              fail(`an object in place in a block in ${c.name}`);
            if (ts[1] === true) fail(`a block value written to memory by ${c.name}`);
            return false;
          case "unsafe.copy":
          case "unsafe.addrInCallRegion":
          case "unsafe.inCallRegion":
            return false;
          case "unsafe.callRegionBytes":
            return true;
          case "unsafe.slice":
          case "arr.subarray":
          case "arr.fill":
            if (ts.slice(1).some((x) => x)) fail(`a block value as a bound in ${c.name}`);
            return ts[0] === true;
          case "arr.set":
            if (ts.slice(1).some((x) => x)) fail(`a block value copied by ${c.name}`);
            return false;
          default:
            if (ts.some((x) => x)) fail(`a block value given to ${te.name} by ${c.name}`);
            return false;
        }
      }
      default:
        for (const x of teChildren(te)) val(x);
        return false;
    }
  };
  let changed = true;
  const stmts = (list: Stmt[], m: FuncInst): void => {
    for (const s of list) {
      switch (s.k) {
        case "let":
          if (s.init !== null && val(s.init) && !taintedVars.has(s.v)) {
            taintedVars.add(s.v);
            changed = true;
          }
          break;
        case "return":
          if (s.val !== null && val(s.val) && !taintedRets.has(m.key)) {
            taintedRets.add(m.key);
            changed = true;
          }
          break;
        case "switch":
          val(s.val);
          for (const cl of s.clauses) for (const k of cl.keys) val(k);
          break;
        case "using":
        case "try":
          fail(`${c.name}'s methods hold a ${s.k}`);
          break;
        default:
          for (const e of stmtExprs(s)) val(e);
      }
      for (const b of stmtBodies(s)) stmts(b, m);
    }
  };
  for (const m of methods) {
    let closure = false;
    walkTE(
      m.body,
      (te) => {
        if (te.k === "closure") closure = true;
      },
      false,
    );
    if (closure) return `${c.name}'s method ${m.display ?? m.key} makes a closure`;
  }
  for (let round = 0; changed && round < 64; round++) {
    changed = false;
    for (const m of methods) stmts(m.body, m);
  }
  if (changed) return `${c.name}'s block values didn't settle`;
  checking = true;
  for (const m of methods) stmts(m.body, m);
  if (why !== null) return why;
  // A result that's a block value goes only to C's own methods.
  if (!escapeFault())
    for (const k of taintedRets) {
      const from = callers.get(k);
      if (from !== undefined && [...from].some((o) => o !== c.key))
        return `${c.name}'s method ${k} gives a block value to code outside ${c.name}`;
    }
  return null;
}
