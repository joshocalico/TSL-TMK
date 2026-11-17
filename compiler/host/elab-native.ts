// TSL proper with memory: plain classes, layout classes, non-escaping closures, raw pointers and whole-program
// compilation (SPEC 3.4, 3.5, Appendix A). A program using none of them goes through the base Elaborator and
// gets exactly the TIR it always did. Containers are ordinary classes here: nothing below knows about a Vec.
import { isCountedExactly } from "./expand-rc.ts";
import { cycleGraph, cycleGroupOf } from "./cycle-graph.ts";
import ts from "typescript";
import { isHandleParam } from "./consume.ts";
import { Elaborator } from "./elab.ts";
import type { DiagSink } from "./diag.ts";
import { packageMemory, repoRelative, tslOptOff } from "./program.ts";
import type { Func } from "../tir/ir.ts";
import {
  isLoweredFile,
  loweredCall,
  loweredData,
  loweredType,
  type LoweredHost,
  type LoweredSetting,
} from "./elab-lowered.ts";
import {
  elemSize as elemSizeOf,
  elemTy,
  ELEM_BY_ARRAY,
  T,
  tyKey,
  tyName,
  type BitField,
  type BuiltinInfo,
  type ClassInst,
  type StrLayout,
  type RcStrLayout,
  type ClsField,
  type ElemInfo,
  type ElemName,
  type FuncInst,
  type GlobalDef,
  type Stmt,
  type StaticObject,
  type TE,
  type TEK,
  type Ty,
  type TypedModule,
  type Var,
} from "./types.ts";

type Env = Map<ts.Symbol, Ty>;
type Fn = ts.FunctionDeclaration | ts.ArrowFunction;
type FnLike = ts.FunctionLikeDeclaration;

function mk(ty: Ty, node: TEK, deps?: unknown[]): TE {
  const te = { ty, ...node } as TE;
  if (deps !== undefined && deps.length > 0) te.deps = deps;
  return te;
}

function strip(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let g = 0; g < 256; g++) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else break;
  }
  return cur;
}

export const STATIC_GEN = 0xffff; // odd, and above every generation a slot can reach, so it's never removable
const SCALARS: Record<string, { ty: Ty; size: number; be?: boolean }> = {
  u8: { ty: T.u8, size: 1 },
  u16: { ty: T.u16, size: 2 },
  u32: { ty: T.u32, size: 4 },
  u64: { ty: T.u64, size: 8 },
  i8: { ty: T.i8, size: 1 },
  i16: { ty: T.i16, size: 2 },
  i32: { ty: T.i32, size: 4 },
  i64: { ty: T.i64, size: 8 },
  f32: { ty: T.f32, size: 4 },
  f64: { ty: T.f64, size: 8 },
  be16: { ty: T.u16, size: 2, be: true },
  be32: { ty: T.u32, size: 4, be: true },
  be64: { ty: T.u64, size: 8, be: true },
};
const LAYOUT_HELPERS = new Set([
  ...Object.keys(SCALARS),
  "array",
  "arrayOf",
  "nested",
  "bits",
  "enumOf",
  "pad",
]);

/** Plain-class fields: scalar alignment equals size, a reference takes 8, a literal union or enum 4 (3.4). */
function memSize(t: Ty): number | null {
  switch (t.k) {
    case "int":
      return t.name === "usize" ? 8 : t.name.endsWith("8") ? 1 : t.name.endsWith("16") ? 2 : 4;
    case "big":
      return 8;
    case "float":
      return t.name === "f32" ? 4 : 8;
    case "bool":
      return 1;
    case "enum":
    case "lits":
      return 4;
    case "cls":
    case "ptr":
    case "fn":
      return 8;
    default:
      return null;
  }
}

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** TIR's text form takes names with no spaces, parentheses or commas. */
function tirNameOf(key: string): string {
  const clean = key.replace(/[^\w.$<>~-]/g, "_");
  return clean === key ? key : `${clean}~${shortHash(key)}`;
}

function stemOf(file: string): string {
  return file.replace(/.*\//, "").replace(/\.ts$/, "");
}

/** A call of `globalAllocator`, from @tsl/std's own module (SPEC 3.5, D43). */
export function isGlobalAllocatorCallee(checker: ts.TypeChecker, e: ts.CallExpression): boolean {
  if (!ts.isIdentifier(e.expression)) return false;
  const raw = checker.getSymbolAtLocation(e.expression);
  if (raw === undefined) return false;
  const sym = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
  return (
    sym.name === "globalAllocator" &&
    (sym.declarations?.[0]?.getSourceFile().fileName ?? "").endsWith("/ex-std-global.ts")
  );
}

export function isCoreFile(name: string): boolean {
  return name.endsWith("packages/tsl-core/index.ts");
}
export function isUnsafeFile(name: string): boolean {
  return name.endsWith("packages/tsl-unsafe/index.ts");
}
export function isArchFile(name: string): boolean {
  return name.endsWith("packages/tsl-arch-aarch64/index.ts");
}

/** An initialiser value that can't read or write the object being built: a literal, or arithmetic on other variables. */
export function initSafe(e: TE, self: Var): boolean {
  switch (e.k) {
    case "lit":
      return true;
    case "var":
      return e.v !== self && e.v.ty.k !== "cls";
    case "arith":
    case "farith":
    case "bit":
    case "cmp":
      return initSafe(e.a, self) && initSafe(e.b, self);
    case "neg":
    case "not":
    case "bitnot":
      return initSafe(e.a, self);
    case "conv":
      return initSafe(e.val, self);
    default:
      return false;
  }
}

/**
 * A literal initialiser the constructor overwrites before anything can read the object needs no store (D64): the leading
 * statements after the initialisers, each `this.f = v` where `v` can't read the object (a literal, or arithmetic on
 * variables that can't be it), say which fields are written first.
 */
function dropOverwrittenInits(out: Stmt[], inits: number, self: Var | undefined): Stmt[] {
  if (self === undefined) return out;
  const safe = (e: TE): boolean => initSafe(e, self);
  const stored = (st: Stmt): ClsField | null =>
    st.k === "expr" && st.e.k === "osetfield" && st.e.obj.k === "var" && st.e.obj.v === self
      ? st.e.f
      : null;
  const first = new Set<ClsField>();
  for (let i = inits; i < out.length; i++) {
    const st = out[i]!;
    const f = stored(st);
    if (f === null || !safe((st as { e: { val: TE } }).e.val)) break;
    first.add(f);
  }
  if (first.size === 0) return out;
  return out.filter((st, i) => {
    if (i >= inits) return true;
    const f = stored(st);
    return !(f !== null && first.has(f) && (st as { e: { val: TE } }).e.val.k === "lit");
  });
}

/**
 * A dispatch interface (3.4, D70): an interface of methods only, with no fields, whose values are objects of the classes
 * that reach it in the program, called through by class id. One that's generic or extends another is TSL1025.
 */
export function isDispatchInterface(d: ts.InterfaceDeclaration): boolean {
  // Only the program's own: lib.d.ts's interfaces (`Iterable`, `ArrayLike`) are tsc's view of JS, not TSL's.
  if (d.getSourceFile().isDeclarationFile) return false;
  return d.members.length > 0 && d.members.every(ts.isMethodSignature);
}

const ASSIGNS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Where a value meets a type it's checked against: the places a class instance can flow into an interface. */
function isFlowPosition(n: ts.Expression): boolean {
  const p = n.parent;
  if (p === undefined) return false;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n) === true)
    return true;
  if (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p))
    return p.initializer === n;
  if (ts.isReturnStatement(p)) return true;
  if (ts.isArrowFunction(p)) return p.body === n;
  if (ts.isBinaryExpression(p)) return p.right === n && ASSIGNS.has(p.operatorToken.kind);
  if (ts.isPropertyAssignment(p)) return p.initializer === n;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  return ts.isArrayLiteralExpression(p);
}

function cidField(): ClsField {
  return {
    name: " cid", // not a name source can write
    ty: T.u32,
    off: 0,
    size: 4,
    align: 4,
    store: "value",
    be: false,
    arrLen: 0,
    checkedEnum: false,
  };
}

export class NativeElaborator extends Elaborator {
  modules: ts.SourceFile[];
  root: ts.SourceFile;
  classes = new Map<ts.Symbol, ts.ClassDeclaration>();
  classInsts = new Map<string, ClassInst>();
  curThis: Var | null = null;
  curInst: FuncInst | null = null;
  closureCount = new Map<string, number>();
  ctorQueue: { inst: FuncInst; c: ClassInst; decl: ts.ClassDeclaration }[] = [];
  methodDecls = new Map<FuncInst, FnLike>();
  hiddenThis = new Map<FuncInst, Var>();
  assertions: ts.CallExpression[] = [];
  litGlobals = new Map<string, GlobalDef>();
  keyErrors = new Set<ts.Node>();
  runFreedHook: Fn | null = null;
  layingOut: ClassInst | undefined = undefined;
  // A package tmk lower wrote (SPEC 4.5, D62): @tsl/lowered's words, its module state, and its runtime's signatures.
  lowered: LoweredSetting | null = null;
  loweredData = new Map<
    ts.Symbol,
    { name: string; size: number; global?: import("../tir/ir.ts").Global }
  >();
  loweredSigs = new Map<string, Func>();
  // Dispatch interfaces (A5 prototype): for each, the classes whose instances flow into a place of its type,
  // in the whole program, and a class id for each class in a set of two or more.
  flowSets = new Map<ts.Symbol, ts.ClassDeclaration[]>();
  classIds = new Map<ts.ClassDeclaration, number>();
  flowUnknown = new Set<ts.Symbol>(); // an interface with a place TSL3010 was reported: its set is incomplete
  ifaceTys = new Map<ts.Symbol, Ty>(); // each dispatch interface's type, once its set is known
  ifaceReported = new Set<ts.Symbol>(); // an interface whose problem was reported, once
  releaseFns: ts.FunctionDeclaration[] = []; // @tsl/gc's release functions, numbered from 1 (R1d)

  constructor(program: ts.Program, root: ts.SourceFile, sink: DiagSink, modules: ts.SourceFile[]) {
    super(program, root, sink);
    this.modules = modules;
    this.root = root;
  }

  // A static method goes through `instance` as a top-level function does (SPEC 3.4).
  override attrsOf(decl: Parameters<Elaborator["attrsOf"]>[0]): string[] {
    if (!ts.isMethodDeclaration(decl as ts.Node)) return super.attrsOf(decl);
    const m = decl as unknown as ts.MethodDeclaration;
    const doc = this.docOf(m);
    return ["inline", "noalloc", "noinline", "nosleep"].filter((a) =>
      new RegExp(`@tsl\\.${a}\\b`).test(doc),
    );
  }

  withSf<R>(sf: ts.SourceFile, f: () => R): R {
    const was = this.sf;
    const wasFile = this.file;
    this.sf = sf;
    this.file = repoRelative(sf.fileName);
    try {
      return f();
    } finally {
      this.sf = was;
      this.file = wasFile;
    }
  }

  /** Numbered over the whole program, so a literal union means one thing in every module. */
  override internStrings(): void {
    const seen = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      if (ts.isStringLiteral(n)) seen.add(n.text);
      ts.forEachChild(n, walk);
    };
    for (const sf of this.modules ?? [this.sf]) walk(sf);
    this.strings = new Map();
    [...seen].sort().forEach((s, i) => this.strings.set(s, i + 1));
  }

  isUnsafeSymbol(sym: ts.Symbol): boolean {
    const decl = sym.declarations?.[0];
    return decl !== undefined && isUnsafeFile(decl.getSourceFile().fileName);
  }

  isLoweredSymbol(sym: ts.Symbol): boolean {
    const decl = sym.declarations?.[0];
    return decl !== undefined && isLoweredFile(decl.getSourceFile().fileName);
  }

  /** In a lowered package a node can say where it came from: `/*@ file.ts:3:9 *\/`, the ordinary TS it was lowered from. */
  override loc(node: ts.Node): string {
    if (this.lowered !== null) {
      // The trivia before the node's first token: TS calls a comment on the line of the token before it trailing, not leading.
      const sf = node.getSourceFile();
      const trivia = sf.text.slice(node.getFullStart(), node.getStart(sf));
      let found: string | null = null;
      for (const m of trivia.matchAll(/\/\*@ ([\s\S]*?) \*\//g)) found = m[1]!;
      if (found !== null) return found;
    }
    return super.loc(node);
  }

  // --- module level

  /** Every layout class in one module, as tslc lays it out, for the check against the host's capture mode. */
  layoutsIn(
    sf: ts.SourceFile,
  ): { name: string; size: number; align: number; fields: Record<string, number> }[] {
    this.internStrings();
    this.sink.muted++;
    for (const m of this.modules) {
      this.withSf(m, () => {
        for (const st of m.statements) {
          if (ts.isEnumDeclaration(st)) this.declareEnum(st);
          if (ts.isClassDeclaration(st) && st.name !== undefined) {
            const sym = this.symbolOf(st.name);
            if (sym !== undefined) this.classes.set(sym, st);
          }
        }
      });
    }
    for (const m of this.modules) {
      this.withSf(m, () => {
        for (const st of m.statements) {
          if (!ts.isVariableStatement(st)) continue;
          const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
          for (const d of st.declarationList.declarations) {
            if (d.initializer !== undefined && !ts.isArrowFunction(d.initializer))
              this.declareTop(d, isConst);
          }
        }
      });
    }
    const out: { name: string; size: number; align: number; fields: Record<string, number> }[] = [];
    this.withSf(sf, () => {
      for (const st of sf.statements) {
        if (!ts.isClassDeclaration(st) || st.name === undefined || st.typeParameters !== undefined)
          continue;
        const c = this.layoutClass(this.classInst(st, [], st), st);
        if (!c.layout) continue;
        const fields: Record<string, number> = {};
        for (const f of c.fields) fields[f.name] = f.off;
        out.push({ name: c.name, size: c.size, align: c.align, fields });
      }
    });
    this.sink.muted--;
    return out;
  }

  override run(): TypedModule {
    this.internStrings();
    for (const st of this.root.statements) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) {
          this.exportedNames.add((e.propertyName ?? e.name).text);
        }
      }
    }
    for (const sf of this.modules) {
      this.withSf(sf, () => {
        for (const st of sf.statements) {
          if (ts.isEnumDeclaration(st)) this.declareEnum(st);
          if (ts.isClassDeclaration(st) && st.name !== undefined) {
            const sym = this.symbolOf(st.name);
            if (sym !== undefined) this.classes.set(sym, st);
            // A tail's element and its place are the class's own, whatever it's instantiated with (D69).
            for (const m of st.typeParameters !== undefined ? st.members : []) {
              const init =
                ts.isPropertyDeclaration(m) && m.initializer !== undefined
                  ? strip(m.initializer)
                  : null;
              if (
                init !== null &&
                ts.isCallExpression(init) &&
                this.coreName(init.expression) === "tail"
              )
                this.err(m, "TSL1024", "a generic class has no tail");
            }
          }
          if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.body !== undefined) {
            const sym = this.symbolOf(st.name);
            if (sym !== undefined) this.top.set(sym, { kind: "func", decl: st });
          }
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              if (
                ts.isIdentifier(d.name) &&
                d.initializer !== undefined &&
                ts.isArrowFunction(d.initializer)
              ) {
                const sym = this.symbolOf(d.name);
                if (sym !== undefined) this.top.set(sym, { kind: "func", decl: d.initializer });
              }
            }
          }
        }
      });
    }
    this.computeFlowSets();
    this.computeReleaseSet();
    for (const sf of this.modules) {
      this.withSf(sf, () => {
        for (const st of sf.statements) {
          if (ts.isVariableStatement(st)) {
            const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const d of st.declarationList.declarations) this.declareTop(d, isConst);
          } else if (ts.isExpressionStatement(st)) {
            const c = st.expression;
            if (ts.isCallExpression(c) && this.coreName(c.expression) === "assertSize") {
              this.assertions.push(c);
            } else
              this.err(st, "TSL1010", "no run-time module init: only declarations and assertSize");
          }
        }
      });
    }
    for (const sf of this.modules) {
      this.withSf(sf, () => {
        for (const c of this.assertions.filter((a) => a.getSourceFile() === sf))
          this.checkAssertSize(c);
        for (const st of sf.statements) {
          if (
            ts.isFunctionDeclaration(st) &&
            st.body !== undefined &&
            st.typeParameters === undefined
          ) {
            this.instance(st, [], st);
          }
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
              const init = d.initializer;
              if (
                init !== undefined &&
                ts.isArrowFunction(init) &&
                init.typeParameters === undefined
              ) {
                this.instance(init, [], d);
              }
            }
          }
          // A non-generic class is checked whole, whether or not anything calls it yet.
          if (ts.isClassDeclaration(st) && st.typeParameters === undefined) this.instantiateAll(st);
        }
      });
    }
    for (let guard = 0; guard < 100000; guard++) {
      const ctor = this.ctorQueue.shift();
      if (ctor !== undefined) {
        this.elabCtor(ctor.inst, ctor.c, ctor.decl);
        continue;
      }
      const item = this.queue.shift();
      if (item === undefined) break;
      this.elabInstance(item.inst, item.decl, item.env);
    }
    return {
      file: repoRelative(this.root.fileName),
      funcs: this.funcs,
      globals: this.globals,
      strings: this.strings,
      nativeOnly: true,
    };
  }

  instantiateAll(decl: ts.ClassDeclaration): void {
    const c = this.classInst(decl, [], decl);
    this.layoutClass(c, decl);
    this.ctorOf(c, decl);
    for (const m of decl.members) {
      if (m.name === undefined || this.hasStatic(m)) continue;
      if (ts.isMethodDeclaration(m) && m.typeParameters !== undefined) continue;
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        this.methodInst(c, m, [], m);
      }
    }
  }

  hasStatic(m: ts.Node): boolean {
    return (
      ts.canHaveModifiers(m) &&
      (ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    );
  }

  coreName(e: ts.Expression): string | null {
    if (!ts.isIdentifier(e)) return null;
    const sym = this.symbolOf(e);
    return sym !== undefined && this.isCoreSymbol(sym) ? sym.name : null;
  }

  unsafeName(e: ts.Expression): string | null {
    if (!ts.isIdentifier(e)) return null;
    const sym = this.symbolOf(e);
    return sym !== undefined && this.isUnsafeSymbol(sym) ? sym.name : null;
  }

  checkAssertSize(e: ts.CallExpression): void {
    const cls = this.classArg(e.arguments[0], e);
    const n = e.arguments[1] !== undefined ? this.fold(e.arguments[1]) : null;
    if (cls === null) return;
    if (typeof n !== "number") {
      this.err(e, "TSL1010", "assertSize takes a constant size");
      return;
    }
    if (cls.size !== n) this.err(e, "TSL1016", `${cls.name} is ${cls.size} bytes, not ${n}`);
  }

  override declareTop(d: ts.VariableDeclaration, isConst: boolean): void {
    const init = d.initializer;
    if (init !== undefined && ts.isIdentifier(d.name)) {
      const stripped = strip(init);
      const sym = this.symbolOf(d.name);
      if (
        sym !== undefined &&
        ts.isNewExpression(stripped) &&
        ts.isIdentifier(stripped.expression)
      ) {
        const isTypedArray = ELEM_BY_ARRAY[stripped.expression.text] !== undefined;
        if (!isTypedArray) {
          if (!isConst) {
            this.err(
              d,
              "TSL1010",
              "a static object is a const: a top-level `new` is never reassigned",
            );
            return;
          }
          this.declareStaticNew(sym, d.name.text, stripped);
          return;
        }
      }
      if (
        sym !== undefined &&
        ts.isCallExpression(stripped) &&
        this.isGlobalAllocatorCall(stripped)
      ) {
        this.declareGlobalAllocator(sym, stripped);
        return;
      }
      if (
        sym !== undefined &&
        this.lowered !== null &&
        ts.isCallExpression(stripped) &&
        ts.isIdentifier(stripped.expression)
      ) {
        const callee = this.symbolOf(stripped.expression);
        if (
          callee !== undefined &&
          this.isLoweredSymbol(callee) &&
          ["data", "text", "charTable", "hashKey"].includes(callee.name)
        ) {
          loweredData(this as unknown as LoweredHost, d, stripped, callee.name);
          return;
        }
      }
      if (sym !== undefined && ts.isCallExpression(stripped)) {
        const u = this.unsafeName(stripped.expression);
        if (u === "onPageRunFreed") {
          const a0 = stripped.arguments[0];
          const s = a0 !== undefined && ts.isIdentifier(a0) ? this.symbolOf(a0) : undefined;
          const f = s !== undefined ? this.top.get(s) : undefined;
          if (f?.kind !== "func") {
            this.err(stripped, "TSL5009", "onPageRunFreed takes a top-level function by name");
          } else this.runFreedHook = f.decl;
          return;
        }
        if (u === "staticView") {
          this.declareStaticView(sym, d.name.text, stripped);
          return;
        }
        const core = this.coreName(stripped.expression);
        if (core === "sizeOf" || core === "alignOf" || core === "offsetOf") {
          const te = this.coreCall(stripped, core);
          if (te.k === "lit") this.top.set(sym, { kind: "typed", ty: T.usize, value: te.value });
          return;
        }
      }
    }
    super.declareTop(d, isConst);
    // Two modules can each have a `next`: a global's name is per module, as its binding is.
    if (ts.isIdentifier(d.name)) {
      const sym = this.symbolOf(d.name);
      const t = sym !== undefined ? this.top.get(sym) : undefined;
      if (t?.kind === "global") {
        t.def.name = this.mangledGlobal(d.name.text);
        // A lowered package keeps the lowering's symbol (SPEC 4.5, D62).
        const stmt = d.parent.parent;
        const tag =
          this.lowered !== null ? /@tsl\.symbol\s+(\S+)/.exec(this.docOf(stmt))?.[1] : undefined;
        if (tag !== undefined) t.def.name = tag;
      }
    }
  }

  mangledGlobal(name: string): string {
    return this.sf === this.root ? name : `${stemOf(this.sf.fileName)}.${name}`;
  }

  override declareTypedArray(
    sym: ts.Symbol,
    name: string,
    init: ts.NewExpression,
    elem: ElemName,
  ): void {
    super.declareTypedArray(sym, this.mangledGlobal(name), init, elem);
  }

  isGlobalAllocatorCall(e: ts.CallExpression): boolean {
    return isGlobalAllocatorCallee(this.checker, e);
  }

  /** `const h = globalAllocator(f)`: the global allocator starts over f, and h is that allocator (SPEC 3.5, D43). */
  declareGlobalAllocator(sym: ts.Symbol, e: ts.CallExpression): void {
    const arg = e.arguments[0];
    const fsym = arg !== undefined && ts.isIdentifier(arg) ? this.symbolOf(arg) : undefined;
    const f = fsym !== undefined ? this.top.get(fsym) : undefined;
    if (f?.kind !== "func") return; // TSL5009, from checkGlobalAllocators
    const statics = new Map<string, GlobalDef>();
    for (const [s, t] of this.top) {
      const file = s.declarations?.[0]?.getSourceFile().fileName ?? "";
      if (t.kind === "global" && file.endsWith("/ex-std-global.ts")) statics.set(s.name, t.def);
    }
    const heap = statics.get("heap");
    const reloc = statics.get("source")?.object?.relocs.find((r) => r.func !== undefined);
    if (heap === undefined || reloc === undefined) {
      this.err(e, "TSL9001", "globalAllocator needs @tsl/std's own module");
      return;
    }
    reloc.func = this.instance(f.decl, [], e);
    this.top.set(sym, { kind: "global", def: heap });
  }

  declareStaticNew(sym: ts.Symbol, name: string, init: ts.NewExpression): void {
    const c = this.classOfNew(init, undefined);
    if (c === null) return;
    if (c.tail !== undefined) {
      this.err(
        init,
        "TSL3012",
        `${c.name} has a tail, so an object of it is made on the heap with withTail(n, new ${c.name}(…)): a static one would have one fixed size`,
      );
      return;
    }
    const bytes = new Uint8Array(c.size);
    const relocs: StaticObject["relocs"] = [];
    this.ctfeObject(c, init, bytes, 0, relocs);
    const def = this.staticGlobal(name, c, bytes, relocs, c.align);
    this.top.set(sym, { kind: "global", def });
  }

  declareStaticView(sym: ts.Symbol, name: string, e: ts.CallExpression): void {
    const c = this.classArg(e.arguments[0], e, true);
    if (c === null) return;
    const a = e.arguments[1] !== undefined ? this.fold(e.arguments[1]) : 16;
    if (typeof a !== "number" || !Number.isInteger(a) || a <= 0 || (a & (a - 1)) !== 0) {
      this.err(e, "TSL1010", "staticView's alignment is a constant power of two");
      return;
    }
    const def = this.staticGlobal(name, c, new Uint8Array(c.size), [], Math.max(a, c.align));
    this.top.set(sym, { kind: "global", def });
  }

  staticGlobal(
    name: string,
    c: ClassInst,
    bytes: Uint8Array,
    relocs: StaticObject["relocs"],
    align: number,
  ): GlobalDef {
    // The prefix sits just before the object, so an aligned object may leave a gap in front of it.
    const a = Math.max(align, 8);
    const off = alignUp(8, a);
    const def: GlobalDef = {
      name: this.mangledGlobal(name),
      jsName: name,
      ty: { k: "cls", c },
      mutable: false,
      object: { c, off, total: off + bytes.length, align: a, bytes, relocs },
    };
    this.globals.push(def);
    return def;
  }

  /** Runs a constructor at compile time, into the static object's bytes (SPEC 3.6, TSL1010). */
  ctfeObject(
    c: ClassInst,
    init: ts.NewExpression,
    bytes: Uint8Array,
    base: number,
    relocs: StaticObject["relocs"],
  ): void {
    const decl = c.decl as ts.ClassDeclaration;
    if (c.layout) return;
    const id = this.classIds.get(decl);
    if (id !== undefined) this.packField(bytes, base + c.fields[0]!.off, c.fields[0]!, id);
    const ctor = decl.members.find(ts.isConstructorDeclaration);
    const params = new Map<ts.Symbol, ts.Expression>();
    if (ctor !== undefined) {
      ctor.parameters.forEach((p, i) => {
        const a = init.arguments?.[i];
        if (!ts.isIdentifier(p.name) || a === undefined) return;
        const s = this.symbolOf(p.name);
        if (s !== undefined) params.set(s, a);
        if (ts.isParameterPropertyDeclaration(p, ctor)) {
          for (const x of this.checker.getSymbolsOfParameterPropertyDeclaration(p, p.name.text)) {
            params.set(x, a);
          }
        }
      });
    }
    const put = (f: ClsField, e: ts.Expression): void => {
      if (f.store === "none") return;
      const value = strip(e);
      if (ts.isIdentifier(value)) {
        const s = this.symbolOf(value);
        const arg = s !== undefined ? params.get(s) : undefined;
        if (arg !== undefined) {
          put(f, arg);
          return;
        }
      }
      if (f.store === "inline") {
        if (!ts.isNewExpression(value) || f.ty.k !== "cls") {
          this.err(e, "TSL1010", "this field's initialiser must be constant");
          return;
        }
        this.ctfeObject(f.ty.c, value, bytes, base + f.off, relocs);
        return;
      }
      if (f.store !== "value") {
        this.err(e, "TSL1010", "this field's initialiser must be constant");
        return;
      }
      if (value.kind === ts.SyntaxKind.NullKeyword) return;
      if (f.ty.k === "fn" || f.ty.k === "cls") {
        const s = ts.isIdentifier(value) ? this.symbolOf(value) : undefined;
        const top = s !== undefined ? this.top.get(s) : undefined;
        if (top?.kind === "func" && f.ty.k === "fn") {
          relocs.push({ off: base + f.off, func: this.instance(top.decl, [], e) });
          return;
        }
        if (top?.kind === "global" && top.def.object !== undefined && f.ty.k === "cls") {
          relocs.push({ off: base + f.off, obj: top.def });
          return;
        }
        this.err(
          e,
          "TSL1010",
          "a static object's reference fields hold other statics or top-level functions",
        );
        return;
      }
      const te = this.coerce(this.expr(e, f.ty), f.ty, e);
      const v = te.ty.k === "unk" ? 0 : this.evalConst(te);
      if (v === null || typeof v === "string") {
        if (v === null) this.err(e, "TSL1010", "top-level initialisers must be constant");
        return;
      }
      this.packField(bytes, base + f.off, f, v);
    };
    this.withSf(decl.getSourceFile(), () => {
      for (const m of decl.members) {
        if (ts.isPropertyDeclaration(m) && m.initializer !== undefined && !this.hasStatic(m)) {
          const f = c.fields.find((x) => x.name === m.name.getText(this.sf));
          if (f !== undefined) put(f, m.initializer);
        }
      }
      if (ctor === undefined) return;
      ctor.parameters.forEach((p) => {
        if (!ts.isParameterPropertyDeclaration(p, ctor) || !ts.isIdentifier(p.name)) return;
        const f = c.fields.find((x) => x.name === (p.name as ts.Identifier).text);
        if (f !== undefined) put(f, p.name);
      });
      for (const st of ctor.body?.statements ?? []) {
        const ok =
          ts.isExpressionStatement(st) &&
          ts.isBinaryExpression(st.expression) &&
          st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(st.expression.left) &&
          st.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword;
        if (!ok) {
          this.err(
            st,
            "TSL1010",
            "a static object's constructor may only assign constants to fields",
          );
          continue;
        }
        const b = st.expression as ts.BinaryExpression;
        const name = (b.left as ts.PropertyAccessExpression).name.text;
        const f = c.fields.find((x) => x.name === name);
        if (f !== undefined) put(f, b.right);
      }
    });
  }

  packField(bytes: Uint8Array, at: number, f: ClsField, v: number | bigint | boolean): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = !f.be;
    const num = typeof v === "boolean" ? (v ? 1 : 0) : v;
    if (f.ty.k === "float") {
      if (f.size === 8) view.setFloat64(at, Number(num), le);
      else view.setFloat32(at, Number(num), le);
    } else if (f.size === 8) view.setBigUint64(at, BigInt.asUintN(64, BigInt(num)), le);
    else if (f.size === 4) view.setUint32(at, Number(num) >>> 0, le);
    else if (f.size === 2) view.setUint16(at, Number(num) & 0xffff, le);
    else view.setUint8(at, Number(num) & 0xff);
  }

  // --- types

  override typeOf(node: ts.TypeNode, env: Env = this.env): Ty {
    const t = super.typeOf(node, env);
    return t.k === "fn" ? { ...t, env: true } : t;
  }

  override fnTyOf(decl: Fn): Ty {
    const t = super.fnTyOf(decl);
    return t.k === "fn" ? { ...t, env: true } : t;
  }

  override literalType(node: ts.LiteralTypeNode): Ty {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { k: "nullish" };
    return super.literalType(node);
  }

  override unionType(node: ts.UnionTypeNode, env: Env): Ty {
    const isNull = (t: ts.TypeNode): boolean =>
      ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
    const isUndef = (t: ts.TypeNode): boolean => t.kind === ts.SyntaxKind.UndefinedKeyword;
    const undefPart = node.types.find(isUndef);
    if (undefPart !== undefined) return this.undefinedUnion(node, undefPart, env);
    const nullPart = node.types.find(isNull);
    if (nullPart === undefined) return super.unionType(node, env);
    const rest = node.types.filter((t) => !isNull(t));
    if (rest.length !== 1) {
      this.err(nullPart, "TSL1008", "null only applies to references");
      return T.unk;
    }
    const inner = this.typeOf(rest[0]!, env);
    if (inner.k === "cls" || inner.k === "ptr" || inner.k === "unk") return inner;
    this.err(nullPart, "TSL1008", `null only applies to references, not ${tyName(inner)}`);
    return T.unk;
  }

  /**
   * `T | undefined` (SPEC 3.3, rule 12). On a reference it's a null pointer, as `T | null` is. On a scalar it's a nullable scalar,
   * two leaves in registers and never in memory (D26, D31), so it's allowed only as what a function gives back: `@tsl/std`'s
   * `Map.get` (D47).
   */
  undefinedUnion(node: ts.UnionTypeNode, undefPart: ts.TypeNode, env: Env): Ty {
    const rest = node.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    if (rest.length !== node.types.length - 1 || rest.length !== 1) {
      this.err(undefPart, "TSL1008", "undefined goes with one type, and not with null");
      return T.unk;
    }
    const inner = this.typeOf(rest[0]!, env);
    if (inner.k === "cls" || inner.k === "ptr" || inner.k === "unk") return inner;
    const scalar =
      inner.k === "int" ||
      inner.k === "big" ||
      inner.k === "float" ||
      inner.k === "bool" ||
      inner.k === "enum" ||
      inner.k === "lits";
    let at: ts.Node = node;
    while (ts.isParenthesizedTypeNode(at.parent)) at = at.parent;
    const p = at.parent;
    const isResult =
      (ts.isMethodDeclaration(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isArrowFunction(p) ||
        ts.isFunctionExpression(p) ||
        ts.isGetAccessorDeclaration(p)) &&
      p.type === at;
    if (scalar && isResult) return { k: "opt", of: inner };
    this.err(
      undefPart,
      "TSL1008",
      scalar
        ? `${tyName(inner)} | undefined is only a function's result: it's never in memory`
        : `undefined only applies to references and to a scalar a function gives back, not ${tyName(inner)}`,
    );
    return T.unk;
  }

  /** `x === undefined` on a nullable scalar from a call, or on a reference (SPEC 3.3, rule 12). */
  override undefinedTest(e: ts.BinaryExpression, op: string): TE | null {
    if (op !== "eq" && op !== "ne") return null;
    const unparen = (x: ts.Expression): ts.Expression => {
      let cur = x;
      while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
      return cur;
    };
    const isUndef = (x: ts.Expression): boolean => {
      const u = unparen(x);
      return ts.isIdentifier(u) && u.text === "undefined";
    };
    const other = isUndef(e.right) ? e.left : isUndef(e.left) ? e.right : null;
    if (other === null) return null;
    const x = unparen(other);
    if (ts.isElementAccessExpression(x)) return super.undefinedTest(e, op);
    if (ts.isIdentifier(x)) {
      const sym = this.symbolOf(x);
      const local = sym !== undefined ? this.scope.get(sym) : undefined;
      if (local !== undefined && !("value" in local) && local.ty.k === "opt")
        return super.undefinedTest(e, op);
    }
    const v = this.expr(other);
    if (v.ty.k === "opt") return mk(T.bool, { k: "isundef", val: v, negate: op === "ne" });
    if (v.ty.k === "cls" || v.ty.k === "ptr")
      return mk(T.bool, { k: "cmp", op, a: v, b: mk(v.ty, { k: "lit", value: 0n }) });
    if (v.ty.k === "unk") return mk(T.bool, { k: "err" });
    return this.err(e, "TSL1008", `undefined only tests a nullable value, not ${tyName(v.ty)}`);
  }

  /** What a nullable scalar has when it has nothing: never read, as the flag says so. */
  zeroOf(t: Ty): TE {
    if (t.k === "big") return mk(t, { k: "lit", value: 0n });
    if (t.k === "bool") return mk(t, { k: "lit", value: false });
    if (t.k === "lits" && t.kind === "str") return mk(T.i32, { k: "lit", value: 0 });
    return mk(t, { k: "lit", value: 0 });
  }

  elemInfo(of: Ty, mode: ElemInfo["mode"], be = false): ElemInfo {
    if (mode === "ref") return { mode, size: 8, be: false };
    if (mode === "inline") {
      const size = of.k === "cls" ? this.layoutClass(of.c, of.c.decl as ts.Node).size : 0;
      return { mode, size, be: false };
    }
    return { mode, size: memSize(of) ?? 8, be };
  }

  defaultElem(of: Ty): ElemInfo {
    return of.k === "cls" || of.k === "fn" || of.k === "unk"
      ? this.elemInfo(of, "ref")
      : this.elemInfo(of, "scalar");
  }

  override typeRef(node: ts.TypeReferenceNode, env: Env): Ty {
    const sym = this.symbolOf(node.typeName);
    if (sym === undefined) return T.unk;
    const argTy = (i: number): Ty => {
      const a = node.typeArguments?.[i];
      return a !== undefined ? this.typeOf(a, env) : T.unk;
    };
    if (this.lowered !== null && this.isLoweredSymbol(sym)) {
      const t = loweredType(this as unknown as LoweredHost, sym.name, node);
      if (t !== null) return t;
    }
    if (this.isUnsafeSymbol(sym)) {
      if (sym.name === "Ptr") {
        const of = argTy(0);
        return { k: "ptr", of, elem: this.defaultElem(of) };
      }
      if (sym.name === "Elem" || sym.name === "ElemOf") {
        const of = argTy(0);
        return { k: "elem", of, elem: this.defaultElem(of) };
      }
      this.err(node, "TSL9001", `the type ${sym.name} is not usable here`);
      return T.unk;
    }
    if (this.isCoreSymbol(sym)) {
      if (sym.name === "ArrayOf") {
        const of = argTy(0);
        const name = of.k === "int" || of.k === "big" || of.k === "float" ? of.name : null;
        if (name === null) {
          if (of.k !== "unk") this.err(node, "TSL2003", `no typed array holds ${tyName(of)}`);
          return T.unk;
        }
        return { k: "arr", elem: name };
      }
      if (sym.name === "Arena") return { k: "arena" };
      if (sym.name === "LayoutArray") {
        const of = argTy(0);
        if (of.k === "cls") return { k: "larr", of: of.c, n: 0 };
        return T.unk;
      }
    }
    const cd = this.classes.get(sym);
    if (cd !== undefined) {
      const args = (node.typeArguments ?? []).map((a) => this.typeOf(a, env));
      if (args.some((a) => a.k === "unk")) return T.unk;
      return { k: "cls", c: this.classInst(cd, args, node) };
    }
    const idecl = sym.declarations?.[0];
    if (idecl !== undefined && ts.isInterfaceDeclaration(idecl) && isDispatchInterface(idecl)) {
      return this.ifaceTy(sym, idecl, node);
    }
    return super.typeRef(node, env);
  }

  /**
   * The string classes' layouts where the program has @tsl/jsrt's (D67, pipe-split), which the build publishes as D36's
   * string ABI: null where it hasn't, or where they aren't the two classes of a dispatch interface it can describe.
   */
  strLayout(): StrLayout | null {
    const find = (name: string): ClassInst | undefined =>
      [...this.classInsts.values()].find(
        (c) => c.name === name && c.key.startsWith("ex-jsrt-string.") && c.laidOut === 2,
      );
    const flat = find("JsFlat");
    const view = find("JsView");
    if (flat === undefined || view === undefined || flat.tail === undefined) return null;
    const fid = this.classIds.get(flat.decl as ts.ClassDeclaration);
    const vid = this.classIds.get(view.decl as ts.ClassDeclaration);
    const n = view.fields.find((f) => f.name === "n");
    const data = view.fields.find((f) => f.name === "data");
    if (fid === undefined || vid === undefined || n === undefined || data === undefined)
      return null;
    return {
      flat: { id: fid, len: flat.tail.f.off, units: flat.tail.at },
      view: { id: vid, len: n.off, addr: data.off },
    };
  }

  /**
   * R10: D36's string ABI where a lowered `rc` program's strings are its own JsStr (emit-rcstr.ts), as laid out here: the
   * length, start and buffer fields, and where each class's tail starts. Null where the program has none.
   */
  rcStrLayout(): RcStrLayout | null {
    const find = (name: string): ClassInst | undefined =>
      [...this.classInsts.values()].find(
        (c) => c.name === name && !c.key.startsWith("ex-") && c.laidOut === 2,
      );
    const s = find("JsStr");
    const b = find("JsStrBuf");
    if (s === undefined || s.tail === undefined) return null;
    const f = (n: string): number | undefined => s.fields.find((x) => x.name === n)?.off;
    const len = f("n");
    const start = f("start");
    const buf = f("buf");
    if (len === undefined || start === undefined || buf === undefined) return null;
    // the injected `rcstr-layout-len` bug (R10): the length published 4 bytes off where it is
    const off = process.env.TMK_TEST_EMIT === "rcstr-layout-len" ? 4 : 0;
    return {
      len: len + off,
      start,
      buf,
      units: s.tail.at,
      bufUnits: b?.tail?.at ?? s.tail.at,
    };
  }

  // --- @tsl/gc's release dispatch (3.5, D70, R1d)

  /**
   * Every top-level function the program names as an `Rc` store's release function (`new Rc<T>(f)`), in the order the
   * program first shows them: the closed set `callRelease` dispatches over, numbered from 1. Anything else given to `Rc`'s
   * constructor is TSL3010, since what it calls couldn't be told.
   */
  computeReleaseSet(): void {
    const isRc = (e: ts.Expression): boolean => {
      if (!ts.isIdentifier(e)) return false;
      const raw = this.checker.getSymbolAtLocation(e);
      if (raw === undefined) return false;
      const sym = raw.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(raw) : raw;
      const d = sym.declarations?.[0];
      return (
        d !== undefined &&
        ts.isClassDeclaration(d) &&
        d.name?.text === "Rc" &&
        /(^|\/)ex-gc-rc\.ts$/.test(d.getSourceFile().fileName)
      );
    };
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && isRc(n.expression) && n.arguments?.length === 1) {
        let a = n.arguments[0]!;
        while (ts.isParenthesizedExpression(a)) a = a.expression;
        const raw = ts.isIdentifier(a) ? this.checker.getSymbolAtLocation(a) : undefined;
        const sym =
          raw !== undefined && raw.flags & ts.SymbolFlags.Alias
            ? this.checker.getAliasedSymbol(raw)
            : raw;
        const d = sym?.declarations?.[0];
        if (
          d !== undefined &&
          ts.isFunctionDeclaration(d) &&
          ts.isSourceFile(d.parent) &&
          d.typeParameters === undefined &&
          d.body !== undefined
        ) {
          if (!this.releaseFns.includes(d)) this.releaseFns.push(d);
        } else {
          this.withSf(n.getSourceFile(), () =>
            this.err(
              a,
              "TSL3010",
              "an Rc store's release function is a top-level function, named here, so the set freeing calls can be told",
            ),
          );
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.modules) visit(sf);
  }

  /** The release functions as instances, with the order an injected bug may rotate (`release-wrong-arm`, R1d). */
  releaseInsts(at: ts.Node): FuncInst[] {
    return this.releaseFns.map((d) => this.instance(d, [], at));
  }

  // --- dispatch interfaces (3.4, D70; design/api-audit.md A5, option c)

  /**
   * Which classes reach each dispatch interface: every place the checker gives a contextual type (an argument, an
   * initialiser, a return, the right of `=` and of `??=`, an array element, a property), whose contextual type is or
   * contains the interface. The value there must be a class instance, or a union of them, or the interface itself (which
   * adds nothing). Anything else, an object literal, a type parameter or another interface, is TSL3010, since its classes
   * can't be told. The set is per interface, over the whole program as written, whether or not the code is reached.
   */
  computeFlowSets(): void {
    // Nothing to do, and nothing walked, in a program that declares none.
    const declared = this.modules.some((sf) =>
      sf.statements.some((st) => ts.isInterfaceDeclaration(st) && isDispatchInterface(st)),
    );
    if (!declared) return;
    const order: ts.ClassDeclaration[] = [];
    const add = (i: ts.Symbol, c: ts.ClassDeclaration): void => {
      const set = this.flowSets.get(i) ?? [];
      if (!set.includes(c)) set.push(c);
      this.flowSets.set(i, set);
      if (!order.includes(c)) order.push(c);
    };
    const targetsOf = (t: ts.Type): ts.Symbol[] => {
      const parts = t.isUnion() ? t.types : [t];
      const out: ts.Symbol[] = [];
      for (const p of parts) {
        const d = p.symbol?.declarations?.[0];
        if (d !== undefined && ts.isInterfaceDeclaration(d) && isDispatchInterface(d))
          out.push(p.symbol);
      }
      return out;
    };
    const sources = (e: ts.Expression): ts.Expression[] => {
      if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e))
        return sources(e.expression);
      if (ts.isConditionalExpression(e)) return [...sources(e.whenTrue), ...sources(e.whenFalse)];
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        return [...sources(e.left), ...sources(e.right)];
      return [e];
    };
    const classify = (i: ts.Symbol, e: ts.Expression): void => {
      const t = this.checker.getTypeAtLocation(e);
      const parts = t.isUnion() ? t.types : [t];
      for (const p of parts) {
        if (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
        if (p.symbol === i) continue; // the interface itself: what it holds was counted where it was stored
        const d = p.symbol?.declarations?.[0];
        if (d !== undefined && ts.isClassDeclaration(d) && this.classes.has(p.symbol)) {
          add(i, d);
          continue;
        }
        let what: string;
        if (ts.isObjectLiteralExpression(e))
          what = "an object literal isn't a class instance, so it has no class to call";
        else if (p.flags & ts.TypeFlags.TypeParameter)
          what = `${this.checker.typeToString(p)} is a type parameter, which could be any class`;
        else if (d !== undefined && ts.isInterfaceDeclaration(d))
          what = `a value of another interface, ${p.symbol.name}, whose classes aren't counted as ${i.name}'s`;
        else what = `a value of type ${this.checker.typeToString(p)} isn't an instance of a class`;
        this.withSf(e.getSourceFile(), () =>
          this.err(e, "TSL3010", `can't tell which classes reach ${i.name} here: ${what}`),
        );
        this.flowUnknown.add(i);
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isExpression(n) && isFlowPosition(n)) {
        const ctx = this.checker.getContextualType(n);
        if (ctx !== undefined) {
          for (const i of targetsOf(ctx)) for (const s of sources(n)) classify(i, s);
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.modules) this.withSf(sf, () => visit(sf));
    // Ids from 1, in the order classes were first seen, so a zeroed object (no id) is never one of them, and an id is
    // the same for a class in every interface it reaches.
    let next = 1;
    for (const c of order) {
      const inMulti = [...this.flowSets.values()].some((set) => set.length > 1 && set.includes(c));
      if (inMulti) this.classIds.set(c, next++);
    }
  }

  /**
   * A dispatch interface as a type: the one class that reaches it, which it then simply is, or a value told apart by its
   * class id. Its problems are reported once each, where they are, not at every use.
   */
  ifaceTy(sym: ts.Symbol, decl: ts.InterfaceDeclaration, node: ts.Node): Ty {
    if (decl.typeParameters !== undefined || decl.heritageClauses !== undefined) return T.unk; // TSL1025, from the subset check
    if (this.flowUnknown.has(sym)) return T.unk; // TSL3010, where it flows
    const once = (at: ts.Node, code: string, msg: string): Ty => {
      if (this.sink.muted === 0 && !this.ifaceReported.has(sym)) {
        this.ifaceReported.add(sym);
        this.withSf(at.getSourceFile(), () => this.err(at, code, msg));
      }
      return T.unk;
    };
    const set = this.flowSets.get(sym) ?? [];
    if (set.length === 0)
      return once(
        node,
        "TSL3010",
        `no class instance reaches ${sym.name} anywhere in this program, so what one of its values is can't be told`,
      );
    for (const c of set) {
      if (c.typeParameters !== undefined)
        return once(
          c.name ?? c,
          "TSL3010",
          `${c.name?.text} reaches ${sym.name} and is generic: each of its instances would be a class of its own`,
        );
    }
    const known = this.ifaceTys.get(sym);
    if (known !== undefined) return known;
    const insts = set.map((c) => this.classInst(c, [], node));
    let ty: Ty;
    if (insts.length === 1)
      ty = { k: "cls", c: insts[0]! }; // one class: it's that class, and calls are direct
    else {
      const key = `iface.${stemOf(decl.getSourceFile().fileName)}.${sym.name}`;
      let c = this.classInsts.get(key);
      if (c === undefined) {
        c = {
          key,
          name: sym.name,
          layout: false,
          tyArgs: [],
          decl,
          env: new Map(),
          fields: [cidField()],
          size: 4,
          align: 4,
          laidOut: 2,
          methods: new Map(),
          ctor: null,
          ctorKnown: true,
          iface: { set: insts, ids: set.map((d) => this.classIds.get(d)!) },
        };
        this.classInsts.set(key, c);
      }
      ty = { k: "cls", c };
    }
    // Known before its methods are checked, since a method may take or give the interface itself.
    this.ifaceTys.set(sym, ty);
    const fail = (at: ts.Node, msg: string): Ty => {
      if (this.sink.muted > 0)
        this.ifaceTys.delete(sym); // to be reported when it isn't
      else this.ifaceTys.set(sym, T.unk);
      return once(at, "TSL1025", msg);
    };
    for (const c of insts) {
      if (c.layout)
        return fail(
          (c.decl as ts.ClassDeclaration).name ?? node,
          `${c.name} is a layout class and reaches ${sym.name}: every byte of it is declared, so it has no room for a class id`,
        );
      const bad = this.ifaceMismatch(sym, decl, c);
      if (bad !== null) return fail(bad.at, bad.msg);
    }
    return ty;
  }

  /** The interface's own types for a method: its parameters' and its result's, as TSL has them. */
  ifaceSig(decl: ts.InterfaceDeclaration, name: string): { params: Ty[]; ret: Ty } | null {
    const m = decl.members.find(
      (x): x is ts.MethodSignature =>
        ts.isMethodSignature(x) && ts.isIdentifier(x.name) && x.name.text === name,
    );
    if (m === undefined) return null;
    return this.withSf(decl.getSourceFile(), () => ({
      params: m.parameters.map((p) =>
        p.type !== undefined ? this.typeOf(p.type, new Map()) : T.unk,
      ),
      ret: m.type !== undefined ? this.typeOf(m.type, new Map()) : T.void,
    }));
  }

  /**
   * Where a class reaching an interface doesn't have its methods as TSL sees them, which tsc can't: a `u32` and a `usize`
   * are both `number` to it, a field holding a function passes for a method, and a method may take fewer parameters.
   */
  ifaceMismatch(
    sym: ts.Symbol,
    decl: ts.InterfaceDeclaration,
    c: ClassInst,
  ): { at: ts.Node; msg: string } | null {
    const cd = c.decl as ts.ClassDeclaration;
    for (const sig of decl.members) {
      if (!ts.isMethodSignature(sig) || !ts.isIdentifier(sig.name)) continue;
      const name = sig.name.text;
      const want = this.ifaceSig(decl, name)!;
      const m = cd.members.find(
        (x) => x.name !== undefined && ts.isIdentifier(x.name) && x.name.text === name,
      );
      if (m === undefined || !ts.isMethodDeclaration(m) || this.hasStatic(m))
        return {
          at: m ?? cd.name ?? cd,
          msg: `${c.name} reaches ${sym.name}, and its ${name} isn't a method of its objects`,
        };
      if (m.typeParameters !== undefined)
        return { at: m, msg: `${c.name}'s ${name} is generic, and ${sym.name}'s isn't` };
      const got = this.withSf(m.getSourceFile(), () => ({
        params: m.parameters.map((p) =>
          p.type !== undefined ? this.typeOf(p.type, c.env as Env) : T.unk,
        ),
        ret: m.type !== undefined ? this.typeOf(m.type, c.env as Env) : T.void,
      }));
      const same =
        got.params.length === want.params.length &&
        got.params.every((t, i) => tyKey(t) === tyKey(want.params[i]!)) &&
        tyKey(got.ret) === tyKey(want.ret);
      if (!same)
        return {
          at: m,
          msg: `${c.name} reaches ${sym.name}, and its ${name} takes (${got.params.map(tyName).join(", ")}) and gives ${tyName(got.ret)} where ${sym.name}'s takes (${want.params.map(tyName).join(", ")}) and gives ${tyName(want.ret)}: TSL needs them the same`,
        };
    }
    return null;
  }

  /**
   * `x.m(a)` where x is a dispatch interface of two or more classes. The receiver, then the arguments, each once, into
   * locals; one load of the class id; then a compare and a direct call per class, and a trap (code 18) for an id that
   * isn't one of them, which only memory reused or overwritten unsafely can give. Never an indirect call.
   */
  dispatch(obj: TE, e: ts.CallExpression, callee: ts.PropertyAccessExpression): TE {
    const ic = (obj.ty as { c: ClassInst }).c;
    const { set, ids } = ic.iface!;
    const name = callee.name.text;
    const sig = this.ifaceSig(ic.decl as ts.InterfaceDeclaration, name);
    if (sig === null) return this.err(callee, "TSL1025", `${ic.name} has no method ${name}`);
    const held = this.newHidden(obj.ty);
    const items: TE[] = [mk(obj.ty, { k: "setvar", v: held, val: obj })];
    const argVars: Var[] = [];
    let bad = false;
    e.arguments.forEach((a, i) => {
      const t = sig.params[i] ?? T.unk;
      const te = this.coerce(this.expr(a, t), t, a);
      if (te.k === "err" || te.ty.k === "unk") bad = true;
      const v = this.newHidden(t);
      items.push(mk(t, { k: "setvar", v, val: te }));
      argVars.push(v);
    });
    if (this.dry || bad || sig.ret.k === "unk")
      return mk(sig.ret.k === "unk" ? T.unk : sig.ret, { k: "err" });
    const tag = this.newHidden(T.u32);
    items.push(
      mk(T.u32, {
        k: "setvar",
        v: tag,
        val: mk(T.u32, {
          k: "ofield",
          obj: mk(obj.ty, { k: "var", v: held }),
          c: ic,
          f: ic.fields[0]!,
          check: true,
          loc: this.loc(callee),
        }),
      }),
    );
    // A bug put in on purpose (`tmk milestone pipe-d` box 16): each arm taken for the next class's id.
    const wrong = process.env.TMK_TEST_TSL === "dispatch-wrong-arm";
    let out: TE = mk(T.never, { k: "trapnow", kind: "dispatch", code: 18, loc: this.loc(callee) });
    for (let i = set.length - 1; i >= 0; i--) {
      const c = this.layoutClass(set[i]!, e);
      const m = this.findMember(c, name) as ts.MethodDeclaration;
      const inst = this.methodInst(c, m, [], e);
      const recv = this.receiver(mk({ k: "cls", c }, { k: "var", v: held }), callee);
      const call = this.at(
        mk(sig.ret, {
          k: "call",
          inst,
          args: [recv, ...argVars.map((v) => mk(v.ty, { k: "var", v }))],
          argAts: [this.loc(e), ...e.arguments.map((a) => this.loc(a))],
        }),
        e,
      );
      const test = mk(T.bool, {
        k: "cmp",
        op: "eq",
        a: mk(T.u32, { k: "var", v: tag }),
        b: mk(T.u32, { k: "lit", value: ids[wrong ? (i + 1) % ids.length : i]! }),
      });
      out = mk(sig.ret, { k: "cond", c: test, a: call, b: out });
    }
    return mk(sig.ret, { k: "seq", items, result: out });
  }

  classInst(decl: ts.ClassDeclaration, tyArgs: Ty[], at: ts.Node): ClassInst {
    const file = decl.getSourceFile();
    const prefix = file === this.root ? "" : `${stemOf(file.fileName)}.`;
    const base = decl.name?.text ?? "anon";
    const key = `${prefix}${base}${tyArgs.length > 0 ? `<${tyArgs.map(tyKey).join(",")}>` : ""}`;
    const hit = this.classInsts.get(key);
    if (hit !== undefined) return hit;
    const env: Env = new Map();
    decl.typeParameters?.forEach((tp, i) => {
      const s = this.checker.getSymbolAtLocation(tp.name);
      if (s !== undefined) env.set(s, tyArgs[i] ?? T.unk);
    });
    const c: ClassInst = {
      key,
      name: base,
      layout: false,
      tyArgs,
      decl,
      env,
      fields: [],
      size: 0,
      align: 1,
      laidOut: 0,
      methods: new Map(),
      ctor: null,
      ctorKnown: false,
      firstAt: at,
      ...((this.layingOut ?? this.curInst?.owner) !== undefined && tyArgs.length > 0
        ? { firstIn: (this.layingOut ?? this.curInst?.owner)! }
        : {}),
    };
    this.classInsts.set(key, c);
    if (tyArgs.length > 0) {
      const n = (this.instanceCounts.get(decl as unknown as Fn) ?? 0) + 1;
      this.instanceCounts.set(decl as unknown as Fn, n);
      if (n === 129) this.err(at, "TSL4001", `${base} has more than 128 instantiations`);
    }
    return c;
  }

  isLayoutHelper(e: ts.Expression | undefined): boolean {
    if (e === undefined) return false;
    const s = strip(e);
    if (!ts.isCallExpression(s)) return false;
    const name = this.coreName(s.expression);
    return name !== null && LAYOUT_HELPERS.has(name);
  }

  /** Field offsets by the normative algorithm (SPEC 3.4). */
  layoutClass(c: ClassInst, at: ts.Node): ClassInst {
    if (c.laidOut === 2) return c;
    const outer = this.layingOut;
    this.layingOut = c;
    try {
      return this.layoutClassBody(c, at);
    } finally {
      this.layingOut = outer;
    }
  }

  layoutClassBody(c: ClassInst, at: ts.Node): ClassInst {
    if (c.laidOut === 1) {
      this.err(at, "TSL1015", `${c.name} contains itself: a class embedded in itself has no size`);
      return c;
    }
    c.laidOut = 1;
    const decl = c.decl as ts.ClassDeclaration;
    this.withSf(decl.getSourceFile(), () => {
      const env = c.env as Env;
      const props = decl.members.filter(
        (m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && !this.hasStatic(m),
      );
      const helperFields = props.filter((p) => this.isLayoutHelper(p.initializer));
      c.layout = helperFields.length > 0;
      if (c.layout) {
        for (const p of props) {
          const init = p.initializer !== undefined ? strip(p.initializer) : undefined;
          if (
            init !== undefined &&
            ts.isCallExpression(init) &&
            this.coreName(init.expression) === "tail"
          ) {
            this.err(p, "TSL1024", "a layout class has no tail: its size is fixed");
            c.tailBad = true;
          } else if (!this.isLayoutHelper(p.initializer)) {
            this.err(p, "TSL1015", "a layout class's fields all use layout helpers");
          }
        }
        for (const m of decl.members) {
          if (ts.isConstructorDeclaration(m))
            this.err(m, "TSL1014", "a layout class has no constructor: use make(T, ...)");
        }
        for (const p of helperFields) {
          const f = this.layoutField(p);
          if (f !== null) c.fields.push(f);
        }
      } else {
        const ctor = decl.members.find(ts.isConstructorDeclaration);
        const embedded = this.embeddedFields(decl);
        if (this.classIds.has(decl)) c.fields.push(cidField());
        for (const m of decl.members) {
          if (ts.isPropertyDeclaration(m) && !this.hasStatic(m)) {
            const f = this.plainField(m, m.type, m.initializer, embedded, env);
            if (f !== null) c.fields.push(f);
          } else if (m === ctor) {
            for (const p of ctor.parameters) {
              if (!ts.isParameterPropertyDeclaration(p, ctor)) continue;
              const f = this.plainField(p, p.type, undefined, embedded, env);
              if (f !== null) c.fields.push(f);
            }
          }
        }
      }
      let off = 0;
      let align = 1;
      for (const f of c.fields) {
        off = alignUp(off, f.align);
        f.off = off;
        off += f.size;
        align = Math.max(align, f.align);
      }
      const tails = c.fields.filter((f) => f.store === "tail");
      const tailNode = (f: ClsField): ts.Node =>
        props.find((p) => p.name.getText(this.sf) === f.name) ?? decl;
      if (
        tails.length > 0 &&
        (c.layout ||
          tails.length > 1 ||
          c.fields[c.fields.length - 1] !== tails[0] ||
          c.tyArgs.length > 0)
      )
        c.tailBad = true;
      if (c.layout && tails.length > 0) {
        this.err(tailNode(tails[0]!), "TSL1024", "a layout class has no tail: its size is fixed");
      } else if (tails.length > 1) {
        this.err(tailNode(tails[1]!), "TSL1024", `${c.name} has one tail at most`);
      } else if (tails.length === 1 && c.fields[c.fields.length - 1] !== tails[0]) {
        this.err(tailNode(tails[0]!), "TSL1024", "a tail is the class's last field");
      } else if (tails.length === 1 && c.tyArgs.length > 0) {
        this.err(tailNode(tails[0]!), "TSL1024", "a generic class has no tail");
      } else if (tails.length === 1) {
        const f = tails[0]!;
        const esize = f.arrLen;
        const at = alignUp(f.off + 4, esize);
        align = Math.max(align, esize);
        c.tail = { f, elem: (f.ty as { elem: ElemName }).elem, esize, at };
        off = at;
      }
      c.align = align;
      c.size = alignUp(off, align);
      this.checkSizeTag(c, decl);
    });
    c.laidOut = 2;
    return c;
  }

  checkSizeTag(c: ClassInst, decl: ts.ClassDeclaration): void {
    const start = decl.getFullStart();
    const text = this.sf.text.slice(start, decl.getStart(this.sf));
    const m = /@tsl\.size\s+(\d+)/.exec(text);
    if (m !== null && Number(m[1]) !== c.size) {
      this.err(decl, "TSL1016", `${c.name} is ${c.size} bytes, not ${m[1]!} as @tsl.size says`);
    }
  }

  /**
   * A field given a direct `new` by its initialiser or a top-level constructor statement, and by nothing else,
   * holds its object in place. There's nowhere else for one to live: `new` in a constructor is on a stack frame
   * that's about to go, and a program says where its memory comes from (D28, SPEC 3.5).
   */
  embeddedFields(decl: ts.ClassDeclaration): Set<string> {
    const candidates = new Set<string>();
    const others = new Set<string>();
    for (const m of decl.members) {
      if (
        ts.isPropertyDeclaration(m) &&
        m.initializer !== undefined &&
        ts.isNewExpression(strip(m.initializer))
      ) {
        const e = strip(m.initializer) as ts.NewExpression;
        if (!ts.isIdentifier(e.expression) || ELEM_BY_ARRAY[e.expression.text] === undefined) {
          candidates.add(m.name.getText(this.sf));
        }
      }
    }
    const ctor = decl.members.find(ts.isConstructorDeclaration);
    const direct = new Set<ts.Node>();
    for (const st of ctor?.body?.statements ?? []) {
      if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
      const b = st.expression;
      if (
        b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(b.left) &&
        b.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isNewExpression(strip(b.right))
      ) {
        candidates.add(b.left.name.text);
        direct.add(b);
      }
    }
    const scan = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        !direct.has(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        others.add(n.left.name.text);
      }
      ts.forEachChild(n, scan);
    };
    scan(decl);
    const out = new Set<string>();
    for (const c of candidates) if (!others.has(c)) out.add(c);
    return out;
  }

  plainField(
    node: ts.PropertyDeclaration | ts.ParameterDeclaration,
    typeNode: ts.TypeNode | undefined,
    init: ts.Expression | undefined,
    embedded: Set<string>,
    env: Env,
  ): ClsField | null {
    const name = node.name.getText(this.sf);
    const base: ClsField = {
      name,
      ty: T.unk,
      off: 0,
      size: 0,
      align: 1,
      store: "value",
      be: false,
      arrLen: 0,
      checkedEnum: false,
    };
    // A field with a reported error stays, with an unknown type, so its uses don't each report it again.
    const poison: ClsField = { ...base, store: "none" };
    let ty: Ty = T.unk;
    const tailCall =
      init !== undefined && ts.isCallExpression(strip(init))
        ? (strip(init) as ts.CallExpression)
        : null;
    if (tailCall !== null && this.coreName(tailCall.expression) === "tail") {
      // A variable-length tail of scalars (D69): its own bytes are its length, and its elements follow the fixed part.
      const a0 = tailCall.arguments[0];
      const n = a0 !== undefined ? this.coreName(a0) : null;
      const sc = n !== null ? SCALARS[n] : undefined;
      if (sc === undefined || sc.be === true) {
        this.err(a0 ?? tailCall, "TSL1024", "a tail holds scalars: tail(u8) to tail(f64)");
        if (this.layingOut !== undefined) this.layingOut.tailBad = true;
        return poison;
      }
      return {
        ...base,
        ty: { k: "arr", elem: (sc.ty as { name: ElemName }).name },
        size: 4,
        align: 4,
        store: "tail",
        arrLen: sc.size,
      };
    }
    if (typeNode !== undefined) ty = this.typeOf(typeNode, env);
    else if (init !== undefined && ts.isNewExpression(strip(init))) {
      const c = this.withEnv(env, () =>
        this.classOfNew(strip(init) as ts.NewExpression, undefined),
      );
      if (c !== null) ty = { k: "cls", c };
    } else if (
      init !== undefined &&
      (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      ty = T.bool;
    } else if (
      init !== undefined &&
      this.unsafeName((strip(init) as ts.CallExpression).expression ?? init) !== null
    ) {
      ty = this.withEnv(env, () => this.expr(init)).ty;
    } else {
      this.err(
        node,
        "TSL2001",
        `every field is annotated: a field's type can't come from its use (${name})`,
      );
      return poison;
    }
    if (ty.k === "unk") return poison;
    base.ty = ty;
    if (ty.k === "elem") {
      base.store = "none";
      base.size = 0;
      base.elemConst = init !== undefined ? this.withEnv(env, () => this.expr(init)).ty : ty;
      return base;
    }
    if (ty.k === "union") {
      this.err(
        node,
        "TSL3005",
        "a value union can't be stored in a field: it only exists in registers",
      );
      return poison;
    }
    if (ty.k === "rec") {
      this.err(node, "TSL9001", "value records in fields are not implemented: flatten the fields");
      return poison;
    }
    if (ty.k === "arr") {
      this.err(
        node,
        "TSL3001",
        "a typed array is a slice, and slices aren't stored in fields: use a Vec",
      );
      return poison;
    }
    if (ty.k === "cls" && embedded.has(name)) {
      const inner = this.layoutClass(ty.c, node);
      if (inner.tail !== undefined) {
        this.err(
          node,
          "TSL3011",
          `${inner.name} has a tail, so it's held by reference only: a field can't hold one in place`,
        );
        return poison;
      }
      base.store = "inline";
      base.size = inner.size;
      base.align = inner.align;
      return base;
    }
    const size = memSize(ty);
    if (size === null) {
      this.err(node, "TSL9001", `a field can't hold a ${tyName(ty)}`);
      return poison;
    }
    base.size = size;
    base.align = size;
    return base;
  }

  withEnv<R>(env: Env, f: () => R): R {
    const was = this.env;
    this.env = env;
    try {
      return f();
    } finally {
      this.env = was;
    }
  }

  layoutField(p: ts.PropertyDeclaration): ClsField | null {
    const name = p.name.getText(this.sf);
    const f: ClsField = {
      name,
      ty: T.unk,
      off: 0,
      size: 0,
      align: 1,
      store: "value",
      be: false,
      arrLen: 0,
      checkedEnum: false,
    };
    const e = strip(p.initializer!) as ts.CallExpression;
    const helper = this.coreName(e.expression)!;
    const scalarOf = (
      arg: ts.Expression | undefined,
    ): { ty: Ty; size: number; be?: boolean } | null => {
      const n = arg !== undefined ? this.coreName(arg) : null;
      const s = n !== null ? SCALARS[n] : undefined;
      if (s === undefined) {
        this.err(arg ?? e, "TSL1015", "this takes a scalar helper such as u16");
        return null;
      }
      return s;
    };
    const count = (arg: ts.Expression | undefined): number | null => {
      const v = arg !== undefined ? this.fold(arg) : null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        const t = arg !== undefined ? this.constantUsize(arg) : null;
        if (t !== null) return t;
        this.err(arg ?? e, "TSL1015", "a layout size is a constant");
        return null;
      }
      return v;
    };
    const s = SCALARS[helper];
    if (s !== undefined) {
      f.ty = s.ty;
      f.size = s.size;
      f.align = s.size;
      f.be = s.be === true;
      return f;
    }
    switch (helper) {
      case "pad": {
        const n = count(e.arguments[0]);
        if (n === null) return null;
        f.ty = T.never;
        f.size = n;
        f.store = "none";
        return f;
      }
      case "array": {
        const w = scalarOf(e.arguments[0]);
        const n = count(e.arguments[1]);
        if (w === null || n === null) return null;
        const elemName = (w.ty as { name: ElemName }).name;
        f.ty = { k: "arr", elem: elemName };
        f.size = w.size * n;
        f.align = w.size;
        f.store = "array";
        f.arrLen = n;
        f.be = w.be === true;
        return f;
      }
      case "nested": {
        const c = this.classArg(e.arguments[0], e, true);
        if (c === null) return null;
        f.ty = { k: "cls", c };
        f.size = c.size;
        f.align = c.align;
        f.store = "inline";
        return f;
      }
      case "arrayOf": {
        const c = this.classArg(e.arguments[0], e, true);
        const n = count(e.arguments[1]);
        if (c === null || n === null) return null;
        f.ty = { k: "larr", of: c, n };
        f.size = c.size * n;
        f.align = c.align;
        f.store = "inline";
        return f;
      }
      case "bits": {
        const w = scalarOf(e.arguments[0]);
        const m = e.arguments[1];
        if (w === null || m === undefined || !ts.isObjectLiteralExpression(m)) {
          this.err(m ?? e, "TSL1015", "bits takes a width and a constant object");
          return null;
        }
        const fields: BitField[] = [];
        let shift = 0;
        for (const prop of m.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const n = this.fold(prop.initializer);
          if (typeof n !== "number" || n < 1) {
            this.err(prop, "TSL1015", "a bit field's width is a constant");
            continue;
          }
          fields.push({ name: prop.name.getText(this.sf), shift, n });
          shift += n;
        }
        if (shift > w.size * 8) this.err(m, "TSL1015", `these bits don't fit in ${w.size * 8}`);
        f.ty = { k: "bits", width: w.size, be: w.be === true, fields };
        f.size = w.size;
        f.align = w.size;
        f.store = "inline";
        return f;
      }
      case "enumOf": {
        const w = scalarOf(e.arguments[0]);
        const id = e.arguments[1];
        const sym = id !== undefined && ts.isIdentifier(id) ? this.symbolOf(id) : undefined;
        const en = sym !== undefined ? this.enums.get(sym) : undefined;
        if (w === null || en === undefined) {
          this.err(id ?? e, "TSL1015", "enumOf takes a width and an enum");
          return null;
        }
        f.ty = en;
        f.size = w.size;
        f.align = w.size;
        f.be = w.be === true;
        f.checkedEnum = true;
        return f;
      }
      default:
        return null;
    }
  }

  constantUsize(arg: ts.Expression): number | null {
    const te = this.expr(arg);
    const v = te.k === "lit" ? te.value : this.evalConst(te);
    return typeof v === "number" ? v : null;
  }

  /** A class named as a value, as in sizeOf(T). `layoutOnly` is where a plain class is TSL1015. */
  classArg(arg: ts.Expression | undefined, at: ts.Node, layoutOnly = true): ClassInst | null {
    if (arg === undefined) return null;
    const sym = ts.isIdentifier(arg) ? this.symbolOf(arg) : undefined;
    let cd = sym !== undefined ? this.classes.get(sym) : undefined;
    if (cd === undefined && sym !== undefined) {
      const v = sym.valueDeclaration;
      if (v !== undefined && ts.isClassDeclaration(v)) {
        cd = v;
        this.classes.set(sym, v);
      }
    }
    if (cd === undefined) {
      this.err(arg, "TSL1015", "this takes a layout class");
      return null;
    }
    const c = this.layoutClass(this.classInst(cd, [], at), at);
    if (c.tail !== undefined) {
      const what = ts.isCallExpression(at) ? at.expression.getText(this.sf) : "this";
      this.err(
        arg,
        "TSL3011",
        `${c.name} has a tail, so it has no one size and is held by reference only: ${what} copies or lays out by a fixed size`,
      );
      return null;
    }
    if (layoutOnly && !c.layout) {
      this.err(arg, "TSL1015", `${c.name} is a plain class: its layout isn't visible on the host`);
      return null;
    }
    return c;
  }

  // --- functions and methods

  override fnName(decl: Fn): string {
    const m = decl as ts.Node;
    const base = ts.isMethodDeclaration(m)
      ? `${(m.parent as ts.ClassDeclaration).name?.text ?? "anon"}.${m.name.getText(m.getSourceFile())}`
      : super.fnName(decl);
    const file = decl.getSourceFile();
    return file === this.root ? base : `${stemOf(file.fileName)}.${base}`;
  }

  override isExported(decl: Fn, name: string): boolean {
    if (ts.isMethodDeclaration(decl as ts.Node)) return false; // a static method
    return decl.getSourceFile() === this.root && super.isExported(decl, name);
  }

  docOf(node: ts.Node): string {
    const sf = node.getSourceFile();
    return sf.text.slice(node.getFullStart(), node.getStart(sf));
  }

  /** `@tsl.tailed item`: a moved parameter that may take an object of a class with a tail, placed with placeTail (D69). */
  tailedOf(decl: FnLike, offset: number, doc: string): number[] {
    const out: number[] = [];
    for (const m of doc.matchAll(/@tsl\.tailed\s+(\w+)/g)) {
      const i = decl.parameters.findIndex((p) => p.name.getText(decl.getSourceFile()) === m[1]);
      if (i >= 0) out.push(i + offset);
    }
    return out;
  }

  movesOf(decl: FnLike, offset: number, doc: string): number[] {
    const out: number[] = [];
    for (const m of doc.matchAll(/@tsl\.moves\s+(\w+)/g)) {
      const i = decl.parameters.findIndex((p) => p.name.getText(decl.getSourceFile()) === m[1]);
      // A handle parameter takes the caller's handle over, which consume.ts checks (TSL3009), and copies nothing (D63).
      if (i >= 0 && !isHandleParam(this.checker, decl.parameters[i]!)) out.push(i + offset);
    }
    return out;
  }

  override instance(decl: Fn, tyArgs: Ty[], at: ts.Node): FuncInst {
    return this.withSf(decl.getSourceFile(), () => {
      const inst = super.instance(decl, tyArgs, at);
      if (inst.at === undefined) {
        inst.tirName = tirNameOf(inst.key);
        inst.at = this.loc(decl);
        inst.display = inst.key;
        const host =
          ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl as ts.Node)
            ? decl
            : decl.parent.parent.parent;
        inst.moves = this.movesOf(decl, 0, this.docOf(host));
        inst.tailMoves = this.tailedOf(decl, 0, this.docOf(host));
        // A lowered package keeps the symbols the lowering chose, which TS's identifiers can't all spell (SPEC 4.5, D62).
        if (this.lowered !== null) {
          const sym = /@tsl\.symbol\s+(\S+)/.exec(this.docOf(host))?.[1];
          if (sym !== undefined) inst.tirName = sym;
        }
      }
      return inst;
    });
  }

  methodKey(m: FnLike): string {
    if (ts.isConstructorDeclaration(m)) return "constructor";
    const name = this.memberName(m as unknown as ts.ClassElement);
    return ts.isGetAccessor(m) ? `get:${name}` : ts.isSetAccessor(m) ? `set:${name}` : name;
  }

  memberName(m: ts.ClassElement): string {
    const n = m.name;
    if (n === undefined) return "";
    if (ts.isComputedPropertyName(n)) return n.expression.getText(m.getSourceFile());
    return n.getText(m.getSourceFile());
  }

  methodInst(c: ClassInst, m: FnLike, tyArgs: Ty[], _at: ts.Node): FuncInst {
    const baseKey = this.methodKey(m);
    const suffix = tyArgs.length > 0 ? `<${tyArgs.map(tyKey).join(",")}>` : "";
    const mapKey = `${baseKey}${suffix}`;
    const hit = c.methods.get(mapKey);
    if (hit !== undefined) return hit;
    return this.withSf(m.getSourceFile(), () => {
      const env: Env = new Map(c.env as Env);
      m.typeParameters?.forEach((tp, i) => {
        const s = this.checker.getSymbolAtLocation(tp.name);
        if (s !== undefined) env.set(s, tyArgs[i] ?? T.unk);
      });
      const thisVar: Var = { id: this.nextVar++, name: "this", ty: { k: "cls", c } };
      const params = m.parameters.map((p): Var => {
        const ty = p.type !== undefined ? this.typeOf(p.type, env) : T.unk;
        return { id: this.nextVar++, name: p.name.getText(this.sf), ty };
      });
      if (m.type === undefined && !ts.isSetAccessor(m)) {
        this.err(m.name ?? m, "TSL2001", "every method's return is annotated");
      }
      const key = `${c.key}.${mapKey}`;
      const doc = this.docOf(m);
      const attrs: string[] = [];
      for (const a of ["inline", "noalloc", "noinline", "nosleep"]) {
        if (new RegExp(`@tsl\\.${a}\\b`).test(doc)) attrs.push(a);
      }
      const inst: FuncInst = {
        key,
        tirName: tirNameOf(key),
        jsName: key,
        params: [thisVar, ...params],
        ret: m.type !== undefined ? this.typeOf(m.type, env) : T.void,
        exported: false,
        attrs,
        body: [],
        at: this.loc(m),
        display: key,
        moves: this.movesOf(m, 1, doc),
        tailMoves: this.tailedOf(m, 1, doc),
        owner: c,
      };
      c.methods.set(mapKey, inst);
      this.funcs.push(inst);
      this.hiddenThis.set(inst, thisVar);
      this.methodDecls.set(inst, m);
      this.queue.push({ inst, decl: m as unknown as Fn, env });
      return inst;
    });
  }

  /** The synthesised constructor: field initialisers in order, parameter properties, then the body (JS order). */
  ctorOf(c: ClassInst, at: ts.Node): FuncInst | null {
    if (c.ctorKnown) return c.ctor;
    c.ctorKnown = true;
    this.layoutClass(c, at);
    const decl = c.decl as ts.ClassDeclaration;
    if (c.layout) return null;
    const ctor = decl.members.find(ts.isConstructorDeclaration);
    const hasInit = decl.members.some(
      (m) => ts.isPropertyDeclaration(m) && m.initializer !== undefined && !this.hasStatic(m),
    );
    if (ctor === undefined && !hasInit) return null;
    return this.withSf(decl.getSourceFile(), () => {
      const env = c.env as Env;
      const thisVar: Var = { id: this.nextVar++, name: "this", ty: { k: "cls", c } };
      const params = (ctor?.parameters ?? []).map((p): Var => {
        const ty = p.type !== undefined ? this.typeOf(p.type, env) : T.unk;
        return { id: this.nextVar++, name: p.name.getText(this.sf), ty };
      });
      const key = `${c.key}.constructor`;
      const inst: FuncInst = {
        key,
        tirName: tirNameOf(key),
        jsName: key,
        params: [thisVar, ...params],
        ret: T.void,
        exported: false,
        // R16: a constructor takes `@tsl.inline` and `@tsl.noinline` as a method does (3.7): only a hint, as everywhere
        attrs:
          ctor !== undefined
            ? ["inline", "noinline"].filter((a) =>
                new RegExp(`@tsl\\.${a}\\b`).test(this.docOf(ctor)),
              )
            : [],
        body: [],
        at: this.loc(ctor ?? decl),
        display: `new ${c.key}`,
        moves: ctor !== undefined ? this.movesOf(ctor, 1, this.docOf(ctor)) : [],
        owner: c,
      };
      c.ctor = inst;
      this.funcs.push(inst);
      this.hiddenThis.set(inst, thisVar);
      this.ctorQueue.push({ inst, c, decl });
      return inst;
    });
  }

  elabCtor(inst: FuncInst, c: ClassInst, decl: ts.ClassDeclaration): void {
    const env = c.env as Env;
    const ctor = decl.members.find(ts.isConstructorDeclaration);
    this.withSf(decl.getSourceFile(), () => {
      const build = (): Stmt[] => {
        const out: Stmt[] = [];
        const thisTe = (): TE => this.thisTe(decl);
        for (const m of decl.members) {
          if (!ts.isPropertyDeclaration(m) || this.hasStatic(m) || m.initializer === undefined)
            continue;
          const f = c.fields.find((x) => x.name === m.name.getText(this.sf));
          if (f === undefined || f.store === "none" || f.store === "tail") continue;
          out.push({ k: "expr", e: this.storeField(thisTe(), c, f, m.initializer, m) });
        }
        ctor?.parameters.forEach((p, i) => {
          if (!ts.isParameterPropertyDeclaration(p, ctor)) return;
          const f = c.fields.find((x) => x.name === p.name.getText(this.sf));
          if (f === undefined || f.store === "none") return;
          const v = inst.params[i + 1]!;
          const val = mk(v.ty, { k: "var", v });
          out.push({
            k: "expr",
            e: this.at(
              mk(val.ty, {
                k: "osetfield",
                obj: thisTe(),
                c,
                f,
                val,
                check: false,
                loc: this.loc(p),
              }),
              p,
            ),
          });
        });
        const inits = out.length;
        if (ctor?.body !== undefined) out.push(...this.block(ctor.body.statements));
        const kept = tslOptOff("init") ? out : dropOverwrittenInits(out, inits, inst.params[0]);
        inst.ctorInits = inits - (out.length - kept.length);
        return kept;
      };
      this.elabWith(inst, env, ctor ?? null, build);
    });
  }

  at(te: TE, node: ts.Node): TE {
    te.at = this.loc(node);
    return te;
  }

  /** Dry passes for inference, then the real one, with this function's state around them. */
  elabWith(inst: FuncInst, env: Env, decl: FnLike | null, build: () => Stmt[]): void {
    const saved = {
      env: this.env,
      scope: this.scope,
      infer: this.infer,
      inferByVar: this.inferByVar,
      finalTy: this.finalTy,
      dry: this.dry,
      retTy: this.retTy,
      curThis: this.curThis,
      curInst: this.curInst,
    };
    this.env = env;
    this.retTy = inst.ret;
    this.curInst = inst;
    this.curThis = this.hiddenThis.get(inst) ?? null;
    this.infer = new Map();
    this.inferByVar = new Map();
    this.finalTy = new Map();
    const bind = (): void => {
      this.scope = new Map();
      const off = this.curThis !== null ? 1 : 0;
      decl?.parameters.forEach((p, i) => {
        if (!ts.isIdentifier(p.name)) {
          this.err(p, "TSL9001", "destructured parameters are not implemented");
          return;
        }
        const sym = this.symbolOf(p.name);
        if (sym !== undefined) this.scope.set(sym, inst.params[i + off]!);
        // A parameter property's name means the parameter inside the constructor, and has a symbol of its own.
        if (p.parent !== undefined && ts.isParameterPropertyDeclaration(p, p.parent)) {
          for (const s of this.checker.getSymbolsOfParameterPropertyDeclaration(p, p.name.text)) {
            this.scope.set(s, inst.params[i + off]!);
          }
        }
      });
    };
    this.dry = true;
    this.sink.muted++;
    let settled = false;
    for (let pass = 0; pass < 8; pass++) {
      this.changed = false;
      bind();
      build();
      if (!this.changed) {
        settled = true;
        break;
      }
    }
    this.sink.muted--;
    this.dry = false;
    for (const [sym, cls] of this.infer) {
      let c = cls;
      for (let g = 0; c.parent !== null && g < 4096; g++) c = c.parent;
      const declNode = sym.valueDeclaration ?? sym.declarations?.[0];
      const at =
        declNode !== undefined
          ? ((declNode as ts.NamedDeclaration).name ?? declNode)
          : (decl ?? this.sf);
      if (!settled || c.conflict) {
        this.err(at, "TSL2001", `conflicting evidence for the type of ${sym.name}: annotate it`);
        this.finalTy.set(sym, T.unk);
      } else if (c.ev !== null) this.finalTy.set(sym, c.ev);
      else if (c.weak) this.finalTy.set(sym, T.usize);
      else {
        this.err(at, "TSL2001", `no evidence for the type of ${sym.name}: annotate it`);
        this.finalTy.set(sym, T.unk);
      }
    }
    bind();
    inst.body = build();
    Object.assign(this, saved);
  }

  override elabInstance(inst: FuncInst, decl: Fn, env: Env): void {
    this.withSf(decl.getSourceFile(), () => {
      const d = decl as unknown as FnLike;
      this.elabWith(inst, env, d, () => {
        if (d.body === undefined) return [];
        if (ts.isBlock(d.body)) return this.block(d.body.statements);
        const b = d.body as ts.Expression;
        const e = this.coerce(this.expr(b, this.retTy), this.retTy, b);
        return [{ k: "return", val: e, at: this.loc(b) }];
      });
    });
  }

  // --- statements

  override stmt(s: ts.Statement): Stmt[] {
    if (ts.isReturnStatement(s) && s.expression !== undefined) {
      const out = super.stmt(s);
      for (const r of out) if (r.k === "return") r.at = this.loc(s.expression);
      return out;
    }
    if (ts.isFunctionDeclaration(s) && s.name !== undefined) {
      // A nested function: a closure bound to a const.
      const sym = this.symbolOf(s.name);
      if (sym === undefined) return [];
      const fn = mk(this.fnTyOf(s), { k: "err" });
      const v: Var = { id: this.nextVar++, name: s.name.text, ty: fn.ty };
      this.scope.set(sym, v);
      const te = this.closureOf(s, fn.ty);
      return [{ k: "let", v, init: te, constant: true, at: this.loc(s) }];
    }
    if (ts.isClassDeclaration(s)) {
      this.err(s, "TSL9001", "a class is declared at the top level");
      return [];
    }
    return super.stmt(s);
  }

  override varList(list: ts.VariableDeclarationList): Stmt[] {
    const scoped = list.flags & ts.NodeFlags.BlockScoped;
    if (scoped === ts.NodeFlags.Using) return this.usingDecl(list);
    return super.varList(list);
  }

  usingDecl(list: ts.VariableDeclarationList): Stmt[] {
    const out: Stmt[] = [];
    for (const d of list.declarations) {
      if (!ts.isIdentifier(d.name) || d.initializer === undefined) {
        this.err(d, "TSL9001", "using binds one name to a value");
        continue;
      }
      const sym = this.symbolOf(d.name);
      if (sym === undefined) continue;
      const annotated = d.type !== undefined ? this.typeOf(d.type) : undefined;
      const init = this.expr(d.initializer, annotated);
      const v: Var = { id: this.nextVar++, name: d.name.text, ty: annotated ?? init.ty };
      this.scope.set(sym, v);
      out.push({ k: "let", v, init, constant: true, at: this.loc(d) });
      if (init.ty.k === "arena" || init.ty.k === "unk") {
        out.push({ k: "using", v, dispose: null });
        continue;
      }
      if (init.ty.k !== "cls") {
        this.err(d, "TSL2003", "using takes an arena or a class with [Symbol.dispose]()");
        continue;
      }
      const c = init.ty.c;
      const m = this.findMember(c, "Symbol.dispose");
      if (m === null || !ts.isMethodDeclaration(m)) {
        this.err(d, "TSL2003", `${c.name} has no [Symbol.dispose]() method`);
        continue;
      }
      const self = mk(v.ty, { k: "var", v });
      const dispose = this.dry
        ? null
        : this.at(mk(T.void, { k: "call", inst: this.methodInst(c, m, [], d), args: [self] }), d);
      out.push({ k: "using", v, dispose });
    }
    return out;
  }

  findMember(c: ClassInst, name: string, kind?: "get" | "set"): ts.ClassElement | null {
    const decl = c.decl as ts.ClassDeclaration;
    for (const m of decl.members) {
      if (this.hasStatic(m)) continue;
      if (this.memberName(m) !== name) continue;
      if (kind === "get" && !ts.isGetAccessor(m)) continue;
      if (kind === "set" && !ts.isSetAccessor(m)) continue;
      return m;
    }
    return null;
  }

  // --- expressions

  thisTe(node: ts.Node): TE {
    if (this.curThis === null) return this.err(node, "TSL9001", "`this` needs a method");
    return mk(this.curThis.ty, { k: "var", v: this.curThis });
  }

  override expr(e: ts.Expression, expected?: Ty, wrap = false): TE {
    switch (e.kind) {
      case ts.SyntaxKind.ThisKeyword:
        return this.thisTe(e);
      case ts.SyntaxKind.NullKeyword:
        return mk({ k: "nullish" }, { k: "lit", value: 0n });
      case ts.SyntaxKind.Identifier: {
        // `undefined` as a value: what a nullable result gives back, or a null reference (SPEC 3.3, rule 12).
        const id = e as ts.Identifier;
        if (id.text === "undefined" && this.isGlobalUndefined(id)) {
          return mk({ k: "nullish" }, { k: "lit", value: 0n, undef: true });
        }
        break;
      }
      case ts.SyntaxKind.NewExpression:
        return this.newExpr(e as ts.NewExpression, expected);
      case ts.SyntaxKind.ArrowFunction:
        return this.closureOf(e as ts.ArrowFunction, expected);
      case ts.SyntaxKind.NonNullExpression: {
        const inner = strip((e as ts.NonNullExpression).expression);
        if (ts.isElementAccessExpression(inner)) return super.expr(e, expected, wrap);
        const te = this.expr((e as ts.NonNullExpression).expression, expected, wrap);
        if (te.ty.k === "cls" || te.ty.k === "ptr" || te.ty.k === "fn") {
          return mk(te.ty, { k: "nonnull", val: te, loc: this.loc(e) });
        }
        return te;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const b = e as ts.BinaryExpression;
        if (b.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
          return this.coalesce(b, expected);
        if (b.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          return this.err(e, "TSL9001", "??= is not implemented: write the test out");
        }
        break;
      }
      default:
        break;
    }
    return super.expr(e, expected, wrap);
  }

  isGlobalUndefined(id: ts.Identifier): boolean {
    const sym = this.symbolOf(id);
    if (sym === undefined) return true;
    if (this.scope.has(sym)) return false;
    return (sym.flags & ts.SymbolFlags.Variable) === 0 || sym.valueDeclaration === undefined;
  }

  /** `a ?? b` on a nullable reference, or on a nullable scalar a call gave back. */
  coalesce(b: ts.BinaryExpression, expected?: Ty): TE {
    const a = this.expr(b.left, expected);
    if (a.ty.k === "unk") return mk(T.unk, { k: "err" });
    if (a.ty.k === "nullish") return this.expr(b.right, expected);
    if (a.ty.k === "opt") {
      const of = a.ty.of;
      const tmp = this.newHidden(a.ty);
      const held = mk(a.ty, { k: "var", v: tmp });
      const other = this.coerce(this.expr(b.right, of), of, b.right);
      const has = mk(T.bool, { k: "isundef", val: held, negate: true });
      const cond = mk(of, {
        k: "cond",
        c: has,
        a: mk(of, { k: "optpayload", val: held }),
        b: other,
      });
      return mk(of, { k: "seq", items: [mk(a.ty, { k: "setvar", v: tmp, val: a })], result: cond });
    }
    if (a.ty.k !== "cls" && a.ty.k !== "ptr") {
      return this.err(b, "TSL1008", "?? applies to nullable references");
    }
    const tmp = this.newHidden(a.ty);
    const held = mk(a.ty, { k: "var", v: tmp });
    const zero = mk(a.ty, { k: "lit", value: 0n });
    const test = mk(T.bool, { k: "cmp", op: "ne", a: held, b: zero });
    const other = this.coerce(this.expr(b.right, a.ty), a.ty, b.right);
    const cond = mk(a.ty, { k: "cond", c: test, a: held, b: other });
    return mk(a.ty, { k: "seq", items: [mk(a.ty, { k: "setvar", v: tmp, val: a })], result: cond });
  }

  override identifier(e: ts.Identifier): TE {
    const sym =
      e.parent !== undefined && ts.isShorthandPropertyAssignment(e.parent)
        ? this.checker.getShorthandAssignmentValueSymbol(e.parent)
        : this.symbolOf(e);
    if (sym !== undefined && this.isCoreSymbol(sym)) {
      const s = SCALARS[sym.name];
      if (s !== undefined) {
        const of = s.ty;
        return mk(
          { k: "elem", of, elem: this.elemInfo(of, "scalar", s.be === true) },
          { k: "tuple", items: [] },
        );
      }
    }
    return super.identifier(e);
  }

  closureOf(e: ts.ArrowFunction | ts.FunctionDeclaration, expected?: Ty): TE {
    const want = expected !== undefined && expected.k === "fn" ? expected : null;
    const params: Var[] = [];
    const tys: Ty[] = [];
    const scopeSaved = new Map(this.scope);
    e.parameters.forEach((p, i) => {
      const ty = p.type !== undefined ? this.typeOf(p.type) : (want?.params[i] ?? T.unk);
      if (ty.k === "unk" && p.type === undefined && !this.dry) {
        this.err(
          p,
          "TSL2001",
          "this closure's parameter has no type from its context: annotate it",
        );
      }
      const v: Var = { id: this.nextVar++, name: p.name.getText(this.sf), ty };
      params.push(v);
      tys.push(ty);
      if (ts.isIdentifier(p.name)) {
        const s = this.symbolOf(p.name);
        if (s !== undefined) this.scope.set(s, v);
      }
    });
    // JS lets a callback take fewer parameters than it's given; its signature still has to match.
    for (let i = e.parameters.length; want !== null && i < want.params.length; i++) {
      const ty = want.params[i]!;
      params.push({ id: this.nextVar++, name: `$p${i}`, ty });
      tys.push(ty);
    }
    const ret = e.type !== undefined ? this.typeOf(e.type) : (want?.ret ?? T.unk);
    if (e.type === undefined && want === null && !this.dry) {
      this.err(e, "TSL2001", "this closure's return has no type from its context: annotate it");
    }
    const fnTy: Ty = { k: "fn", params: tys, ret, env: true };
    const savedRet = this.retTy;
    this.retTy = ret;
    let body: Stmt[] = [];
    const b = e.body;
    if (b !== undefined) {
      if (ts.isBlock(b)) body = this.block(b.statements);
      else {
        const x = b as ts.Expression;
        if (ret.k === "void") body = [{ k: "expr", e: this.exprStmt(x) }];
        else body = [{ k: "return", val: this.coerce(this.expr(x, ret), ret, x), at: this.loc(x) }];
      }
    }
    this.retTy = savedRet;
    for (const key of this.scope.keys()) {
      if (!scopeSaved.has(key)) this.scope.delete(key);
    }
    for (const [key, val] of scopeSaved) this.scope.set(key, val);
    if (this.dry) return mk(fnTy, { k: "err" });
    const outer = this.curInst;
    const base = outer?.key ?? "top";
    const n = (this.closureCount.get(base) ?? 0) + 1;
    this.closureCount.set(base, n);
    const key = `${base}$c${n}`;
    const inst: FuncInst = {
      key,
      tirName: tirNameOf(key),
      jsName: key,
      params,
      ret,
      exported: false,
      attrs: outer?.attrs.filter((a) => a === "noalloc" || a === "nosleep") ?? [],
      body,
      at: this.loc(e),
      display: `a closure in ${outer?.display ?? "the module"}`,
      isClosure: true,
    };
    this.funcs.push(inst);
    return this.at(mk(fnTy, { k: "closure", inst }), e);
  }

  // --- new

  classOfNew(e: ts.NewExpression, expected?: Ty): ClassInst | null {
    if (!ts.isIdentifier(e.expression)) {
      this.err(e, "TSL9001", "new takes a class by name");
      return null;
    }
    const sym = this.symbolOf(e.expression);
    const cd = sym !== undefined ? this.classes.get(sym) : undefined;
    if (cd === undefined) {
      this.err(e, "TSL9001", `${e.expression.text} is not a class this compiler knows`);
      return null;
    }
    const tps = cd.typeParameters;
    if (tps === undefined || tps.length === 0)
      return this.layoutClass(this.classInst(cd, [], e), e);
    let args: Ty[];
    if (e.typeArguments !== undefined) args = e.typeArguments.map((a) => this.typeOf(a));
    else if (expected !== undefined && expected.k === "cls" && expected.c.decl === cd)
      args = expected.c.tyArgs;
    else {
      const ctor = cd.members.find(ts.isConstructorDeclaration);
      const env: Env = new Map();
      const set = new Set(tps.map((tp) => this.checker.getSymbolAtLocation(tp.name)!));
      ctor?.parameters.forEach((p, i) => {
        const a = e.arguments?.[i];
        if (p.type === undefined || a === undefined || ts.isArrowFunction(strip(a))) return;
        this.unifyType(p.type, this.expr(a).ty, env, set);
      });
      args = tps.map((tp) => env.get(this.checker.getSymbolAtLocation(tp.name)!) ?? T.unk);
      if (args.some((a) => a.k === "unk")) {
        if (!this.dry)
          this.err(e, "TSL2001", "no evidence for this class's type: give it explicitly");
        return null;
      }
    }
    if (args.some((a) => a.k === "unk")) return null;
    return this.layoutClass(this.classInst(cd, args, e), e);
  }

  newExpr(e: ts.NewExpression, expected?: Ty): TE {
    const name = ts.isIdentifier(e.expression) ? e.expression.text : "";
    if (ELEM_BY_ARRAY[name] !== undefined) {
      return this.err(e, "TSL1001", "new of a typed array inside a function is banned");
    }
    const c = this.classOfNew(e, expected);
    if (c === null) return mk(T.unk, { k: "err" });
    return this.buildNew(c, e, null);
  }

  buildNew(c: ClassInst, e: ts.NewExpression, into: { obj: TE; f: ClsField } | null): TE {
    const ty: Ty = { k: "cls", c };
    const decl = c.decl as ts.ClassDeclaration;
    const ctor = decl.members.find(ts.isConstructorDeclaration);
    const given = e.arguments ?? [];
    const env = c.env as Env;
    const args = given.map((a, i) => {
      const p = ctor?.parameters[i];
      const t = p?.type !== undefined ? this.typeOf(p.type, env) : T.unk;
      return this.coerce(this.expr(a, t), t, a);
    });
    if (this.dry) return mk(ty, { k: "err" });
    return this.at(
      mk(ty, {
        k: "new",
        c,
        ctor: this.ctorOf(c, e),
        args,
        init: this.classIds.has(decl)
          ? [{ f: c.fields[0]!, val: mk(T.u32, { k: "lit", value: this.classIds.get(decl)! }) }]
          : [],
        into,
        argAts: given.map((a) => this.loc(a)),
      }),
      e,
    );
  }

  // --- generics: finding T from an argument's type

  unifyType(node: ts.TypeNode, ty: Ty, env: Env, tps: Set<ts.Symbol>): void {
    if (ts.isParenthesizedTypeNode(node)) {
      this.unifyType(node.type, ty, env, tps);
      return;
    }
    if (ts.isUnionTypeNode(node)) {
      for (const p of node.types) this.unifyType(p, ty, env, tps);
      return;
    }
    if (ts.isFunctionTypeNode(node) && ty.k === "fn") {
      node.parameters.forEach((p, i) => {
        if (p.type !== undefined && ty.params[i] !== undefined)
          this.unifyType(p.type, ty.params[i]!, env, tps);
      });
      this.unifyType(node.type, ty.ret, env, tps);
      return;
    }
    if (!ts.isTypeReferenceNode(node)) return;
    const s = this.symbolOf(node.typeName);
    if (s === undefined) return;
    if (tps.has(s)) {
      if (
        !env.has(s) &&
        ty.k !== "unk" &&
        ty.k !== "lit-num" &&
        ty.k !== "lit-big" &&
        ty.k !== "nullish"
      )
        env.set(s, ty);
      else if (env.has(s) && (ty.k === "int" || ty.k === "float")) {
        const cur = env.get(s)!;
        if (cur.k === ty.k) {
          // Widen a numeric T to the join of its arguments, as the base elaborator does.
          const w = this.peerTy(cur, ty);
          if (w !== null) env.set(s, w);
        }
      }
      return;
    }
    const arg0 = node.typeArguments?.[0];
    if (arg0 === undefined) return;
    if (ty.k === "elem" && this.isUnsafeSymbol(s)) this.unifyType(arg0, ty.of, env, tps);
    else if (ty.k === "ptr" && s.name === "Ptr") this.unifyType(arg0, ty.of, env, tps);
    else if (ty.k === "arr" && s.name === "ArrayOf")
      this.unifyType(arg0, elemTy(ty.elem), env, tps);
    else if (ty.k === "cls") {
      node.typeArguments?.forEach((a, i) => {
        const t = ty.c.tyArgs[i];
        if (t !== undefined) this.unifyType(a, t, env, tps);
      });
    }
  }

  peerTy(a: Ty, b: Ty): Ty | null {
    if (tyKey(a) === tyKey(b)) return a;
    const dummy = mk(a, { k: "err" });
    const dummy2 = mk(b, { k: "err" });
    this.sink.muted++;
    const p = this.peer(this.sf, dummy, dummy2);
    this.sink.muted--;
    return p.ty.k === "unk" ? null : p.ty;
  }

  override directCall(e: ts.CallExpression, decl: Fn, expected?: Ty): TE {
    return this.callWithGenerics(e, decl as unknown as FnLike, e.arguments, expected, null, null);
  }

  /** A call of a function or method, generic or not. `recv` is the receiver for a method. */
  callWithGenerics(
    e: ts.CallExpression,
    decl: FnLike,
    given: readonly ts.Expression[],
    expected: Ty | undefined,
    recv: TE | null,
    owner: ClassInst | null,
  ): TE {
    const tps = decl.typeParameters;
    const ownerEnv = owner !== null ? (owner.env as Env) : null;
    const baseEnv: Env = new Map(ownerEnv ?? []);
    const tyArgs: Ty[] = [];
    const held: (TE | null)[] = given.map(() => null);
    if (tps !== undefined && tps.length > 0) {
      const set = new Set(tps.map((tp) => this.checker.getSymbolAtLocation(tp.name)!));
      e.typeArguments?.forEach((a, i) => {
        const tp = tps[i];
        if (tp !== undefined)
          baseEnv.set(this.checker.getSymbolAtLocation(tp.name)!, this.typeOf(a));
      });
      decl.parameters.forEach((p, i) => {
        const a = given[i];
        if (p.type === undefined || a === undefined || ts.isArrowFunction(strip(a))) return;
        const te = this.expr(a);
        if (te.k !== "closure" && te.k !== "new") held[i] = te;
        else if (!this.dry) held[i] = te;
        this.unifyType(p.type, te.ty, baseEnv, set);
      });
      if (decl.type !== undefined && expected !== undefined)
        this.unifyType(decl.type, expected, baseEnv, set);
      for (const tp of tps) {
        const s = this.checker.getSymbolAtLocation(tp.name)!;
        let t = baseEnv.get(s);
        if (t === undefined) {
          if (this.dry) t = T.unk;
          else
            return this.err(
              e,
              "TSL2001",
              "no evidence for this generic's type: give it explicitly",
            );
        }
        baseEnv.set(s, t);
        tyArgs.push(t);
      }
    }
    const paramTys = decl.parameters.map((p) =>
      p.type !== undefined ? this.typeOf(p.type, baseEnv) : T.unk,
    );
    const ret = decl.type !== undefined ? this.typeOf(decl.type, baseEnv) : T.void;
    const args: TE[] = given.map((a, i) => {
      const t = paramTys[i] ?? T.unk;
      return this.coerce(held[i] ?? this.expr(a, t), t, a);
    });
    if (this.dry) {
      // A generic result is as wide as the arguments typed by the same T, so their evidence joins.
      const deps: unknown[] = [];
      const rn = decl.type;
      if (tps !== undefined && rn !== undefined && ts.isTypeReferenceNode(rn)) {
        const rs = this.symbolOf(rn.typeName);
        const isParam = tps.some((tp) => this.checker.getSymbolAtLocation(tp.name) === rs);
        decl.parameters.forEach((p, i) => {
          const pn = p.type;
          if (!isParam || pn === undefined || !ts.isTypeReferenceNode(pn)) return;
          if (this.symbolOf(pn.typeName) !== rs) return;
          const h = held[i];
          if (h?.deps !== undefined) deps.push(...h.deps);
        });
      }
      return mk(ret, { k: "err" }, deps.length > 0 ? deps : undefined);
    }
    if (tyArgs.some((t) => t.k === "unk") || args.some((a) => a.k === "err"))
      return mk(T.unk, { k: "err" });
    const inst =
      owner !== null
        ? this.methodInst(owner, decl, tyArgs, e)
        : this.instance(decl as unknown as Fn, tyArgs, e);
    const te = mk(ret, {
      k: "call",
      inst,
      args: recv !== null ? [recv, ...args] : args,
      argAts: [...(recv !== null ? [this.loc(e)] : []), ...given.map((a) => this.loc(a))],
    });
    return this.at(te, e);
  }

  override call(e: ts.CallExpression, expected?: Ty): TE {
    const callee = e.expression;
    if (ts.isIdentifier(callee)) {
      const sym = this.symbolOf(callee);
      if (sym !== undefined && this.isUnsafeSymbol(sym))
        return this.unsafeCall(e, sym.name, expected);
      if (sym !== undefined && this.lowered !== null && this.isLoweredSymbol(sym))
        return loweredCall(this as unknown as LoweredHost, e, sym.name);
    } else if (ts.isCallExpression(strip(callee))) {
      // A function value that a call returned: only a top-level function can come back (TSL3003).
      return this.callValue(this.expr(callee), e);
    }
    const te = super.call(e, expected);
    te.at ??= this.loc(e);
    return te;
  }

  // --- members

  ptrElemOf(e: ts.Expression | undefined, at: ts.Node): { of: Ty; elem: ElemInfo } | null {
    if (e === undefined) return null;
    const t = this.expr(e);
    if (t.ty.k === "elem") return { of: t.ty.of, elem: t.ty.elem };
    if (t.ty.k !== "unk") this.err(at, "TSL2003", "this takes an element descriptor");
    return null;
  }

  readField(obj: TE, c: ClassInst, f: ClsField, node: ts.Node): TE {
    if (f.ty.k === "unk") return mk(T.unk, { k: "err" });
    if (f.store === "tail" && this.curInst !== null && this.curInst === c.ctor) {
      // On the host the tail is the object's once it's made, after its constructor (D69); natively it's zero then.
      return this.err(
        node,
        "TSL3012",
        `${c.name}.${f.name} is a tail: it's sized when the object is made, after its constructor, so the constructor can't use it`,
      );
    }
    if (f.store === "none") {
      if (f.ty.k === "never") return this.err(node, "TSL2003", "reserved bytes can't be read");
      return mk(f.elemConst ?? f.ty, { k: "tuple", items: [] });
    }
    return this.at(mk(f.ty, { k: "ofield", obj, c, f, check: false, loc: this.loc(node) }), node);
  }

  storeField(obj: TE, c: ClassInst, f: ClsField, value: ts.Expression, node: ts.Node): TE {
    const direct = strip(value);
    if (f.store === "inline") {
      if (ts.isNewExpression(direct) && f.ty.k === "cls") {
        const target = f.ty.c;
        const cc = this.classOfNew(direct, f.ty);
        if (cc === null) return mk(T.unk, { k: "err" });
        if (cc !== target)
          return this.err(value, "TSL2006", `${cc.name} doesn't fit ${target.name}`);
        return this.buildNew(cc, direct, { obj, f });
      }
      return this.err(
        value,
        "TSL3001",
        `${c.name}.${f.name} holds its object in place: it takes a direct new, once, at construction`,
      );
    }
    if (f.store === "array" || f.store === "tail") {
      return this.err(
        node,
        "TSL2006",
        `${c.name}.${f.name} is an array in place: write its elements`,
      );
    }
    const val = this.coerce(this.expr(value, f.ty), f.ty, value);
    return this.at(
      mk(val.ty, { k: "osetfield", obj, c, f, val, check: false, loc: this.loc(node) }),
      value,
    );
  }

  override property(e: ts.PropertyAccessExpression): TE {
    if (e.questionDotToken !== undefined) return this.optionalChain(e);
    // A static constant, by its class's name.
    if (ts.isIdentifier(e.expression)) {
      const sym = this.symbolOf(e.expression);
      const cd = sym !== undefined ? this.classes.get(sym) : undefined;
      if (cd !== undefined) {
        for (const m of cd.members) {
          if (
            ts.isPropertyDeclaration(m) &&
            this.hasStatic(m) &&
            m.name.getText(cd.getSourceFile()) === e.name.text
          ) {
            if (m.initializer === undefined)
              return this.err(e, "TSL1010", "a static member has a constant initialiser");
            return this.withSf(cd.getSourceFile(), () => {
              const ty = m.type !== undefined ? this.typeOf(m.type) : undefined;
              const te = this.expr(m.initializer!, ty);
              const v = ty !== undefined ? this.coerce(te, ty, m) : te;
              if (v.k !== "lit" && v.ty.k !== "unk" && this.evalConst(v) === null) {
                return this.err(m, "TSL1010", "a static member has a constant initialiser");
              }
              const c = this.evalConst(v);
              return c !== null ? mk(v.ty, { k: "lit", value: c }) : v;
            });
          }
        }
        return this.err(
          e,
          "TSL9001",
          `${cd.name?.text ?? "this class"} has no static ${e.name.text}`,
        );
      }
    }
    // Enums, and value records and unions, keep the base class's path.
    const left = ts.isIdentifier(e.expression) ? this.symbolOf(e.expression) : undefined;
    if (left !== undefined && (this.enumOf(left) !== undefined || this.isLibSymbol(left)))
      return super.property(e);
    const obj = this.expr(e.expression);
    return this.memberOf(obj, e.name.text, e, e.expression);
  }

  memberOf(obj: TE, name: string, node: ts.PropertyAccessExpression, objNode: ts.Node): TE {
    const t = obj.ty;
    if (t.k === "cls" && t.c.iface !== undefined) {
      return this.err(
        node,
        "TSL1025",
        `${t.c.name} is a dispatch interface, whose methods are only called: ${name} can't be read as a value`,
      );
    }
    if (t.k === "cls") {
      const c = this.layoutClass(t.c, node);
      const f = c.fields.find((x) => x.name === name);
      if (f !== undefined) return this.readField(obj, c, f, node);
      const g = this.findMember(c, name, "get");
      if (g !== null) {
        const ret = (g as ts.GetAccessorDeclaration).type;
        const ty = ret !== undefined ? this.typeOf(ret, c.env as Env) : T.unk;
        if (this.dry) return mk(ty, { k: "err" });
        const inst = this.methodInst(c, g as ts.GetAccessorDeclaration, [], node);
        return this.at(
          mk(ty, { k: "call", inst, args: [this.receiver(obj, node)], argAts: [this.loc(node)] }),
          node,
        );
      }
      if (this.findMember(c, name) !== null) {
        return this.err(node, "TSL3003", `a method isn't a value: write x => o.${name}(x)`);
      }
      return this.err(node, "TSL9001", `${c.name} has no member ${name}`);
    }
    if (t.k === "ptr" && name === "addr") return mk(T.u64, { k: "conv", val: obj });
    if (t.k === "larr" && name === "length") return mk(T.usize, { k: "lit", value: t.n });
    if (t.k === "bits") {
      const f = t.fields.find((x) => x.name === name);
      if (f === undefined) return this.err(node, "TSL9001", `no bit field ${name}`);
      const ty: Ty = f.n === 1 ? T.bool : T.u32;
      const te = mk(ty, {
        k: "builtin",
        name: "bit.get",
        args: [obj],
        loc: this.loc(node),
        info: { shift: f.shift, n: f.n, size: t.width },
      });
      if (f.n > 1 && f.n < 32) te.range = [0, 2 ** f.n - 1];
      return te;
    }
    return this.fieldOf(obj, name, node, objNode);
  }

  /** A method's receiver: a reference loaded from memory gets its generation checked here (SPEC 3.5). */
  receiver(obj: TE, node: ts.Node): TE {
    return mk(obj.ty, { k: "chkref", val: obj, check: false, loc: this.loc(node) });
  }

  /** `a?.b` and `a?.m()`: a nullable reference, read at once by ??, ! or a statement (SPEC 3.6). */
  optionalChain(e: ts.PropertyAccessExpression | ts.CallExpression): TE {
    let p: ts.Node = e;
    for (let g = 0; g < 64 && ts.isParenthesizedExpression(p.parent); g++) p = p.parent;
    const parent = p.parent;
    const consumed =
      ts.isExpressionStatement(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        parent.left === p &&
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);
    if (!consumed) {
      return this.err(
        e,
        "TSL1008",
        "?. gives undefined, which isn't a value: follow it with ?? or test first",
      );
    }
    const inner = ts.isCallExpression(e)
      ? (e.expression as ts.PropertyAccessExpression).expression
      : e.expression;
    const obj = this.expr(inner);
    if (obj.ty.k === "unk") return mk(T.unk, { k: "err" });
    if (obj.ty.k !== "cls") return this.err(e, "TSL1008", "?. applies to nullable references");
    const tmp = this.newHidden(obj.ty);
    const held = mk(obj.ty, { k: "var", v: tmp });
    const access = ts.isCallExpression(e)
      ? this.methodOn(held, e, e.expression as ts.PropertyAccessExpression)
      : this.memberOf(held, e.name.text, e, inner);
    if (access.ty.k === "unk") return access;
    const test = mk(T.bool, {
      k: "cmp",
      op: "ne",
      a: held,
      b: mk(obj.ty, { k: "lit", value: 0n }),
    });
    const save = mk(obj.ty, { k: "setvar", v: tmp, val: obj });
    if (access.ty.k === "void") {
      return mk(T.void, {
        k: "seq",
        items: [
          save,
          mk(T.void, { k: "cond", c: test, a: access, b: mk(T.never, { k: "tuple", items: [] }) }),
        ],
        result: mk(T.void, { k: "tuple", items: [] }),
      });
    }
    if (access.ty.k !== "cls" && access.ty.k !== "ptr") {
      return this.err(
        e,
        "TSL1008",
        "?. here would be a nullable scalar: only a[i] and enumValue make those",
      );
    }
    const zero = mk(access.ty, { k: "lit", value: 0n });
    const result = mk(access.ty, { k: "cond", c: test, a: access, b: zero });
    return mk(access.ty, { k: "seq", items: [save], result });
  }

  override methodCall(
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    expected?: Ty,
  ): TE {
    if (callee.questionDotToken !== undefined || e.questionDotToken !== undefined)
      return this.optionalChain(e);
    const left = ts.isIdentifier(callee.expression) ? this.symbolOf(callee.expression) : undefined;
    if (left !== undefined && (this.isLibSymbol(left) || this.isCoreSymbol(left))) {
      return super.methodCall(e, callee, expected);
    }
    const cd = left !== undefined ? this.classes.get(left) : undefined;
    if (cd !== undefined) {
      // A static method is a top-level function with a longer name. A generic class has no T to give it.
      const m = cd.members.find(
        (x) =>
          ts.isMethodDeclaration(x) &&
          this.hasStatic(x) &&
          x.name.getText(cd.getSourceFile()) === callee.name.text,
      );
      if (m !== undefined && cd.typeParameters === undefined) {
        return this.callWithGenerics(e, m as FnLike, e.arguments, expected, null, null);
      }
    }
    const obj = this.expr(callee.expression);
    return this.methodOn(obj, e, callee, expected);
  }

  methodOn(obj: TE, e: ts.CallExpression, callee: ts.PropertyAccessExpression, expected?: Ty): TE {
    const name = callee.name.text;
    const t = obj.ty;
    switch (t.k) {
      case "unk":
        return mk(T.unk, { k: "err" });
      case "cls": {
        if (t.c.iface !== undefined) return this.dispatch(obj, e, callee);
        const c = this.layoutClass(t.c, e);
        const f = c.fields.find((x) => x.name === name);
        if (f !== undefined) {
          const fn = this.readField(obj, c, f, callee);
          if (fn.ty.k !== "fn")
            return this.err(callee, "TSL9001", `${c.name}.${name} is not callable`);
          return this.callValue(fn, e);
        }
        const m = this.findMember(c, name);
        if (m === null || !ts.isMethodDeclaration(m)) {
          return this.err(callee, "TSL9001", `${c.name} has no method ${name}`);
        }
        return this.callWithGenerics(e, m, e.arguments, expected, this.receiver(obj, callee), c);
      }
      case "ptr":
        return this.ptrMethod(obj, t, name, e);
      case "arr":
        return this.arrayMethod(obj, name, e);
      case "larr": {
        if (name !== "at") return this.err(callee, "TSL9001", `LayoutArray has no ${name}`);
        const i = this.indexOf(e.arguments[0]!);
        const c = this.layoutClass(t.of, e);
        return mk(
          { k: "cls", c },
          {
            k: "builtin",
            name: "layout.at",
            args: [obj, i],
            loc: this.loc(e),
            info: { c, n: t.n },
          },
        );
      }
      case "arena":
        return this.arenaMethod(obj, name, e);
      default:
        return this.err(callee, "TSL9001", `${tyName(t)} has no method ${name}`);
    }
  }

  callValue(fn: TE, e: ts.CallExpression): TE {
    if (fn.ty.k !== "fn") return this.err(e, "TSL9001", "this value is not callable");
    const fnTy = fn.ty;
    if (e.arguments.length !== fnTy.params.length) return mk(fnTy.ret, { k: "err" });
    const args = e.arguments.map((a, i) => {
      const t = fnTy.params[i]!;
      return this.coerce(this.expr(a, t), t, a);
    });
    return this.at(mk(fnTy.ret, { k: "callind", fn, args }), e);
  }

  ptrMethod(obj: TE, t: Extract<Ty, { k: "ptr" }>, name: string, e: ts.CallExpression): TE {
    const loc = this.loc(e);
    const info: BuiltinInfo = { elem: t.elem, of: t.of };
    switch (name) {
      case "add": {
        const n = this.coerce(this.expr(e.arguments[0]!, T.usize), T.usize, e.arguments[0]!);
        return mk(t, { k: "builtin", name: "ptr.add", args: [obj, n], loc, info });
      }
      case "read":
        return this.at(mk(t.of, { k: "builtin", name: "ptr.read", args: [obj], loc, info }), e);
      case "write": {
        const a = e.arguments[0]!;
        if (t.elem.mode === "inline" && t.of.k === "cls" && t.of.c.tail !== undefined)
          return this.err(
            a,
            "TSL3011",
            `${t.of.c.name} has a tail, so it's held by reference only: an inline write copies by its fixed size`,
          );
        const v = this.coerce(this.expr(a, t.of), t.of, a);
        return this.at(
          mk(T.void, { k: "builtin", name: "ptr.write", args: [obj, v], loc, info }),
          a,
        );
      }
      case "cast": {
        const d = this.ptrElemOf(e.arguments[0], e);
        if (d === null) return mk(T.unk, { k: "err" });
        return mk({ k: "ptr", of: d.of, elem: d.elem }, { k: "conv", val: obj });
      }
      default:
        return this.err(e, "TSL9001", `Ptr has no method ${name}`);
    }
  }

  arrayMethod(obj: TE, name: string, e: ts.CallExpression): TE {
    const loc = this.loc(e);
    const t = obj.ty as Extract<Ty, { k: "arr" }>;
    const usizeArg = (i: number): TE | null => {
      const a = e.arguments[i];
      return a === undefined ? null : this.coerce(this.expr(a, T.usize), T.usize, a);
    };
    switch (name) {
      case "subarray": {
        const from = usizeArg(0) ?? mk(T.usize, { k: "lit", value: 0 });
        const to = usizeArg(1);
        const args = to === null ? [obj, from] : [obj, from, to];
        return mk(t, {
          k: "builtin",
          name: "arr.subarray",
          args,
          loc,
          info: { size: elemSizeOf(t.elem) },
        });
      }
      case "fill": {
        const target = t.elem === "f32" ? T.f64 : elemTy(t.elem);
        const a0 = e.arguments[0]!;
        const v = this.coerce(this.expr(a0, target), target, a0);
        const from = usizeArg(1) ?? mk(T.usize, { k: "lit", value: 0 });
        const to = usizeArg(2);
        const args = to === null ? [obj, v, from] : [obj, v, from, to];
        return mk(t, { k: "builtin", name: "arr.fill", args, loc });
      }
      case "set": {
        const a0 = e.arguments[0]!;
        const src = this.expr(a0);
        if (src.ty.k !== "arr" || src.ty.elem !== t.elem) {
          if (src.ty.k === "unk") return mk(T.void, { k: "err" });
          return this.err(a0, "TSL2003", "set copies between arrays of one element type");
        }
        const off = usizeArg(1) ?? mk(T.usize, { k: "lit", value: 0 });
        return mk(T.void, {
          k: "builtin",
          name: "arr.set",
          args: [obj, src, off],
          loc,
          info: { size: elemSizeOf(t.elem) },
        });
      }
      default:
        return this.err(e, "TSL1006", `.${name} is not in the allowed surface`);
    }
  }

  arenaMethod(obj: TE, name: string, e: ts.CallExpression): TE {
    const loc = this.loc(e);
    const a0 = e.arguments[0];
    if (name === "make") {
      const c = this.classArg(a0, e, true);
      if (c === null) return mk(T.unk, { k: "err" });
      return this.at(
        mk({ k: "cls", c }, { k: "builtin", name: "arena.make", args: [obj], loc, info: { c } }),
        e,
      );
    }
    if (name !== "bytes" && name !== "u32s") return this.err(e, "TSL9001", `Arena has no ${name}`);
    if (a0 === undefined) return mk(T.unk, { k: "err" });
    const n = this.coerce(this.expr(a0, T.usize), T.usize, a0);
    const elem: ElemName = name === "bytes" ? "u8" : "u32";
    return this.at(
      mk(
        { k: "arr", elem },
        { k: "builtin", name: "arena.take", args: [obj, n], loc, info: { size: elemSizeOf(elem) } },
      ),
      e,
    );
  }

  // --- assignment to members

  override assign(e: ts.BinaryExpression): TE {
    const lhs = strip(e.left);
    if (ts.isPropertyAccessExpression(lhs)) return this.assignMember(e, lhs);
    const te = super.assign(e);
    te.at ??= this.loc(e.right);
    return te;
  }

  assignMember(e: ts.BinaryExpression, lhs: ts.PropertyAccessExpression): TE {
    const obj =
      lhs.expression.kind === ts.SyntaxKind.ThisKeyword
        ? this.thisTe(lhs)
        : this.expr(lhs.expression);
    return this.storeMember(obj, lhs, e.right, e);
  }

  storeMember(
    obj: TE,
    lhs: ts.PropertyAccessExpression,
    value: ts.Expression | TE,
    node: ts.Node,
  ): TE {
    const name = lhs.name.text;
    const t = obj.ty;
    const valueOf = (ty: Ty): TE => {
      if (!("k" in value)) return this.coerce(this.expr(value, ty), ty, value);
      return this.coerce(value, ty, node);
    };
    if (t.k === "unk") return mk(T.unk, { k: "err" });
    if (t.k === "bits") {
      const f = t.fields.find((x) => x.name === name);
      if (f === undefined) return this.err(lhs, "TSL9001", `no bit field ${name}`);
      const val = valueOf(f.n === 1 ? T.bool : T.u32);
      return mk(val.ty, {
        k: "builtin",
        name: "bit.set",
        args: [obj, val],
        loc: this.loc(lhs),
        info: { shift: f.shift, n: f.n, size: t.width },
      });
    }
    if (t.k !== "cls")
      return this.err(lhs, "TSL9001", "this assignment target is not a class field");
    const c = this.layoutClass(t.c, lhs);
    const f = c.fields.find((x) => x.name === name);
    if (f !== undefined) {
      if (f.ty.k === "unk") return mk(T.unk, { k: "err" });
      if (f.store === "none") {
        const val = valueOf(f.ty);
        return mk(T.void, {
          k: "seq",
          items: [val],
          result: mk(T.void, { k: "tuple", items: [] }),
        });
      }
      if (!("k" in value)) return this.storeField(obj, c, f, value, lhs);
      const val = valueOf(f.ty);
      return this.at(
        mk(val.ty, { k: "osetfield", obj, c, f, val, check: false, loc: this.loc(lhs) }),
        node,
      );
    }
    const s = this.findMember(c, name, "set");
    if (s !== null) {
      const p = (s as ts.SetAccessorDeclaration).parameters[0];
      const pt = p?.type !== undefined ? this.typeOf(p.type, c.env as Env) : T.unk;
      const val = valueOf(pt);
      if (this.dry) return mk(val.ty, { k: "err" });
      const inst = this.methodInst(c, s as ts.SetAccessorDeclaration, [], lhs);
      const tmp = this.newHidden(val.ty);
      const save = mk(val.ty, { k: "setvar", v: tmp, val });
      const held = mk(val.ty, { k: "var", v: tmp });
      return mk(val.ty, {
        k: "seq",
        items: [
          save,
          this.at(mk(T.void, { k: "call", inst, args: [this.receiver(obj, lhs), held] }), lhs),
        ],
        result: held,
      });
    }
    return this.err(lhs, "TSL9001", `${c.name} has no settable member ${name}`);
  }

  /** Read-modify-write of a member, with its object evaluated once. */
  override compound(e: ts.BinaryExpression, op: Parameters<Elaborator["compound"]>[1]): TE {
    const lhs = strip(e.left);
    if (!ts.isPropertyAccessExpression(lhs)) return super.compound(e, op);
    const obj = this.expr(lhs.expression);
    if (obj.ty.k === "unk") return mk(T.unk, { k: "err" });
    const tmp = this.newHidden(obj.ty);
    const held = mk(obj.ty, { k: "var", v: tmp });
    const read = this.memberOf(held, lhs.name.text, lhs, lhs.expression);
    const rhs = this.expr(e.right, read.ty);
    const val = this.combine(e, op, read, rhs);
    const store = this.storeMember(held, lhs, val, e);
    return mk(store.ty, {
      k: "seq",
      items: [mk(obj.ty, { k: "setvar", v: tmp, val: obj })],
      result: store,
    });
  }

  override update(
    e: ts.Expression,
    operand: ts.Expression,
    operator: ts.SyntaxKind,
    valueUsed: boolean,
  ): TE {
    const lhs = strip(operand);
    if (!ts.isPropertyAccessExpression(lhs)) return super.update(e, operand, operator, valueUsed);
    const obj = this.expr(lhs.expression);
    if (obj.ty.k === "unk") return mk(T.unk, { k: "err" });
    const tmp = this.newHidden(obj.ty);
    const held = mk(obj.ty, { k: "var", v: tmp });
    const save = mk(obj.ty, { k: "setvar", v: tmp, val: obj });
    const read = this.memberOf(held, lhs.name.text, lhs, lhs.expression);
    if (read.ty.k === "unk") return read;
    const one =
      read.ty.k === "big"
        ? mk(T.litBig, { k: "lit", value: 1n })
        : mk(T.litNum, { k: "lit", value: 1 });
    const op = operator === ts.SyntaxKind.PlusPlusToken ? "add" : "sub";
    const bin = e as unknown as ts.BinaryExpression;
    const old = this.newHidden(read.ty);
    const oldRead = mk(read.ty, { k: "var", v: old });
    const saveOld = mk(read.ty, { k: "setvar", v: old, val: read });
    const next = this.storeMember(held, lhs, this.arith(bin, op, oldRead, one, false), e);
    return mk(read.ty, {
      k: "seq",
      items: [save, saveOld, next],
      result: valueUsed ? oldRead : mk(read.ty, { k: "var", v: old }),
    });
  }

  // --- coercion and comparison of references

  override evidence(cls: Parameters<Elaborator["evidence"]>[0], ty: Ty): void {
    if (ty.k === "nullish") return;
    super.evidence(cls, ty);
  }

  override coerce(te: TE, target: Ty, node: ts.Node): TE {
    if (target.k === "opt" && te.ty.k !== "unk") {
      // A function's nullable scalar result (SPEC 3.3, rule 12): undefined, or a value with the flag set.
      if (te.ty.k === "nullish") {
        if (te.k !== "lit" || te.undef !== true)
          return this.err(node, "TSL1008", "this is undefined, not null");
        return mk(target, {
          k: "tuple",
          items: [mk(T.i32, { k: "lit", value: 0 }), this.zeroOf(target.of)],
        });
      }
      if (te.ty.k === "opt") {
        if (tyKey(te.ty) === tyKey(target)) return te;
        return this.err(node, "TSL2006", `${tyName(te.ty)} doesn't widen to ${tyName(target)}`);
      }
      const v = this.coerce(te, target.of, node);
      if (v.ty.k === "unk") return v;
      return mk(target, { k: "tuple", items: [mk(T.i32, { k: "lit", value: 1 }), v] });
    }
    if (te.ty.k === "nullish") {
      if (target.k === "cls" || target.k === "ptr") return mk(target, { k: "lit", value: 0n });
      if (target.k === "unk") return te;
      return this.err(node, "TSL1008", `null only applies to references, not ${tyName(target)}`);
    }
    if (te.ty.k === "elem" && target.k === "elem") {
      if (te.ty.elem.mode !== target.elem.mode) {
        return this.err(
          node,
          "TSL9001",
          "a generic parameter here takes a reference or scalar descriptor",
        );
      }
      return te;
    }
    if (te.ty.k === "cls" && target.k === "cls" && te.ty.c !== target.c) {
      // Into a dispatch interface: the same reference, if the flow pass counted its class. If not, that's a
      // place it missed, and an error, never a silent widening.
      if (target.c.iface?.set.includes(te.ty.c) === true) return { ...te, ty: target };
      return this.err(
        node,
        "TSL2006",
        `${te.ty.c.name} isn't a ${target.c.name}: classes have no subtypes`,
      );
    }
    if (te.ty.k === "fn" && target.k === "fn") return te;
    // An enum member is a constant, so it adapts to an integer like a literal does: ex-messages.ts compares
    // a raw u32 from outside with EventKind.Irq.
    if (te.ty.k === "enum" && te.k === "lit" && target.k === "int") {
      return this.coerce(mk(T.litNum, { k: "lit", value: te.value }), target, node);
    }
    return super.coerce(te, target, node);
  }

  override compare(e: ts.BinaryExpression, op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"): TE {
    if (op === "eq" || op === "ne") {
      // enumValue's nullable scalar, tested against null (SPEC 3.3, rule 12).
      const isNull = (x: ts.Expression): boolean => strip(x).kind === ts.SyntaxKind.NullKeyword;
      const other = isNull(e.right) ? e.left : isNull(e.left) ? e.right : null;
      if (other !== null) {
        // V8 says `undefined === null` is false, and a null reference here is both: say which it is.
        const t = this.checker.getTypeAtLocation(other);
        const parts = t.isUnion() ? t.types : [t];
        if (
          parts.some((p) => (p.flags & ts.TypeFlags.Undefined) !== 0) &&
          !parts.some((p) => (p.flags & ts.TypeFlags.Null) !== 0)
        )
          return this.err(
            e,
            "TSL1008",
            "this can be undefined, not null: test it against undefined",
          );
        const x = this.expr(other);
        if (x.ty.k === "opt") return mk(T.bool, { k: "isundef", val: x, negate: op === "ne" });
        if (x.ty.k === "unk") return mk(T.bool, { k: "err" });
        if (x.ty.k === "cls" || x.ty.k === "ptr" || x.ty.k === "nullish") {
          return mk(T.bool, { k: "cmp", op, a: x, b: mk(x.ty, { k: "lit", value: 0n }) });
        }
        return this.err(e, "TSL1008", `null only applies to references, not ${tyName(x.ty)}`);
      }
    }
    return super.compare(e, op);
  }

  override compareTe(
    e: ts.BinaryExpression,
    op: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
    a: TE,
    b: TE,
  ): TE {
    // A lowered package's pointers compare by address, as the lowering's own comparisons did (SPEC 4.5, D62).
    if (this.lowered !== null && a.ty.k === "ref" && b.ty.k === "ref") {
      // Ordered too: the stack pointer against the limit below which a recursion throws (3.10 item 14).
      return mk(T.bool, { k: "cmp", op, a, b });
    }
    if (a.ty.k === "cls" || b.ty.k === "cls" || a.ty.k === "ptr" || b.ty.k === "ptr") {
      if (op !== "eq" && op !== "ne") return this.err(e, "TSL2003", "references have no order");
      // A dispatch interface's value and an object of one of its classes can be the same object (D70).
      const within = (x: ClassInst, y: ClassInst): boolean => x.iface?.set.includes(y) === true;
      if (
        a.ty.k === "cls" &&
        b.ty.k === "cls" &&
        a.ty.c !== b.ty.c &&
        !within(a.ty.c, b.ty.c) &&
        !within(b.ty.c, a.ty.c)
      ) {
        return this.err(e, "TSL2003", `a ${a.ty.c.name} is never a ${b.ty.c.name}`);
      }
      return this.at(mk(T.bool, { k: "cmp", op, a, b }), e);
    }
    return super.compareTe(e, op, a, b);
  }

  override readSymbol(sym: ts.Symbol, e: ts.Node): TE {
    const local = this.scope.get(sym);
    // In a lowered package an Opt<T> is a value like any other, which @tsl/lowered's isUndef and optPayload take apart.
    if (this.lowered !== null && local !== undefined && !("value" in local) && local.ty.k === "opt")
      return mk(local.ty, { k: "var", v: local });
    // A nullable scalar from enumValue narrows by null as a[i] narrows by undefined.
    if (local !== undefined && !("value" in local) && local.ty.k === "opt") {
      const t = this.checker.getTypeAtLocation(e);
      const parts = t.isUnion() ? t.types : [t];
      if (parts.some((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0)) {
        const asOperand =
          ts.isBinaryExpression(e.parent) &&
          [e.parent.left, e.parent.right].some((x) => strip(x).kind === ts.SyntaxKind.NullKeyword);
        if (asOperand) return mk(local.ty, { k: "var", v: local });
      }
    }
    return super.readSymbol(sym, e);
  }

  override conditional(e: ts.ConditionalExpression, expected?: Ty): TE {
    if (expected === undefined) {
      const a = this.expr(e.whenTrue);
      const b = this.expr(e.whenFalse);
      if (a.ty.k === "nullish" && (b.ty.k === "cls" || b.ty.k === "ptr")) {
        const c = this.condition(e.condition);
        return mk(b.ty, { k: "cond", c, a: mk(b.ty, { k: "lit", value: 0n }), b });
      }
      if (b.ty.k === "nullish" && (a.ty.k === "cls" || a.ty.k === "ptr")) {
        const c = this.condition(e.condition);
        return mk(a.ty, { k: "cond", c, a, b: mk(a.ty, { k: "lit", value: 0n }) });
      }
      if (a.ty.k === "cls" || a.ty.k === "ptr") {
        const c = this.condition(e.condition);
        return mk(a.ty, { k: "cond", c, a, b: this.coerce(b, a.ty, e.whenFalse) });
      }
    }
    return super.conditional(e, expected);
  }

  // --- @tsl/core's compile-time and layout operations

  override coreCall(e: ts.CallExpression, name: string, expected?: Ty): TE {
    const loc = this.loc(e);
    switch (name) {
      case "sizeOf":
      case "alignOf": {
        const c = this.classArg(e.arguments[0], e, true);
        if (c === null) return mk(T.usize, { k: "err" });
        return mk(T.usize, { k: "lit", value: name === "sizeOf" ? c.size : c.align });
      }
      case "offsetOf": {
        const c = this.classArg(e.arguments[0], e, true);
        const f = e.arguments[1];
        if (c === null || f === undefined || !ts.isStringLiteralLike(f))
          return mk(T.usize, { k: "err" });
        const field = c.fields.find((x) => x.name === f.text);
        if (field === undefined) return this.err(f, "TSL1015", `${c.name} has no field ${f.text}`);
        return mk(T.usize, { k: "lit", value: field.off });
      }
      case "withTail": {
        // withTail(n, new T(…)): a T whose tail has n elements, made on the heap at its real size (D69).
        const a0 = e.arguments[0];
        const a1 = e.arguments[1];
        if (a0 === undefined || a1 === undefined)
          return this.err(e, "TSL3012", "withTail takes a length and a new");
        const n = this.coerce(this.expr(a0, T.usize), T.usize, a0);
        const made = strip(a1);
        if (!ts.isNewExpression(made))
          return this.err(a1, "TSL3012", "withTail takes a direct new of a class with a tail");
        const c = this.classOfNew(made, expected);
        if (c === null) return mk(T.unk, { k: "err" });
        if (c.tail === undefined && c.tailBad === true) return mk(T.unk, { k: "err" }); // its declaration's error says why
        if (c.tail === undefined)
          return this.err(a1, "TSL3012", `${c.name} has no tail: make it with a plain new`);
        const te = this.buildNew(c, made, null);
        if (te.k !== "new") return te;
        return this.at({ ...te, tail: n }, e);
      }
      case "tail":
        return this.err(e, "TSL1024", "tail() declares a class's last field: it isn't a value");
      case "assertSize":
        this.checkAssertSize(e);
        return mk(T.void, { k: "tuple", items: [] });
      case "make": {
        const c = this.classArg(e.arguments[0], e, true);
        if (c === null) return mk(T.unk, { k: "err" });
        const init = this.initFields(c, e.arguments[1]);
        if (this.dry) return mk({ k: "cls", c }, { k: "err" });
        return this.at(
          mk({ k: "cls", c }, { k: "new", c, ctor: null, args: [], init, into: null, argAts: [] }),
          e,
        );
      }
      case "set": {
        const obj = this.expr(e.arguments[0]!);
        if (obj.ty.k === "unk") return mk(T.unk, { k: "err" });
        if (obj.ty.k !== "cls")
          return this.err(e.arguments[0]!, "TSL1015", "set takes a layout-class object");
        const c = this.layoutClass(obj.ty.c, e);
        if (c.tail !== undefined)
          return this.err(
            e.arguments[0]!,
            "TSL3011",
            `${c.name} has a tail, so it's held by reference only: set writes by its fixed size`,
          );
        if (!c.layout)
          return this.err(e.arguments[0]!, "TSL1015", "set takes a layout-class object");
        const tmp = this.newHidden(obj.ty);
        const held = mk(obj.ty, { k: "var", v: tmp });
        const items: TE[] = [mk(obj.ty, { k: "setvar", v: tmp, val: obj })];
        for (const { f, val } of this.initFields(c, e.arguments[1])) {
          items.push(mk(val.ty, { k: "osetfield", obj: held, c, f, val, check: false, loc }));
        }
        return mk(obj.ty, { k: "seq", items, result: held });
      }
      case "over": {
        const c = this.classArg(e.arguments[0], e, true);
        const bytes = this.expr(e.arguments[1]!);
        const a2 = e.arguments[2]!;
        const off = this.coerce(this.expr(a2, T.usize), T.usize, a2);
        if (c === null) return mk(T.unk, { k: "err" });
        if (bytes.ty.k !== "arr") return mk({ k: "cls", c }, { k: "err" });
        return this.at(
          mk(
            { k: "cls", c },
            { k: "builtin", name: "layout.over", args: [bytes, off], loc, info: { c } },
          ),
          e,
        );
      }
      case "enumValue": {
        const id = e.arguments[0];
        const sym = id !== undefined && ts.isIdentifier(id) ? this.symbolOf(id) : undefined;
        const en = sym !== undefined ? this.enums.get(sym) : undefined;
        const a1 = e.arguments[1];
        if (en === undefined || a1 === undefined)
          return this.err(e, "TSL2003", "enumValue takes an enum and a value");
        const x = this.expr(a1, T.i32);
        const v = x.ty.k === "lit-num" ? this.coerce(x, T.i32, a1) : x;
        if (v.ty.k === "big" || v.ty.k === "float")
          return this.err(a1, "TSL2003", "enumValue takes an integer");
        return mk(
          { k: "opt", of: en },
          { k: "builtin", name: "enumValue", args: [v], loc, info: { of: en } },
        );
      }
      case "arenaOver": {
        const b = e.arguments[0];
        if (b === undefined) return mk(T.unk, { k: "err" });
        const arr = this.expr(b);
        if (arr.ty.k !== "arr" && arr.ty.k !== "unk")
          return this.err(b, "TSL2003", "arenaOver takes a Uint8Array");
        return this.at(
          mk({ k: "arena" }, { k: "builtin", name: "arena.new", args: [arr], loc }),
          e,
        );
      }
      case "lit": {
        // A literal's bytes are static data wherever it's written, one copy per text (SPEC 3.6).
        const arg = e.arguments[0];
        if (arg === undefined || !ts.isStringLiteralLike(arg)) {
          return this.err(e, "TSL9001", "lit takes a string literal");
        }
        let def = this.litGlobals.get(arg.text);
        if (def === undefined) {
          const bytes = Uint8Array.from(Buffer.from(arg.text, "utf8"));
          const name = `__lit${this.litGlobals.size}`;
          def = {
            name,
            jsName: name,
            ty: { k: "arr", elem: "u8" },
            mutable: false,
            array: { elem: "u8", length: bytes.length, bytes, text: arg.text },
          };
          this.litGlobals.set(arg.text, def);
          this.globals.push(def);
        }
        return mk(def.ty, { k: "global", g: def });
      }
      default: {
        if (LAYOUT_HELPERS.has(name)) {
          return this.err(e, "TSL1015", `${name}() declares a layout field: it isn't a value`);
        }
        return super.coreCall(e, name, expected);
      }
    }
  }

  /** The object literal given to make() and set(): scalar fields, in the written order. */
  initFields(c: ClassInst, lit: ts.Expression | undefined): { f: ClsField; val: TE }[] {
    if (lit === undefined) return [];
    if (!ts.isObjectLiteralExpression(lit)) {
      this.err(lit, "TSL1005", "this takes an object literal of scalar fields");
      return [];
    }
    const out: { f: ClsField; val: TE }[] = [];
    for (const p of lit.properties) {
      let init: ts.Expression;
      if (ts.isPropertyAssignment(p)) init = p.initializer;
      else if (ts.isShorthandPropertyAssignment(p)) init = p.name;
      else {
        this.err(p, "TSL1005", "this takes plain named fields");
        continue;
      }
      const name = p.name.getText(this.sf);
      const f = c.fields.find((x) => x.name === name);
      if (f === undefined || f.store !== "value") {
        this.err(p, "TSL1015", `${name} is not a scalar field of ${c.name}`);
        continue;
      }
      out.push({ f, val: this.coerce(this.expr(init, f.ty), f.ty, init) });
    }
    return out;
  }

  /** A key's hash, chosen by its type here, where generics are already concrete (SPEC 3.5, D43). */
  keyHashOf(k: TE, e: ts.CallExpression): TE {
    const loc = this.loc(e);
    const t = k.ty;
    if (t.k === "unk") return mk(T.u32, { k: "err" });
    if (t.k === "cls" && t.c.iface !== undefined) {
      const d = this.keyDispatch(k, "hashKey", [], e);
      if (d !== null) return d;
      return mk(T.u32, { k: "builtin", name: "key.bits64", args: [k], loc });
    }
    if (t.k === "cls") {
      const m = this.keyMethod(t.c, "hashKey", e);
      if (m === "bad") return mk(T.u32, { k: "err" });
      if (m !== null) {
        return this.at(
          mk(T.u32, {
            k: "call",
            inst: this.methodInst(t.c, m, [], e),
            args: [this.receiver(k, e)],
            argAts: [loc],
          }),
          e,
        );
      }
      return mk(T.u32, { k: "builtin", name: "key.bits64", args: [k], loc });
    }
    if (t.k === "big" || (t.k === "int" && t.name === "usize"))
      return mk(T.u32, { k: "builtin", name: "key.bits64", args: [k], loc });
    if (t.k === "int") return mk(T.u32, { k: "builtin", name: "wrapU32", args: [k], loc });
    return this.keyErr(
      `a key is an integer or a class, not ${tyName(t)}: a float has two zeros and a NaN that isn't itself, so a table of them would need its own rules`,
    );
  }

  /** A wrong key type is the program's mistake, so it's reported at the program's `new`, once, not inside the library. */
  keyErr(msg: string): TE {
    let c = this.curInst?.owner;
    for (let g = 0; g < 16 && c?.firstIn !== undefined; g++) c = c.firstIn;
    const at = c?.firstAt as ts.Node | undefined;
    if (at !== undefined && this.sink.muted === 0 && !this.keyErrors.has(at)) {
      this.keyErrors.add(at);
      this.withSf(at.getSourceFile(), () => this.err(at, "TSL2003", msg));
    }
    return mk(T.unk, { k: "err" });
  }

  keySameOf(a: TE, b: TE, e: ts.CallExpression): TE {
    const t = a.ty;
    if (t.k === "unk" || b.ty.k === "unk") return mk(T.bool, { k: "err" });
    if (t.k === "cls" && t.c.iface !== undefined) {
      const d = this.keyDispatch(a, "sameKey", [b], e);
      if (d !== null) return d;
    } else if (t.k === "cls") {
      const m = this.keyMethod(t.c, "sameKey", e);
      if (m === "bad") return mk(T.bool, { k: "err" });
      if (m !== null) {
        return this.at(
          mk(T.bool, {
            k: "call",
            inst: this.methodInst(t.c, m, [], e),
            args: [this.receiver(a, e), b],
            argAts: [this.loc(e), this.loc(e)],
          }),
          e,
        );
      }
    } else if (t.k !== "int" && t.k !== "big") {
      return this.keyErr(`a key is an integer or a class, not ${tyName(t)}`);
    }
    return this.at(mk(T.bool, { k: "cmp", op: "eq", a, b }), e);
  }

  /** A class's `hashKey` or `sameKey`, if it has one: the two go together, or a table would disagree with itself. */
  keyMethod(c: ClassInst, name: "hashKey" | "sameKey", _e: ts.Node): FnLike | "bad" | null {
    const m = this.findMember(c, name);
    const other = this.findMember(c, name === "hashKey" ? "sameKey" : "hashKey");
    if (m === null && other === null) return null;
    if (m === null || !ts.isMethodDeclaration(m) || other === null) {
      this.keyErr(`${c.name} as a key needs both hashKey and sameKey, as methods`);
      return "bad";
    }
    return m;
  }

  /**
   * `keyHash` or `keySame` on a dispatch interface (D70, D72): the key's own `hashKey` or `sameKey` through the class-id
   * switch, as `k.hashKey()` would be, where the interface has both; null where it has neither, a key by identity then.
   * The receiver and the argument each once into locals, one load of the class id, a compare and a direct call per class,
   * and trap 18 for an id that's no class's. `JsString` is such a key.
   */
  keyDispatch(obj: TE, name: "hashKey" | "sameKey", args: TE[], e: ts.CallExpression): TE | null {
    const ic = (obj.ty as { c: ClassInst }).c;
    const decl = ic.decl as ts.InterfaceDeclaration;
    const sig = this.ifaceSig(decl, name);
    const other = this.ifaceSig(decl, name === "hashKey" ? "sameKey" : "hashKey");
    const ret = name === "hashKey" ? T.u32 : T.bool;
    if (sig === null && other === null) return null;
    const ok = (s: typeof sig, p: number, r: Ty): boolean =>
      s !== null &&
      s.params.length === p &&
      tyKey(s.ret) === tyKey(r) &&
      s.params.every((x) => tyKey(x) === tyKey(obj.ty));
    if (
      sig === null ||
      other === null ||
      !ok(this.ifaceSig(decl, "hashKey"), 0, T.u32) ||
      !ok(this.ifaceSig(decl, "sameKey"), 1, T.bool)
    ) {
      this.keyErr(
        `${ic.name} as a key needs both hashKey(): u32 and sameKey(b: ${ic.name}): bool, as methods`,
      );
      return mk(ret, { k: "err" });
    }
    if (args.some((x) => x.ty.k !== "cls" || x.ty.c !== ic)) {
      this.keyErr(`both keys compared by ${ic.name}'s sameKey are ${ic.name}s`);
      return mk(ret, { k: "err" });
    }
    if (this.dry) return mk(ret, { k: "err" });
    const { set, ids } = ic.iface!;
    const loc = this.loc(e);
    const held = this.newHidden(obj.ty);
    const items: TE[] = [mk(obj.ty, { k: "setvar", v: held, val: obj })];
    const argVars = args.map((x) => {
      const v = this.newHidden(x.ty);
      items.push(mk(x.ty, { k: "setvar", v, val: x }));
      return v;
    });
    const tag = this.newHidden(T.u32);
    items.push(
      mk(T.u32, {
        k: "setvar",
        v: tag,
        val: mk(T.u32, {
          k: "ofield",
          obj: mk(obj.ty, { k: "var", v: held }),
          c: ic,
          f: ic.fields[0]!,
          check: true,
          loc,
        }),
      }),
    );
    let out: TE = mk(T.never, { k: "trapnow", kind: "dispatch", code: 18, loc });
    for (let i = set.length - 1; i >= 0; i--) {
      const c = this.layoutClass(set[i]!, e);
      const m = this.findMember(c, name) as ts.MethodDeclaration;
      const call = this.at(
        mk(ret, {
          k: "call",
          inst: this.methodInst(c, m, [], e),
          args: [
            this.receiver(mk({ k: "cls", c }, { k: "var", v: held }), e),
            ...argVars.map((v) => mk(v.ty, { k: "var", v })),
          ],
          argAts: [loc, ...argVars.map(() => loc)],
        }),
        e,
      );
      const test = mk(T.bool, {
        k: "cmp",
        op: "eq",
        a: mk(T.u32, { k: "var", v: tag }),
        b: mk(T.u32, { k: "lit", value: ids[i]! }),
      });
      out = mk(ret, { k: "cond", c: test, a: call, b: out });
    }
    return mk(ret, { k: "seq", items, result: out });
  }

  // --- @tsl/unsafe (SPEC Appendix A): each of these is a real memory operation natively

  unsafeCall(e: ts.CallExpression, name: string, expected?: Ty): TE {
    const loc = this.loc(e);
    const a = e.arguments;
    const u64Arg = (i: number): TE => this.coerce(this.expr(a[i]!, T.u64), T.u64, a[i]!);
    const usizeArg = (i: number): TE => this.coerce(this.expr(a[i]!, T.usize), T.usize, a[i]!);
    const elemTyArg = (): Ty => {
      const n = e.typeArguments?.[0];
      if (n !== undefined) return this.typeOf(n);
      if (expected?.k === "elem") return expected.of;
      return T.unk;
    };
    switch (name) {
      case "ref": {
        const of = elemTyArg();
        // A stored reference: an object's, or a function value's (a code pointer). A scalar is its own element.
        if (of.k !== "cls" && of.k !== "fn" && of.k !== "ptr" && of.k !== "ref" && of.k !== "unk") {
          return this.err(
            e,
            "TSL2003",
            `ref takes a class or a function type: ${tyName(of)} is its own element`,
          );
        }
        return mk({ k: "elem", of, elem: this.elemInfo(of, "ref") }, { k: "tuple", items: [] });
      }
      case "inlineOf": {
        const of = elemTyArg();
        if (of.k !== "cls") {
          if (of.k === "unk") return mk(T.unk, { k: "err" });
          return this.err(e, "TSL2003", "inlineOf takes a class");
        }
        return mk({ k: "elem", of, elem: this.elemInfo(of, "inline") }, { k: "tuple", items: [] });
      }
      case "elemSize": {
        const d = this.ptrElemOf(a[0], e);
        if (d === null) return mk(T.usize, { k: "err" });
        // the injected `arena-elem-size` bug (R13): the arena array's element size taken as half what it is, so its
        // buffers, and the bytes it copies and clears, are half as many as its elements take
        if (
          process.env.TMK_TEST_TSL === "arena-elem-size" &&
          this.curInst?.owner?.name === "JsArenaArray" &&
          d.elem.size > 1
        )
          return mk(T.usize, { k: "lit", value: d.elem.size / 2 });
        return mk(T.usize, { k: "lit", value: d.elem.size });
      }
      case "ptrAt": {
        const d = this.ptrElemOf(a[0], e);
        const addr = u64Arg(1);
        if (d === null) return mk(T.unk, { k: "err" });
        return mk({ k: "ptr", of: d.of, elem: d.elem }, { k: "conv", val: addr });
      }
      case "sliceOf": {
        const d = this.ptrElemOf(a[0], e);
        const addr = u64Arg(1);
        const n = usizeArg(2);
        if (d === null) return mk(T.unk, { k: "err" });
        const of = d.of;
        if (of.k !== "int" && of.k !== "big" && of.k !== "float") {
          if (of.k === "unk") return mk(T.unk, { k: "err" });
          return this.err(a[0]!, "TSL2003", "a slice holds scalars");
        }
        return mk(
          { k: "arr", elem: of.name },
          { k: "builtin", name: "unsafe.slice", args: [addr, n], loc },
        );
      }
      case "bytesAt":
        return mk(
          { k: "arr", elem: "u8" },
          { k: "builtin", name: "unsafe.slice", args: [u64Arg(0), usizeArg(1)], loc },
        );
      case "copyBytes":
        return mk(T.void, {
          k: "builtin",
          name: "unsafe.copy",
          args: [u64Arg(0), u64Arg(1), usizeArg(2)],
          loc,
        });
      case "viewAt": {
        const c = this.classArg(a[0], e, true);
        const addr = u64Arg(1);
        if (c === null) return mk(T.unk, { k: "err" });
        return this.at(
          mk(
            { k: "cls", c },
            { k: "builtin", name: "unsafe.viewAt", args: [addr], loc, info: { c } },
          ),
          e,
        );
      }
      case "staticView":
        return this.err(e, "TSL1010", "staticView is top-level static storage");
      case "addrOf": {
        const o = this.expr(a[0]!);
        if (o.ty.k === "unk") return mk(T.u64, { k: "err" });
        const layout = o.ty.k === "cls" && this.layoutClass(o.ty.c, e).layout;
        if (!layout) {
          return this.err(
            a[0]!,
            "TSL5005",
            "addrOf takes a layout-class object in host-visible memory, from viewAt or staticView",
          );
        }
        return this.at(mk(T.u64, { k: "builtin", name: "unsafe.addrOf", args: [o], loc }), a[0]!);
      }
      case "placeObject": {
        const slot = u64Arg(0);
        const g = this.coerce(this.expr(a[1]!, T.u32), T.u32, a[1]!);
        const item = this.expr(a[2]!, expected);
        if (item.ty.k === "unk") return mk(T.unk, { k: "err" });
        if (item.ty.k !== "cls") return this.err(a[2]!, "TSL2003", "placeObject takes an object");
        const c = this.layoutClass(item.ty.c, e);
        // A library's moved parameter: the caller's `new` is what's wrong, and escape.ts says so there (TSL3011).
        const moved =
          item.k === "var" && this.curInst !== null ? this.curInst.params.indexOf(item.v) : -1;
        const generic = (this.curInst?.owner?.tyArgs.length ?? 0) > 0;
        if (
          c.tail !== undefined &&
          generic &&
          moved >= 0 &&
          this.curInst?.moves?.includes(moved) === true
        )
          return mk(T.unk, { k: "err" });
        if (c.tail !== undefined)
          return this.err(
            a[2]!,
            "TSL3011",
            `${c.name} has a tail, so it's held by reference only: placeObject copies by its fixed size (placeTail sizes it)`,
          );
        return this.at(
          mk(item.ty, {
            k: "builtin",
            name: "unsafe.place",
            args: [slot, g, item],
            loc,
            info: { c },
          }),
          e,
        );
      }
      case "placeTail": {
        // placeTail(slot, gen, n, item[, keep]): placeObject for a class with a tail (D69). The moved object's fixed part
        // goes in the slot, its tail of n elements after it is zeroed, and the slot must hold objectBytes of the result.
        // `keep` (R4): the tail's first keep elements aren't zeroed, as the caller writes them before anything reads them.
        const slot = u64Arg(0);
        const g = this.coerce(this.expr(a[1]!, T.u32), T.u32, a[1]!);
        const n = usizeArg(2);
        const item = this.expr(a[3]!, expected);
        const keep = a.length > 4 ? usizeArg(4) : null;
        if (item.ty.k === "unk") return mk(T.unk, { k: "err" });
        if (item.ty.k !== "cls") return this.err(a[3]!, "TSL2003", "placeTail takes an object");
        const c = this.layoutClass(item.ty.c, e);
        if (c.tail === undefined)
          return this.err(a[3]!, "TSL3012", `${c.name} has no tail: use placeObject`);
        return this.at(
          mk(item.ty, {
            k: "builtin",
            name: "unsafe.placeTail",
            args: keep === null ? [slot, g, n, item] : [slot, g, n, item, keep],
            loc,
            info: { c },
          }),
          e,
        );
      }
      case "tailBytes": {
        // tailBytes(inlineOf<T>(), n): the bytes an object of T with a tail of n elements takes (D69).
        const d = this.ptrElemOf(a[0], e);
        const n = usizeArg(1);
        if (d === null) return mk(T.usize, { k: "err" });
        if (d.of.k !== "cls" || d.of.c.tail === undefined)
          return this.err(
            a[0]!,
            "TSL3012",
            "tailBytes takes the descriptor of a class with a tail",
          );
        return mk(T.usize, {
          k: "builtin",
          name: "unsafe.tailBytes",
          args: [n],
          loc,
          info: { c: d.of.c },
        });
      }
      case "objectBytes":
      case "tailAddr": {
        // objectBytes(o): the bytes o takes, its tail's included. tailAddr(o): where its tail's element 0 is (D69).
        const o = this.expr(a[0]!);
        if (o.ty.k === "unk") return mk(T.unk, { k: "err" });
        if (o.ty.k !== "cls") return this.err(a[0]!, "TSL2003", `${name} takes an object`);
        const c = this.layoutClass(o.ty.c, e);
        if (name === "tailAddr" && c.tail === undefined)
          return this.err(a[0]!, "TSL3012", `${c.name} has no tail`);
        const ty = name === "tailAddr" ? T.u64 : T.usize;
        return this.at(
          mk(ty, {
            k: "builtin",
            name: `unsafe.${name}`,
            args: [this.receiver(o, e)],
            loc,
            info: { c },
          }),
          a[0]!,
        );
      }
      case "objectAt": {
        const of =
          e.typeArguments?.[0] !== undefined
            ? this.typeOf(e.typeArguments[0])
            : (expected ?? T.unk);
        const slot = u64Arg(0);
        if (of.k !== "cls") {
          if (of.k === "unk") return mk(T.unk, { k: "err" });
          return this.err(e, "TSL2003", "objectAt gives an object");
        }
        return this.at(mk(of, { k: "builtin", name: "unsafe.objectAt", args: [slot], loc }), e);
      }
      case "slotOf":
      case "slotOfLive":
      case "genOf": {
        const o = this.expr(a[0]!);
        const ty = name === "genOf" ? T.u32 : T.u64;
        return mk(ty, { k: "builtin", name: `unsafe.${name}`, args: [o], loc });
      }
      case "unsafeFree": {
        const o = this.expr(a[0]!);
        if (o.ty.k === "unk") return mk(T.void, { k: "err" });
        if (packageMemory(e.getSourceFile().fileName) !== "manual") {
          return this.err(e, "TSL5007", 'unsafeFree is only for a package with "memory": "manual"');
        }
        if (o.ty.k !== "cls") return this.err(a[0]!, "TSL2003", "unsafeFree takes an object");
        const c = this.layoutClass(o.ty.c, e);
        return this.at(
          mk(T.void, { k: "builtin", name: "unsafe.free", args: [o], loc, info: { c } }),
          a[0]!,
        );
      }
      case "setPageSource": {
        const f = this.expr(a[0]!);
        if (f.ty.k === "unk") return mk(T.void, { k: "err" });
        if (f.k !== "fnref") {
          return this.err(
            a[0]!,
            "TSL5009",
            "setPageSource takes a top-level function by name: it's called with no environment, whenever memory runs out",
          );
        }
        return this.at(
          mk(T.void, { k: "builtin", name: "unsafe.setPageSource", args: [f], loc }),
          a[0]!,
        );
      }
      case "cycleGroup":
      case "cycleGroupOf": {
        // A constant for each class (3.5, D41, R1c): its component in the type graph, 0 if it can't be in a cycle or the
        // collector is off. cycleGroupOf's argument is for the host, which can't see T: natively it isn't evaluated.
        const of = elemTyArg();
        const g =
          of.k === "cls"
            ? cycleGroupOf(this.program, this.root.fileName, of.c.decl as ts.ClassDeclaration)
            : 0;
        return mk(T.u32, { k: "lit", value: g });
      }
      case "cyclesLinked":
        // Whether some counted class can be in a cycle: with none, the collector's code is never reached (3.5, D41).
        return mk(T.bool, {
          k: "lit",
          value: cycleGraph(this.program, this.root.fileName).counted,
        });
      case "countedExactly": {
        // A constant for each class (3.5, D74): whether the rc expansion places every count of its objects.
        const of = elemTyArg();
        return mk(T.bool, { k: "lit", value: of.k === "cls" && isCountedExactly(of.c.decl) });
      }
      case "releaseIndex": {
        // A release function's number in the program's closed set (R1d): its code address compared with each one's.
        const f = this.expr(a[0]!);
        if (f.ty.k === "unk") return mk(T.u32, { k: "err" });
        if (this.dry) return mk(T.u32, { k: "err" });
        return mk(T.u32, {
          k: "builtin",
          name: "unsafe.releaseIndex",
          args: [f],
          loc,
          info: { fns: this.releaseInsts(e) },
        });
      }
      case "releaseIsEmpty": {
        // R17: whether a release function is one of the closed set whose body is `return 0;` and nothing else (a class with
        // no slots of its own, as tslc's expansion writes a leaf's, a weak reference's or a room's): calling it does
        // nothing and gives 0, so freeing may take that step without the call. Its code address compared with each such
        // function's, as releaseIndex compares it with all of them; false for any other, which is always safe.
        const f = this.expr(a[0]!);
        if (f.ty.k === "unk") return mk(T.bool, { k: "err" });
        if (this.dry) return mk(T.bool, { k: "err" });
        const fns = this.releaseFns.filter(isEmptyRelease).map((d) => this.instance(d, [], e));
        const idx = mk(T.u32, {
          k: "builtin",
          name: "unsafe.releaseIndex",
          args: [f],
          loc,
          info: { fns },
        });
        return mk(T.bool, { k: "cmp", op: "ne", a: idx, b: mk(T.u32, { k: "lit", value: 0 }) });
      }
      case "callRelease": {
        // Closed-world dispatch (D70's form, R1d): the number compared with each release function's in turn, each arm a
        // direct call, and trap 18 for a number that's none of them, which only memory written unsafely can give.
        const idx = this.coerce(this.expr(a[0]!, T.u32), T.u32, a[0]!);
        const item = this.expr(a[1]!);
        const at = usizeArg(2);
        const op = this.expr(a[3]!);
        if (this.dry || item.ty.k === "unk" || op.ty.k === "unk") return mk(T.usize, { k: "err" });
        const fns = this.releaseInsts(e);
        const vi = this.newHidden(T.u32);
        const vo = this.newHidden(item.ty);
        const va = this.newHidden(T.usize);
        const vp = this.newHidden(op.ty);
        const items: TE[] = [
          mk(T.u32, { k: "setvar", v: vi, val: idx }),
          mk(item.ty, { k: "setvar", v: vo, val: item }),
          mk(T.usize, { k: "setvar", v: va, val: at }),
          mk(op.ty, { k: "setvar", v: vp, val: op }),
        ];
        // `tmk milestone pipe-d`'s injected bug: each number calls the next function's release. Never set otherwise.
        const wrong = process.env.TMK_TEST_TSL === "release-wrong-arm" && fns.length > 1;
        let out: TE = mk(T.never, { k: "trapnow", kind: "dispatch", code: 18, loc });
        for (let i = fns.length - 1; i >= 0; i--) {
          const g = fns[wrong ? (i + 1) % fns.length : i]!;
          const p0 = g.params[0]!.ty;
          const call = this.at(
            mk(T.usize, {
              k: "call",
              inst: g,
              args: [
                mk(p0, { k: "var", v: vo }),
                mk(T.usize, { k: "var", v: va }),
                mk(g.params[2]!.ty, { k: "var", v: vp }),
              ],
              argAts: [loc, loc, loc],
            }),
            e,
          );
          const test = mk(T.bool, {
            k: "cmp",
            op: "eq",
            a: mk(T.u32, { k: "var", v: vi }),
            b: mk(T.u32, { k: "lit", value: i + 1 }),
          });
          out = mk(T.usize, { k: "cond", c: test, a: call, b: out });
        }
        return mk(T.usize, { k: "seq", items, result: out });
      }
      case "retireObject": {
        // R17: natively retiring is nothing, and an `objectAt(slot)` given to it straight is only a read of the slot's
        // generation, so it isn't evaluated either (`@tsl/gc`'s giveBack): that read would otherwise be kept, as a load
        // -O0 ran (keep.ts), where nothing uses it. Anything else is evaluated for what it does, as before.
        let x = a[0]!;
        while (ts.isParenthesizedExpression(x)) x = x.expression;
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
          const sym = this.symbolOf(x.expression);
          if (sym !== undefined && this.isUnsafeSymbol(sym) && sym.name === "objectAt")
            return mk(T.void, { k: "tuple", items: [] });
        }
        return mk(T.void, {
          k: "seq",
          items: [this.expr(a[0]!)],
          result: mk(T.void, { k: "tuple", items: [] }),
        });
      }
      case "pageRunFreed": {
        // No code at all, arguments included, in a program with no @tsl/std: this is how Heap stays byte-identical there.
        const hook = this.runFreedHook;
        if (hook === null) return mk(T.void, { k: "tuple", items: [] });
        return this.at(
          mk(T.void, {
            k: "call",
            inst: this.instance(hook, [], e),
            args: [u64Arg(0), usizeArg(1)],
            argAts: [loc, loc],
          }),
          e,
        );
      }
      case "sourcePages":
        return mk(T.u64, { k: "builtin", name: "unsafe.sourcePages", args: [usizeArg(0)], loc });
      // R6: the per-call region, where tslc places what no export call outlives (region.ts, lower-native.ts).
      case "inCallRegion": {
        const o = this.expr(a[0]!);
        if (o.ty.k === "unk") return mk(T.unk, { k: "err" });
        if (o.ty.k !== "cls") return this.err(a[0]!, "TSL2003", "inCallRegion takes an object");
        return mk(T.bool, {
          k: "builtin",
          name: "unsafe.inCallRegion",
          args: [this.receiver(o, e)],
          loc,
        });
      }
      case "addrInCallRegion":
        return mk(T.bool, {
          k: "builtin",
          name: "unsafe.addrInCallRegion",
          args: [u64Arg(0)],
          loc,
        });
      case "callRegionBytes":
        return mk(T.u64, {
          k: "builtin",
          name: "unsafe.callRegionBytes",
          args: [usizeArg(0)],
          loc,
        });
      case "checkLive": {
        const x = this.expr(a[0]!);
        const items = x.ty.k === "cls" ? [this.receiver(x, e)] : [x];
        return mk(T.void, { k: "seq", items, result: mk(T.void, { k: "tuple", items: [] }) });
      }
      case "keyHash":
        return this.keyHashOf(this.expr(a[0]!), e);
      case "keySame":
        return this.keySameOf(this.expr(a[0]!), this.expr(a[1]!), e);
      default:
        return this.err(
          e,
          "TSL9001",
          `${name} is not in this phase's scope (MMIO, fnAddr and asmFn only typecheck)`,
        );
    }
  }
}

/**
 * R17: a release function whose body is `return 0;` alone, its parameters with no initialisers: calling it has no effect
 * and gives 0, whatever it's given (`releaseIsEmpty`).
 */
function isEmptyRelease(d: ts.FunctionDeclaration): boolean {
  // the injected `release-empty-all` bug (R17): every release function taken as doing nothing, so freeing gives an object
  // with slots back without visiting them, and what it held is never dropped
  if (process.env.TMK_TEST_TSL === "release-empty-all") return true;
  const body = d.body;
  if (body === undefined || body.statements.length !== 1) return false;
  if (d.parameters.some((p) => p.initializer !== undefined)) return false;
  const st = body.statements[0]!;
  if (!ts.isReturnStatement(st) || st.expression === undefined) return false;
  let x = st.expression;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return ts.isNumericLiteral(x) && Number(x.text) === 0;
}
