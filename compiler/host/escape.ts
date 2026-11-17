// Whole-program escape checking (SPEC 3.5) and @tsl.noalloc verification (SPEC 3.7). Each function gets a summary:
// which parameters it can store, which its result can derive from. Those settle to a fixed point, and then every
// error names the storing line and the calls leading there (SPEC 12.1, risk 14). The same analysis decides where a
// generation check goes: a reference loaded from memory gets one at each member access, and a reference whose
// object was known to be live when it was obtained doesn't (SPEC 3.5, 3.10 divergence 5).
import ts from "typescript";
import type { DiagSink } from "./diag.ts";
import { computeCaptures } from "./lower-native.ts";
import { classMemory, type MemorySetting } from "./program.ts";
import { isCountedExactly, stackTagged } from "./expand-rc.ts";
import { r9Off } from "./down-model.ts";
import type {
  ClassInst,
  ClsField,
  FuncInst,
  GenCheck,
  Stmt,
  TE,
  TypedModule,
  Var,
} from "./types.ts";
import { stmtBodies, stmtExprs, teChildren, walkTE } from "./walk.ts";

/** A class tagged `@tsl.sharedSlots`: what it places shares slots with every other class it places (R1b). */
function sharesSlots(decl: unknown): boolean {
  const d = decl as ts.Node | undefined;
  if (d === undefined || typeof d.getSourceFile !== "function") return false;
  return /@tsl\.sharedSlots\b/.test(d.getSourceFile().text.slice(d.getFullStart(), d.getStart()));
}

const STACK = 1; // a stack object: it's gone at return
const ARENA = 2; // lent by an arena: it's gone at the arena's scope exit
const VIEW = 4; // over(), viewAt(), .at(), or an object held in place in another: no generation prefix
const LOADED = 8; // came out of memory: may be stale by now
const FRESH = 16; // from a slab just now: known live when obtained
const STATIC = 32; // a top-level object: lives forever
const UNKNOWN = 64; // from a function value, or a closure's parameter: no stack object gets there
const CLOSURE = 128; // a capturing closure
const LOOPNEW = 256; // a stack object made in a loop, whose slot is reused per iteration
// In a package with a memory mode (SPEC 3.5): a `new` that's a stack object unless something makes it escape,
// and then it's in the mode's allocator. LEAKED has a prefix and never goes stale. RAW has neither.
const HEAPABLE = 512;
const LEAKED = 1024;
const RAW = 2048;
const DANGLES = STACK | ARENA | VIEW | HEAPABLE;
const ERRORS = STACK | ARENA | VIEW;

interface Origin {
  flags: number;
  params: Set<number>;
  site?: string;
  news?: Set<NewTE>; // the HEAPABLE sites this can be
  // What a parameter can be, across every call in the program. It decides where generation checks go. It's not
  // what errors are about: a call that passes a stack object to a storing parameter is reported at that call.
  soft?: number;
}

interface Witness {
  at: string; // the storing line, or the call that passes it on
  via?: { callee: FuncInst; param: number };
}

interface Summary {
  stored: Map<number, Witness>;
  // Stored in a field of `this` and nowhere else: fine if `this` is a stack object in a frame the value outlives (SPEC 3.5).
  intoThis: Map<number, { w: Witness; fields: Set<ClsField> }>;
  returned: Set<number>;
  retFlags: number;
}

interface Scope {
  f: FuncInst;
  vars: Map<Var, Origin>;
  loopDepth: number;
  closureDepth: number;
  captured?: Set<Var>; // what the closure being scanned captures
}

type NewTE = Extract<TE, { k: "new" }>;

function none(): Origin {
  return { flags: 0, params: new Set() };
}

function mergeInto(a: Origin, b: Origin): boolean {
  let changed = false;
  if ((a.flags | b.flags) !== a.flags) {
    a.flags |= b.flags;
    changed = true;
  }
  for (const p of b.params) {
    if (!a.params.has(p)) {
      a.params.add(p);
      changed = true;
    }
  }
  if (a.site === undefined && b.site !== undefined) a.site = b.site;
  if (b.news !== undefined) {
    a.news ??= new Set();
    for (const n of b.news) {
      if (!a.news.has(n)) {
        a.news.add(n);
        changed = true;
      }
    }
  }
  if (b.soft !== undefined && ((a.soft ?? 0) | b.soft) !== (a.soft ?? 0)) {
    a.soft = (a.soft ?? 0) | b.soft;
    changed = true;
  }
  return changed;
}

function merged(...list: Origin[]): Origin {
  const out = none();
  for (const o of list) mergeInto(out, o);
  return out;
}

function holdsReference(te: TE): boolean {
  const k = te.ty.k;
  return (
    k === "cls" ||
    k === "fn" ||
    k === "larr" ||
    k === "bits" ||
    k === "arr" ||
    k === "rec" ||
    k === "union" ||
    k === "ptr"
  );
}

export function checkEscapes(tm: TypedModule, sink: DiagSink, lowered?: MemorySetting): void {
  computeCaptures(tm);
  const e = new Escape(tm, sink);
  e.lowered = lowered;
  e.run();
}

class Escape {
  tm: TypedModule;
  sink: DiagSink;
  summaries = new Map<FuncInst, Summary>();
  incoming = new Map<FuncInst, number[]>();
  scopes = new Map<FuncInst, Scope>();
  changed = false;
  emit = false;
  heapified = false;
  siteMode = new Map<NewTE, "leak" | "manual">();
  placed = new Set<unknown>(); // classes a Slab can hold, or anything else that places objects in slots
  // Classes placed by a class tagged `@tsl.sharedSlots` (@tsl/gc's Rc, 3.5, R1b): their slots hold objects of any class over
  // time, so a stale reference to one could read another class's fields, and every use is checked, wherever it came from.
  shared = new Set<unknown>();
  fieldsOnStack = new Set<ClsField>(); // fields a stack object was put in: what's read from one is a stack object, unchecked
  moved = new Set<TE>(); // a `new` moved into place by @tsl.moves: it won't stay a stack object
  lowered: MemorySetting | undefined; // a lowered build's mode, which every function in it has (tslc.ts)

  constructor(tm: TypedModule, sink: DiagSink) {
    this.tm = tm;
    this.sink = sink;
  }

  classMemory(c: ClassInst): MemorySetting {
    const m = classMemory((c.decl as ts.Node).getSourceFile().fileName);
    // A lowered build gives every function its mode, a library's too, so a library's class with a mode of its own, such
    // as @tsl/jsrt's JsString (D67), has the build's: its objects are made in that mode's heap.
    return this.lowered !== undefined && m !== "strict" ? this.lowered : m;
  }

  /**
   * Objects of a class with a tail (D69). One is only ever on the heap, at its real size: `withTail(n, new T())` takes its
   * package's heap, whatever it escapes to, and is TSL3012 where there's none (`strict`). The one other way to make one is
   * a direct `new` moved into a `@tsl.tailed` parameter, which `placeTail` puts in a slot; moved anywhere else it would be
   * copied by its fixed size (`Slab.add`, `Rc.make`), which is TSL3011. A `new` of one anywhere else is TSL3012.
   */
  tails(): void {
    const report = (at: string | undefined, code: string, msg: string): void => {
      const m = at !== undefined ? /^(.*):(\d+):(\d+)$/.exec(at) : null;
      if (m !== null)
        this.sink.add({ code, file: m[1]!, line: Number(m[2]), col: Number(m[3]), msg });
    };
    const ok = new Set<TE>();
    for (const f of this.tm.funcs) {
      walkTE(
        f.body,
        (te) => {
          if (te.k !== "call" || te.inst.moves === undefined) return;
          te.args.forEach((a, i) => {
            if (a.k !== "new" || a.c.tail === undefined || te.inst.moves?.includes(i) !== true)
              return;
            ok.add(a);
            if (te.inst.tailMoves?.includes(i) === true) return;
            // `tmk milestone pipe-d`'s injected bug: a copy by fixed size not rejected. Never set otherwise.
            if (process.env.TMK_TEST_TSL === "tail-moves-unchecked") return;
            report(
              te.argAts?.[i] ?? a.at,
              "TSL3011",
              `${a.c.name} has a tail, so it's held by reference only: ${te.inst.display ?? te.inst.key} moves ${this.paramName(te.inst, i)} into place by its fixed size`,
            );
          });
        },
        true,
      );
    }
    for (const f of this.tm.funcs) {
      walkTE(
        f.body,
        (te) => {
          if (te.k !== "new" || te.c.tail === undefined || ok.has(te)) return;
          if (te.tail === undefined) {
            report(
              te.at,
              "TSL3012",
              `${te.c.name} has a tail, so an object of it is made with withTail(n, new ${te.c.name}(…)), on the heap at its real size`,
            );
          } else if (f.memory === undefined) {
            report(
              te.at,
              "TSL3012",
              `${te.c.name} has a tail, and an object with a tail is only ever on the heap: this package is strict, so it has none (an Rc store's makeTail has one)`,
            );
          } else te.heap = f.memory;
        },
        true,
      );
    }
  }

  heapify(o: Origin): void {
    for (const n of o.news ?? []) {
      if (n.heap === undefined) {
        n.heap = this.siteMode.get(n)!;
        this.changed = true;
        this.heapified = true;
      }
    }
  }

  run(): void {
    const roots = this.tm.funcs.filter((f) => f.isClosure !== true);
    for (const f of this.tm.funcs) {
      walkTE(
        f.body,
        (te) => {
          if (
            te.k === "builtin" &&
            (te.name === "unsafe.place" ||
              te.name === "unsafe.placeTail" ||
              te.name === "unsafe.objectAt") &&
            te.ty.k === "cls"
          ) {
            this.placed.add(te.ty.c);
            if (te.name !== "unsafe.objectAt" && sharesSlots(f.owner?.decl))
              this.shared.add(te.ty.c);
          }
        },
        true,
      );
    }
    this.tails();
    // A `new` found to escape changes what everything downstream can be, so that's worked out again from
    // nothing, with those decisions fixed. Nothing else un-learns a fact. The bound is a guard.
    for (let pass = 0; pass < 16; pass++) {
      this.heapified = false;
      for (const f of roots) {
        this.summaries.set(f, {
          stored: new Map(),
          intoThis: new Map(),
          returned: new Set(),
          retFlags: 0,
        });
        this.incoming.set(
          f,
          f.params.map(() => 0),
        );
        this.scopes.set(f, { f, vars: new Map(), loopDepth: 0, closureDepth: 0 });
      }
      // Monotonic over finite sets, so this settles. The bound is the guard against a mistake in that.
      for (let round = 0; round < 64; round++) {
        this.changed = false;
        for (const f of roots) this.scan(f);
        if (!this.changed) break;
      }
      if (!this.heapified) break;
    }
    this.emit = true;
    for (const f of roots) this.scan(f);
    this.checkNoAlloc(roots);
  }

  scan(f: FuncInst): void {
    const sc = this.scopes.get(f)!;
    sc.loopDepth = 0;
    sc.closureDepth = 0;
    const inc = this.incoming.get(f)!;
    f.params.forEach((p, i) => {
      // `this` is checked where the call is made, so inside a method it's a plain local.
      const isThis = i === 0 && f.owner !== undefined;
      const o: Origin = {
        flags: isThis ? FRESH : 0,
        params: new Set([i]),
        soft: isThis ? 0 : inc[i]!,
      };
      this.mergeVar(sc, p, o);
    });
    this.stmts(sc, f.body);
  }

  mergeVar(sc: Scope, v: Var, o: Origin): void {
    let cur = sc.vars.get(v);
    if (cur === undefined) {
      cur = none();
      sc.vars.set(v, cur);
      this.changed = true;
    }
    if (mergeInto(cur, o)) this.changed = true;
  }

  err(at: string | undefined, code: string, msg: string): void {
    if (!this.emit || at === undefined) return;
    const m = /^(.*):(\d+):(\d+)$/.exec(at);
    if (m === null) return;
    this.sink.add({ code, file: m[1]!, line: Number(m[2]), col: Number(m[3]), msg });
  }

  // --- what a value can be

  origin(sc: Scope, te: TE): Origin {
    switch (te.k) {
      case "var":
        return sc.vars.get(te.v) ?? none();
      case "global":
        if (te.g.object !== undefined) return { flags: STATIC, params: new Set() };
        return {
          flags:
            te.ty.k === "cls" || te.ty.k === "ptr"
              ? LOADED | (te.g.memory === "manual" && te.ty.k === "cls" ? RAW : 0)
              : 0,
          params: new Set(),
        };
      case "ofield": {
        if (te.f.store === "value") {
          if (this.fieldsOnStack.has(te.f)) return { flags: STACK, params: new Set(), soft: STACK };
          const raw = te.ty.k === "cls" && this.classMemory(te.c) === "manual" ? RAW : 0;
          return { flags: te.ty.k === "cls" ? LOADED | raw : 0, params: new Set() };
        }
        // An object held in place lives as long as the one around it.
        const o = this.origin(sc, te.obj);
        return {
          flags: VIEW | (o.flags & (STACK | ARENA | LOOPNEW | HEAPABLE)),
          params: new Set(o.params),
          ...(o.site !== undefined ? { site: o.site } : {}),
          ...(o.news !== undefined ? { news: o.news } : {}),
        };
      }
      case "new":
        if (te.heap !== undefined) {
          return {
            flags: te.heap === "manual" ? RAW : LEAKED,
            params: new Set(),
            ...(te.at !== undefined ? { site: te.at } : {}),
          };
        }
        if (sc.f.memory !== undefined && te.into === null) {
          this.siteMode.set(te, sc.f.memory);
          return {
            flags: HEAPABLE | (sc.loopDepth > 0 ? LOOPNEW : 0),
            params: new Set(),
            news: new Set([te]),
            ...(te.at !== undefined ? { site: te.at } : {}),
          };
        }
        // the injected bug (TMK_TEST_TSL=r18-stack-unchecked): a `@tsl.stack` class's `new` (R18) not taken as a stack
        // object, so nothing it escapes to is refused
        if (
          process.env.TMK_TEST_TSL === "r18-stack-unchecked" &&
          ts.isClassDeclaration(te.c.decl as ts.Node) &&
          stackTagged(te.c.decl as ts.ClassDeclaration)
        )
          return { flags: 0, params: new Set() };
        return {
          flags: STACK | (sc.loopDepth > 0 ? LOOPNEW : 0),
          params: new Set(),
          ...(te.at !== undefined ? { site: te.at } : {}),
        };
      case "closure":
        return {
          flags: (te.inst.captures?.length ?? 0) > 0 ? CLOSURE : 0,
          params: new Set(),
          ...(te.at !== undefined ? { site: te.at } : {}),
        };
      case "conv":
      case "nonnull":
      case "chkref":
        return this.origin(sc, te.val);
      // R9: in a lowered package, a typed array's pointer (@tsl/lowered's `part`), an element's address past it, and a
      // typed array made of such a pointer (`pack`, as `subarray` prints) are of the object whose storage it is
      case "slice":
        return r9Off("escape") ? none() : this.origin(sc, te.val);
      case "elemaddr":
        return r9Off("escape") ? none() : this.origin(sc, te.base);
      case "tuple":
        return te.ty.k === "arr" && te.items[0] !== undefined && !r9Off("escape")
          ? this.origin(sc, te.items[0])
          : none();
      case "setvar":
        return this.origin(sc, te.val);
      case "seq":
        return this.origin(sc, te.result);
      case "blockexpr":
        return this.origin(sc, te.result);
      case "cond":
        return merged(this.origin(sc, te.a), this.origin(sc, te.b));
      case "record":
      case "ulit":
        return merged(...te.fields.map((f) => this.origin(sc, f.val)));
      case "field":
        return this.origin(sc, te.obj);
      case "call": {
        const s = this.summaries.get(te.inst);
        if (s === undefined) return none();
        const out: Origin = { flags: s.retFlags, params: new Set() };
        for (const p of s.returned) {
          const a = te.args[p];
          if (a !== undefined) mergeInto(out, this.origin(sc, a));
        }
        return out;
      }
      case "callind":
        return { flags: UNKNOWN, params: new Set() };
      case "builtin":
        return this.builtinOrigin(sc, te);
      default:
        return none();
    }
  }

  builtinOrigin(sc: Scope, te: Extract<TE, { k: "builtin" }>): Origin {
    switch (te.name) {
      case "ptr.read":
        if (te.info?.elem?.mode === "ref") {
          return { flags: LOADED | (sc.f.memory === "manual" ? RAW : 0), params: new Set() };
        }
        if (te.info?.elem?.mode === "inline") return { flags: VIEW, params: new Set() };
        return none();
      case "unsafe.place":
      case "unsafe.objectAt":
        return { flags: FRESH, params: new Set() };
      case "unsafe.viewAt":
        return { flags: VIEW, params: new Set() };
      case "layout.over":
      case "layout.at":
      case "arr.subarray":
      case "arr.fill": {
        const o = this.origin(sc, te.args[0]!);
        const keep = te.name === "layout.over" || te.name === "layout.at" ? VIEW : 0;
        return {
          flags: keep | (o.flags & (STACK | ARENA | LOOPNEW)),
          params: new Set(o.params),
          ...(o.site !== undefined ? { site: o.site } : {}),
        };
      }
      case "arena.make":
      case "arena.take":
        return { flags: ARENA, params: new Set(), ...(te.at !== undefined ? { site: te.at } : {}) };
      default:
        return none();
    }
  }

  // --- statements

  stmts(sc: Scope, list: Stmt[]): void {
    for (const s of list) this.stmt(sc, s);
  }

  stmt(sc: Scope, s: Stmt): void {
    const isLoop = s.k === "while" || s.k === "do" || s.k === "for" || s.k === "forof";
    if (s.k === "for") {
      this.stmts(sc, s.init);
      sc.loopDepth++;
      for (const e of stmtExprs(s)) this.visit(sc, e);
      this.stmts(sc, s.body);
      sc.loopDepth--;
      return;
    }
    if (isLoop) sc.loopDepth++;
    for (const e of stmtExprs(s)) this.visit(sc, e);
    if (s.k === "let") {
      if (s.init !== null) {
        const o = this.origin(sc, s.init);
        if (!s.constant && (o.flags & LOOPNEW) !== 0 && (o.flags & HEAPABLE) !== 0) this.heapify(o);
        else if (!s.constant && (o.flags & LOOPNEW) !== 0) {
          this.err(
            s.at ?? o.site,
            "TSL3007",
            `a stack object made in a loop is bound to a let (${s.v.name}): its slot is reused per iteration, so bind it to a const inside the loop`,
          );
        }
        this.mergeVar(sc, s.v, o);
      }
    } else if (s.k === "forof") {
      this.mergeVar(sc, s.v, none());
    } else if (s.k === "return") {
      this.ret(sc, s);
    }
    for (const b of stmtBodies(s)) this.stmts(sc, b);
    if (isLoop) sc.loopDepth--;
  }

  ret(sc: Scope, s: Extract<Stmt, { k: "return" }>): void {
    if (s.val === null || !holdsReference(s.val)) return;
    const o = this.origin(sc, s.val);
    if ((o.flags & HEAPABLE) !== 0) this.heapify(o);
    if ((o.flags & CLOSURE) !== 0) {
      this.err(
        s.at,
        "TSL3003",
        `a capturing closure can't be returned: it can only be passed down or called${o.site !== undefined ? `. It's made at ${o.site}` : ""}`,
      );
    }
    if ((o.flags & (STACK | ARENA)) !== 0) {
      const what = (o.flags & STACK) !== 0 ? "stack object" : "arena loan";
      this.err(
        s.at,
        "TSL3002",
        `this returns a ${what}${o.site !== undefined ? ` made at ${o.site}` : ""}, which is gone once the ${(o.flags & STACK) !== 0 ? "function returns" : "arena's scope ends"}. Put it in a Slab to make it last`,
      );
    }
    if (sc.closureDepth > 0) {
      // What a closure returns goes wherever its caller puts it: count it as stored.
      for (const p of o.params) this.markStored(sc, p, { at: s.at ?? "" });
      return;
    }
    const sum = this.summaries.get(sc.f)!;
    for (const p of o.params) {
      if (!sum.returned.has(p)) {
        sum.returned.add(p);
        this.changed = true;
      }
    }
    const flags = o.flags & (VIEW | LOADED | FRESH | STATIC | UNKNOWN | LEAKED | RAW);
    if ((sum.retFlags | flags) !== sum.retFlags) {
      sum.retFlags |= flags;
      this.changed = true;
    }
  }

  markStored(sc: Scope, p: number, w: Witness): void {
    const sum = this.summaries.get(sc.f)!;
    if (!sum.stored.has(p)) {
      sum.stored.set(p, w);
      this.changed = true;
    }
  }

  /** The storing line, and the calls that lead to it. */
  chain(callee: FuncInst, param: number): string {
    const parts: string[] = [];
    let f = callee;
    let p = param;
    for (let guard = 0; guard < 16; guard++) {
      const sum = this.summaries.get(f);
      const w = sum?.stored.get(p) ?? sum?.intoThis.get(p)?.w;
      const name = `${f.display ?? f.key}, parameter ${this.paramName(f, p)}`;
      if (w === undefined) {
        parts.push(name);
        break;
      }
      if (w.via === undefined) {
        parts.push(`${name}, which stores it at ${w.at}`);
        break;
      }
      parts.push(`${name}, which passes it on at ${w.at}`);
      f = w.via.callee;
      p = w.via.param;
    }
    return parts.join(" -> ");
  }

  paramName(f: FuncInst, p: number): string {
    return f.params[p]?.name ?? String(p);
  }

  /** Something stores this value here: a field, a global, through a pointer, or a function value. */
  store(sc: Scope, val: TE, at: string | undefined, where: string, into?: MemorySetting): void {
    if (val.ty.k === "arr" || !holdsReference(val)) return;
    const o = this.origin(sc, val);
    if ((o.flags & HEAPABLE) !== 0) this.heapify(o);
    const target = into ?? sc.f.memory ?? "strict";
    const rawFlags = sc.f.memory === "manual" ? o.flags | (o.soft ?? 0) : o.flags;
    if ((rawFlags & RAW) !== 0 && target !== "manual") {
      this.err(at, "TSL3008", this.rawMessage(`stored ${where}`));
    }
    if ((o.flags & CLOSURE) !== 0) {
      this.err(
        at,
        "TSL3003",
        `a capturing closure can't be stored (${where}): it can only be passed down or called${o.site !== undefined ? `. It's made at ${o.site}` : ""}`,
      );
    }
    if ((o.flags & ERRORS) !== 0) {
      this.err(
        at,
        "TSL3001",
        `${this.describe(o)} can't be stored (${where}): the reference would outlive it. Put it in a Slab to make it last`,
      );
    }
    for (const p of o.params) this.markStored(sc, p, { at: at ?? "" });
  }

  rawMessage(what: string): string {
    return `a raw reference from a "memory": "manual" package can't be ${what}: nothing could check its generation there, so its object could be freed under a safe package. Wrap it in a safe API that hands out values`;
  }

  describe(o: Origin): string {
    const site = o.site !== undefined ? ` made at ${o.site}` : "";
    if ((o.flags & STACK) !== 0) return `this stack object${site}`;
    if ((o.flags & ARENA) !== 0) return `this arena loan${site}`;
    return `this view${site}`;
  }

  holdOnStack(f: ClsField): void {
    if (!this.fieldsOnStack.has(f)) {
      this.fieldsOnStack.add(f);
      this.changed = true;
    }
  }

  /** A stack object of this frame, as opposed to anything that could outlive it. */
  isStackHere(sc: Scope, te: TE): boolean {
    if (te.k === "new") return te.into === null && !this.moved.has(te) && sc.f.memory === undefined;
    const o = this.origin(sc, te);
    return (o.flags & STACK) !== 0 && (o.flags & (HEAPABLE | LOADED)) === 0 && o.params.size === 0;
  }

  passes(
    sc: Scope,
    callee: FuncInst,
    index: number,
    arg: TE,
    at: string | undefined,
    stackReceiver = false,
  ): void {
    if (!holdsReference(arg)) return;
    const o = this.origin(sc, arg);
    // Whole-program facts about what a parameter can be.
    const inc = this.incoming.get(callee);
    if (inc !== undefined && inc[index] !== undefined) {
      const add = (o.flags | (o.soft ?? 0)) & ~CLOSURE;
      if ((inc[index] | add) !== inc[index]) {
        inc[index] |= add;
        this.changed = true;
      }
    }
    if (arg.ty.k === "arr") return;
    const sum = this.summaries.get(callee);
    const into = sum?.intoThis.get(index);
    if (
      into !== undefined &&
      stackReceiver &&
      (o.flags & (HEAPABLE | ARENA | CLOSURE | RAW | LOOPNEW)) === 0
    ) {
      // Held by a stack object of this frame, which goes before anything it could be holding here.
      if ((o.flags & (STACK | VIEW)) !== 0 || ((o.soft ?? 0) & (STACK | VIEW)) !== 0) {
        for (const f of into.fields) this.holdOnStack(f);
      }
      return;
    }
    const w = sum?.stored.get(index) ?? into?.w;
    if (w === undefined) return;
    const moved = callee.moves?.includes(index) === true;
    if (moved) return;
    if ((o.flags & HEAPABLE) !== 0) this.heapify(o);
    if (
      callee.memory !== "manual" &&
      ((o.flags | (sc.f.memory === "manual" ? (o.soft ?? 0) : 0)) & RAW) !== 0
    ) {
      this.err(at, "TSL3008", this.rawMessage(`passed to ${this.chain(callee, index)}`));
    }
    if ((o.flags & CLOSURE) !== 0) {
      this.err(
        at,
        "TSL3003",
        `a capturing closure is passed to ${this.chain(callee, index)}. A closure can't be stored`,
      );
    }
    if ((o.flags & ERRORS) !== 0) {
      this.err(
        at,
        "TSL3001",
        `${this.describe(o)} is passed to ${this.chain(callee, index)}. The stored reference would outlive it, so put it in a Slab`,
      );
    }
    for (const p of o.params)
      this.markStored(sc, p, { at: at ?? "", via: { callee, param: index } });
  }

  isMove(arg: TE): boolean {
    let cur = arg;
    for (let g = 0; g < 16 && (cur.k === "conv" || cur.k === "nonnull"); g++) cur = cur.val;
    return cur.k === "new" && cur.into === null;
  }

  /** A function's own `@tsl.moves` parameter passed on to another: still one object, moved once (SPEC 3.5). */
  isOwnMove(sc: Scope, arg: TE): boolean {
    let cur = arg;
    for (let g = 0; g < 16 && (cur.k === "conv" || cur.k === "nonnull"); g++) cur = cur.val;
    if (cur.k !== "var") return false;
    const at = sc.f.params.indexOf(cur.v);
    return at >= 0 && sc.f.moves?.includes(at) === true;
  }

  /**
   * `holder.f = x` with both stack objects of this frame, or `this.f = param` in a method, whose caller decides (SPEC 3.5).
   * A holder from anywhere else could outlive x, and x made in a loop has its slot reused, so those stay errors.
   */
  storeOnStack(sc: Scope, te: Extract<TE, { k: "osetfield" }>): boolean {
    if (!holdsReference(te.val) || te.val.ty.k === "arr") return false;
    const o = this.origin(sc, te.val);
    if (
      sc.closureDepth === 0 &&
      sc.f.owner !== undefined &&
      sc.f.memory === undefined &&
      te.obj.k === "var" &&
      te.obj.v === sc.f.params[0] &&
      o.params.size > 0 &&
      (o.flags & ~(LOADED | FRESH | STATIC | UNKNOWN)) === 0
    ) {
      const sum = this.summaries.get(sc.f)!;
      for (const p of o.params) {
        const hit = sum.intoThis.get(p);
        if (hit === undefined) {
          sum.intoThis.set(p, { w: { at: te.at ?? "" }, fields: new Set([te.f]) });
          this.changed = true;
        } else if (!hit.fields.has(te.f)) {
          hit.fields.add(te.f);
          this.changed = true;
        }
      }
      return true;
    }
    if (
      (o.flags & (STACK | VIEW)) !== 0 &&
      (o.flags & (HEAPABLE | ARENA | CLOSURE | RAW | LOOPNEW)) === 0 &&
      this.isStackHere(sc, te.obj)
    ) {
      this.holdOnStack(te.f);
      return true;
    }
    return false;
  }

  visit(sc: Scope, te: TE): void {
    if (te.k === "call") {
      te.args.forEach((a, i) => {
        if (te.inst.moves?.includes(i) === true) this.moved.add(a);
      });
    }
    for (const c of teChildren(te)) this.visit(sc, c);
    switch (te.k) {
      case "setvar": {
        const o = this.origin(sc, te.val);
        // A slice lent to a closure ends with the call (SPEC 3.5). A local outside the closure would outlive the loan,
        // and a buffer can move once it's over. A static array is the one thing that's fine to keep there.
        if (te.val.ty.k === "arr" && sc.captured?.has(te.v) === true && te.val.k !== "global") {
          this.err(
            te.at ?? sc.f.at,
            "TSL3003",
            `a slice given to a closure can't be kept in ${te.v.name}, outside it: the slice ends with the call`,
          );
        }
        if ((o.flags & LOOPNEW) !== 0 && (o.flags & HEAPABLE) !== 0) {
          if (!te.v.name.startsWith("$t")) this.heapify(o);
        } else if ((o.flags & LOOPNEW) !== 0 && !te.v.name.startsWith("$t")) {
          this.err(
            te.at ?? o.site,
            "TSL3007",
            `a stack object made in a loop flows out to ${te.v.name}: its slot is reused per iteration, so JS would see a different object. Bind it to a const inside the loop`,
          );
        }
        this.mergeVar(sc, te.v, o);
        return;
      }
      case "osetfield":
        if (this.storeOnStack(sc, te)) {
          if (this.emit) te.check = this.isChecked(sc, te.obj);
          return;
        }
        this.store(sc, te.val, te.at, `in ${te.c.name}.${te.f.name}`, this.classMemory(te.c));
        if (this.emit) te.check = this.isChecked(sc, te.obj);
        return;
      case "ofield":
        if (this.emit) te.check = this.isChecked(sc, te.obj);
        return;
      case "conv": {
        // R9: a typed array's pointer made an integer (`cast<usize>(part<Ref>(a, 0, 1))`, a lowered package's typed-array
        // field or module state): nothing follows it from there, so the object whose storage the array is outlives this
        // frame, on the heap
        if (
          (te.ty.k === "int" || te.ty.k === "big") &&
          (te.val.k === "slice" || te.val.k === "elemaddr") &&
          !r9Off("escape")
        ) {
          const o = this.origin(sc, te.val);
          if ((o.flags & HEAPABLE) !== 0 && process.env.TMK_TEST_TSL !== "view-int-unheaped")
            this.heapify(o);
        }
        return;
      }
      case "chkref":
        if (this.emit) te.check = this.isChecked(sc, te.val);
        return;
      case "setglobal":
        this.store(sc, te.val, te.at, `in the global ${te.g.jsName}`);
        return;
      case "builtin":
        if (te.name === "ptr.write" && te.info?.elem?.mode === "ref") {
          this.store(sc, te.args[1]!, te.at, "through a Ptr");
        }
        if (te.name === "unsafe.free") {
          const o = this.origin(sc, te.args[0]!);
          if ((o.flags & HEAPABLE) !== 0) this.heapify(o);
          if ((o.flags & (STACK | ARENA | VIEW | STATIC | FRESH | LEAKED)) !== 0) {
            this.err(
              te.at,
              "TSL5008",
              "unsafeFree takes an object this package's heap allocated: this one came from a Slab, an arena or a view, or is static",
            );
          }
        }
        if (te.name === "unsafe.addrOf") {
          const o = this.origin(sc, te.args[0]!);
          if ((o.flags & (VIEW | STATIC)) === 0 || (o.flags & (STACK | ARENA)) !== 0) {
            this.err(
              te.at,
              "TSL5005",
              "addrOf takes a layout-class object in host-visible memory, from viewAt or staticView",
            );
          }
        }
        return;
      case "call":
        te.args.forEach((a, i) => {
          const at = te.argAts?.[i] ?? te.at;
          const recv = te.inst.owner !== undefined && i > 0 && this.isStackHere(sc, te.args[0]!);
          if (te.inst.moves?.includes(i) === true && !this.isMove(a) && !this.isOwnMove(sc, a)) {
            this.err(
              at,
              "TSL3006",
              `${te.inst.display ?? te.inst.key} moves ${this.paramName(te.inst, i)} into place, so it takes a direct new or make: JS would otherwise see one object where native code has two`,
            );
          }
          this.passes(sc, te.inst, i, a, at, recv);
        });
        return;
      case "callind":
        for (const a of te.args) {
          // A parameter of function type is assumed to store whatever it's given (SPEC 3.5).
          this.store(
            sc,
            a,
            te.at,
            "passed to a function value, which is assumed to store what it's given",
          );
        }
        return;
      case "new":
        if (te.ctor !== null) {
          const recv = this.isStackHere(sc, te);
          te.args.forEach((a, i) => {
            this.passes(sc, te.ctor!, i + 1, a, te.argAts[i] ?? te.at, recv);
          });
          // The object itself goes in as `this`: a constructor that stores it escapes it.
          if (te.into === null) {
            const w = this.summaries.get(te.ctor)?.stored.get(0);
            if (w !== undefined && te.heap === undefined && sc.f.memory !== undefined) {
              this.siteMode.set(te, sc.f.memory);
              this.heapify({ flags: HEAPABLE, params: new Set(), news: new Set([te]) });
            } else if (w !== undefined && te.heap === undefined) {
              this.err(
                te.at,
                "TSL3001",
                `this stack object is stored by its own constructor: ${this.chain(te.ctor, 0)}`,
              );
            }
          }
        }
        return;
      case "closure": {
        const inner = te.inst;
        for (const p of inner.params) {
          this.mergeVar(sc, p, { flags: UNKNOWN, params: new Set() });
        }
        const saved = sc.loopDepth;
        const savedCaptured = sc.captured;
        sc.captured = new Set(inner.captures ?? []);
        sc.loopDepth = 0;
        sc.closureDepth++;
        this.stmts(sc, inner.body);
        sc.closureDepth--;
        sc.loopDepth = saved;
        sc.captured = savedCaptured;
        return;
      }
      case "cmp": {
        if (te.a.ty.k !== "cls" || te.b.ty.k !== "cls") return;
        if (te.a.k === "lit" || te.b.k === "lit") return;
        if (
          ((this.origin(sc, te.a).flags | this.origin(sc, te.b).flags) & (STACK | HEAPABLE)) !==
          0
        ) {
          this.err(
            te.at,
            "TSL2020",
            "a stack object is compared by identity: JS sees one object per new, and native code reuses slots",
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /** A generation check needs a prefix to read, so nothing that could lack one gets it. */
  isChecked(sc: Scope, obj: TE): GenCheck {
    // Every count of an rc package's class is the expansion's, so no reference to one can be stale (3.5's proof, D74).
    if (obj.ty.k === "cls" && isCountedExactly(obj.ty.c.decl)) return false;
    // A counted slot can hold another class later: a use of what it held is checked wherever it came from (R1b).
    if (obj.ty.k === "cls" && this.shared.has(obj.ty.c)) return "tagged";
    const o = this.origin(sc, obj);
    const f = o.flags | (o.soft ?? 0);
    if ((f & LOADED) === 0 || (f & DANGLES) !== 0) return false;
    const mode = sc.f.memory;
    if (mode === undefined && (f & RAW) === 0) return true;
    // What can go stale is only ever in a slot, and every slot's class is known: the rest cost nothing.
    const slotted = obj.ty.k !== "cls" || this.placed.has(obj.ty.c);
    if (!slotted) return false;
    // Everything in a leak package has a prefix. In a manual package, a plain reference has no tag.
    return mode === "leak" && (f & RAW) === 0 ? true : "tagged";
  }

  // --- @tsl.noalloc, verified transitively (SPEC 3.7)

  /** What a function does that a @tsl.noalloc path can't, directly. Closures it makes count as its own. */
  checkNoAlloc(roots: FuncInst[]): void {
    const direct = new Map<FuncInst, { at: string; why: string }>();
    const edges = new Map<FuncInst, { callee: FuncInst; at: string }[]>();
    for (const f of roots) {
      const list: { callee: FuncInst; at: string }[] = [];
      edges.set(f, list);
      const at0 = f.at ?? "";
      const note = (at: string | undefined, why: string): void => {
        if (!direct.has(f)) direct.set(f, { at: at ?? at0, why });
      };
      walkTE(
        f.body,
        (te) => {
          if (te.k === "call") list.push({ callee: te.inst, at: te.at ?? at0 });
          if (te.k === "new" && te.ctor !== null) list.push({ callee: te.ctor, at: te.at ?? at0 });
          if (te.k === "new" && te.heap !== undefined)
            note(te.at, "this new escapes, so it allocates from the page source");
          if (te.k === "fnref") list.push({ callee: te.inst, at: te.at ?? at0 });
          if (te.k === "builtin" && te.name === "arena.new")
            note(te.at ?? te.loc, "arenaOver takes an arena");
          if (te.k === "callind") {
            let fn = te.fn;
            for (let g = 0; g < 16 && (fn.k === "nonnull" || fn.k === "conv"); g++) fn = fn.val;
            if (fn.k === "tableget") {
              for (const inst of fn.g.table ?? []) list.push({ callee: inst, at: te.at ?? at0 });
            } else if (fn.k === "ofield" || fn.k === "global") {
              note(te.at, "it calls a function value held in memory, which nothing can verify");
            }
          }
        },
        true,
      );
    }
    const closureBad = (f: FuncInst): { at: string; why: string } | null => direct.get(f) ?? null;
    const memo = new Map<FuncInst, string | null>();
    const reason = (f: FuncInst, path: FuncInst[]): string | null => {
      const hit = memo.get(f);
      if (hit !== undefined) return hit;
      if (path.includes(f)) return null;
      const d = closureBad(f);
      let out: string | null = null;
      if (d !== null) out = `${f.display ?? f.key} (${d.why}, at ${d.at})`;
      else {
        for (const e of edges.get(f) ?? []) {
          const r = reason(e.callee, [...path, f]);
          if (r !== null) {
            out = `${f.display ?? f.key} -> ${r}`;
            break;
          }
        }
      }
      memo.set(f, out);
      return out;
    };
    for (const f of roots) {
      if (!f.attrs.includes("noalloc")) continue;
      const d = direct.get(f);
      if (d !== undefined) {
        this.err(d.at, "TSL1017", `@tsl.noalloc ${f.display ?? f.key}: ${d.why}`);
      }
      for (const e of edges.get(f) ?? []) {
        const r = reason(e.callee, [f]);
        if (r !== null) {
          this.err(e.at, "TSL1017", `@tsl.noalloc ${f.display ?? f.key} can allocate: ${r}`);
        }
      }
      // Recursion anywhere on a path from here.
      const done = new Set<FuncInst>();
      const walk = (g: FuncInst, onPath: FuncInst[]): void => {
        for (const e of edges.get(g) ?? []) {
          if (onPath.includes(e.callee)) {
            this.err(
              e.at,
              "TSL1012",
              `recursion on a @tsl.noalloc path from ${f.display ?? f.key}: the stack isn't bounded`,
            );
          } else if (!done.has(e.callee)) walk(e.callee, [...onPath, e.callee]);
        }
        done.add(g);
      };
      walk(f, [f]);
    }
  }
}
