// The `rc` memory mode as a desugaring onto TSL (SPEC 3.5, D63, D74). In a package with `"memory": "rc"` a person writes
// plain classes and `new`, and this rewrites each of the package's modules into the TSL they could have written with
// `@tsl/gc`: every class instance counted in a store of its class, `new` as `make`, a copy of a reference into a field,
// global or vector as `share` or `replace`, a local's last use as `take`, and scope exit as `drop`. The result is ordinary
// TSL in a `strict` package, which tslc then compiles like any other: nothing after this knows `rc` exists, and
// `tmk compile --emit tsl` prints it.
//
// The convention is D39's. An argument is borrowed: the caller holds a count for the whole call. A result is owned: the
// caller gets one count. So every value of a counted class is either owned (from `make`, a call, `share`, or moved out of a
// vector), which someone must take over or drop, or borrowed (read from a local, a parameter, a field, a global or a
// vector), good until something overwrites where it came from. A local holds a count of its own, except where a borrow is
// provably enough: in a function that can't give up a count anywhere but the scope exit of its own locals (it's *quiet*),
// a local whose every value is read from a path rooted in a parameter, `this`, a global, or a local that outlives it,
// keeps no count. Freeing is deferred (a drop to zero only queues), and nothing the quiet function does can drop a count
// held along such a path, so what it reads stays alive until it returns.
import ts from "typescript";
import type { Diag } from "./diag.ts";
import { findTslJson, repoRelative } from "./program.ts";
import { cycleGraph } from "./cycle-graph.ts";
import { r18Off } from "./down-model.ts";

export interface RcExpansion {
  texts: Map<string, string>; // absolute path -> expanded module text
  diags: Diag[];
}

/** Whether a module is in a package whose memory mode is `rc`, and so is expanded here. */
export function isRcModule(file: string): boolean {
  const pkg = findTslJson(file);
  if (pkg === null) return false;
  // A package `tmk lower --emit tsl` printed from an `rc` program (R2): plain classes and `new`, counted the same way.
  if (pkg.lowered !== undefined) return (pkg.lowered as { memory?: unknown }).memory === "rc";
  return pkg.memory === "rc";
}

const rcModuleCache = new Map<string, boolean>();

/**
 * R19: whether a class is declared in a lowered `rc` package (`tmk lower --emit tsl`'s), which can't import @tsl/unsafe
 * (TSL1023), whose every count this expansion places (isCountedExactly), and which isn't tagged `@tsl.stack` (R18): so every
 * object of it is in a counted slot a store's `make` placed, which @tsl/gc reuses only once no reference to its object is
 * left (3.5's proof), and nothing but its own code writes its fields (tslc's markInvariantFields).
 */
export function loweredRcHeapClass(decl: unknown): boolean {
  const d = decl as ts.ClassDeclaration | undefined;
  if (d === undefined || !ts.isClassDeclaration(d)) return false;
  return isCountedExactly(d) && !stackTagged(d) && inLoweredRc(d);
}

/** Whether a declaration is in a lowered `rc` package (its tsl.json's `lowered.memory`). */
function inLoweredRc(d: ts.Node): boolean {
  const sf = d.getSourceFile?.();
  if (sf === undefined) return false;
  let hit = loweredRcCache.get(sf.fileName);
  if (hit === undefined) {
    const pkg = findTslJson(sf.fileName);
    hit =
      pkg !== null &&
      pkg.lowered !== undefined &&
      (pkg.lowered as { memory?: unknown }).memory === "rc";
    loweredRcCache.set(sf.fileName, hit);
  }
  return hit;
}

const loweredRcCache = new Map<string, boolean>();

/** R10: a class whose every member is a field initialised by `array(…)`: a layout class's storage, which holds scalars. */
function isLayoutStorage(st: ts.ClassDeclaration): boolean {
  if ((process.env.TMK_R10_OFF ?? "").split(",").includes("typed")) return false;
  return (
    st.members.length > 0 &&
    st.heritageClauses === undefined &&
    st.members.every(
      (m) =>
        ts.isPropertyDeclaration(m) &&
        m.initializer !== undefined &&
        ts.isCallExpression(m.initializer) &&
        ts.isIdentifier(m.initializer.expression) &&
        m.initializer.expression.text === "array",
    )
  );
}

/**
 * R18: a class `rc` class printing tagged `@tsl.stack` in a lowered package (emit-tsl.ts's planStack): the lowering keeps
 * every object of it on its function's stack, as the direct route does, so it isn't counted. Like a layout class's storage
 * (R10), it has no store and no release function, a `new` of it stays a `new`, and its references are never shared or
 * dropped; tslc's escape checking then puts that `new` on the stack, as a `strict` package's, and refuses any program where
 * one could be reached after its frame (3.5). What it holds is numbers and booleans alone, so nothing counted is held by an
 * object no count tracks. Anywhere else the tag means nothing: a hand-written package's classes are all counted.
 */
export function stackTagged(st: ts.ClassDeclaration): boolean {
  if (r18Off("stack")) return false;
  const sf = st.getSourceFile();
  if (!/@tsl\.stack\b/.test(sf.text.slice(st.getFullStart(), st.getStart(sf)))) return false;
  const low = findTslJson(sf.fileName)?.lowered as { memory?: unknown } | undefined;
  return low?.memory === "rc";
}

/**
 * R18: why a `@tsl.stack` class can't be one, or null: a base or a tail, or a field that isn't a number, a boolean or an
 * object of another such class (which holds no count either).
 */
function stackRefusal(
  st: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  seen = new Set<ts.ClassDeclaration>(),
): string | null {
  if (st.heritageClauses !== undefined || st.typeParameters !== undefined)
    return "a base or type parameters";
  seen.add(st);
  const NUM = ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;
  const scalar = (t: ts.Type): boolean => {
    if (t.flags & NUM) return true;
    if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
    if (t.isUnion()) return t.types.every(scalar);
    // a flavoured number (`i32`): a number and a brand
    if (t.isIntersection()) return t.types.some((p) => (p.flags & NUM) !== 0);
    // another class kept on the stack (one already being looked at, in a cycle of them, is taken as one)
    const d = t.getSymbol()?.valueDeclaration;
    return (
      d !== undefined &&
      ts.isClassDeclaration(d) &&
      stackTagged(d) &&
      (seen.has(d) || stackRefusal(d, checker, seen) === null)
    );
  };
  for (const m of st.members) {
    if (!ts.isPropertyDeclaration(m)) continue;
    if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true)
      return "a static field";
    if (
      m.initializer !== undefined &&
      ts.isCallExpression(m.initializer) &&
      ts.isIdentifier(m.initializer.expression) &&
      m.initializer.expression.text === "tail"
    )
      return "a tail";
    if (!scalar(checker.getTypeAtLocation(m)))
      return `a field that isn't a number, a boolean or a @tsl.stack class's object (${m.name.getText()})`;
  }
  return null;
}

/**
 * Whether every count of a class's objects is placed by this expansion (3.5's proof, D74, R1b): a class an `rc` package
 * declares. tslc then checks nothing on its references, in `@tsl/gc`'s count operations (`countedExactly`) or at a use
 * (escape.ts), as none can be stale. `TMK_TEST_TSL=exact-all` takes every class as one, a bug put in on purpose.
 */
export function isCountedExactly(decl: unknown): boolean {
  if (process.env.TMK_TEST_TSL === "exact-all") return true;
  if (process.env.TMK_TEST_TSL === "exact-none") return false; // for measuring what the checks cost
  const sf = (decl as ts.Node | undefined)?.getSourceFile?.();
  if (sf === undefined) return false;
  let hit = rcModuleCache.get(sf.fileName);
  if (hit === undefined) {
    hit = isRcModule(sf.fileName);
    rcModuleCache.set(sf.fileName, hit);
  }
  return hit;
}

/**
 * R8: whether a class's references are plain addresses, with no generation in their top bits: a class tslc's `rc` expansion
 * counts exactly (D74), whose references nothing ever checks (3.5's proof), so the generation a reference carried was never
 * read. A native caller then holds, reads and writes such an object at its address, as through the direct route (4.5).
 * `TMK_R8_OFF` with `untag` in it keeps the tag, for computing what this moved (tools/r8-pins.ts).
 */
export function untaggedCounted(decl: unknown): boolean {
  if ((process.env.TMK_R8_OFF ?? "").split(",").includes("untag")) return false;
  return isCountedExactly(decl);
}

interface CountedClass {
  name: string;
  weak?: CountedClass; // the store of weak references to it, `Node$weak`, if the program makes any (`new WeakRef`)
  target?: CountedClass; // for that weak store's own class, Weak<Node>: whose it is
  decl: ts.ClassDeclaration;
  store: string; //   `Node$rc`
  release: string; // `Node$release`
  tail: boolean;
  file: string;
  cyclic?: boolean; // the type graph puts it in a cycle (D41, R1c): its release function visits a vector's elements in place for a scan
  leaf?: boolean; // R4: no slots of its own, so freeing one is only giving its block back (isLeaf)
  stack?: boolean; // R18: tagged @tsl.stack, counted only by the injected bug `r18-stack-counted`, whose `new` stays a `new`
}

interface Val {
  text: string;
  own: boolean; // a count the consumer must take over or drop
  cls: CountedClass | null; // the counted class of its value, or null for anything else
  nullable: boolean;
  nil: string; // what "nothing" is for it: null, or undefined (a WeakRef's deref)
  root: Root; // where a borrowed value hangs from
  simple: boolean; // re-evaluating the text is free and has no effect
  local?: ts.Symbol; // the value is exactly this local
  global?: ts.Symbol; // R28: the value is exactly this module variable, read as it is
}

type Root = "param" | "this" | "global" | "temp" | "owned" | "null" | "none" | ts.Symbol;

interface Local {
  sym: ts.Symbol;
  name: string;
  cls: CountedClass;
  nullable: boolean;
  nil: string;
  owned: boolean; // false: a borrow, which holds no count
  moved: boolean;
  isConst: boolean;
  scope: Scope;
}

interface Scope {
  locals: Local[];
  block: ts.Node | null; // the statement list it belongs to
  stmts: readonly ts.Statement[] | null;
  label: string | null;
  loop: boolean; // a loop body: `continue` and unlabelled `break` stop here
  breakable: boolean; // loop or switch
  update: (() => string[]) | null; // a for loop's update, run before its `continue`
  closes?: string[]; // what closes each map cursor declared in it, where it ends by any way out (R3)
}

class Unsupported extends Error {
  node: ts.Node;
  constructor(node: ts.Node, msg: string) {
    super(msg);
    this.node = node;
  }
}

const VEC_READS = new Set(["get", "length", "forEach", "withSlice"]);
/** What on a JsMap or JsSet (R2) changes no count: `put`, `cut`, `entryAt` and `clear` are the changes. */
const MAP_READS = new Set([
  "get",
  "getOr",
  "has",
  "cursor",
  "advance",
  "keyAt",
  "valAt",
  "forEach",
  "outKey",
  "outVal",
  "positions",
]);

/**
 * A bug put into the expansion on purpose, for a test to show it's caught (SPEC 8.1, `tmk milestone pipe-d` box 21):
 * `TMK_TEST_RC_TSL`: `no-share` leaves out every share, `no-drop` every drop at a scope's exit, and `elide` keeps no count on an argument
 * read from memory across a call that can overwrite where it came from.
 */
/** R11: whether a part of R11 is turned off by TMK_R11_OFF, for computing what it moved (tools/r11-pins.ts). */
function r11Off(part: string): boolean {
  return (process.env.TMK_R11_OFF ?? "").split(",").includes(part);
}

function fault(): string {
  return process.env.TMK_TEST_RC_TSL ?? "";
}

/** Expands every `rc` module a program reaches. */
export function expandRcProgram(program: ts.Program, rootFile: string): RcExpansion {
  const checker = program.getTypeChecker();
  const modules = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/") && isRcModule(sf.fileName),
    );
  const ex = new Expander(checker, modules);
  ex.groups = cycleGraph(program, rootFile).groups;
  ex.collect();
  ex.checkBoundary(program);
  if (ex.diags.length > 0) return { texts: new Map(), diags: ex.diags };
  ex.collectWeak();
  ex.computeQuiet();
  const texts = new Map<string, string>();
  for (const sf of modules) {
    try {
      texts.set(sf.fileName, ex.module(sf));
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      ex.diag(e.node, "TSL9001", e.message);
    }
  }
  void rootFile;
  return { texts, diags: ex.diags };
}

class Expander {
  classes = new Map<ts.Symbol, CountedClass>();
  stackClasses = new Set<ts.ClassDeclaration>(); // R18: tagged @tsl.stack, uncounted, their members expanded all the same
  quiet = new Map<ts.Node, boolean>();
  diags: Diag[] = [];
  storesUsed = new Set<CountedClass>();
  needGc = new Set<string>();
  needCore = new Set<string>();
  sf!: ts.SourceFile;
  tmp = 0;
  groups = new Map<ts.ClassDeclaration, number>();
  aliases = new Map<CountedClass, string>(); // the current module's names for counted classes it imports renamed

  checker: ts.TypeChecker;
  modules: ts.SourceFile[];
  constructor(checker: ts.TypeChecker, modules: ts.SourceFile[]) {
    this.checker = checker;
    this.modules = modules;
  }

  diag(node: ts.Node, code: string, msg: string): void {
    const sf = node.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    this.diags.push({
      code,
      file: repoRelative(sf.fileName),
      line: p.line + 1,
      col: p.character + 1,
      msg,
    });
  }

  // --- the boundary that makes counts exact (3.5's proof, D74, R1b)

  /**
   * Every count of a counted class is placed by this expansion, which is what lets tslc check nothing on its references
   * (`isCountedExactly`). So nothing else may hold one or count one: a module outside the program's `rc` packages can't
   * name a counted class or have a value whose type holds one (a reference, a vector of them, its store), and an `rc`
   * package's module, as written, doesn't name @tsl/gc's `Rc`, `Weak` or `Counted`, which are the expansion's.
   */
  checkBoundary(program: ts.Program): void {
    if (this.classes.size === 0) return;
    const reported = new Set<ts.SourceFile>();
    const countedIn = (t: ts.Type, depth: number): CountedClass | null => {
      if (depth > 6) return null;
      const parts = t.isUnion() || t.isIntersection() ? t.types : [t];
      for (const p of parts) {
        for (const sym of [p.getSymbol(), p.aliasSymbol]) {
          const c = sym !== undefined ? this.classes.get(sym) : undefined;
          if (c !== undefined) return c;
        }
        const args = [
          ...(p.aliasTypeArguments ?? []),
          ...((p.flags & ts.TypeFlags.Object) !== 0 &&
          ((p as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
            ? this.checker.getTypeArguments(p as ts.TypeReference)
            : []),
        ];
        for (const a of args) {
          const c = countedIn(a, depth + 1);
          if (c !== null) return c;
        }
        // a function giving or taking one: what it's called with or gives would be held here
        for (const sig of p.getCallSignatures()) {
          const r = countedIn(sig.getReturnType(), depth + 1);
          if (r !== null) return r;
          for (const prm of sig.getParameters()) {
            const c = countedIn(this.checker.getTypeOfSymbol(prm), depth + 1);
            if (c !== null) return c;
          }
        }
      }
      return null;
    };
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || sf.fileName.includes("/node_modules/")) continue;
      if (isRcModule(sf.fileName)) {
        for (const st of sf.statements) {
          if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
          if (st.moduleSpecifier.text !== "@tsl/gc") continue;
          const named = st.importClause?.namedBindings;
          if (named === undefined || !ts.isNamedImports(named)) continue;
          for (const el of named.elements) {
            const n = (el.propertyName ?? el.name).text;
            if (n === "Rc" || n === "Weak" || n === "Counted")
              this.diag(
                el,
                "TSL9001",
                `rc: an rc package's classes are counted by tslc, which names @tsl/gc's ${n} for it: a package that counts by hand isn't an rc package`,
              );
          }
        }
        continue;
      }
      // and none of the names the expansion adds, which what's written doesn't export
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const mod = this.checker.getSymbolAtLocation(st.moduleSpecifier);
        const file = mod?.valueDeclaration?.getSourceFile().fileName;
        if (mod === undefined || file === undefined || !isRcModule(file)) continue;
        const exported = new Set(this.checker.getExportsOfModule(mod).map((e) => e.name));
        const named = st.importClause?.namedBindings;
        if (named === undefined || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          const n = (el.propertyName ?? el.name).text;
          if (!exported.has(n))
            this.diag(
              el,
              "TSL9001",
              `rc: ${n} is the rc expansion's, not something its package's module exports`,
            );
        }
      }
      const visit = (n: ts.Node): void => {
        if (reported.has(sf)) return;
        if (ts.isIdentifier(n)) {
          const c = countedIn(this.checker.getTypeAtLocation(n), 0);
          if (c !== null) {
            reported.add(sf);
            this.diag(
              n,
              "TSL9001",
              `rc: ${c.name} is counted in its rc package, and a counted object stays there: only tslc's expansion counts it (3.5)`,
            );
            return;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  // --- what's counted

  /** Every class some module makes a WeakRef to: its weak store is declared beside its own. */
  collectWeak(): void {
    const visit = (n: ts.Node): void => {
      if (
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "WeakRef"
      ) {
        const a = n.arguments?.[0];
        const c = a !== undefined ? this.classOf(a).cls : null;
        if (c !== null) this.weakOf(c);
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.modules) visit(sf);
  }

  collect(): void {
    for (const sf of this.modules) {
      for (const st of sf.statements) {
        if (!ts.isClassDeclaration(st) || st.name === undefined) continue;
        if (st.typeParameters !== undefined) {
          this.diag(st.name, "TSL9001", `rc: a generic class isn't counted yet: ${st.name.text}`);
          continue;
        }
        const sym = this.checker.getSymbolAtLocation(st.name);
        if (sym === undefined) continue;
        // R10: a layout class's storage (`class Int32Array_12 { items = array(i32, 12); }`, a typed array a lowered
        // function makes, R9) isn't counted: it holds no reference and has no tail, and a `new` of it stays a `new`, which
        // tslc puts on the stack, or refuses where its view would outlive the frame, as a `strict` package's stack object.
        if (isLayoutStorage(st)) continue;
        // R18: a class the printing keeps on the stack isn't counted either (stackTagged), once it's one that can be
        const stack = stackTagged(st);
        if (stack) {
          // the injected bug (TMK_TEST_RC_TSL=r18-stack-refs): a tagged class taken whatever it holds
          const why = fault() === "r18-stack-refs" ? null : stackRefusal(st, this.checker);
          if (why !== null) {
            this.diag(
              st.name,
              "TSL9001",
              `rc: ${st.name.text} is tagged @tsl.stack, but has ${why}`,
            );
            continue;
          }
          // the injected bug (TMK_TEST_RC_TSL=r18-stack-counted): its `new` left on the stack, its references counted still
          if (fault() !== "r18-stack-counted") {
            this.stackClasses.add(st);
            continue;
          }
        }
        const name = st.name.text;
        const tail = st.members.some(
          (m) =>
            ts.isPropertyDeclaration(m) &&
            m.initializer !== undefined &&
            ts.isCallExpression(m.initializer) &&
            ts.isIdentifier(m.initializer.expression) &&
            m.initializer.expression.text === "tail",
        );
        this.classes.set(sym, {
          name,
          decl: st,
          store: `${name}$rc`,
          release: `${name}$release`,
          tail,
          file: sf.fileName,
          cyclic: (this.groups.get(st) ?? 0) !== 0,
          ...(stack ? { stack: true } : {}),
        });
      }
    }
  }

  classOfType(t: ts.Type): { cls: CountedClass | null; nullable: boolean; nil: string } {
    let nullable = false;
    let nil = "null";
    let cls: CountedClass | null = null;
    const parts = t.isUnion() ? t.types : [t];
    for (const p of parts) {
      if (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
        nullable = true;
        if (p.flags & ts.TypeFlags.Undefined) nil = "undefined";
        continue;
      }
      let sym = p.getSymbol() ?? p.aliasSymbol;
      if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias)
        sym = this.checker.getAliasedSymbol(sym);
      if (sym !== undefined && (sym.name === "WeakRef" || sym.name === "Weak")) {
        // WeakRef<C> as written, or @tsl/gc's Weak<C> it becomes: counted in C's weak store
        const args = this.checker.getTypeArguments(p as ts.TypeReference);
        const target = args.length === 1 ? this.classOfType(args[0]!).cls : null;
        if (target !== null) cls = this.weakOf(target);
        continue;
      }
      const c = sym !== undefined ? this.classes.get(sym) : undefined;
      if (c !== undefined) cls = c;
    }
    return { cls, nullable, nil };
  }

  /** The counted class of weak references to c, Weak<c>, with its store `c$weak` beside c's. */
  weakOf(c: CountedClass): CountedClass {
    if (c.weak === undefined)
      c.weak = {
        name: `Weak<${c.name}>`,
        decl: c.decl,
        store: `${c.name}$weak`,
        release: `${c.name}$weakRelease`,
        tail: false,
        file: c.file,
        target: c,
      };
    return c.weak;
  }

  classOf(node: ts.Node): { cls: CountedClass | null; nullable: boolean; nil: string } {
    const flow = this.classOfType(this.checker.getTypeAtLocation(node));
    // R11: module state tsc has narrowed to no class at all (`null`, by an assignment, kept across calls that can change it:
    // an exception's value, `__exc_val`, set again by a call that throws) by its declared type, so a read after one isn't
    // taken for no reference and counted as none
    if (
      flow.cls === null &&
      ts.isIdentifier(node) &&
      !r11Off("narrow") &&
      fault() !== "r11-global-narrowed"
    ) {
      const sym = this.symOf(node);
      const d = sym?.valueDeclaration;
      if (
        sym !== undefined &&
        d !== undefined &&
        ts.isVariableDeclaration(d) &&
        !this.isLocalDecl(d)
      )
        return this.classOfType(this.checker.getTypeOfSymbol(sym));
    }
    return flow;
  }

  /** Whether a variable is declared in a function, not in module state. */
  isLocalDecl(d: ts.VariableDeclaration): boolean {
    for (let p: ts.Node = d.parent; !ts.isSourceFile(p); p = p.parent)
      if (ts.isFunctionLike(p)) return true;
    return false;
  }

  /**
   * The element class of a `Vec` of a counted class, if `node` is one; or of a `JsArray` (R2), which a lowered `rc` package
   * holds in place in a holder class of its own, as a `Vec` is held, and whose elements can be holes (`null`).
   */
  vecElem(node: ts.Node): CountedClass | null {
    const t = this.checker.getTypeAtLocation(node);
    const sym = t.getSymbol();
    if (
      sym === undefined ||
      (sym.name !== "Vec" && sym.name !== "JsArray" && sym.name !== "JsRoomArray")
    )
      return null;
    const args = this.checker.getTypeArguments(t as ts.TypeReference);
    if (args.length !== 1) return null;
    return this.classOfType(args[0]!).cls;
  }

  /**
   * @tsl/jsrt's JsMap or JsSet (R2), held in place by a lowered `rc` package's holder: the counted classes of its keys and
   * values, either null when it isn't one; null if `node` isn't a map.
   */
  mapOf(node: ts.Node): { k: CountedClass | null; v: CountedClass | null; set: boolean } | null {
    const t = this.checker.getTypeAtLocation(node);
    const name = t.getSymbol()?.name;
    if (name !== "JsMap" && name !== "JsSet") return null;
    const args = this.checker.getTypeArguments(t as ts.TypeReference);
    const k = args[0] !== undefined ? this.classOfType(args[0]).cls : null;
    const v = name === "JsMap" && args[1] !== undefined ? this.classOfType(args[1]).cls : null;
    return { k, v, set: name === "JsSet" };
  }

  /** Whether `node` is @tsl/jsrt's JsArray, of anything (R2): its buffer goes back when its holder is freed. */
  isJsArray(node: ts.Node): boolean {
    const n = this.checker.getTypeAtLocation(node).getSymbol()?.name;
    return n === "JsArray" || n === "JsRoomArray";
  }

  /**
   * Whether `node` is @tsl/gc's JsRoomArray (R3): a lowered `rc` array whose first room is its holder's tail, so freeing
   * gives back a room only where it has one of its own (`rooms`).
   */
  isRoomArray(node: ts.Node): boolean {
    return this.checker.getTypeAtLocation(node).getSymbol()?.name === "JsRoomArray";
  }

  symOf(node: ts.Node): ts.Symbol | undefined {
    let s = this.checker.getSymbolAtLocation(node);
    if (s !== undefined && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
    return s;
  }

  declOfCall(call: ts.CallExpression | ts.NewExpression): ts.Declaration | undefined {
    return this.checker.getResolvedSignature(call)?.declaration;
  }

  inRc(node: ts.Node): boolean {
    return this.modules.includes(node.getSourceFile());
  }

  // --- quiet functions: no count given up, but at the scope exit of their own locals (the header's argument)

  computeQuiet(): void {
    const fns: ts.FunctionLikeDeclaration[] = [];
    const visit = (n: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isConstructorDeclaration(n) ||
          ts.isGetAccessorDeclaration(n) ||
          ts.isSetAccessorDeclaration(n)) &&
        n.body !== undefined
      )
        fns.push(n);
      ts.forEachChild(n, visit);
    };
    for (const sf of this.modules) visit(sf);
    const direct = new Map<ts.Node, boolean>();
    const calls = new Map<ts.Node, ts.Node[]>();
    for (const f of fns) {
      const h = this.hazards(f.body!, f, ts.isConstructorDeclaration(f));
      direct.set(f, h.hazard);
      calls.set(f, h.callees);
    }
    for (const f of fns) this.quiet.set(f, !direct.get(f));
    let changed = true;
    for (let guard = 0; changed && guard < 10_000; guard++) {
      changed = false;
      for (const f of fns) {
        if (!this.quiet.get(f)) continue;
        if ((calls.get(f) ?? []).some((c) => this.quiet.get(c) !== true)) {
          this.quiet.set(f, false);
          changed = true;
        }
      }
    }
  }

  /**
   * What in `root` (part of function `f`) can give up a count held along a path: a counted store, a vector's element
   * moved or replaced, a call through a function value; and the functions of this program it calls, whose own hazards
   * count too.
   */
  hazards(root: ts.Node, f: ts.Node, ctor: boolean): { hazard: boolean; callees: ts.Node[] } {
    const callees: ts.Node[] = [];
    let hazard = false;
    const walk = (n: ts.Node): void => {
      if (n !== f && (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))) return;
      if (ts.isBinaryExpression(n) && isAssign(n.operatorToken.kind)) {
        const { cls } = this.classOf(n.left);
        if (cls !== null) {
          const toThisField =
            ctor &&
            ts.isPropertyAccessExpression(n.left) &&
            n.left.expression.kind === ts.SyntaxKind.ThisKeyword;
          const toLocal = ts.isIdentifier(n.left) && this.isLocal(n.left);
          if (!toThisField && !toLocal) hazard = true;
          // an owned local's old value is dropped; a local only ever given paths is a borrow, and drops nothing
          if (toLocal && !this.onlyPaths(this.symOf(n.left)!, f)) hazard = true;
        }
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const mp = ts.isPropertyAccessExpression(callee) ? this.mapOf(callee.expression) : null;
        if (ts.isPropertyAccessExpression(callee) && this.vecElem(callee.expression) !== null) {
          if (!VEC_READS.has(callee.name.text) && callee.name.text !== "push") hazard = true;
        } else if (ts.isPropertyAccessExpression(callee) && mp !== null) {
          // a map's change gives up what it held (R2): only its reads are quiet
          if ((mp.k !== null || mp.v !== null) && !MAP_READS.has(callee.name.text)) hazard = true;
        } else {
          const d = this.declOfCall(n);
          if (d === undefined) hazard = true;
          else if (this.inRc(d)) callees.push(d);
          // a call through a function value: assume the worst (a library calling a closure walks the closure here)
          if (
            d !== undefined &&
            (ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d))
          )
            hazard = true;
        }
      }
      if (ts.isNewExpression(n)) {
        const d = this.declOfCall(n);
        if (d !== undefined && this.inRc(d)) callees.push(d);
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    return { hazard, callees };
  }

  /** Whether nothing in these nodes of `f` can give up a count held along a path (D39's "nothing in between"). */
  regionQuiet(nodes: readonly ts.Node[], f: ts.Node): boolean {
    for (const n of nodes) {
      const h = this.hazards(n, f, ts.isConstructorDeclaration(f));
      if (h.hazard || h.callees.some((c) => this.quiet.get(c) !== true)) return false;
    }
    return true;
  }

  /** Whether a local of `f` is only ever given values read along a path: it can be a borrow, and gives up nothing. */
  onlyPaths(sym: ts.Symbol, f: ts.Node): boolean {
    const d = sym.valueDeclaration;
    if (d === undefined || !ts.isVariableDeclaration(d) || d.initializer === undefined)
      return false;
    const sources: ts.Expression[] = [d.initializer];
    const walk = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        isAssign(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        this.symOf(n.left) === sym
      )
        sources.push(n.right);
      ts.forEachChild(n, walk);
    };
    walk(f);
    return sources.every((e) => isPath(e, this));
  }

  /**
   * R28: whether a module variable is written only by its module's `__init` (the printing's literals, `strlit_k`, and
   * module state set once there), which nothing in the program calls: the runtime runs it once, before any export. Such a
   * variable's value, once set, is never overwritten while anything else runs, so a count of its own holds it as long as
   * the program does, and a call given it borrowed needs no count of its own around the call (its object can't go while
   * the call runs: only overwriting the variable could drop that count). Every write is found by the checker's symbols over
   * the program's `rc` modules: an assignment of any kind, `++`/`--`, or a destructuring target; one anywhere but a
   * top-level `function __init` of the variable's own module, or a reference to that `__init` other than its declaration,
   * and the variable isn't one. `TMK_TEST_RC_TSL=r28-init-any` (an injected bug) takes every module variable as one.
   */
  initOnly(sym: ts.Symbol): boolean {
    if ((process.env.TMK_R28_OFF ?? "").split(",").includes("initonly")) return false;
    if (fault() === "r28-init-any") return true;
    if (this.initOnlySyms === null) this.initOnlySyms = this.findInitOnly();
    return this.initOnlySyms.has(sym);
  }

  initOnlySyms: Set<ts.Symbol> | null = null;

  private findInitOnly(): Set<ts.Symbol> {
    const out = new Set<ts.Symbol>();
    const bad = new Set<ts.Symbol>();
    const inits = new Set<ts.Node>(); // each module's top-level `function __init`
    for (const sf of this.modules)
      for (const st of sf.statements)
        if (ts.isFunctionDeclaration(st) && st.name?.text === "__init" && st.body !== undefined) {
          inits.add(st);
          // a module variable it writes may be one, unless something calls it, or names it at all
          const fs = this.symOf(st.name);
          if (fs !== undefined) {
            for (const m of this.modules) {
              const walk = (n: ts.Node): void => {
                if (
                  ts.isIdentifier(n) &&
                  n !== st.name &&
                  n.text === "__init" &&
                  this.symOf(n) === fs
                )
                  inits.delete(st);
                ts.forEachChild(n, walk);
              };
              walk(m);
            }
          }
        }
    const target = (e: ts.Expression, at: ts.Node): void => {
      let x: ts.Expression = e;
      while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
      if (ts.isIdentifier(x)) {
        const s = this.symOf(x);
        if (s === undefined) return;
        const d = s.valueDeclaration;
        if (d === undefined || !ts.isVariableDeclaration(d) || this.isLocal(x)) return;
        let fn: ts.Node | undefined = at;
        while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
        // its own module's top-level __init, and no function inside it (a closure could run later)
        const ok =
          fn !== undefined &&
          inits.has(fn) &&
          fn.getSourceFile() === d.getSourceFile() &&
          ts.isSourceFile(fn.parent);
        if (ok) out.add(s);
        else bad.add(s);
      } else if (ts.isObjectLiteralExpression(x) || ts.isArrayLiteralExpression(x)) {
        for (const el of ts.isArrayLiteralExpression(x) ? x.elements : x.properties) {
          if (ts.isSpreadElement(el)) target(el.expression, at);
          else if (ts.isPropertyAssignment(el)) target(el.initializer, at);
          else if (ts.isShorthandPropertyAssignment(el)) target(el.name, at);
          else if (ts.isSpreadAssignment(el)) target(el.expression, at);
          else if (ts.isExpression(el)) target(el, at);
        }
      } else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        target(x.left, at);
    };
    for (const sf of this.modules) {
      const walk = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          target(n.left, n);
        else if (
          (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken ||
            n.operator === ts.SyntaxKind.MinusMinusToken)
        )
          target(n.operand, n);
        else if (ts.isForInStatement(n) || ts.isForOfStatement(n)) {
          if (!ts.isVariableDeclarationList(n.initializer)) target(n.initializer, n);
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
    for (const s of bad) out.delete(s);
    return out;
  }

  isQuiet(d: ts.Node | undefined): boolean {
    if (d === undefined) return false;
    if (!this.inRc(d)) return true;
    return this.quiet.get(d) ?? false;
  }

  isLocal(id: ts.Identifier): boolean {
    const s = this.symOf(id);
    const d = s?.valueDeclaration;
    if (d === undefined || !ts.isVariableDeclaration(d)) return false;
    let p: ts.Node = d;
    while (!ts.isSourceFile(p.parent)) {
      p = p.parent;
      if (ts.isFunctionLike(p)) return true;
    }
    return false;
  }

  // --- a module

  module(sf: ts.SourceFile): string {
    this.sf = sf;
    this.storesUsed = new Set();
    this.needGc = new Set();
    this.needCore = new Set();
    // a counted class imported under another name (R2: two modules' classes of one name, `Square as Square_inShapes`)
    // is that name here, and so is its store
    this.aliases = new Map();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      const named = st.importClause?.namedBindings;
      if (named === undefined || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) {
        if (el.propertyName === undefined) continue;
        const c = this.classes.get(this.symOf(el.name)!);
        if (c !== undefined) this.aliases.set(c, el.name.text);
      }
    }
    const body: string[] = [];
    const imports: ts.ImportDeclaration[] = [];
    let last = 0;
    const text = sf.text;
    const lead = (st: ts.Node): string => text.slice(last, st.getStart(sf));
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        imports.push(st);
        last = st.end;
        continue;
      }
      const pre = lead(st);
      last = st.end;
      if (ts.isClassDeclaration(st) && st.name !== undefined) {
        const c = this.classes.get(this.symOf(st.name)!);
        if (c !== undefined) {
          body.push(pre + this.classDecl(st, c));
          continue;
        }
        if (this.stackClasses.has(st)) {
          body.push(pre + this.stackClassDecl(st));
          continue;
        }
      }
      if (ts.isFunctionDeclaration(st) && st.body !== undefined) {
        body.push(pre + this.functionDecl(st));
        continue;
      }
      if (ts.isVariableStatement(st)) {
        const d = st.declarationList.declarations[0];
        const init = d?.initializer;
        if (
          st.declarationList.declarations.length === 1 &&
          init !== undefined &&
          ts.isArrowFunction(init) &&
          ts.isBlock(init.body)
        ) {
          const f = new FnExpand(this, init, false);
          f.quiet = this.isQuiet(init);
          const head = sf.text.slice(st.getStart(sf), init.body.getStart(sf));
          body.push(pre + head + f.body(init.body, []) + ";");
          continue;
        }
        body.push(pre + this.topVariable(st));
        continue;
      }
      body.push(pre + st.getText(sf));
    }
    body.push(text.slice(last));
    const head = this.importsText(sf, imports);
    // WeakRef<C> as a type is @tsl/gc's Weak<C> (D74); every `new WeakRef` is already a Weak store's make
    let out = body.join("");
    if (/\bWeakRef</.test(out)) {
      this.needGc.add("Weak");
      out = out.replace(/\bWeakRef</g, "Weak<");
      return this.importsText(sf, imports) + out;
    }
    return head + out;
  }

  importsText(sf: ts.SourceFile, imports: ts.ImportDeclaration[]): string {
    const out: string[] = [];
    let sawCore = false;
    let sawGc = false;
    const headStart = imports.length > 0 ? sf.text.slice(0, imports[0]!.getStart(sf)) : "";
    for (const im of imports) {
      const spec = (im.moduleSpecifier as ts.StringLiteral).text;
      const named = im.importClause?.namedBindings;
      const have = new Set<string>();
      const parts: string[] = [];
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          have.add(el.name.text);
          parts.push(el.getText(sf));
        }
      }
      let add: string[] = [];
      if (spec === "@tsl/core") {
        sawCore = true;
        add = [...this.needCore].filter((n) => !have.has(n)).map((n) => `type ${n}`);
      } else if (spec === "@tsl/gc") {
        sawGc = true;
        add = [...this.needGc]
          .filter((n) => !have.has(n))
          .map((n) => (n === "Counted" ? "type Counted" : n));
      } else {
        // a store, for each counted class this module imports and whose store the expansion uses
        for (const el of named !== undefined && ts.isNamedImports(named) ? named.elements : []) {
          const c = this.classes.get(this.symOf(el.name)!);
          const a = c !== undefined ? this.aliases.get(c) : undefined;
          if (c !== undefined && this.storesUsed.has(c) && a !== undefined)
            add.push(`${c.store} as ${a}$rc`);
          else if (c !== undefined && this.storesUsed.has(c) && !have.has(c.store))
            add.push(c.store);
          const w = c?.weak;
          if (w !== undefined && this.storesUsed.has(w) && !have.has(w.store)) add.push(w.store);
        }
      }
      if (add.length === 0 || named === undefined || !ts.isNamedImports(named)) {
        out.push(im.getText(sf));
        continue;
      }
      const typeOnly = im.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "type " : "";
      out.push(
        `import ${typeOnly}{ ${[...parts, ...add].join(", ")} } from ${im.moduleSpecifier.getText(sf)};`,
      );
    }
    if (!sawCore && this.needCore.size > 0)
      out.push(
        `import { ${[...this.needCore].map((n) => `type ${n}`).join(", ")} } from "@tsl/core";`,
      );
    if (!sawGc && this.needGc.size > 0)
      out.push(
        `import { ${[...this.needGc]
          .sort()
          .map((n) => (n === "Counted" ? "type Counted" : n))
          .join(", ")} } from "@tsl/gc";`,
      );
    return headStart + out.join("\n");
  }

  /**
   * Whether c's objects have no slots of their own (R4): no counted field, no vector, array or map, nothing inherited, so
   * its release function gives 0 and freeing one is only giving its block back. A weak reference's class is one. Freeing
   * drops one with `visitLeaf`, which gives its block back at once where the step budget has room for it.
   */
  isLeaf(c: CountedClass): boolean {
    if (c.target !== undefined) return true;
    if (c.leaf !== undefined) return c.leaf;
    let leaf = c.decl.heritageClauses === undefined;
    for (const m of c.decl.members) {
      if (!leaf) break;
      if (ts.isPropertyDeclaration(m)) {
        if (
          this.classOf(m.name).cls !== null ||
          this.vecElem(m.name) !== null ||
          this.isJsArray(m.name) ||
          this.mapOf(m.name) !== null
        )
          leaf = false;
      } else if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters)
          if (
            (ts.getModifiers(p) ?? []).some((x) => isPropModifier(x.kind)) &&
            this.classOf(p.name).cls !== null
          )
            leaf = false;
      }
    }
    c.leaf = leaf;
    return leaf;
  }

  /**
   * R34 (D39's R34, 3.5): whether this `withTail(n, new C(…))` makes an object whose counted references are all null and
   * stay so, which @tsl/gc's `makeTailLeaf` then makes in its store's leaf entry, freed as one step with no call. So: C has
   * slots (it isn't a leaf already), each a reference field (no array, vector or map), C is in no cycle and has no
   * superclass; each reference field is written only by C's constructor, as a statement of its own at its top level,
   * `this.f = p` from one of its parameters that the constructor never assigns, or not at all with `null` as its initialiser;
   * nothing else in any `rc` module writes a field of that name of a C (an assignment to it, or anywhere in a destructuring
   * target); and here, each such parameter is given `null`. A flat string is one: `jsStrZeroed`'s `new JsStr(n, 0, null, 0)`.
   * Were a case missed, an object made so would keep what a reference set in it later refers to alive for ever (a leak, never
   * a fault: freeing never visits it). `TMK_R34_OFF=leaf` makes none so (tools/r34-pins.ts); `TMK_TEST_RC_TSL=r34-leaf-any`
   * (an injected bug) takes every tailed `new` of a class with slots as one.
   */
  leafMake(c: CountedClass, e: ts.NewExpression): boolean {
    if ((process.env.TMK_R34_OFF ?? "").split(",").includes("leaf")) return false;
    if (c.target !== undefined || c.stack === true || c.cyclic === true || this.isLeaf(c))
      return false;
    if (fault() === "r34-leaf-any") return true;
    const need = this.leafParams(c);
    if (need === null) return false;
    const args = e.arguments ?? [];
    for (const i of need) {
      let a: ts.Expression | undefined = args[i];
      while (a !== undefined && ts.isParenthesizedExpression(a)) a = a.expression;
      if (a === undefined || a.kind !== ts.SyntaxKind.NullKeyword) return false;
    }
    return true;
  }

  leafParamsOf = new Map<CountedClass, number[] | null>();

  /** R34: the constructor parameters each reference field of c is set from (leafMake), or null if c doesn't qualify. */
  leafParams(c: CountedClass): number[] | null {
    const had = this.leafParamsOf.get(c);
    if (had !== undefined) return had;
    const out = this.findLeafParams(c);
    this.leafParamsOf.set(c, out);
    return out;
  }

  private findLeafParams(c: CountedClass): number[] | null {
    const d = c.decl;
    if (d.heritageClauses !== undefined) return null;
    const fields = new Map<string, { init: ts.Expression | undefined; param: number | null }>();
    let ctor: ts.ConstructorDeclaration | undefined;
    for (const m of d.members) {
      if (ts.isPropertyDeclaration(m)) {
        if (this.vecElem(m.name) !== null || this.isJsArray(m.name) || this.mapOf(m.name) !== null)
          return null;
        if (this.classOf(m.name).cls === null) continue;
        if (!ts.isIdentifier(m.name)) return null;
        fields.set(m.name.text, { init: m.initializer, param: null });
      } else if (ts.isConstructorDeclaration(m) && m.body !== undefined) ctor = m;
    }
    const params = ctor?.parameters ?? [];
    params.forEach((p, i) => {
      if (
        (ts.getModifiers(p) ?? []).some((x) => isPropModifier(x.kind)) &&
        ts.isIdentifier(p.name) &&
        this.classOf(p.name).cls !== null
      )
        fields.set(p.name.text, { init: undefined, param: i });
    });
    if (fields.size === 0) return null;
    // the constructor's own `this.f = p` statements, at its top level, from a parameter it never assigns
    const ok = new Set<ts.Node>();
    if (ctor?.body !== undefined) {
      const assigned = new Set<string>();
      const walk = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && isAssign(n.operatorToken.kind) && ts.isIdentifier(n.left))
          assigned.add(n.left.text);
        ts.forEachChild(n, walk);
      };
      walk(ctor.body);
      for (const st of ctor.body.statements) {
        if (!ts.isExpressionStatement(st)) continue;
        const x = st.expression;
        if (
          !ts.isBinaryExpression(x) ||
          !isAssign(x.operatorToken.kind) ||
          !ts.isPropertyAccessExpression(x.left) ||
          x.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
          !ts.isIdentifier(x.right)
        )
          continue;
        const f = fields.get(x.left.name.text);
        const pi = params.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === (x.right as ts.Identifier).text,
        );
        if (f === undefined || pi < 0 || assigned.has((x.right as ts.Identifier).text)) continue;
        if (f.param !== null) return null; // set twice
        f.param = pi;
        ok.add(x.left);
      }
    }
    // every other write to a field of that name, of a C, anywhere
    let bad = false;
    const names = new Set(fields.keys());
    // of a C, or of what can't be told
    const isC = (x: ts.Expression): boolean =>
      (this.checker.getTypeAtLocation(x).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
      this.classOf(x).cls === c;
    const target = (x: ts.Expression): void => {
      while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
      if (ts.isPropertyAccessExpression(x)) {
        if (names.has(x.name.text) && !ok.has(x) && isC(x.expression)) bad = true;
      } else if (ts.isElementAccessExpression(x)) {
        if (isC(x.expression)) bad = true;
      } else if (ts.isObjectLiteralExpression(x) || ts.isArrayLiteralExpression(x)) {
        for (const el of ts.isArrayLiteralExpression(x) ? x.elements : x.properties) {
          if (ts.isSpreadElement(el)) target(el.expression);
          else if (ts.isPropertyAssignment(el)) target(el.initializer);
          else if (ts.isSpreadAssignment(el)) target(el.expression);
          else if (ts.isExpression(el)) target(el);
        }
      } else if (ts.isBinaryExpression(x) && isAssign(x.operatorToken.kind)) target(x.left);
    };
    for (const sf of this.modules) {
      const walk = (n: ts.Node): void => {
        if (bad) return;
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          target(n.left);
        ts.forEachChild(n, walk);
      };
      walk(sf);
      if (bad) return null;
    }
    const need: number[] = [];
    for (const f of fields.values()) {
      if (f.param !== null) need.push(f.param);
      else if (f.init === undefined || f.init.kind !== ts.SyntaxKind.NullKeyword) return null;
    }
    return need;
  }

  /**
   * R34: whether a release function's visit of a reference field to c hands c's object to freeing at its last count
   * (`handLeaf`), telling freeing so through what it gives (`RC_HANDED`), where R4's `visitLeaf` gave it back through
   * `spare`: wherever c is a leaf (visitOf's `visitLeaf`), but for the injected `leaf-all` bug, which keeps R4's form. A
   * field only (a view's buffer): an array's or vector's element, and a map's key and value, keep `visitLeaf`.
   * `TMK_R34_OFF=hand` keeps R4's everywhere (tools/r34-pins.ts).
   */
  handOf(c: CountedClass): boolean {
    if ((process.env.TMK_R34_OFF ?? "").split(",").includes("hand")) return false;
    if (process.env.TMK_TEST_RC_TSL === "leaf-all") return false;
    if (!this.isLeaf(c)) return false;
    this.needGc.add("RC_HANDED");
    return true;
  }

  /** R34: a room array's room given back through `trimHand` where R4's `trim` gave it back through `spare` (handOf). */
  roomHand(): boolean {
    if ((process.env.TMK_R34_OFF ?? "").split(",").includes("hand")) return false;
    this.needGc.add("RC_HANDED");
    return true;
  }

  /** How a release function visits a reference to c: `visitLeaf` where c is a leaf (R4), `visit` otherwise. */
  visitOf(c: CountedClass): string {
    // `tmk milestone pipe-d`'s injected bug (R4): every class taken as a leaf, so freeing drops what it holds unvisited
    if (process.env.TMK_TEST_RC_TSL === "leaf-all") return "visitLeaf";
    return this.isLeaf(c) ? "visitLeaf" : "visit";
  }

  useStore(c: CountedClass): string {
    this.storesUsed.add(c);
    const a = this.aliases.get(c);
    return a !== undefined ? `${a}$rc` : c.store;
  }

  countedType(c: CountedClass, nullable: boolean, nil = "null"): string {
    this.needGc.add("Counted");
    return `Counted<${this.aliases.get(c) ?? c.name}>${nullable ? ` | ${nil}` : ""}`;
  }

  /** A declared type, with each counted class in it written as `Counted<…>`. */
  typeText(t: ts.TypeNode | undefined, node: ts.Node): string | null {
    const { cls, nullable } = this.classOf(node);
    if (cls === null) return t === undefined ? null : t.getText(this.sf);
    return this.countedType(cls, nullable);
  }

  // --- top-level variables

  topVariable(st: ts.VariableStatement): string {
    const out: string[] = [];
    for (const d of st.declarationList.declarations) {
      const { cls } = this.classOf(d.name);
      if (cls === null) continue;
      if (d.initializer !== undefined && d.initializer.kind !== ts.SyntaxKind.NullKeyword)
        throw new Unsupported(
          d,
          "rc: a top-level counted object isn't supported yet: start it as null and set it in a function",
        );
      out.push(d.name.getText(this.sf));
    }
    if (out.length === 0) return st.getText(this.sf);
    const kw = st.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
    const mods = (ts.getModifiers(st) ?? []).map((m) => m.getText(this.sf) + " ").join("");
    const decls = st.declarationList.declarations.map((d) => {
      const ty = this.typeText(d.type, d.name);
      return `${d.name.getText(this.sf)}${ty !== null ? `: ${ty}` : ""}${d.initializer !== undefined ? ` = ${d.initializer.getText(this.sf)}` : ""}`;
    });
    return `${mods}${kw} ${decls.join(", ")};`;
  }

  // --- classes

  /**
   * R18: a class kept on the stack, which isn't counted: its fields as written (numbers, booleans and references to other
   * such classes, nothing counted), and its constructor and methods expanded as any function is, since what they make,
   * read and store of counted classes is counted as anywhere else.
   */
  stackClassDecl(st: ts.ClassDeclaration): string {
    const sf = this.sf;
    const lines: string[] = [sf.text.slice(st.getStart(sf), st.members.pos)];
    for (const m of st.members) {
      // each member's leading text as it was, so what follows keeps its lines (a diagnostic's place is the source's)
      const pre = sf.text.slice(m.getFullStart(), m.getStart(sf));
      if (ts.isConstructorDeclaration(m) && m.body !== undefined) {
        const f = new FnExpand(this, m, true);
        f.ctorInit = new Set();
        lines.push(
          `${pre}constructor(${m.parameters.map((p) => p.getText(sf)).join(", ")}) ${f.body(m.body, [])}`,
        );
        continue;
      }
      if (
        (ts.isMethodDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)) &&
        m.body !== undefined
      ) {
        lines.push(pre + this.methodText(m));
        continue;
      }
      lines.push(pre + m.getText(sf));
    }
    lines.push(sf.text.slice(st.members.end, st.end));
    return lines.join("");
  }

  classDecl(st: ts.ClassDeclaration, c: CountedClass): string {
    const sf = this.sf;
    const lines: string[] = [];
    const mods = (ts.getModifiers(st) ?? []).map((m) => m.getText(sf) + " ").join("");
    const exported = mods.includes("export");
    lines.push(sf.text.slice(st.getStart(sf), st.members.pos).trimEnd());
    // `buf`: a JsArray of no counted class (R2), whose buffer goes back as freeing's last step
    // `map`: a JsMap or JsSet held in place (R2), its positions freed one a step, then its buffers
    const slots: {
      kind: "ref" | "vec" | "buf" | "map";
      name: string;
      cls: CountedClass | null;
      vcls?: CountedClass | null;
      nullable: boolean;
      js?: boolean;
      set?: boolean;
      room?: boolean; // R3: a JsRoomArray, whose freeing gives back a room only where it has one of its own
    }[] = [];
    const ctorFields: string[] = [];
    const uninit = new Set<string>();
    for (const m of st.members) {
      const pre = sf.text.slice(m.getFullStart(), m.getStart(sf)).replace(/^\n+/, "\n");
      if (ts.isPropertyDeclaration(m)) {
        const name = m.name.getText(sf);
        const { cls, nullable } = this.classOf(m.name);
        const ve = this.vecElem(m.name);
        const js = this.isJsArray(m.name);
        const mp = this.mapOf(m.name);
        const room = js && this.isRoomArray(m.name);
        if (ve !== null) slots.push({ kind: "vec", name, cls: ve, nullable: js, js, room });
        else if (js) slots.push({ kind: "buf", name, cls: null, nullable: false, js, room });
        else if (mp !== null)
          slots.push({ kind: "map", name, cls: mp.k, vcls: mp.v, nullable: true, set: mp.set });
        if (cls === null) {
          lines.push(pre + "  " + m.getText(sf));
          continue;
        }
        // R11: a field declared assigned (`!`) with no initialiser may still be null when its object is freed: an
        // `unknown`'s storage shared between the classes it can hold (D68's Dyn) leaves the fields of the others unset
        slots.push({
          kind: "ref",
          name,
          cls,
          nullable:
            nullable ||
            (m.exclamationToken !== undefined &&
              m.initializer === undefined &&
              fault() !== "r11-dyn-unset" &&
              !r11Off("unset")),
        });
        const mm = (ts.getModifiers(m) ?? []).map((x) => x.getText(sf) + " ").join("");
        let init = "";
        if (m.initializer !== undefined) {
          const f = new FnExpand(this, null, false);
          init = ` = ${f.ownedInit(m.initializer)}`;
        } else uninit.add(name);
        lines.push(
          `${pre}  ${mm}${name}${m.questionToken !== undefined ? "?" : ""}${m.exclamationToken !== undefined ? "!" : ""}: ${this.countedType(cls, nullable)}${init};`,
        );
        continue;
      }
      if (ts.isConstructorDeclaration(m)) {
        // a counted parameter property becomes a field and an assignment that takes its own count
        const params: string[] = [];
        for (const p of m.parameters) {
          const props = (ts.getModifiers(p) ?? []).filter((x) => isPropModifier(x.kind));
          const { cls, nullable } = this.classOf(p.name);
          if (props.length > 0 && cls !== null) {
            const name = p.name.getText(sf);
            const mm = props.map((x) => x.getText(sf) + " ").join("");
            lines.push(
              `  ${mm.replace(/\bpublic \b/, "")}${name}: ${this.countedType(cls, nullable)};`.replace(
                "  readonly ",
                "  readonly ",
              ),
            );
            slots.push({ kind: "ref", name, cls, nullable });
            ctorFields.push(name);
            const rest = (ts.getModifiers(p) ?? []).filter((x) => !isPropModifier(x.kind));
            params.push(
              `${rest.map((x) => x.getText(sf) + " ").join("")}${name}: ${p.type!.getText(sf)}`,
            );
          } else params.push(p.getText(sf));
        }
        const f = new FnExpand(this, m, true);
        f.ctorInit = new Set(uninit);
        const pre2 = sf.text.slice(m.getFullStart(), m.getStart(sf)).replace(/^\n+/, "\n");
        const assigns = ctorFields.map((n) => {
          const p = m.parameters.find((x) => x.name.getText(sf) === n)!;
          const { cls, nullable } = this.classOf(p.name);
          return `this.${n} = ${f.shareText(n, cls!, nullable, true)};`;
        });
        lines.push(`${pre2}  constructor(${params.join(", ")}) ${f.body(m.body!, assigns)}`);
        continue;
      }
      if (
        (ts.isMethodDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)) &&
        m.body !== undefined
      ) {
        lines.push(pre + "  " + this.methodText(m));
        continue;
      }
      lines.push(pre + "  " + m.getText(sf));
    }
    lines.push("}");
    // what freeing it does, one slot a step (D39): each reference slot, each vector's elements, then each vector's buffer
    const r: string[] = [];
    this.needGc.add("Visit");
    this.needGc.add("Rc");
    this.needCore.add("usize");
    const vecs = slots.filter((s) => s.kind === "vec");
    const refs = slots.filter((s) => s.kind === "ref");
    const bufs = slots.filter((s) => s.kind === "buf");
    const maps = slots.filter((s) => s.kind === "map");
    const used = slots.length > 0;
    r.push(
      `\n\n/** Freeing a ${c.name}, one step a call: its reference slots, then what isn't a reference (3.5, D74). */`,
    );
    // R4: a small one is inlined where @tsl/gc calls it, at -O1 too, as a call a step was most of what a step cost there;
    // a map's, or one with many slots, stays a function
    if (maps.length === 0 && refs.length + vecs.length + bufs.length <= 3)
      r.push("/** @tsl.inline */");
    r.push(
      `function ${c.release}(${used ? "o" : "_o"}: ${c.name}, ${used ? "at" : "_at"}: usize, ${used ? "op" : "_op"}: Visit): usize {`,
    );
    // k: the reference fields, each vector's elements, and each vector's buffer
    let k = `${refs.length}`;
    // a map's positions don't change while it's freed, so they're counted by `at`, right after the references
    // R11: a map holding nothing counted is its buffers alone, one step, as the direct route's vectors of numbers are
    const mapSteps = (v: (typeof maps)[number]): string =>
      v.cls === null && (v.vcls === null || v.vcls === undefined) && !r11Off("mapsteps")
        ? "1"
        : `o.${v.name}.positions() + 1`;
    for (const v of maps) k += ` + ${mapSteps(v)}`;
    // a JsRoomArray (R3) has a room to give back only where it outgrew its holder's tail
    for (const v of [...vecs, ...bufs])
      k += `${v.kind === "vec" ? ` + o.${v.name}.length` : ""} + ${v.room === true ? (process.env.TMK_TEST_RC_TSL === "rooms-uncounted" ? "0" : `o.${v.name}.rooms`) : `(o.${v.name}.capacity > 0 ? 1 : 0)`}`;
    if (slots.length === 0) r.push("  return 0;");
    else {
      r.push(`  const k: usize = ${k};`);
      let i = 0;
      let first = true;
      const kw = (): string => {
        const s = first ? "if" : "else if";
        first = false;
        return s;
      };
      // R34: what a release function gives where it handed a leaf to freeing: its count of slots and `RC_HANDED` at slot 0,
      // the one call whose count freeing reads, and `RC_HANDED` alone past it (an arm for slot i > 0, or `at` tested where
      // the arm can be either), so no add, and no check of one, where freeing reads only the flag
      const handRet = (i: number | null): string =>
        i === 0
          ? "k + RC_HANDED"
          : i !== null
            ? "RC_HANDED"
            : "at === 0 ? k + RC_HANDED : RC_HANDED";
      for (const s of refs) {
        const st = this.useStore(s.cls!);
        // the injected `rcstr-field-twice` bug (R10): a string field visited twice, so freeing its holder drops it twice
        const twice =
          fault() === "rcstr-field-twice" && s.cls!.name === "JsStr"
            ? ` const y = o.${s.name}; if (y !== null) ${st}.${this.visitOf(s.cls!)}(y, op);`
            : "";
        if (s.nullable && twice !== "")
          r.push(
            `  ${kw()} (at === ${i}) {\n    const x = o.${s.name};\n    if (x !== null) { ${st}.${this.visitOf(s.cls!)}(x, op);${twice} }\n  }`,
          );
        else if (s.nullable && this.handOf(s.cls!))
          r.push(
            `  ${kw()} (at === ${i}) {\n    const x = o.${s.name};\n    if (x !== null && ${st}.handLeaf(x, op)) return ${handRet(i)};\n  }`,
          );
        else if (s.nullable)
          r.push(
            `  ${kw()} (at === ${i}) {\n    const x = o.${s.name};\n    if (x !== null) ${st}.${this.visitOf(s.cls!)}(x, op);\n  }`,
          );
        else if (twice !== "")
          r.push(
            `  ${kw()} (at === ${i}) {\n    const x = o.${s.name};\n    ${st}.${this.visitOf(s.cls!)}(x, op);${twice}\n  }`,
          );
        else if (this.handOf(s.cls!))
          r.push(
            `  ${kw()} (at === ${i}) {\n    if (${st}.handLeaf(o.${s.name}, op)) return ${handRet(i)};\n  }`,
          );
        else r.push(`  ${kw()} (at === ${i}) ${st}.${this.visitOf(s.cls!)}(o.${s.name}, op);`);
        i++;
      }
      // each map's positions, by `at`: freeing takes the entry out, the collector looking only visits it (D41), and
      // the step after its last gives its buffers back
      let base = `${refs.length}`;
      for (const v of maps) {
        const parts: string[] = [];
        if (v.cls !== null) {
          const st = this.useStore(v.cls);
          parts.push(
            `      const x = o.${v.name}.outKey();\n      if (x !== null) ${st}.${this.visitOf(v.cls)}(x, op);`,
          );
        }
        if (v.vcls !== null && v.vcls !== undefined) {
          const st = this.useStore(v.vcls);
          parts.push(
            `      const y = o.${v.name}.outVal();\n      if (y !== null) ${st}.${this.visitOf(v.vcls)}(y, op);`,
          );
        }
        const j = `at - (${base})`;
        if (mapSteps(v) === "1") {
          r.push(
            `  ${kw()} (at === ${base}) {\n    if (op !== Visit.Scan && op !== Visit.Trace) o.${v.name}.trim();\n  }`,
          );
          base = `${base} + 1`;
          continue;
        }
        if (parts.length > 0)
          r.push(
            `  ${kw()} (at < ${base} + o.${v.name}.positions()) {\n    if (o.${v.name}.entryAt(${base === "0" ? "at" : j}, op !== Visit.Scan && op !== Visit.Trace)) {\n${parts.join("\n")}\n    }\n  }`,
          );
        r.push(
          `  ${kw()} (at === ${base} + o.${v.name}.positions()) {\n    if (op !== Visit.Scan && op !== Visit.Trace) o.${v.name}.trim();\n  }`,
        );
        base = `${base} + o.${v.name}.positions() + 1`;
      }
      // JsArrays alone (R2, a lowered package's holders): each element visited where it is, by `at`, whatever the step
      // asks, freeing included, as nothing reads an array that's being freed; then each buffer given back. Nothing is
      // zeroed or moved, and no length changes before the buffers go, so `at` finds the same element throughout.
      const jsOnly =
        vecs.length > 0 &&
        vecs.every((v) => v.js === true) &&
        process.env.TMK_TEST_RC_TSL !== "js-pop-free";
      if (jsOnly) {
        const b0 = maps.length > 0 ? `(${base})` : `${refs.length}`;
        const all = vecs.map((v) => `o.${v.name}.length`).join(" + ");
        const lines: string[] = [`    let j: usize = at - ${b0};`];
        vecs.forEach((v, n) => {
          const st = this.useStore(v.cls!);
          // R34: an element keeps R4's visitLeaf: where most visits hand a leaf over (an array of leaves), handing it back
          // through what the release function returns cost more than `spare` (bench/memory's acyclic, MEASURED)
          const visit = `{\n      const x = o.${v.name}.get(j);\n      if (x !== null) ${st}.${this.visitOf(v.cls!)}(x, op);\n    }`;
          if (n + 1 < vecs.length)
            lines.push(`    if (j < o.${v.name}.length) ${visit}`, `    j -= o.${v.name}.length;`);
          else lines.push(`    ${visit}`);
        });
        r.push(`  ${kw()} (at < ${b0} + ${all}) {\n${lines.join("\n")}\n  }`);
        for (const v of vecs)
          r.push(
            fault() === "js-free-keeps"
              ? `  ${kw()} (op !== Visit.Scan && op !== Visit.Trace && o.${v.name}.capacity > 0 && false) {\n  }`
              : v.room === true && this.roomHand()
                ? `  ${kw()} (op !== Visit.Scan && op !== Visit.Trace && o.${v.name}.rooms !== 0) {\n    if (o.${v.name}.trimHand()) return ${handRet(null)};\n  }`
                : `  ${kw()} (op !== Visit.Scan && op !== Visit.Trace && o.${v.name}.trim()) {\n  }`,
          );
      }
      // the cycle collector looking (D41): a vector's elements visited where they are, nothing moved or given back
      if (!jsOnly && c.cyclic === true && vecs.length > 0) {
        this.needGc.add("Visit");
        const parts: string[] = [];
        let close = "";
        vecs.forEach((v, n) => {
          const st = this.useStore(v.cls!);
          const len = `o.${v.name}.length`;
          if (v.js === true)
            parts.push(
              `    if (j < ${len}) {\n      const x = o.${v.name}.get(j);\n      if (x !== null) ${st}.visit(x, op);\n    }`,
            );
          else parts.push(`    if (j < ${len}) ${st}.visit(o.${v.name}.get(j), op);`);
          if (n + 1 < vecs.length) {
            parts.push(`    else if (j >= ${len} + (o.${v.name}.capacity > 0 ? 1 : 0)) {`);
            parts.push(`    j -= ${len} + (o.${v.name}.capacity > 0 ? 1 : 0);`);
            close += "    }\n";
          }
        });
        r.push(
          `  ${kw()} (op === Visit.Scan || op === Visit.Trace) {\n    let j: usize = at - ${maps.length > 0 ? `(${base})` : refs.length};\n${parts.join("\n")}\n${close}  }`,
        );
      }
      // past the fields, each call does the next thing: a vector's last element moved out and visited, or an empty
      // vector's buffer given back (`trim`), so a freed vector is never read again and every step is one of these
      for (const v of jsOnly ? [] : vecs) {
        const st = this.useStore(v.cls!);
        // R34: an element keeps R4's visitLeaf (above)
        if (v.js === true)
          r.push(
            `  ${kw()} (o.${v.name}.length > 0) {\n    const x = o.${v.name}.pop(null);\n    if (x !== null) ${st}.${this.visitOf(v.cls!)}(x, op);\n  }`,
          );
        else
          r.push(
            `  ${kw()} (o.${v.name}.length > 0) ${st}.${this.visitOf(v.cls!)}(o.${v.name}.pop(), op);`,
          );
        r.push(
          v.room === true && this.roomHand()
            ? `  ${kw()} (o.${v.name}.rooms !== 0) {\n    if (o.${v.name}.trimHand()) return ${handRet(null)};\n  }`
            : `  ${kw()} (o.${v.name}.trim()) {\n  }`,
        );
      }
      // a JsArray of numbers (R2): its buffer, given back (R34: a room through trimHand)
      for (const v of bufs)
        r.push(
          v.room === true && this.roomHand()
            ? `  ${kw()} (o.${v.name}.rooms !== 0) {\n    if (o.${v.name}.trimHand()) return ${handRet(null)};\n  }`
            : `  ${kw()} (o.${v.name}.trim()) {\n  }`,
        );
      r.push("  return k;");
    }
    r.push("}");
    r.push(`\n${exported ? "export " : ""}const ${c.store} = new Rc<${c.name}>(${c.release});`);
    this.storesUsed.add(c);
    const w = c.weak;
    if (w !== undefined) {
      // weak references to it: counted objects of their own, holding no reference slot (D74)
      this.needGc.add("Weak");
      r.push(
        `\n/** Weak references to a ${c.name}: \`new WeakRef(x)\` (3.5, D74). They hold no count, so freeing one is one step. */`,
      );
      r.push(
        `/** @tsl.inline */\nfunction ${w.release}(_o: Weak<${c.name}>, _at: usize, _op: Visit): usize {\n  return 0;\n}`,
      );
      r.push(
        `\n${exported ? "export " : ""}const ${w.store} = new Rc<Weak<${c.name}>>(${w.release});`,
      );
    }
    return lines.join("\n") + r.join("\n");
  }

  methodText(
    m: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  ): string {
    const sf = this.sf;
    const f = new FnExpand(this, m, false);
    const head = sf.text.slice(m.getStart(sf), m.body!.getStart(sf));
    return this.retypedHead(m, head) + f.body(m.body!, []);
  }

  functionDecl(st: ts.FunctionDeclaration): string {
    const sf = this.sf;
    const f = new FnExpand(this, st, false);
    let head = sf.text.slice(st.getStart(sf), st.body!.getStart(sf));
    // R8: a counted parameter the function takes over (`@tsl.moves p`) is a handle, `Counted<C>`, as a person writing
    // @tsl/gc would type it, so tslc's move check holds a caller to it (TSL3009, D63). Right to left, so offsets hold.
    for (const p of [...movedParams(st)].reverse()) {
      if (p.type === undefined) continue;
      const { cls, nullable } = this.classOf(p.name);
      if (cls === null) continue;
      const at = p.type.getStart(sf) - st.getStart(sf);
      head =
        head.slice(0, at) +
        this.countedType(cls, nullable) +
        head.slice(at + p.type.getText(sf).length);
    }
    return this.retypedHead(st, head) + f.body(st.body!, []);
  }

  /** A function's head with a counted return type written as `Counted<…>`. */
  retypedHead(f: ts.SignatureDeclaration, head: string): string {
    if (f.type === undefined) return head;
    const sig = this.checker.getSignatureFromDeclaration(f);
    if (sig === undefined) return head;
    const { cls, nullable } = this.classOfType(sig.getReturnType());
    if (cls === null) return head;
    const sf = this.sf;
    const at = f.type.getStart(sf) - f.getStart(sf);
    return (
      head.slice(0, at) +
      this.countedType(cls, nullable) +
      head.slice(at + f.type.getText(sf).length)
    );
  }
}

/**
 * R8: the parameters a function declaration takes over, `@tsl.moves p` in its doc comment: in an `rc` package, a counted
 * parameter so tagged is owned by the function (its caller's count is the function's to drop), where every other argument
 * is borrowed (D39). It's how a package gives a native caller something to hand a count back to (4.5's ABI in `rc`).
 */
export function movedParams(d: ts.Node): ts.ParameterDeclaration[] {
  if (!ts.isFunctionDeclaration(d)) return [];
  const sf = d.getSourceFile();
  const doc = sf.text.slice(d.getFullStart(), d.getStart(sf));
  const out: ts.ParameterDeclaration[] = [];
  for (const m of doc.matchAll(/@tsl\.moves\s+(\w+)/g)) {
    const p = d.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === m[1]);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** public, private, protected or readonly on a constructor parameter: it's a field too. */
function isPropModifier(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.PublicKeyword ||
    k === ts.SyntaxKind.PrivateKeyword ||
    k === ts.SyntaxKind.ProtectedKeyword ||
    k === ts.SyntaxKind.ReadonlyKeyword
  );
}

function isAssign(k: ts.SyntaxKind): boolean {
  return k === ts.SyntaxKind.EqualsToken;
}

function isSimple(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isSimple(e.expression);
  if (ts.isNonNullExpression(e)) return isSimple(e.expression);
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(e)) return isSimple(e.expression);
  return false;
}

/** One function's body (or a field initialiser), expanded. */
class FnExpand {
  scopes: Scope[] = [];
  locals = new Map<ts.Symbol, Local>();
  pre: string[] = []; //   statements to run before the current one
  temps: string[] = []; // owned temporaries the current statement drops after it
  quiet: boolean;
  ctorInit: Set<string> = new Set();
  indent = "  ";
  params = new Set<ts.Symbol>();
  returnsCounted = false;

  x: Expander;
  fn: ts.FunctionLikeDeclaration | null;
  ctor: boolean;
  constructor(x: Expander, fn: ts.FunctionLikeDeclaration | null, ctor: boolean) {
    this.x = x;
    this.fn = fn;
    this.ctor = ctor;
    this.quiet = fn !== null && x.isQuiet(fn);
    if (fn !== null) {
      for (const p of fn.parameters) {
        const s = x.symOf(p.name);
        if (s !== undefined) this.params.add(s);
      }
    }
  }

  get sf(): ts.SourceFile {
    return this.x.sf;
  }

  fresh(base: string): string {
    return `$${base}${++this.x.tmp}`;
  }

  // --- values

  /** A counted value made owned: `share` on a borrow (null stays null). */
  shareText(text: string, c: CountedClass, nullable: boolean, simple: boolean): string {
    const st = this.x.useStore(c);
    if (fault() === "no-share") return text;
    if (!nullable) return `${st}.share(${text})`;
    if (simple) return `${text} === null ? null : ${st}.share(${text})`;
    const t = this.fresh("b");
    this.pre.push(`const ${t} = ${text};`);
    return `${t} === null ? null : ${st}.share(${t})`;
  }

  /** The owned form of a value, for a consumer that takes a count over: a field, a global, a result, a vector. */
  owned(v: Val, lastUse: boolean): string {
    if (v.own || v.cls === null || v.root === "null") return v.text;
    // the injected `rcstr-lit-unretained` bug (R10): a string read from module state (a literal's) handed on uncounted
    if (fault() === "rcstr-lit-unretained" && v.root === "global" && v.cls.name === "JsStr")
      return v.text;
    if (v.local !== undefined) {
      const l = this.locals.get(v.local);
      if (l !== undefined && l.owned && lastUse && !l.moved) {
        l.moved = true;
        // take wants a handle; a nullable local's count moves as it is, and nothing drops it after
        return l.nullable ? v.text : `${this.x.useStore(v.cls)}.take(${v.text})`;
      }
    }
    return this.shareText(v.text, v.cls, v.nullable, v.simple);
  }

  /** A value only read: an owned one goes in a temporary the statement drops after it. */
  borrowed(v: Val): string {
    if (!v.own || v.cls === null) return v.text;
    const t = this.fresh("t");
    this.pre.push(`const ${t} = ${v.text};`);
    // the injected `rcstr-temp-leak` bug (R10): a string only read, a concatenation's temporary, never let go of
    if (fault() === "rcstr-temp-leak" && v.cls.name === "JsStr") return t;
    this.temps.push(
      v.nullable
        ? `if (${t} !== ${v.nil}) ${this.x.useStore(v.cls)}.drop(${t});`
        : `${this.x.useStore(v.cls)}.drop(${t});`,
    );
    return t;
  }

  ownedInit(e: ts.Expression): string {
    const v = this.expr(e);
    const s = this.owned(v, false);
    if (this.pre.length > 0 || this.temps.length > 0)
      throw new Unsupported(e, "rc: this initialiser needs a statement of its own");
    return s;
  }

  val(text: string, e: ts.Node, extra: Partial<Val> = {}): Val {
    const { cls, nullable, nil } = this.x.classOf(e);
    return { text, own: false, cls, nullable, nil, root: "none", simple: false, ...extra };
  }

  /** Every child expression of e, rebuilt, spliced into its own text. */
  splice(e: ts.Node): string {
    const sf = this.sf;
    const start = e.getStart(sf);
    let text = "";
    let at = start;
    let sawCall = false;
    const kids: ts.Node[] = [];
    ts.forEachChild(e, (k) => {
      kids.push(k);
    });
    for (const k of kids) {
      if (!ts.isExpression(k) && !ts.isTemplateSpan(k)) continue;
      const before = this.pre.length;
      const r = ts.isTemplateSpan(k)
        ? this.splice(k)
        : this.borrowed(this.expr(k as ts.Expression));
      if (this.pre.length > before && sawCall)
        throw new Unsupported(
          k,
          "rc: an allocation or temporary after a call in the same expression: give it a statement of its own",
        );
      if (containsCall(k)) sawCall = true;
      text += sf.text.slice(at, k.getStart(sf)) + r;
      at = k.end;
    }
    return text + sf.text.slice(at, e.end);
  }

  expr(e: ts.Expression): Val {
    const sf = this.sf;
    if (ts.isParenthesizedExpression(e)) {
      const v = this.expr(e.expression);
      return { ...v, text: v.simple ? `(${v.text})` : `(${v.text})` };
    }
    if (ts.isNonNullExpression(e)) {
      const v = this.expr(e.expression);
      return { ...v, text: `${v.text}!`, nullable: false };
    }
    if (e.kind === ts.SyntaxKind.NullKeyword)
      return { ...this.val("null", e), root: "null", simple: true };
    if (e.kind === ts.SyntaxKind.ThisKeyword) {
      // In its own constructor the object isn't counted yet (`make` places it after), so it can't be given away (R1c,
      // found porting D41's corpus): passing it on, or storing it, would share what has no count.
      if (this.ctor && !(ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e))
        throw new Unsupported(
          e,
          "rc: `this` given away in its own constructor isn't counted yet: give it away after `new`",
        );
      return { ...this.val("this", e), root: "this", simple: true };
    }
    if (ts.isIdentifier(e)) {
      const s = this.x.symOf(e);
      const v = this.val(e.text, e, { simple: true });
      if (s === undefined) return v;
      if (this.params.has(s)) return { ...v, root: "param" };
      const l = this.locals.get(s);
      if (l !== undefined) {
        if (l.moved) throw new Unsupported(e, `rc: ${l.name} is read after its last use moved it`);
        return { ...v, root: l.owned ? s : l.sym, local: s };
      }
      if (this.isLocalSym(s)) return { ...v, root: s };
      return { ...v, root: "global", global: s };
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = this.expr(e.expression);
      const b = this.borrowed(base);
      const v = this.val(`${b}.${e.name.text}`, e);
      return { ...v, root: base.own ? "temp" : base.root, simple: base.simple && !base.own };
    }
    if (ts.isNewExpression(e)) return this.newExpr(e);
    if (ts.isCallExpression(e)) return this.call(e);
    if (ts.isConditionalExpression(e)) {
      const { cls } = this.x.classOf(e);
      const c = this.splice(e.condition);
      const before = this.pre.length;
      const a = this.expr(e.whenTrue);
      const b = this.expr(e.whenFalse);
      if (this.pre.length !== before)
        throw new Unsupported(
          e,
          "rc: an allocation inside a conditional expression: give it a statement of its own",
        );
      if (cls === null) return this.val(`${c} ? ${a.text} : ${b.text}`, e);
      const own = a.own || b.own;
      const at = own ? this.ownedInBranch(a, e.whenTrue) : a.text;
      const bt = own ? this.ownedInBranch(b, e.whenFalse) : b.text;
      return { ...this.val(`${c} ? ${at} : ${bt}`, e), own, root: own ? "owned" : "none" };
    }
    if (ts.isBinaryExpression(e) && isAssign(e.operatorToken.kind)) {
      const { cls } = this.x.classOf(e.left);
      if (cls !== null)
        throw new Unsupported(
          e,
          "rc: an assignment of a counted reference is a statement of its own",
        );
      if (ts.isBinaryExpression(e)) {
        const l = this.splice(e.left);
        return this.val(
          `${l} ${e.operatorToken.getText(sf)} ${this.borrowed(this.expr(e.right))}`,
          e,
        );
      }
    }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      const { cls } = this.x.classOf(e);
      if (
        cls !== null &&
        (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken)
      ) {
        const a = this.expr(e.left);
        const before = this.pre.length;
        const b = this.expr(e.right);
        if (this.pre.length !== before || a.own || b.own)
          throw new Unsupported(
            e,
            "rc: an owned value inside ?? or ||: give it a statement of its own",
          );
        return {
          ...this.val(`${a.text} ${e.operatorToken.getText(sf)} ${b.text}`, e),
          root: "none",
        };
      }
      if (
        k === ts.SyntaxKind.AmpersandAmpersandToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const a = this.splice(e.left);
        const before = this.pre.length;
        const b = this.borrowed(this.expr(e.right));
        if (this.pre.length !== before)
          throw new Unsupported(
            e.right,
            "rc: an allocation on the right of a short-circuit: give it a statement of its own",
          );
        return this.val(`${a} ${e.operatorToken.getText(sf)} ${b}`, e);
      }
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.val(this.closure(e), e);
    return this.val(this.splice(e), e);
  }

  ownedInBranch(v: Val, e: ts.Node): string {
    if (v.own || v.cls === null || v.root === "null") return v.text;
    if (fault() === "rcstr-lit-unretained" && v.root === "global" && v.cls.name === "JsStr")
      return v.text;
    if (!v.simple) throw new Unsupported(e, "rc: give this branch's value a local of its own");
    // R10: a branch's value that can be null (a string literal's module state, `JsStr | null`) is shared only if it isn't
    if (v.nullable)
      return `(${v.text} === ${v.nil} ? ${v.nil} : ${this.x.useStore(v.cls)}.share(${v.text}))`;
    return `${this.x.useStore(v.cls)}.share(${v.text})`;
  }

  isLocalSym(s: ts.Symbol): boolean {
    const d = s.valueDeclaration;
    if (d === undefined || !ts.isVariableDeclaration(d)) return false;
    let p: ts.Node = d;
    while (!ts.isSourceFile(p.parent)) {
      p = p.parent;
      if (ts.isFunctionLike(p)) return true;
    }
    return false;
  }

  newExpr(e: ts.NewExpression): Val {
    const { cls } = this.x.classOf(e);
    if (cls !== null && cls.target !== undefined) {
      // new WeakRef(x): a counted Weak<C> holding x's slot and generation, and no count on x
      const a = e.arguments?.[0];
      if (a === undefined) throw new Unsupported(e, "rc: WeakRef takes its target");
      const x = this.borrowed(this.expr(a));
      this.x.needGc.add("Weak");
      return {
        ...this.val(
          `${this.x.useStore(cls)}.make(new Weak<${cls.target.name}>(${this.x.useStore(cls.target)}, ${x}))`,
          e,
        ),
        own: true,
        root: "owned",
      };
    }
    const args = this.args(e, e.arguments ?? []);
    const text = `new ${e.expression.getText(this.sf)}${e.typeArguments !== undefined ? `<${e.typeArguments.map((t) => t.getText(this.sf)).join(", ")}>` : ""}(${args.join(", ")})`;
    if (cls === null) return this.val(text, e);
    // the injected bug `r18-stack-counted`: a stack object, counted all the same, which @tsl/gc's drop then frees
    if (cls.stack === true) return { ...this.val(text, e), own: true, root: "owned" };
    if (cls.tail)
      throw new Unsupported(
        e,
        `rc: ${cls.name} has a tail, so it's made with withTail(n, new ${cls.name}(…))`,
      );
    return { ...this.val(`${this.x.useStore(cls)}.make(${text})`, e), own: true, root: "owned" };
  }

  /** Arguments are borrowed. One read from memory is held across a call that could overwrite where it came from. */
  args(call: ts.CallExpression | ts.NewExpression, list: readonly ts.Expression[]): string[] {
    const d = this.x.declOfCall(call);
    const quietCallee = this.x.isQuiet(d) || fault() === "elide";
    const out: string[] = [];
    let sawCall = false;
    for (const a of list) {
      const before = this.pre.length;
      const v = this.expr(a);
      let t: string;
      if (
        v.cls !== null &&
        !v.own &&
        !quietCallee &&
        v.root !== "null" &&
        v.local === undefined &&
        v.root !== "param" &&
        v.root !== "this" &&
        !(v.global !== undefined && this.x.initOnly(v.global))
      ) {
        t = this.borrowed({
          ...v,
          text: this.shareText(v.text, v.cls, v.nullable, v.simple),
          own: true,
        });
      } else t = this.borrowed(v);
      if (this.pre.length > before && sawCall) {
        if (r11Off("args"))
          throw new Unsupported(
            a,
            "rc: an allocation or temporary after a call among the arguments: give it a statement of its own",
          );
        // R11: what this argument needs first would run before a call in an argument before it, so the arguments before it
        // are evaluated into locals first, in order, and then what this one needs: the order the source has
        const spill: string[] = [];
        for (let k = 0; k < out.length; k++) {
          if (/^[A-Za-z_$][\w$]*$|^-?\d/.test(out[k]!)) continue;
          const t = this.fresh("a");
          spill.push(`const ${t} = ${out[k]!};`);
          out[k] = t;
        }
        this.pre.splice(before, 0, ...spill);
      }
      if (containsCall(a)) sawCall = true;
      out.push(t);
    }
    return out;
  }

  call(e: ts.CallExpression): Val {
    const sf = this.sf;
    const callee = e.expression;
    // withTail(n, new T(…)) of a counted class: makeTail
    if (ts.isIdentifier(callee) && callee.text === "withTail" && e.arguments.length === 2) {
      const inner = e.arguments[1]!;
      const { cls } = this.x.classOf(e);
      if (cls !== null && ts.isNewExpression(inner)) {
        const n = this.borrowed(this.expr(e.arguments[0]!));
        const args = this.args(inner, inner.arguments ?? []);
        // R34: an object whose references are all null and stay so, made in its store's leaf entry
        const make = this.x.leafMake(cls, inner) ? "makeTailLeaf" : "makeTail";
        return {
          ...this.val(
            `${this.x.useStore(cls)}.${make}(${n}, new ${inner.expression.getText(sf)}(${args.join(", ")}))`,
            e,
          ),
          own: true,
          root: "owned",
        };
      }
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const ve = this.x.vecElem(callee.expression);
      if (ve !== null) return this.vecCall(e, callee, ve);
      const mp = this.x.mapOf(callee.expression);
      if (mp !== null && (mp.k !== null || mp.v !== null)) return this.mapCall(e, callee, mp);
    }
    const d = this.x.declOfCall(e);
    if (d !== undefined && this.x.inRc(d) && movedParams(d).length > 0)
      throw new Unsupported(
        e,
        "rc: a function that takes a counted parameter over (@tsl.moves) is for a caller outside the package",
      );
    // @tsl/lowered's `nonNull(x)` and `cast<T>(x)` in a lowered rc package (R2): x itself, read as it was
    if (
      ts.isIdentifier(callee) &&
      (callee.text === "nonNull" || callee.text === "cast") &&
      e.arguments.length >= 1 &&
      d !== undefined &&
      /\/tsl-lowered\//.test(d.getSourceFile().fileName) &&
      this.x.classOf(e).cls !== null
    ) {
      const v = this.expr(e.arguments[0]!);
      const targs =
        e.typeArguments !== undefined
          ? `<${e.typeArguments.map((t) => t.getText(sf)).join(", ")}>`
          : "";
      const rest = e.arguments
        .slice(1)
        .map((a) => `, ${a.getText(sf)}`)
        .join("");
      const { nullable } = this.x.classOf(e);
      // the injected bug (`nonnull-owned`): taken for a call's result, a count the caller holds, so it's dropped too
      if (fault() === "nonnull-owned")
        return {
          ...this.val(`${callee.text}${targs}(${v.text}${rest})`, e),
          own: true,
          root: "owned",
        };
      return { ...v, text: `${callee.text}${targs}(${v.text}${rest})`, nullable, simple: false };
    }
    let calleeText: string;
    if (ts.isPropertyAccessExpression(callee)) {
      const recv = this.expr(callee.expression);
      let r: string;
      if (
        recv.cls !== null &&
        !recv.own &&
        !this.x.isQuiet(d) &&
        recv.local === undefined &&
        recv.root !== "param" &&
        recv.root !== "this"
      )
        r = this.borrowed({
          ...recv,
          text: this.shareText(recv.text, recv.cls, recv.nullable, recv.simple),
          own: true,
        });
      else r = this.borrowed(recv);
      calleeText = `${r}${callee.questionDotToken !== undefined ? "?." : "."}${callee.name.text}`;
    } else calleeText = this.borrowed(this.expr(callee));
    const targs =
      e.typeArguments !== undefined
        ? `<${e.typeArguments.map((t) => t.getText(sf)).join(", ")}>`
        : "";
    const args = this.args(e, e.arguments);
    const v = this.val(`${calleeText}${targs}(${args.join(", ")})`, e);
    // a counted result is owned; anything else is what it is
    if (v.cls !== null) return { ...v, own: true, root: "owned" };
    return v;
  }

  vecCall(e: ts.CallExpression, callee: ts.PropertyAccessExpression, c: CountedClass): Val {
    const name = callee.name.text;
    const recv = this.expr(callee.expression);
    if (recv.own)
      throw new Unsupported(
        callee,
        "rc: a vector of counted references is a field of a counted object",
      );
    const v = recv.text;
    const st = this.x.useStore(c);
    const arg = (i: number): Val => this.expr(e.arguments[i]!);
    const simpleIdx = (a: ts.Expression): string => {
      const t = this.borrowed(this.expr(a));
      if (isSimple(a) || ts.isNumericLiteral(a)) return t;
      const n = this.fresh("i");
      this.pre.push(`const ${n} = ${t};`);
      return n;
    };
    // D41's barrier on a count-preserving move: before elements of a vector of a class that can be in a cycle move, while
    // a scan is on, each one that moves is touched, so the scan can't count an edge twice or miss one unnoticed (R1c)
    const moveFrom = (a: ts.Expression | null): string => {
      if (c.cyclic !== true || process.env.TMK_TEST_RC_TSL === "no-move-touch")
        return a === null ? "" : this.borrowed(this.expr(a));
      const i = a === null ? "" : simpleIdx(a);
      this.x.needGc.add("rcScanning");
      this.x.needCore.add("usize");
      const j = this.fresh("j");
      if (a === null)
        this.pre.push(
          `if (rcScanning() && ${v}.length > 0) ${st}.touch(${v}.get(${v}.length - 1));`,
        );
      else
        this.pre.push(
          `if (rcScanning()) for (let ${j}: usize = ${i}; ${j} < ${v}.length; ${j}++) ${st}.touch(${v}.get(${j}));`,
        );
      return i;
    };
    if (this.x.isJsArray(callee.expression)) {
      const r = this.jsArrayCall(e, name, v, st, c, arg, simpleIdx);
      if (r !== null) return r;
    }
    switch (name) {
      case "get":
        return {
          ...this.val(`${v}.get(${this.borrowed(arg(0))})`, e),
          root: recv.root,
          simple: false,
        };
      case "push": {
        const x = arg(0);
        return this.val(`${v}.push(${this.owned(x, this.lastUseNow(x))})`, e);
      }
      case "insert": {
        const i = moveFrom(e.arguments[0]!);
        const x = arg(1);
        return this.val(`${v}.insert(${i}, ${this.owned(x, false)})`, e);
      }
      case "set": {
        const i = simpleIdx(e.arguments[0]!);
        const x = arg(1);
        return this.val(
          `${v}.set(${i}, ${st}.replace(${v}.get(${i}), ${this.owned(x, false)}))`,
          e,
        );
      }
      case "pop":
      case "removeAt":
      case "swapRemove":
        if (name === "pop") moveFrom(null);
        return {
          ...this.val(
            name === "pop" ? `${v}.pop()` : `${v}.${name}(${moveFrom(e.arguments[0]!)})`,
            e,
          ),
          own: true,
          root: "owned",
        };
      case "clear": {
        const i = this.fresh("i");
        this.pre.push(
          `for (let ${i}: usize = 0; ${i} < ${v}.length; ${i}++) ${st}.drop(${v}.get(${i}));`,
        );
        this.x.needCore.add("usize");
        return this.val(`${v}.clear()`, e);
      }
      case "free":
        throw new Unsupported(
          e,
          "rc: a vector of counted references is freed with the object holding it",
        );
      default:
        return this.val(
          `${v}.${name}(${e.arguments.map((a) => this.borrowed(this.expr(a))).join(", ")})`,
          e,
        );
    }
  }

  /**
   * A JsArray of a counted class, held in place by a lowered `rc` package's holder (R2): what differs from a `Vec`. Its
   * elements can be holes (`null`), `pop` and `shift` take what an empty array gives, and `setLength` drops what it cuts
   * off. Null for what's the same as a Vec's.
   */
  jsArrayCall(
    e: ts.CallExpression,
    name: string,
    v: string,
    st: string,
    c: CountedClass,
    arg: (i: number) => Val,
    simpleIdx: (a: ts.Expression) => string,
  ): Val | null {
    const drop = (x: string): string => `if (${x} !== null) ${st}.drop(${x});`;
    // D41's barrier on elements that move while a scan is on (R1c), holes passed over: the last one, or all of them
    const touch = (all: boolean): void => {
      if (c.cyclic !== true || process.env.TMK_TEST_RC_TSL === "no-move-touch") return;
      this.x.needGc.add("rcScanning");
      this.x.needCore.add("usize");
      const j = this.fresh("j");
      const x = this.fresh("x");
      const from = all ? "0" : `${v}.length - 1`;
      this.pre.push(
        `if (rcScanning()) for (let ${j}: usize = ${all ? "0" : `${v}.length > 0 ? ${from} : 0`}; ${j} < ${v}.length; ${j}++) {\n  const ${x} = ${v}.get(${j});\n  if (${x} !== null) ${st}.touch(${x});\n}`,
      );
    };
    switch (name) {
      case "set": {
        // the new element counted, then the old one dropped, after the statement (D39's order)
        const i = simpleIdx(e.arguments[0]!);
        const o = this.fresh("o");
        this.pre.push(`const ${o} = ${v}.get(${i});`);
        const x = arg(1);
        const nv = this.owned(x, this.lastUseNow(x));
        if (process.env.TMK_TEST_RC_TSL !== "js-set-keeps") this.temps.push(drop(o));
        return this.val(`${v}.set(${i}, ${nv})`, e);
      }
      case "push": {
        const x = arg(0);
        return this.val(`${v}.push(${this.owned(x, this.lastUseNow(x))})`, e);
      }
      case "pop":
      case "shift": {
        // moved out: the caller owns it, holes and the empty array's `none` included
        touch(name === "shift");
        const none = e.arguments[0] !== undefined ? this.borrowed(arg(0)) : "null";
        return { ...this.val(`${v}.${name}(${none})`, e), own: true, root: "owned" };
      }
      case "setLength": {
        // what a shorter length cuts off is dropped first: dropping only queues it, so nothing is freed in between
        const n = simpleIdx(e.arguments[0]!);
        const j = this.fresh("j");
        const x = this.fresh("x");
        this.x.needCore.add("usize");
        if (process.env.TMK_TEST_RC_TSL !== "js-cut-keeps")
          this.pre.push(
            `for (let ${j}: usize = ${n}; ${j} < ${v}.length; ${j}++) {\n  const ${x} = ${v}.get(${j});\n  ${drop(x)}\n}`,
          );
        return this.val(`${v}.setLength(${n})`, e);
      }
      case "get":
      case "length":
      case "reserve":
      case "forEach":
      case "attach": // R3: a JsRoomArray's first room, its holder's tail
        return null;
      default:
        throw new Unsupported(e, `rc: JsArray's ${name} on counted references`);
    }
  }

  /**
   * A call on a JsMap or JsSet of counted keys or values, held in place by a lowered `rc` package's holder (R2). A read
   * gives a borrow, good until the map changes. A change goes through what hands back what the map stops holding, which
   * is dropped: `set` is `put` (the key's own count kept if it was inserted, the value replaced dropped), `delete` is
   * `cut` (the key and value dropped), and `clear` takes every entry out first.
   */
  mapCall(
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    mp: { k: CountedClass | null; v: CountedClass | null; set: boolean },
  ): Val {
    const name = callee.name.text;
    const recv = this.expr(callee.expression);
    if (recv.own)
      throw new Unsupported(
        callee,
        "rc: a map of counted references is a field of a counted object",
      );
    const m = recv.text;
    const fault = process.env.TMK_TEST_RC_TSL ?? "";
    const dropOut = (c: CountedClass | null, read: string): string[] => {
      if (c === null) return [];
      const x = this.fresh("x");
      return [
        `const ${x} = ${m}.${read}();`,
        `if (${x} !== null) ${this.x.useStore(c)}.drop(${x});`,
      ];
    };
    switch (name) {
      case "get":
      case "getOr":
      case "keyAt":
      case "valAt":
        // a borrow from the map, read where it is
        return {
          ...this.val(
            `${m}.${name}(${e.arguments.map((a) => this.borrowed(this.expr(a))).join(", ")})`,
            e,
          ),
          root: recv.root,
          simple: false,
        };
      case "set":
      case "add": {
        const ka = this.expr(e.arguments[0]!);
        const kt = mp.k !== null ? this.owned(ka, false) : this.borrowed(ka);
        const k = this.fresh("k");
        this.pre.push(`const ${k} = ${kt};`);
        let v = "";
        if (name === "set") {
          const va = this.expr(e.arguments[1]!);
          v = this.fresh("v");
          this.pre.push(
            `const ${v} = ${mp.v !== null ? this.owned(va, this.lastUseNow(va)) : this.borrowed(va)};`,
          );
        }
        const ins = this.fresh("i");
        this.pre.push(`const ${ins} = ${m}.put(${k}${name === "set" ? `, ${v}` : ""});`);
        const kept: string[] = [];
        if (mp.k !== null && fault !== "map-key-kept")
          kept.push(`if (${k} !== null) ${this.x.useStore(mp.k)}.drop(${k});`);
        if (mp.v !== null && name === "set" && fault !== "map-val-kept")
          kept.push(...dropOut(mp.v, "outVal"));
        if (kept.length > 0) this.pre.push(`if (!${ins}) {`, ...kept.map((l) => `  ${l}`), "}");
        return this.val("", e);
      }
      case "delete": {
        const ka = this.borrowed(this.expr(e.arguments[0]!));
        const c = this.fresh("c");
        this.pre.push(`const ${c} = ${m}.cut(${ka});`);
        const out =
          fault === "map-cut-kept" ? [] : [...dropOut(mp.k, "outKey"), ...dropOut(mp.v, "outVal")];
        if (out.length > 0) this.pre.push(`if (${c}) {`, ...out.map((l) => `  ${l}`), "}");
        return this.val(c, e);
      }
      case "clear": {
        // every entry out first, its counts dropped: the one change on a map whose work grows with it
        const p = this.fresh("p");
        this.x.needCore.add("usize");
        const out = [...dropOut(mp.k, "outKey"), ...dropOut(mp.v, "outVal")];
        if (fault !== "map-clear-kept")
          this.pre.push(
            `for (let ${p}: usize = 0; ${p} < ${m}.positions(); ${p}++) {`,
            `  if (${m}.entryAt(${p}, true)) {`,
            ...out.map((l) => `    ${l}`),
            "  }",
            "}",
          );
        return this.val(`${m}.clear()`, e);
      }
      case "has":
      case "cursor":
      case "advance":
      case "forEach":
      case "freesTables":
      case "tablesIn":
        return this.val(
          `${m}.${name}(${e.arguments.map((a) => this.borrowed(this.expr(a))).join(", ")})`,
          e,
        );
      default:
        throw new Unsupported(e, `rc: a map's ${name} on counted references`);
    }
  }

  closure(e: ts.ArrowFunction | ts.FunctionExpression): string {
    const inner = new FnExpand(this.x, e, false);
    inner.quiet = false;
    // a closure's counted parameters are held for its whole body: what it's given may be overwritten by what it does
    inner.holdParams = true;
    const sf = this.sf;
    const head = sf.text.slice(e.getStart(sf), e.body.getStart(sf));
    if (!ts.isBlock(e.body)) {
      const v = inner.expr(e.body);
      if (inner.pre.length > 0 || inner.temps.length > 0 || v.own)
        throw new Unsupported(e, "rc: give this closure a block body");
      for (const p of e.parameters)
        if (this.x.classOf(p.name).cls !== null)
          throw new Unsupported(e, "rc: give this closure a block body");
      return head + v.text;
    }
    return head + inner.body(e.body, []);
  }

  holdParams = false;
  cur: { st: ts.Statement; scope: Scope; i: number } | null = null; // the statement being expanded

  /**
   * Whether a value is a local's last use in the statement being expanded, so a vector or map given it can take its count
   * over rather than share it (R2: a lowered package's `const t = new C(); xs.v.push(t)`).
   */
  lastUseNow(v: Val): boolean {
    const c = this.cur;
    if (c === null || v.local === undefined || process.env.TMK_TEST_RC_TSL === "push-no-move")
      return false;
    return this.lastUse(v.local, c.scope, c.i, c.st);
  }

  // --- statements

  body(b: ts.Block, prologue: string[]): string {
    const out: string[] = ["{"];
    const scope: Scope = {
      locals: [],
      block: b,
      stmts: b.statements,
      label: null,
      loop: false,
      breakable: false,
      update: null,
    };
    this.scopes.push(scope);
    for (const p of prologue) out.push(this.indent + p);
    if (this.holdParams && this.fn !== null) {
      for (const p of this.fn.parameters) {
        const { cls, nullable, nil } = this.x.classOf(p.name);
        const s = this.x.symOf(p.name);
        if (cls === null || s === undefined) continue;
        const name = `${p.name.getText(this.sf)}$held`;
        out.push(
          `${this.indent}const ${name} = ${this.shareText(p.name.getText(this.sf), cls, nullable, true)};`,
        );
        // the held copy is dropped at the end; the parameter itself stays the name the body uses
        const l: Local = {
          sym: s,
          name,
          cls,
          nullable,
          nil,
          owned: true,
          moved: false,
          isConst: true,
          scope,
        };
        scope.locals.push(l);
        this.params.add(s);
      }
    }
    // R8: a parameter the function takes over is a local it owns from the start: its last use moves it, and scope exit
    // and every way out drop it, as any owned local's count
    if (this.fn !== null && this.scopes.length === 1)
      for (const p of movedParams(this.fn)) {
        const { cls, nullable, nil } = this.x.classOf(p.name);
        const s = this.x.symOf(p.name);
        if (cls === null || s === undefined) continue;
        const l: Local = {
          sym: s,
          name: p.name.getText(this.sf),
          cls,
          nullable,
          nil,
          owned: true,
          moved: false,
          isConst: false,
          scope,
        };
        scope.locals.push(l);
        // R8's injected bug `r8-release-twice`: the count a release takes over dropped twice, the second time through a
        // copy of the handle (dropping `p` itself twice is TSL3009, which tslc's move check rejects)
        if (fault() === "r8-release-twice") {
          out.push(`${this.indent}const ${l.name}$again = ${l.name};`);
          scope.locals.push({ ...l, name: `${l.name}$again` });
        }
        this.locals.set(s, l);
        this.params.delete(s);
      }
    const terminal = this.stmts(b.statements, out, scope);
    if (!terminal) for (const d of this.dropsOf(scope)) out.push(this.indent + d);
    this.scopes.pop();
    out.push("}");
    return out.join("\n" + this.indent.slice(2));
  }

  /** A statement list in its scope; true if it ends in a jump, so nothing after it runs. */
  stmts(list: readonly ts.Statement[], out: string[], scope: Scope): boolean {
    let terminal = false;
    for (let i = 0; i < list.length; i++) {
      const st = list[i]!;
      // what follows a jump never runs: a lowered package's printing can have a `return` there (R2), which would drop
      // what the jump already gave up, where tsc no longer narrows
      if (terminal) break;
      const lead = this.leadingComments(st);
      if (lead !== "") out.push(lead);
      const was = this.cur;
      this.cur = { st, scope, i };
      const lines = this.stmt(st, scope, i);
      this.cur = was;
      for (const l of lines) out.push(this.indent + l);
      terminal =
        ts.isReturnStatement(st) ||
        ts.isBreakStatement(st) ||
        ts.isContinueStatement(st) ||
        ts.isThrowStatement(st) ||
        this.neverStmt(st) ||
        this.blockJumps(st);
    }
    return terminal;
  }

  leadingComments(st: ts.Node): string {
    const sf = this.sf;
    const ranges = ts.getLeadingCommentRanges(sf.text, st.getFullStart()) ?? [];
    return ranges.map((r) => this.indent + sf.text.slice(r.pos, r.end)).join("\n");
  }

  drop(l: Local): string {
    if (fault() === "no-drop") return "";
    const st = this.x.useStore(l.cls);
    return l.nullable
      ? `if (${l.name} !== ${l.nil}) ${st}.drop(${l.name});`
      : `${st}.drop(${l.name});`;
  }

  dropsOf(scope: Scope): string[] {
    // a map's cursors closed first (R3): nothing a drop frees is one, and a holder the cursor reads is dropped after
    const closes = [...(scope.closes ?? [])].reverse();
    return [
      ...closes,
      ...scope.locals
        .filter((l) => l.owned && !l.moved)
        .reverse()
        .map((l) => this.drop(l))
        .filter((d) => d !== ""),
    ];
  }

  /**
   * A local given `<map>.cursor()` of @tsl/jsrt's JsMap or JsSet (a lowered `rc` package's holder's, which `freesTables`):
   * the statement that closes it where its scope ends (R3), so the map's generations and cursors are reused once none is
   * open. The map is named by a path from a `const`, a parameter (the printer gives one it assigns to a local) or `this`,
   * so the close reaches the map the cursor reads. Otherwise null, and the cursor stays open, as before R3.
   */
  cursorClose(d: ts.VariableDeclaration): string | null {
    const init = d.initializer;
    if (init === undefined || !ts.isIdentifier(d.name)) return null;
    let call: ts.Expression = init;
    while (ts.isParenthesizedExpression(call) || ts.isNonNullExpression(call))
      call = call.expression;
    if (
      !ts.isCallExpression(call) ||
      call.arguments.length !== 0 ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "cursor"
    )
      return null;
    const recv = call.expression.expression;
    const kind = this.x.checker.getTypeAtLocation(recv).getSymbol()?.name;
    if (kind !== "JsMap" && kind !== "JsSet") return null;
    let root: ts.Expression = recv;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (root.kind !== ts.SyntaxKind.ThisKeyword) {
      if (!ts.isIdentifier(root)) return null;
      const decl = this.x.symOf(root)?.valueDeclaration;
      const stable =
        decl !== undefined &&
        (ts.isParameter(decl) ||
          (ts.isVariableDeclaration(decl) &&
            (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0));
      if (!stable) return null;
    }
    if (fault() === "cursor-unclosed") return null;
    return `${recv.getText(this.sf)}.close(${d.name.text});`;
  }

  /** Statement-level: run what the statement hoisted, then it, then drop its temporaries. */
  wrap(text: string): string[] {
    const out = [...this.pre, text, ...this.temps];
    this.pre = [];
    this.temps = [];
    return out;
  }

  /** Whether `sym`'s use in statement `i` of `scope` is its last, and plainly reached. */
  lastUse(sym: ts.Symbol, scope: Scope, i: number, st: ts.Statement): boolean {
    const l = this.locals.get(sym);
    if (l === undefined || scope.stmts === null) return false;
    if (countRefs(this.x, st, sym) !== 1) return false;
    // The value it holds is dead after this statement when the next one assigns it a new one without reading it, as
    // `c.next = h; h = c;` builds a list: a move, and the assignment then has nothing to drop (R1b). A local of an
    // enclosing block counts too, as nothing between the two statements can leave.
    const next = scope.stmts[i + 1];
    if (
      next !== undefined &&
      ts.isExpressionStatement(next) &&
      ts.isBinaryExpression(next.expression) &&
      next.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(next.expression.left) &&
      this.x.symOf(next.expression.left) === sym &&
      countRefs(this.x, next.expression.right, sym) === 0 &&
      process.env.TMK_TEST_RC_TSL !== "no-dead-move"
    )
      return true;
    if (l.scope !== scope) return false;
    for (let j = i + 1; j < scope.stmts.length; j++)
      if (countRefs(this.x, scope.stmts[j]!, sym) > 0) return false;
    return true;
  }

  stmt(st: ts.Statement, scope: Scope, i: number): string[] {
    const sf = this.sf;
    if (ts.isVariableStatement(st)) return this.varStmt(st, scope, i);
    if (ts.isExpressionStatement(st)) return this.exprStmt(st, scope, i);
    if (ts.isReturnStatement(st)) return this.returnStmt(st, scope, i);
    if (ts.isIfStatement(st)) {
      const c = this.borrowed(this.expr(st.expression));
      const head = this.cond(c);
      const thenT = this.sub(st.thenStatement, null);
      const elseT =
        st.elseStatement !== undefined ? ` else ${this.sub(st.elseStatement, null)}` : "";
      return [...head.lines, `if (${head.c}) ${thenT}${elseT}`];
    }
    if (ts.isBlock(st)) return [this.sub(st, null)];
    if (ts.isWhileStatement(st)) {
      const c = this.borrowed(this.expr(st.expression));
      this.noHoist(st.expression);
      return [`while (${c}) ${this.sub(st.statement, { loop: true, label: labelOf(st) })}`];
    }
    if (ts.isDoStatement(st)) {
      const body = this.sub(st.statement, { loop: true, label: labelOf(st) });
      const c = this.borrowed(this.expr(st.expression));
      this.noHoist(st.expression);
      return [`do ${body} while (${c});`];
    }
    if (ts.isForStatement(st)) return this.forStmt(st, scope);
    if (ts.isForOfStatement(st)) throw new Unsupported(st, "rc: for-of isn't TSL");
    if (ts.isBreakStatement(st) || ts.isContinueStatement(st)) return this.jump(st);
    if (ts.isLabeledStatement(st)) {
      // a labelled block (R2: how a lowered package's printing leaves an inlined call or a `try`): `break L` leaves its
      // scope, and drops what's in it, not what's outside
      if (ts.isBlock(st.statement))
        return [
          `${st.label.text}: ${this.sub(st.statement, { loop: false, label: st.label.text })}`,
        ];
      const inner = this.stmt(st.statement, scope, i);
      return [`${st.label.text}: ${inner[0] ?? ""}`, ...inner.slice(1)];
    }
    if (ts.isSwitchStatement(st)) {
      const c = this.borrowed(this.expr(st.expression));
      this.noHoist(st.expression);
      const lines = [`switch (${c}) {`];
      const sw: Scope = {
        locals: [],
        block: st,
        stmts: null,
        label: labelOf(st),
        loop: false,
        breakable: true,
        update: null,
      };
      this.scopes.push(sw);
      for (const cl of st.caseBlock.clauses) {
        lines.push(ts.isCaseClause(cl) ? `  case ${cl.expression.getText(sf)}:` : "  default:");
        const out: string[] = [];
        const save = this.indent;
        this.indent = save + "    ";
        this.stmts(cl.statements, out, sw);
        this.indent = save;
        lines.push(...out.map((l) => l.slice(save.length - 2)));
      }
      if (sw.locals.some((l) => l.owned) || (sw.closes?.length ?? 0) > 0)
        throw new Unsupported(st, "rc: give a case's counted locals a block of their own");
      this.scopes.pop();
      lines.push("}");
      return lines;
    }
    if (ts.isEmptyStatement(st)) return [";"];
    if (ts.isFunctionDeclaration(st))
      throw new Unsupported(st, "rc: a nested function declaration: use a closure");
    // anything else holds no counted value: as written, with its expressions rebuilt
    return this.wrap(this.splice(st));
  }

  noHoist(e: ts.Node): void {
    if (this.pre.length > 0 || this.temps.length > 0)
      throw new Unsupported(
        e,
        "rc: a loop or switch condition that allocates or holds a temporary: compute it in the body",
      );
  }

  cond(c: string): { lines: string[]; c: string } {
    if (this.temps.length === 0) {
      const lines = this.pre;
      this.pre = [];
      return { lines, c };
    }
    const t = this.fresh("c");
    const lines = [...this.pre, `const ${t} = ${c};`, ...this.temps];
    this.pre = [];
    this.temps = [];
    return { lines, c: t };
  }

  /** A nested statement as a block of its own scope. */
  sub(
    st: ts.Statement,
    loop: { loop: boolean; label: string | null; update?: () => string[] } | null,
  ): string {
    const save = this.indent;
    this.indent = save + "  ";
    const scope: Scope = {
      locals: [],
      block: st,
      stmts: ts.isBlock(st) ? st.statements : [st],
      label: loop?.label ?? null,
      loop: loop?.loop ?? false,
      breakable: loop?.loop ?? false,
      update: loop?.update ?? null,
    };
    this.scopes.push(scope);
    const out: string[] = ["{"];
    const terminal = this.stmts(ts.isBlock(st) ? st.statements : [st], out, scope);
    if (!terminal) {
      for (const d of this.dropsOf(scope)) out.push(this.indent + d);
      if (scope.update !== null) for (const u of scope.update()) out.push(this.indent + u);
    }
    this.scopes.pop();
    this.indent = save;
    out.push(save.slice(2) + "}");
    return out.join("\n");
  }

  jump(st: ts.BreakStatement | ts.ContinueStatement): string[] {
    const label = st.label?.text ?? null;
    const cont = ts.isContinueStatement(st);
    const out: string[] = [];
    for (let j = this.scopes.length - 1; j >= 0; j--) {
      const s = this.scopes[j]!;
      const target = label !== null ? s.label === label : cont ? s.loop : s.breakable;
      if (target && cont) {
        // continue: this loop body's locals go, then its update runs
        out.push(...this.dropsOf(s));
        if (s.update !== null) out.push(...s.update());
        break;
      }
      out.push(...this.dropsOf(s));
      if (target) break;
    }
    out.push(st.getText(this.sf));
    return out;
  }

  forStmt(st: ts.ForStatement, scope: Scope): string[] {
    const sf = this.sf;
    void scope;
    // the header's own scope
    const hs: Scope = {
      locals: [],
      block: st,
      stmts: null,
      label: null,
      loop: false,
      breakable: false,
      update: null,
    };
    this.scopes.push(hs);
    let init = "";
    const initLines: string[] = [];
    if (st.initializer !== undefined) {
      if (ts.isVariableDeclarationList(st.initializer)) {
        const lines = this.declList(st.initializer, hs, -1, null);
        if (lines.length === 1 && this.pre.length === 0) init = lines[0]!.replace(/;$/, "");
        else initLines.push(...lines);
      } else init = this.splice(st.initializer);
    }
    const cond = st.condition !== undefined ? this.borrowed(this.expr(st.condition)) : "";
    this.noHoist(st.condition ?? st);
    const owned = hs.locals.some((l) => l.owned);
    if ((hs.closes?.length ?? 0) > 0)
      throw new Unsupported(
        st,
        "rc: a map's cursor in a for loop's header: declare it before the loop",
      );
    let update = "";
    let updateFn: (() => string[]) | undefined;
    if (st.incrementor !== undefined) {
      const inc = st.incrementor;
      if (owned || this.assignsCounted(inc)) {
        const r = this.exprStmtOf(inc, hs, -1, null);
        if (r.length === 1 && !owned) update = r[0]!.replace(/;$/, "");
        else updateFn = (): string[] => this.exprStmtOf(inc, hs, -1, null);
      } else {
        update = this.splice(inc);
        this.noHoist(inc);
      }
    }
    const body = this.sub(st.statement, { loop: true, label: labelOf(st), update: updateFn });
    this.scopes.pop();
    if (updateFn === undefined && initLines.length === 0 && !owned)
      return [`for (${init}; ${cond}; ${update}) ${body}`];
    // a counted loop variable: the loop as a block with a while, so its update and its drop are statements
    const out = ["{", ...initLines.map((l) => "  " + l)];
    if (init !== "") out.push(`  ${init};`);
    out.push(`  for (; ${cond}; ${update}) ${body.split("\n").join("\n  ")}`);
    out.push(...this.dropsOf(hs).map((d) => "  " + d));
    out.push("}");
    void sf;
    return out;
  }

  assignsCounted(e: ts.Expression): boolean {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        isAssign(n.operatorToken.kind) &&
        this.x.classOf(n.left).cls !== null
      )
        found = true;
      ts.forEachChild(n, walk);
    };
    walk(e);
    return found;
  }

  varStmt(st: ts.VariableStatement, scope: Scope, i: number): string[] {
    return this.declList(st.declarationList, scope, i, st);
  }

  declList(
    list: ts.VariableDeclarationList,
    scope: Scope,
    i: number,
    st: ts.Statement | null,
  ): string[] {
    const sf = this.sf;
    const kw =
      list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Using ? "using" : "let";
    const out: string[] = [];
    for (const d of list.declarations) {
      const s = this.x.symOf(d.name);
      const { cls, nullable, nil } = this.x.classOf(d.name);
      const ve = this.x.vecElem(d.name);
      if (ve !== null)
        throw new Unsupported(
          d,
          "rc: a vector of counted references is a field of a counted object (D74)",
        );
      const name = d.name.getText(sf);
      if (cls === null || s === undefined) {
        const ty = d.type !== undefined ? `: ${d.type.getText(sf)}` : "";
        const init =
          d.initializer !== undefined ? ` = ${this.borrowed(this.expr(d.initializer))}` : "";
        // R11: a definite assignment (`let x!: T`) kept: a `finally`'s held result is set on the paths that read it
        const bang = d.exclamationToken !== undefined && !r11Off("never") ? "!" : "";
        out.push(...this.wrap(`${kw} ${name}${bang}${ty}${init};`));
        const close = this.cursorClose(d);
        if (close !== null) (scope.closes ??= []).push(close);
        continue;
      }
      if (kw === "using") throw new Unsupported(d, "rc: `using` of a counted object");
      const ty = d.type !== undefined ? `: ${this.x.countedType(cls, nullable, nil)}` : "";
      if (d.initializer === undefined) {
        if (!nullable)
          throw new Unsupported(d, "rc: give a counted local a value where it's declared");
        out.push(`${kw} ${name}: ${this.x.countedType(cls, true)} = null;`);
        scope.locals.push(this.addLocal(s, name, cls, true, true, kw === "const", scope));
        continue;
      }
      const v = this.expr(d.initializer);
      const isConst = kw === "const";
      const borrow = !v.own && this.canBorrow(s, d, scope);
      let init: string;
      if (borrow) init = v.text;
      else
        init = this.owned(
          v,
          st !== null && v.local !== undefined && this.lastUse(v.local, scope, i, st),
        );
      const l = this.addLocal(s, name, cls, nullable, !borrow, isConst, scope);
      if (!borrow) scope.locals.push(l);
      out.push(
        ...this.wrap(
          `${kw} ${name}${ty !== "" ? ty : borrow ? "" : `: ${this.x.countedType(cls, nullable, nil)}`} = ${init};`,
        ),
      );
    }
    return out;
  }

  addLocal(
    sym: ts.Symbol,
    name: string,
    cls: CountedClass,
    nullable: boolean,
    owned: boolean,
    isConst: boolean,
    scope: Scope,
  ): Local {
    const nil =
      sym.valueDeclaration !== undefined ? this.x.classOf(sym.valueDeclaration).nil : "null";
    const l: Local = { sym, name, cls, nullable, nil, owned, moved: false, isConst, scope };
    this.locals.set(sym, l);
    return l;
  }

  /**
   * A local keeps no count (it's a borrow) when the function is quiet and every value it's given, here and in any
   * assignment, is read along a path rooted in a parameter, `this`, a global, a borrowed local, or an owned `const` local
   * of an enclosing scope (which outlives it).
   */
  canBorrow(sym: ts.Symbol, d: ts.VariableDeclaration, scope: Scope): boolean {
    if (!this.quiet && (this.fn === null || !this.x.regionQuiet(this.regionOf(d), this.fn)))
      return false;
    const sources: ts.Expression[] = [d.initializer!];
    const fnBody = this.fn?.body;
    if (fnBody === undefined) return false;
    const walk = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        isAssign(n.operatorToken.kind) &&
        ts.isIdentifier(n.left) &&
        this.x.symOf(n.left) === sym
      )
        sources.push(n.right);
      ts.forEachChild(n, walk);
    };
    walk(fnBody);
    return sources.every((e) => this.borrowable(e, sym, scope));
  }

  /** Where a local lives: its for statement, or its declaration's statement and every one after it in its block. */
  regionOf(d: ts.VariableDeclaration): ts.Node[] {
    const list = d.parent;
    const st = list.parent;
    if (ts.isForStatement(st)) return [st];
    const holder = st.parent;
    if (
      ts.isBlock(holder) ||
      ts.isSourceFile(holder) ||
      ts.isCaseClause(holder) ||
      ts.isDefaultClause(holder)
    ) {
      const i = holder.statements.indexOf(st as ts.Statement);
      return holder.statements.slice(i);
    }
    return [st];
  }

  borrowable(e: ts.Expression, self: ts.Symbol, scope: Scope): boolean {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e))
      return this.borrowable(e.expression, self, scope);
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (ts.isConditionalExpression(e))
      return this.borrowable(e.whenTrue, self, scope) && this.borrowable(e.whenFalse, self, scope);
    if (ts.isPropertyAccessExpression(e)) return this.borrowable(e.expression, self, scope);
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "get" &&
      this.x.vecElem(e.expression.expression) !== null
    )
      return this.borrowable(e.expression.expression, self, scope);
    if (ts.isIdentifier(e)) {
      const s = this.x.symOf(e);
      if (s === undefined) return false;
      if (s === self || this.params.has(s)) return true;
      const l = this.locals.get(s);
      if (l !== undefined) return !l.owned || (l.isConst && this.scopes.includes(l.scope));
      return !this.isLocalSym(s); // a global
    }
    return false;
  }

  exprStmt(st: ts.ExpressionStatement, scope: Scope, i: number): string[] {
    // R11: a call that never returns (the trap path's `throwJs`, an uncaught exception reaching a native caller that didn't
    // take exceptions) ends its statement list: its temporaries' drops, and the scope's after it, would be dead code, where
    // tsc doesn't narrow, so they're left out, as after a `throw` (a trap leaves what its frames held, 4.5)
    if (this.neverStmt(st)) {
      const v = this.expr(st.expression);
      const out = [...this.pre, `${v.text};`];
      this.pre = [];
      this.temps = [];
      return out;
    }
    return this.exprStmtOf(st.expression, scope, i, st);
  }

  /**
   * R11: a plain block whose last statement jumps (a `return`, `break`, `continue`, `throw`, a call that never returns, or
   * such a block or `if` in turn), or an `if` both of whose arms do: nothing after it runs, and what follows it, scope-end
   * drops included, is dead code tsc doesn't narrow in. A labelled block isn't one: `break` to its own label goes on after it.
   */
  blockJumps(st: ts.Statement): boolean {
    if (r11Off("never")) return false;
    const ends = (x: ts.Statement): boolean =>
      ts.isReturnStatement(x) ||
      ts.isBreakStatement(x) ||
      ts.isContinueStatement(x) ||
      ts.isThrowStatement(x) ||
      this.neverStmt(x) ||
      this.blockJumps(x);
    if (ts.isBlock(st)) {
      const last = st.statements[st.statements.length - 1];
      return last !== undefined && ends(last);
    }
    if (ts.isIfStatement(st))
      return st.elseStatement !== undefined && ends(st.thenStatement) && ends(st.elseStatement);
    return false;
  }

  /** R11: an expression statement that's a call whose type is `never`: nothing after it runs. */
  neverStmt(st: ts.Statement): boolean {
    if (r11Off("never")) return false;
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return false;
    return (this.x.checker.getTypeAtLocation(st.expression).flags & ts.TypeFlags.Never) !== 0;
  }

  exprStmtOf(e: ts.Expression, scope: Scope, i: number, st: ts.Statement | null): string[] {
    const sf = this.sf;
    if (ts.isBinaryExpression(e) && isAssign(e.operatorToken.kind)) {
      const { cls } = this.x.classOf(e.left);
      if (cls !== null) return this.assign(e, cls, scope, i, st);
    }
    const v = this.expr(e);
    if (v.own && v.cls !== null) {
      const store = this.x.useStore(v.cls);
      if (!v.nullable) return this.wrap(`${store}.drop(${v.text});`);
      const t = this.fresh("t");
      return this.wrap(
        `const ${t} = ${v.text};\nif (${t} !== ${v.nil}) ${store}.drop(${t});`,
      ).flatMap((l) => l.split("\n"));
    }
    void sf;
    return this.wrap(`${v.text};`);
  }

  /** `slot = e` for a counted slot: the new value counted first, then the old one dropped (D39's order). */
  assign(
    e: ts.BinaryExpression,
    cls: CountedClass,
    scope: Scope,
    i: number,
    st: ts.Statement | null,
  ): string[] {
    const sf = this.sf;
    const store = this.x.useStore(cls);
    const left = e.left;
    // a borrowed local is only ever given borrows (canBorrow checked every assignment)
    if (ts.isIdentifier(left)) {
      const s = this.x.symOf(left);
      const l = s !== undefined ? this.locals.get(s) : undefined;
      if (l !== undefined && !l.owned) {
        const v = this.expr(e.right);
        return this.wrap(`${left.text} = ${v.text};`);
      }
      if (s !== undefined && this.params.has(s))
        throw new Unsupported(
          e,
          "rc: a counted parameter is borrowed, so it isn't assigned: give it a local",
        );
      if (l !== undefined && l.moved) {
        // its count was moved out: it holds nothing to drop, and holds the new value's count from here
        const v = this.expr(e.right);
        const nv = this.owned(
          v,
          st !== null && v.local !== undefined && this.lastUse(v.local, scope, i, st),
        );
        l.moved = false;
        return this.wrap(`${left.text} = ${nv};`);
      }
    }
    let target: string;
    if (ts.isPropertyAccessExpression(left)) {
      const base = this.expr(left.expression);
      let b = this.borrowed(base);
      if (!base.simple) {
        const t = this.fresh("o");
        this.pre.push(`const ${t} = ${b};`);
        b = t;
      }
      target = `${b}.${left.name.text}`;
      // a constructor's first assignment to a field with nothing in it yet
      if (
        this.ctor &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        this.ctorInit.has(left.name.text)
      ) {
        this.ctorInit.delete(left.name.text);
        const v = this.expr(e.right);
        const last = st !== null && v.local !== undefined && this.lastUse(v.local, scope, i, st);
        return this.wrap(`${target} = ${this.owned(v, last)};`);
      }
    } else if (ts.isIdentifier(left)) target = left.text;
    else if (ts.isElementAccessExpression(left))
      throw new Unsupported(left, "rc: counted references are held in fields, globals and vectors");
    else target = left.getText(sf);
    const v = this.expr(e.right);
    const last = st !== null && v.local !== undefined && this.lastUse(v.local, scope, i, st);
    // R11's injected `r11-rethrow-unshared` bug: an exception held across a `finally`, thrown again with no count of its
    // own, so the local's drop at its scope's end and whoever catches it release it twice
    const nv =
      fault() === "r11-rethrow-unshared" &&
      target === "__exc_val" &&
      v.local !== undefined &&
      v.nullable &&
      v.text.startsWith("t_thrown")
        ? v.text
        : this.owned(v, last);
    const { nullable: valueNullable } = this.x.classOf(e.right);
    if (!valueNullable && v.root !== "null")
      return this.wrap(`${target} = ${store}.replace(${target}, ${nv});`);
    const o = this.fresh("o");
    return [
      ...this.pre.splice(0),
      `const ${o} = ${target};`,
      `${target} = ${nv};`,
      `if (${o} !== null) ${store}.drop(${o});`,
      ...this.temps.splice(0),
    ];
  }

  /** The name of the function being expanded, for R8's injected bugs. */
  fnName(): string {
    const f = this.fn;
    return f !== null && ts.isFunctionDeclaration(f) && f.name !== undefined ? f.name.text : "";
  }

  returnStmt(st: ts.ReturnStatement, scope: Scope, i: number): string[] {
    void scope;
    void i;
    if (st.expression === undefined)
      return [...this.scopes.flatMap((s) => this.dropsOf(s)), "return;"];
    const v = this.expr(st.expression);
    const counted = v.cls !== null;
    let r: string;
    // nothing after a return runs, so it's the last use of a local it names once; other paths still drop it
    let movedHere: Local | null = null;
    if (counted) {
      const l = v.local !== undefined ? this.locals.get(v.local) : undefined;
      const last = l !== undefined && l.owned && !l.moved && countRefs(this.x, st, l.sym) === 1;
      r = this.owned(v, last);
      if (last) movedHere = l!;
    } else r = v.text;
    const drops = this.scopes.flatMap((s) => this.dropsOf(s));
    if (movedHere !== null) movedHere.moved = false;
    // R8's injected bugs at the native boundary (tools/r8-tests.ts), each in one of the exports a native caller counts
    // with: retain giving back its argument borrowed, so the caller's extra count is never taken (`r8-retain-borrowed`),
    // and a placed object given back at a count of none, dropped as it's returned (`r8-result-zero`)
    if (counted && fault() === "r8-retain-borrowed" && this.fnName().startsWith("__rc_retain_"))
      r = v.text;
    if (counted && fault() === "r8-result-zero" && this.fnName().startsWith("__rc_place_")) {
      const t = this.fresh("r");
      return [
        ...this.pre,
        `const ${t} = ${r};`,
        `const ${t}$again = ${t};`,
        `${this.x.useStore(v.cls!)}.drop(${t}$again);`,
        `return ${t};`,
      ];
    }
    if (drops.length === 0 && this.temps.length === 0) return this.wrap(`return ${r};`);
    const t = this.fresh("r");
    const lines = [...this.pre, `const ${t} = ${r};`, ...this.temps, ...drops, `return ${t};`];
    this.pre = [];
    this.temps = [];
    return lines;
  }
}

/** A value read along a path, with no call or allocation: what a borrow can be given. */
function isPath(e: ts.Expression, x: Expander): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return isPath(e.expression, x);
  if (
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isIdentifier(e)
  )
    return true;
  if (ts.isPropertyAccessExpression(e)) return isPath(e.expression, x);
  if (ts.isConditionalExpression(e)) return isPath(e.whenTrue, x) && isPath(e.whenFalse, x);
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "get"
  )
    return x.vecElem(e.expression.expression) !== null && isPath(e.expression.expression, x);
  return false;
}

function labelOf(st: ts.Statement): string | null {
  return ts.isLabeledStatement(st.parent) ? st.parent.label.text : null;
}

function containsCall(n: ts.Node): boolean {
  let found = false;
  const walk = (k: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(k) || ts.isNewExpression(k)) found = true;
    else if (!ts.isArrowFunction(k) && !ts.isFunctionExpression(k)) ts.forEachChild(k, walk);
  };
  walk(n);
  return found;
}

function countRefs(x: Expander, n: ts.Node, sym: ts.Symbol): number {
  let c = 0;
  const walk = (k: ts.Node): void => {
    if (ts.isIdentifier(k) && x.symOf(k) === sym) c++;
    ts.forEachChild(k, walk);
  };
  walk(n);
  return c;
}
