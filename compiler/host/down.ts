// Down-lowering (SPEC 4.5): strict ordinary TS to the same typed tree TSL elaborates to, so TIR and
// every backend are shared. The pass walks each reachable function using the TS checker's types,
// and records evidence about every `number` location and heap object as it goes. Evidence only rises,
// so repeated walks reach a fixed point, and the last walk's tree is consistent with its conclusions.
// A construct it can't express throws Blocked, and that function stays JS, with the root cause.
import ts from "typescript";
import {
  BLOCKERS,
  Blocked,
  findLoc,
  findNode,
  I32_MAX,
  I32_MIN,
  joinLoc,
  allocBytes,
  layoutOf,
  optValueOff,
  liveNodes,
  locTy,
  memOf,
  newLoc,
  newNode,
  resetNodeIds,
  sizeOf,
  tyOf,
  U32_MAX,
  unifyLocs,
  type Fact,
  type HeapNode,
  type NumLoc,
  type Nul,
  type Shape,
} from "./down-model.ts";
import { applyRc, countedOf, cycleClasses, type RcOptions, type RcStats } from "./down-rc.ts";
import { applyExc, usesExceptions, type ExcOptions, type ExcStats } from "./down-exc.ts";
import {
  memoryRtFuncs,
  hashRtFuncs,
  memoryRtGlobals,
  RC_CYCLES_DEFAULT,
  strRtFuncs,
  RC_TRAPS,
  rcRtFuncs,
  rcRtGlobals,
  rtFuncs,
  RT_TRAPS,
  rtGlobals,
  TRAP_ARGS_SLOTS,
  VEC_CAP,
  VEC_DATA,
  VEC_LEN,
  excRtFuncs,
  excRtGlobals,
} from "./down-rt.ts";
import { packElems } from "./elab.ts";
import { repoRelative, rtFilePath } from "./program.ts";
import {
  ELEM_BY_ARRAY,
  elemSize,
  T,
  type ElemName,
  type FuncInst,
  type GlobalDef,
  type Stmt,
  type StrLayout,
  type RcStrLayout,
  type TE,
  type TEK,
  type Ty,
  type TypedModule,
  type Var,
} from "./types.ts";
import type { Extern, Global } from "../tir/ir.ts";

export type FnLike =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

type Env = Map<number, ts.Type>;

class Scope {
  parent: Scope | null;
  map = new Map<ts.Symbol, Binding>();
  constructor(parent: Scope | null) {
    this.parent = parent;
  }
  get(sym: ts.Symbol): Binding | undefined {
    const b = this.map.get(sym);
    return b !== undefined || this.parent === null ? b : this.parent.get(sym);
  }
}

interface Target {
  decl: FnLike;
  scope: Scope;
  env: Env;
  key: string;
  round: number;
  dyn?: { v: Var; sh: Shape }; // memory modes: a closure value, known only at run time
}

export type MemoryMode = "strict" | "leak" | "manual" | "rc";

/** What a lifted closure's environment holds, after its code pointer (SPEC 4.5). */
type Capture =
  | { c: "value"; sym: ts.Symbol; off: number; sh: Shape; dyn: boolean }
  | { c: "box"; sym: ts.Symbol; off: number; node: HeapNode; sh: Shape }
  | { c: "this"; off: number; sh: Shape }
  | { c: "same"; sym: ts.Symbol; b: Binding }
  | { c: "closure"; sym: ts.Symbol; targets: Target[] };

/** The key of a closure's capture at `off` in its environment, as class printing's environment class names it (R3). */
function envKey(fi: FuncInst, off: number): string {
  return `@env:${fi.tirName}:${off}`;
}

type Binding =
  | { b: "var"; v: Var; sh: Shape; konst?: TE }
  | { b: "closure"; targets: Target[]; tag: Var | null }
  | { b: "box"; v: Var; node: HeapNode; sh: Shape } // memory modes: lives in a cell closures share
  | { b: "sroa"; fields: Map<string, { v: Var; sh: Shape }> };

interface Frame {
  path: string;
  retSh: Shape | null; // null: never returns a value
  retLabel: string | null; // inline: where `return` goes
  retVar: Var | null;
  stack: FnLike[];
}

export interface Inst {
  key: string;
  decl: FnLike | ts.ClassLikeDeclaration | ts.SourceFile;
  owner: ts.Node; // what a fallback is recorded against
  env: Env;
  lits: Map<number, number>;
  fi: FuncInst;
  paramSh: Shape[];
  retSh: Shape;
  thisSh: Shape | null;
  exported: boolean;
  lifted: {
    captured: ts.Symbol[];
    target: Target;
    boxes?: Map<ts.Symbol, { node: HeapNode; sh: Shape }>;
    konsts?: [ts.Symbol, Binding][];
  } | null;
  run: boolean; // reachable after module init, from an export
  clo?: { target: Target; node: HeapNode; caps: Capture[]; size: number };
}

export interface FallbackInfo {
  blocker: string;
  detail: string;
  line: number;
  col: number;
  file: string;
  root?: string;
  blockedCallers: string[];
}

interface GlobalEntry {
  name: string;
  sh: Shape;
  dynamicBlocked: boolean;
  konst?: TE;
  arrayDef?: GlobalDef;
  isConst: boolean;
}

export interface AllocSite {
  fn: string;
  loc: string;
  what: string;
  stack: () => number | null;
  long?: () => boolean;
  node?: HeapNode;
}

export type Desc =
  | { k: "num"; rep: "i32" | "u32" | "f64" }
  | { k: "bool" }
  | { k: "str" }
  | { k: "void" }
  | { k: "arr"; elem: ElemName; nul?: Nul; written?: boolean; long?: boolean }
  | { k: "fn"; nul?: Nul }
  | { k: "opt"; of: Desc; nul: Nul; off: number }
  | { k: "string"; nul?: Nul } // a run-time string, by pointer (SPEC 4.5, D36)
  | { k: "ref"; id: number; nul?: Nul };

export interface ObjDesc {
  k: "obj";
  size: number;
  written: boolean;
  long?: boolean;
  rcDesc?: number; // `rc`: what a caller placing one of these gives __rc_new
  // R8: in `rc`, printed through the TSL route, the exports a native caller places one with (no arguments), adds a count
  // with and gives one back with, in place of `__rc_new`, `__rc_retain` and `__rc_release` (4.5's ABI in `rc`)
  place?: string;
  retain?: string;
  release?: string;
  tuple?: number; // a tuple with no single element representation: a JS array of this length
  // A `Map` or `Set`: which exports build one and read one, and what it holds. Its layout is the runtime's own, so `fields` is
  // empty, and only `internal`, for the test harness's reader of a memory dump, says where they are (SPEC 4.5, D36, D47).
  map?: { kind: "map" | "set"; keyDesc: Desc; valDesc: Desc } & MapSurface;
  fields: { name: string; off: number; ty: Desc; optional: boolean }[];
  internal?: { name: string; off: number; ty: Desc; optional: boolean }[];
  variants: { tag: string; value: string | number | boolean; fields: string[] }[];
}
/**
 * The exports a native caller has for one `Map` or `Set` type (SPEC 4.5, D36, D47): `make()` and `put(m, k, v)` (`put(m, k)` for a
 * `Set`) where one can be passed in, and `size(m)`, `has(m, k)`, `iter(m)` for a cursor, `step(m, c)` to move it on, and
 * `key(m, c)` and `val(m, c)` where it stopped, where one can cross either way. "" where there's none.
 */
export interface MapSurface {
  make: string;
  put: string;
  size: string;
  has: string;
  iter: string;
  step: string;
  key: string;
  val: string;
}

export interface VecDesc {
  k: "vec";
  slot: number;
  elem: Desc;
  written: boolean;
  long?: boolean;
  rcDesc?: number; // `rc`: what a caller placing one of these gives __vec_new_rc
  holes: boolean;
  // Printed through the TSL route (R5): the export that places one, `__vec_place_<id>(length)`, in place of `__vec_new*`.
  // The header it gives has D36's layout: the buffer's address at p + 0, the length at p + 8.
  place?: string;
  // R8: in `rc`, through the TSL route, the exports that add a count to one and give one back (4.5's ABI in `rc`)
  retain?: string;
  release?: string;
}

export interface DownMeta {
  exports: Record<string, { params: Desc[]; ret: Desc; fallback?: boolean }>;
  shims: Record<string, { js: string; params: Desc[]; ret: Desc }>;
  heap: Record<string, ObjDesc | VecDesc>;
  strings: Record<string, number>;
  traps: Record<string, string>;
  fallbackFile: string | null;
  fallbackNames: string[];
  memory?: "leak" | "manual" | "rc"; // absent for strict, which is the JS glue's whole world
  // Exceptions (D36, D49): the function that describes a thrown value, and the trap code an uncaught one reports.
  exc?: { describe: string; uncaught: number; release?: string };
  // Strings printed as @tsl/jsrt's JsString (D67): a string is a JsFlat or a JsView (D70), laid out as `strLayout` says
  // (pipe-split), where the direct route's are D36's, its units at p plus the offset at p + 8 (4.5's ABI).
  strAbs?: boolean;
  strLayout?: StrLayout;
  // Printed through the TSL route (R5): each class crossing an export by its heap id, as the printed TSL names it, D36's
  // size, and each field's TSL name at its D36 offset, which tslc checked are where TSL lays them out. A native caller
  // needs none of it (the offsets are `heap`'s); a host caller of the printed TSL makes and reads the classes by it.
  // R7: each Map or Set crossing an export through the TSL route, by heap id (a JsMap, or a JsSet holding one in place), and
  // where JsMap keeps what a reader of its memory needs
  // R8: in `rc`, printed through the TSL route: the exports for what the direct route's `__rc_collect` does and for its live
  // objects and freeing steps (each heap entry names its own place, retain and release)
  rcTsl?: { collect: string; live: string; steps: string };
  // R10: in `rc` through the TSL route, a string is the program's own JsStr: where its parts are (types.ts's RcStrLayout),
  // and the module's pair a native caller counts one with, as an object's (R8): a placed string and a result are each one
  // count of the caller's, given back by `release`; `retain` adds one
  rcStr?: { layout: RcStrLayout; retain: string; release: string };
  tslMaps?: {
    kinds: Record<string, "map" | "set">;
    layout: { fields: Record<string, number>; setMap: number };
  };
  tslClasses?: Record<
    string,
    {
      name: string;
      size: number;
      // R7: an optional scalar's entry is its flag, at D36's offset, and `value` its value field
      fields: Record<
        string,
        { name: string; off: number; value?: { name: string; off: number }; arr?: true }
      >;
    }
  >;
}

// A literal is a block in static data with a count that can't reach zero, so counting it needs no test (SPEC 3.5).
const RC_HDR = 16;
const STATIC_COUNT = 0x40000000;
const STR_FLAT_HDR = 16;
const STR_CHAR_SIZE = 48;
const HASH_KEY_DEFAULT = [0x243f6a88, 0x85a308d3]; // a caller with entropy sets its own (SPEC 4.5)

/** A class in the program's forest of classes (D50). Ids are preorder, so a class and its subclasses are [id, last]. */
interface ClassRec {
  decl: ts.ClassLikeDeclaration;
  jsName: string; // what JS's `constructor.name` gives
  base: ClassRec | null;
  subs: ClassRec[];
  id: number;
  last: number;
  key: string;
}

/** The library's error classes, and the runtime classes that are them (compiler/rt/exc.ts). */
const ERROR_RT: Record<string, string> = {
  Error: "TmkError",
  TypeError: "TmkTypeError",
  RangeError: "TmkRangeError",
  SyntaxError: "TmkSyntaxError",
  ReferenceError: "TmkReferenceError",
  EvalError: "TmkEvalError",
  URIError: "TmkURIError",
  SuppressedError: "TmkSuppressedError",
};
const RT_ERROR_JS: Record<string, string> = Object.fromEntries(
  Object.entries(ERROR_RT).map(([js, rt]) => [rt, js]),
);

function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MAX_ROUNDS = 400;
const MAX_INSTANCES = 128;
const MAX_INLINE_DEPTH = 24;
const THROW_CODE_BASE = 100000;

function range(te: TE): readonly [number, number] {
  if (te.range !== undefined) return te.range;
  if (te.ty.k === "int") {
    switch (te.ty.name) {
      case "u32":
        return [0, U32_MAX];
      case "usize":
        return [0, I32_MAX];
      default:
        return [I32_MIN, I32_MAX];
    }
  }
  return [-Infinity, Infinity];
}

const isF = (te: TE): boolean => te.ty.k === "float";
const isInt = (te: TE): boolean => te.ty.k === "int";
const isU32 = (te: TE): boolean => te.ty.k === "int" && te.ty.name === "u32";
const isNum = (te: TE): boolean => te.ty.k === "int" || te.ty.k === "float";

function litOf(te: TE | null): number | null {
  return te !== null && te.k === "lit" && typeof te.value === "number" ? te.value : null;
}

function retype(te: TE, ty: Ty): TE {
  return { ...te, ty } as TE;
}

function mk(ty: Ty, node: TEK, extra?: Partial<TE>): TE {
  return { ty, ...node, ...extra } as TE;
}

function litNum(v: number): TE {
  if (Number.isInteger(v) && !Object.is(v, -0)) {
    if (v >= I32_MIN && v <= I32_MAX) return mk(T.i32, { k: "lit", value: v }, { range: [v, v] });
    if (v >= 0 && v <= U32_MAX) return mk(T.u32, { k: "lit", value: v }, { range: [v, v] });
  }
  const negz = Object.is(v, -0);
  const r = Number.isNaN(v) ? ([-Infinity, Infinity] as const) : ([v, v] as const);
  return mk(T.f64, { k: "lit", value: v }, { range: r, negz });
}

const lit32 = (v: number): TE => mk(T.i32, { k: "lit", value: v }, { range: [v, v] });
const litBool = (v: boolean): TE => mk(T.bool, { k: "lit", value: v });
const litIx = (v: number): TE => mk(T.usize, { k: "lit", value: v }, { range: [v, v] });
const nullPtr = (): TE => mk({ k: "ref" }, { k: "lit", value: 0 });
const NULLISH: TE = mk({ k: "nullish" }, { k: "tuple", items: [] });
const VOID: TE = mk(T.void, { k: "tuple", items: [] });
const NEVER_TY: Ty = T.never;

function hasFlag(t: ts.Type, f: ts.TypeFlags): boolean {
  return (t.flags & f) !== 0;
}

function strip(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let g = 0; g < 256; g++) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) && !isAnyTypeNode(cur.type)) cur = cur.expression;
    else break;
  }
  return cur;
}

function isAnyTypeNode(n: ts.TypeNode): boolean {
  return n.kind === ts.SyntaxKind.AnyKeyword || n.kind === ts.SyntaxKind.UnknownKeyword;
}

function iadd(a: number, b: number): number {
  const r = a + b;
  return Number.isNaN(r) ? (a === Infinity || b === Infinity ? Infinity : -Infinity) : r;
}

function imul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return a * b;
}

function bitsUpper(hi: number): number {
  // The smallest 2^n - 1 at or above hi, for | and ^ of two non-negative values.
  let m = 1;
  while (m - 1 < hi && m < 2 ** 31) m *= 2;
  return m - 1;
}

const LIB_BLOCKERS: Record<string, [string, string]> = {
  eval: ["reflection", "eval can't be compiled statically"],
  Proxy: ["reflection", "Proxy needs dynamic dispatch"],
  Reflect: ["reflection", "Reflect needs run-time type information"],
  Object: ["reflection", "Object.* needs run-time shapes"],
  JSON: ["string-use", "JSON works on strings and run-time shapes"],
  Map: ["map-set", "Map isn't lowered on the first pass"],
  Set: ["map-set", "Set isn't lowered on the first pass"],
  FinalizationRegistry: ["finalization", "a finalizer needs a callback queue nothing here runs"],
  WeakMap: ["map-set", "WeakMap isn't lowered"],
  WeakSet: ["map-set", "WeakSet isn't lowered"],
  Date: ["date", "Date reads the host's clock and calendar"],
  RegExp: ["regexp", "RegExp isn't lowered"],
  Promise: ["async", "Promise needs a scheduler"],
  Symbol: ["reflection", "Symbol is run-time identity"],
  globalThis: ["reflection", "globalThis is a dynamic object"],
};

const MATH_F1 = new Set([
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "exp",
  "expm1",
  "log",
  "log2",
  "log10",
  "log1p",
  "cbrt",
]);
const MATH_CONST: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};
const NUMBER_CONST: Record<string, number> = {
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  EPSILON: Number.EPSILON,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: Number.NaN,
};

export interface DownResult {
  typed: TypedModule;
  meta: DownMeta;
  fallback: Map<ts.Node, FallbackInfo>;
  insts: Inst[];
  allocs: AllocSite[];
  warnings: { code: string; fn: string; callee: string; loc: string; detail: string }[];
  rounds: number;
  sourceFiles: ts.SourceFile[];
  // Where each piece of the program came from, for printing one TSL module per source module (D65): a module-state
  // global's lowering name to its source file, and each module-init statement to the file whose top level it's from.
  globalFiles: Map<string, ts.SourceFile>;
  initFiles: WeakMap<Stmt, ts.SourceFile>;
  imports: Map<ts.SourceFile, ts.SourceFile[]>;
  sharedTop: Set<string>;
  fnNameOf: (n: ts.Node) => string;
  usedMath: string[];
  rc?: RcStats;
  cycles?: { classes: string[]; sites: string[] }[];
  cycleCollector?: boolean;
  exc?: ExcStats;
  excSource?: ExcSource; // the tree before down-exc.ts, for class printing's own desugaring (D68)
}

/**
 * Each function's fields before and after down-exc.ts (its body, result, name, export and attributes), and what it
 * added: class printing swaps the earlier ones in while it prints, and back (emit-exc.ts, D68).
 */
export interface ExcSource {
  funcs: { f: FuncInst; pre: FuncInst; post: FuncInst }[];
  wrappers: FuncInst[];
  dynSh: unknown;
  describe: FuncInst | null;
  overflow: FuncInst | null;
  uncaughtCode: number;
}

export class DownLower {
  program: ts.Program;
  checker: ts.TypeChecker;
  rootSf: ts.SourceFile;
  files: ts.SourceFile[] = [];
  globalFiles = new Map<string, ts.SourceFile>();
  excSource: ExcSource | null = null;
  initFiles = new WeakMap<Stmt, ts.SourceFile>();
  importsOf = new Map<ts.SourceFile, ts.SourceFile[]>();
  // Top-level names declared in more than one module: each is named for its module, so no name depends on import order.
  sharedTop = new Set<string>();
  strings = new Map<string, number>();
  changed = false;
  round = 0;
  slots = new Map<string, Shape>();
  nodesByType = new Map<string, HeapNode>();
  insts = new Map<string, Inst>();
  queue: Inst[] = [];
  visited = new Set<string>();
  fallback = new Map<ts.Node, FallbackInfo>();
  forced = new Set<string>();
  usedNames = new Map<string, string>();
  instCount = new Map<ts.Node, number>();
  globals = new Map<ts.Symbol, GlobalEntry>();
  globalDefs = new Map<string, GlobalDef>();
  closureSets = new Map<string, Target[]>();
  externs = new Map<string, { ext: Extern; meta: DownMeta["shims"][string] }>();
  allocs: AllocSite[] = [];
  warnings: DownResult["warnings"] = [];
  warned = new Set<string>();
  sharedGlobals = new Set<ts.Symbol>();
  initBlocked = new Set<ts.Symbol>();
  mutatedGlobals = new Set<ts.Symbol>();
  usedMath = new Set<string>();
  // Walk state
  inst!: Inst;
  frame!: Frame;
  scope!: Scope;
  env: Env = new Map();
  nextVar = 1;
  nextLabel = 1;
  nextThrow = 0;
  loopDepth = 0;
  inInit = false;
  initFn: FuncInst | null = null;
  initDirty = false;
  memory: MemoryMode;
  mem: boolean; // a memory mode other than strict: everything this adds is behind this
  boxedSyms = new Set<ts.Symbol>();
  rebound = new Set<ts.Symbol>();

  rcOptions: RcOptions;
  excOptions: ExcOptions = {};
  classFault: string | null = null;
  strRt: boolean; // this module has run-time strings: every string in it is a pointer (SPEC 4.5, D42)
  strNode: HeapNode; // the one class of string
  strLits = new Map<string, string>();
  usesCharTable = false;
  usesHashKey = false;
  mapNodes = new Map<HeapNode, { kind: "map" | "set"; env: Env; keyT: ts.Type; valT: ts.Type }>();

  constructor(
    program: ts.Program,
    sf: ts.SourceFile,
    memory: MemoryMode = "strict",
    rcOptions: Partial<RcOptions> = {},
    strRt = false,
  ) {
    resetNodeIds();
    this.memory = memory;
    this.strRt = strRt;
    this.strNode = newNode("obj");
    this.strNode.klass = "string";
    this.strNode.long = strRt;
    this.strNode.escapes = strRt;
    this.strNode.chainOnly = true; // a view refers to its owner, and an owner never refers to anything
    this.dynNode = newNode("obj");
    this.dynNode.klass = "$unknown";
    this.dynNode.dyn = true;
    this.dynNode.long = memory !== "strict";
    this.dynNode.escapes = memory !== "strict";
    this.dynNode.dynTargets = [];
    this.rcOptions = {
      check: false,
      account: false,
      elide: true,
      cycles: RC_CYCLES_DEFAULT,
      ...rcOptions,
    };
    this.mem = memory !== "strict";
    // Test builds: a mistake in exceptions or classes, to show the tests catch it (D49, D50). Nothing that ships reads this.
    const fault = process.env.TMK_TEST_EXC;
    if (fault !== undefined && this.mem) {
      const f = JSON.parse(fault) as { fault?: string; at?: number };
      if (f.fault === "no-check" || f.fault === "finally-late")
        this.excOptions = { fault: f.fault, ...(f.at !== undefined ? { faultAt: f.at } : {}) };
      if (f.fault === "no-release-path") this.rcOptions.excFault = f.fault;
      if (f.fault === "wrong-slot" || f.fault === "wrong-instanceof" || f.fault === "init-order")
        this.classFault = f.fault;
    }
    this.program = program;
    this.checker = program.getTypeChecker();
    this.rootSf = sf;
  }

  // --- errors and positions

  block(blocker: string, node: ts.Node, detail: string, root?: string): never {
    throw new Blocked(blocker, node, detail, root);
  }

  loc(node: ts.Node): string {
    const sf = node.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${repoRelative(sf.fileName)}:${p.line + 1}:${p.character + 1}`;
  }

  /** A top-level name two modules both declare, named for its module: `shapes.Square` (D65). */
  topQualified(name: string, at: ts.Node, top = name): string {
    if (!this.sharedTop.has(top)) return name;
    const stem = at.getSourceFile().fileName.replace(/.*\//, "").replace(/\.ts$/, "");
    return `${stem}.${name}`;
  }

  fnName(n: ts.Node): string {
    const base = this.fnName0(n);
    if (base.startsWith("<")) return base;
    let top: ts.Node = n;
    while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent;
    const head = base.split(".")[0]!;
    let topName: string | null = null;
    if ((ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) && top.name !== undefined)
      topName = top.name.text;
    if (ts.isVariableStatement(top))
      for (const d of top.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === head) topName = head;
    return topName === head ? this.topQualified(base, n, head) : base;
  }

  fnName0(n: ts.Node): string {
    if (ts.isSourceFile(n)) return "<module init>";
    if (ts.isVariableDeclaration(n)) return n.name.getText();
    if (ts.isStatement(n) && !ts.isFunctionDeclaration(n) && !ts.isClassLike(n))
      return "<module init>";
    if (ts.isConstructorDeclaration(n)) return `${n.parent.name?.text ?? "class"}.constructor`;
    if (ts.isClassLike(n)) return `${n.name?.text ?? "class"}.constructor`;
    if (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
      const c = n.parent;
      const owner = ts.isClassLike(c) ? (c.name?.text ?? "class") : "object";
      const pre = ts.isGetAccessor(n) ? "get " : ts.isSetAccessor(n) ? "set " : "";
      return `${owner}.${pre}${n.name.getText()}`;
    }
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) return n.name.text;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
    return "<anonymous>";
  }

  // --- symbols and types

  symbolOf(node: ts.Node): ts.Symbol | undefined {
    let sym: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(node)) {
      sym = this.checker.getShorthandAssignmentValueSymbol(node);
    } else sym = this.checker.getSymbolAtLocation(node);
    if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
      sym = this.checker.getAliasedSymbol(sym);
    }
    return sym;
  }

  isLibSymbol(sym: ts.Symbol): boolean {
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    return d !== undefined && this.program.isSourceFileDefaultLibrary(d.getSourceFile());
  }

  subst(t: ts.Type): ts.Type {
    if (hasFlag(t, ts.TypeFlags.TypeParameter)) {
      const m = this.env.get((t as unknown as { id: number }).id);
      if (m !== undefined) return m;
    }
    return t;
  }

  typeAt(node: ts.Node): ts.Type {
    return this.subst(this.checker.getTypeAtLocation(node));
  }

  envKey(env: Env = this.env): string {
    if (env.size === 0) return "";
    const parts: string[] = [];
    for (const [k, v] of env) parts.push(`${k}=${(v as unknown as { id: number }).id}`);
    return `<${parts.join(",")}>`;
  }

  nullishOf(t: ts.Type): { null: boolean; undef: boolean } {
    let n = false;
    let u = false;
    const parts = t.isUnion() ? t.types : [t];
    for (const p of parts) {
      if (hasFlag(p, ts.TypeFlags.Null)) n = true;
      if (hasFlag(p, ts.TypeFlags.Undefined | ts.TypeFlags.Void)) u = true;
    }
    return { null: n, undef: u };
  }

  nonNullable(t: ts.Type): boolean {
    const x = this.nullishOf(t);
    return !x.null && !x.undef;
  }

  isCallable(t0: ts.Type): boolean {
    const t = this.subst(t0);
    if (t.isUnion()) return t.types.some((x) => this.isCallable(x));
    return t.getCallSignatures().length > 0;
  }

  /** The lowered shape of a TS type: every location gets one from its declared type. */
  shapeOf(t0: ts.Type, at: ts.Node): Shape {
    const t = this.subst(t0);
    if (this.mem && hasFlag(t, ts.TypeFlags.Unknown)) return this.dynShape();
    if (hasFlag(t, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      this.block("any-type", at, `a value of type ${this.checker.typeToString(t)}`);
    }
    if (hasFlag(t, ts.TypeFlags.TypeParameter)) {
      this.block("any-type", at, `an unresolved type parameter ${this.checker.typeToString(t)}`);
    }
    if (
      hasFlag(
        t,
        ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never,
      )
    ) {
      return { s: "void" };
    }
    if (
      hasFlag(t, ts.TypeFlags.NumberLike) ||
      (hasFlag(t, ts.TypeFlags.EnumLike) && !t.isUnion())
    ) {
      return { s: "num", loc: newLoc() };
    }
    if (hasFlag(t, ts.TypeFlags.BooleanLike)) return { s: "bool" };
    if (hasFlag(t, ts.TypeFlags.BigIntLike)) {
      this.block("bigint", at, "a plain bigint has arbitrary precision");
    }
    if (hasFlag(t, ts.TypeFlags.StringLiteral)) {
      if (this.strRt) return this.strShape();
      this.strLit((t as ts.StringLiteralType).value);
      return { s: "str" };
    }
    if (hasFlag(t, ts.TypeFlags.StringLike)) {
      this.needStr(at, "a run-time string");
      return this.strShape();
    }
    if (t.isUnion()) return this.unionShape(t, at);
    if (t.isIntersection()) {
      this.block("union-mixed", at, `an intersection type: ${this.checker.typeToString(t)}`);
    }
    return this.objectShape(t as ts.ObjectType, at);
  }

  unionShape(t: ts.UnionType, at: ts.Node): Shape {
    if (this.mem) {
      if (t.aliasSymbol?.name === "IteratorResult" && this.isLibSymbol(t.aliasSymbol)) {
        return this.resultShape(t.aliasTypeArguments![0]!, at);
      }
      if (t.types.some((p) => hasFlag(p, ts.TypeFlags.TypeParameter))) {
        return this.unionOfParams(t, at);
      }
    }
    const nl = this.nullishOf(t);
    if (nl.null && nl.undef) {
      this.block("nullish-both", at, `${this.checker.typeToString(t)} has both null and undefined`);
    }
    const nul: Nul = nl.null ? "null" : "undefined";
    const rest = t.types.filter(
      (p) => !hasFlag(p, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void),
    );
    const nullable = nl.null || nl.undef;
    const wrap = (sh: Shape): Shape => {
      if (!nullable) return sh;
      if (sh.s === "num" || sh.s === "bool" || sh.s === "str") return { s: "opt", of: sh, nul };
      if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") return { ...sh, nul };
      return sh;
    };
    const all = (f: ts.TypeFlags): boolean => rest.every((p) => hasFlag(p, f));
    if (this.mem && rest.length > 0 && all(ts.TypeFlags.StringLike)) {
      if (this.strRt || !all(ts.TypeFlags.StringLiteral)) {
        this.needStr(at, "a union of strings");
        return wrap(this.strShape());
      }
    }
    if (all(ts.TypeFlags.NumberLike | ts.TypeFlags.EnumLike))
      return wrap({ s: "num", loc: newLoc() });
    if (all(ts.TypeFlags.BooleanLike)) return wrap({ s: "bool" });
    if (all(ts.TypeFlags.StringLiteral)) {
      for (const p of rest) this.strLit((p as ts.StringLiteralType).value);
      return wrap({ s: "str" });
    }
    if (rest.some((p) => hasFlag(p, ts.TypeFlags.StringLike))) {
      this.block("string-use", at, `a union with strings: ${this.checker.typeToString(t)}`);
    }
    if (rest.some((p) => !hasFlag(p, ts.TypeFlags.Object))) {
      this.block("union-mixed", at, `no single representation for ${this.checker.typeToString(t)}`);
    }
    if (rest.length === 1) return wrap(this.shapeOf(rest[0]!, at));
    // Object shapes in one union become one struct holding every member's fields.
    const shapes = rest.map((p) => this.shapeOf(p, at));
    let first: Shape = shapes[0]!;
    for (const s of shapes.slice(1)) {
      if (first.s !== "obj" || s.s !== "obj") {
        this.block(
          "union-mixed",
          at,
          `no single representation for ${this.checker.typeToString(t)}`,
        );
      }
      first = this.unify(first, s, at);
    }
    if (first.s === "obj") this.noteVariants(rest, findNode(first.node));
    return wrap(first);
  }

  noteVariants(members: ts.Type[], node: HeapNode): void {
    if (node.variants.length > 0) return;
    const props = (m: ts.Type): ts.Symbol[] => m.getProperties();
    for (const candidate of props(members[0]!)) {
      const name = candidate.name;
      const values: (string | number | boolean)[] = [];
      for (const m of members) {
        const p = m.getProperty(name);
        if (p === undefined) break;
        const ty = this.checker.getTypeOfSymbol(p);
        if (ty.isStringLiteral() || ty.isNumberLiteral()) values.push(ty.value as string | number);
        else if (hasFlag(ty, ts.TypeFlags.BooleanLiteral)) {
          values.push((ty as unknown as { intrinsicName: string }).intrinsicName === "true");
        } else break;
      }
      if (values.length === members.length) {
        node.variants = members.map((m, i) => ({
          tag: name,
          value: values[i]!,
          fields: props(m).map((x) => x.name),
        }));
        return;
      }
    }
  }

  libName(t: ts.Type): string | null {
    const sym = t.getSymbol() ?? t.aliasSymbol;
    if (sym === undefined || !this.isLibSymbol(sym)) return null;
    return sym.name;
  }

  objectShape(t: ts.ObjectType, at: ts.Node): Shape {
    const checker = this.checker;
    if (this.mem && checker.isTupleType(t) && this.isStructTuple(t, at)) {
      return { s: "obj", node: this.tupleNode(t, at) };
    }
    if (checker.isTupleType(t) || checker.isArrayType(t)) return this.vecShape(t, at);
    if (
      checker.getIndexInfoOfType(t, ts.IndexKind.String) !== undefined &&
      (t.flags & ts.TypeFlags.Object) !== 0
    ) {
      this.block("computed-key", at, `${checker.typeToString(t)} has dynamic keys`);
    }
    const lib = this.libName(t);
    if (lib !== null) {
      const elem = ELEM_BY_ARRAY[lib];
      if (elem === "u64" || elem === "i64") this.block("bigint", at, `${lib} holds bigints`);
      if (elem !== undefined) return { s: "arr", elem, node: newNode("arr") };
      if (lib === "ReadonlyArray") return this.vecShape(t, at);
      if (lib === "WeakRef") return this.weakShape(t, at);
      if (this.mem) {
        const rt = this.rtLibShape(t, lib, at);
        if (rt !== null) return rt;
        const err = this.errorRtName(lib);
        if (err !== null) return this.rtClassShape(err, [], at);
        if (lib === "ErrorOptions") return { s: "obj", node: this.objNode(t, at) };
      }
      const hit = LIB_BLOCKERS[lib];
      if (hit !== undefined) this.block(hit[0], at, hit[1]);
      if (lib === "Generator" || lib === "AsyncGenerator" || lib === "Iterator") {
        this.block("generator", at, "a generator or iterator object");
      }
      if (lib === "Function") this.block("closure-escape", at, "a value of type Function");
      if (lib === "Error" || lib === "TypeError" || lib === "RangeError") {
        this.block("throw-non-error", at, "an Error used as a value, not thrown");
      }
      if (t.getCallSignatures().length === 0) {
        this.block("unsupported", at, `the library type ${lib}`);
      }
    }
    if (t.getCallSignatures().length > 0) {
      return this.mem ? { s: "obj", node: this.fnNode(t, at) } : { s: "fn" };
    }
    if (
      checker.getIndexInfoOfType(t, ts.IndexKind.String) !== undefined ||
      checker.getIndexInfoOfType(t, ts.IndexKind.Number) !== undefined
    ) {
      this.block("computed-key", at, `${checker.typeToString(t)} has dynamic keys`);
    }
    return { s: "obj", node: this.objNode(t, at) };
  }

  /** A WeakRef holds a count on a cell the target shares, not on the target (SPEC 3.5). `rc` only. */
  weakShape(t: ts.ObjectType, at: ts.Node): Shape {
    if (this.memory !== "rc") {
      this.block("weakref", at, `WeakRef in ${this.memory}: only a count can say a target is gone`);
    }
    const key = `weak${(t as unknown as { id: number }).id}${this.envKey()}`;
    let node = this.nodesByType.get(key);
    if (node === undefined) {
      node = newNode("obj");
      node.klass = "WeakRef";
      this.nodesByType.set(key, node);
      const arg = this.checker.getTypeArguments(t as ts.TypeReference)[0];
      if (arg === undefined) this.block("weakref", at, "a WeakRef with no type argument");
      const target = this.shapeOf(arg, at);
      if (target.s !== "obj" && target.s !== "vec") {
        this.block("weakref", at, "a WeakRef of a typed array, which is a pointer and a length");
      }
      node.weakOf = target;
    }
    return { s: "obj", node };
  }

  vecShape(t: ts.ObjectType, at: ts.Node): Shape {
    const node = newNode("vec");
    const args = this.checker.getTypeArguments(t as ts.TypeReference);
    let elem: Shape | null = null;
    for (const a of args) {
      const s = this.shapeOf(a, at);
      elem = elem === null ? s : this.unifyElem(elem, s, at);
    }
    node.elem = elem ?? { s: "void" };
    return { s: "vec", node };
  }

  unifyElem(a: Shape, b: Shape, at: ts.Node): Shape {
    if (a.s === b.s || a.s === "opt" || b.s === "opt") return this.unify(a, b, at);
    this.block("union-mixed", at, "a tuple whose elements have no single representation");
  }

  objNode(t: ts.ObjectType, at: ts.Node): HeapNode {
    const id = (t as unknown as { id: number }).id;
    const key = `${id}${this.envKey()}`;
    const hit = this.nodesByType.get(key);
    if (hit !== undefined) return hit;
    const node = newNode("obj");
    this.nodesByType.set(key, node);
    const sym = t.getSymbol();
    const classDecl = sym?.declarations?.find(ts.isClassLike);
    if (classDecl !== undefined) {
      node.klass = sym!.name;
      if (this.mem && sym!.name === "TmkGen") node.chainOnly = true;
      this.checkClass(classDecl, at);
    }
    for (const p of this.checker.getPropertiesOfType(t)) {
      if ((p.flags & ts.SymbolFlags.Property) === 0) {
        if (
          (p.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) !== 0 &&
          classDecl !== undefined
        )
          continue;
        this.block("unsupported", at, `object member ${p.name} is a method or accessor`);
      }
      if (p.name.startsWith("__@") || p.name.startsWith("__#")) {
        this.block("reflection", at, `the computed or private member ${p.name}`);
      }
      const decl = p.valueDeclaration ?? p.declarations?.[0] ?? at;
      const pt = this.checker.getTypeOfSymbolAtLocation(p, decl);
      if (this.mem && classDecl !== undefined && this.isLibSymbol(p)) {
        // Error's `stack` is computed (3.10), and SuppressedError's two parts are `any` in the library: `unknown` here.
        if (p.name === "stack") continue;
        if (hasFlag(pt, ts.TypeFlags.Any)) {
          node.fields.set(p.name, this.dynShape());
          continue;
        }
      }
      if (this.isCallable(pt) && !this.mem) {
        this.block("closure-escape", decl, `the field ${p.name} holds a function`);
      }
      const key =
        classDecl !== undefined && (ts.isPropertyDeclaration(decl) || ts.isParameter(decl))
          ? this.fieldKeyOfDecl(p.name, this.enclosingClass(decl))
          : p.name;
      node.fields.set(key, this.shapeOf(pt, decl));
    }
    return node;
  }

  /** A function type as a value: its closures share one calling convention, by unification (SPEC 4.5). */
  fnNode(t: ts.ObjectType, at: ts.Node): HeapNode {
    const key = `fn${(t as unknown as { id: number }).id}${this.envKey()}`;
    const hit = this.nodesByType.get(key);
    if (hit !== undefined) return hit;
    const sigs = t.getCallSignatures();
    if (sigs.length !== 1) this.block("closure-escape", at, "an overloaded function value");
    const sig = sigs[0]!;
    if (sig.typeParameters !== undefined)
      this.block("closure-escape", at, "a generic function used as a value");
    const node = newNode("fn");
    this.nodesByType.set(key, node);
    for (const p of sig.parameters) {
      const d = p.valueDeclaration;
      if (d !== undefined && ts.isParameter(d) && d.dotDotDotToken !== undefined)
        this.block("closure-escape", at, "a rest parameter on a function value");
      node.params.push(this.shapeOf(this.checker.getTypeOfSymbolAtLocation(p, d ?? at), d ?? at));
    }
    const rt = this.subst(this.checker.getReturnTypeOfSignature(sig));
    node.ret = hasFlag(rt, ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined)
      ? { s: "void" }
      : this.shapeOf(rt, at);
    return node;
  }

  checkClass(c: ts.ClassLikeDeclaration, _at: ts.Node): void {
    const heritage = c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    if (heritage !== undefined && !this.mem)
      this.block(
        "inheritance",
        heritage,
        "a class with a base class, which needs a memory mode in this phase",
      );
    if (c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true && !this.mem) {
      this.block("inheritance", c, "an abstract class, which needs a memory mode in this phase");
    }
    if (this.mem) {
      const rec = this.classRec(c);
      if (this.inHierarchy(rec) && c.typeParameters !== undefined)
        this.block("inheritance", c, "a generic class in a hierarchy");
    }
    for (const m of c.members) {
      if (
        ts.canHaveModifiers(m) &&
        ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true &&
        !(this.mem && (ts.isPropertyDeclaration(m) || ts.isMethodDeclaration(m)))
      ) {
        this.block("unsupported", m, "a static class member");
      }
      if (ts.isClassStaticBlockDeclaration(m)) this.block("unsupported", m, "a static block");
      if (ts.isPropertyDeclaration(m) && m.exclamationToken !== undefined) {
        // Read too early, JS gives undefined, and a zeroed struct would give 0: a silent difference.
        this.block("unsupported", m, "a definite-assignment assertion on a field");
      }
      if (m.name !== undefined && ts.isPrivateIdentifier(m.name)) {
        this.block("unsupported", m, "a #private member");
      }
    }
  }

  // --- unification

  unify(a: Shape, b: Shape, at: ts.Node): Shape {
    if (a === b) return a;
    if (a.s === "void") return b;
    if (b.s === "void") return a;
    if (a.s === "opt" && b.s === "opt") {
      return { s: "opt", of: this.unify(a.of, b.of, at), nul: a.nul };
    }
    if (a.s === "opt") return { s: "opt", of: this.unify(a.of, b, at), nul: a.nul };
    if (b.s === "opt") return { s: "opt", of: this.unify(a, b.of, at), nul: b.nul };
    if (a.s === "num" && b.s === "num") {
      if (unifyLocs(a.loc, b.loc)) this.changed = true;
      return a;
    }
    if (a.s === "bool" && b.s === "bool") return a;
    if (a.s === "str" && b.s === "str") return a;
    if (a.s === "fn" && b.s === "fn") return a;
    if (a.s === "arr" && b.s === "arr") {
      if (a.elem !== b.elem) {
        this.block("union-mixed", at, `${a.elem} and ${b.elem} typed arrays in one place`);
      }
      this.unifyNodes(a.node, b.node, at);
      return a;
    }
    if (a.s === "obj" && b.s === "obj" && this.isDyn(a) !== this.isDyn(b)) {
      // A class instance is already a valid `unknown`: the place becomes one (D49). A string or null would need a box.
      const other = this.isDyn(a) ? b : a;
      const n = findNode(other.node);
      if (
        n.kind === "fn" ||
        n === findNode(this.strNode) ||
        other.nul === "null" ||
        n.tupleLen !== undefined
      )
        this.block("any-type", at, "an unknown and a known type in one place");
      this.markCls(n);
      this.markLong(other);
      this.noteDynTarget(n);
      return this.dynShape();
    }
    if ((a.s === "vec" && b.s === "vec") || (a.s === "obj" && b.s === "obj")) {
      this.unifyNodes(a.node, b.node, at);
      return a;
    }
    this.block("union-mixed", at, `a ${a.s} and a ${b.s} in one place`);
  }

  unifyNodes(a0: HeapNode, b0: HeapNode, at: ts.Node): void {
    const a = findNode(a0);
    const b = findNode(b0);
    if (a === b) return;
    if (a.dyn === true || b.dyn === true) {
      this.block("any-type", at, "an unknown and a known type in one place");
    }
    this.changed = true;
    b.parent = a;
    if (b.classes !== undefined) {
      a.classes ??= new Set();
      for (const r of b.classes) a.classes.add(r);
    }
    if (b.cls === true && a.cls !== true) a.cls = true;
    a.escapes ||= b.escapes;
    a.global ||= b.global;
    a.written ||= b.written;
    a.external ||= b.external;
    a.long ||= b.long;
    a.klass ??= b.klass;
    if (b.chainOnly === true) a.chainOnly = true;
    if (a.kind === "fn" && b.kind === "fn") {
      const n = Math.max(a.params.length, b.params.length);
      for (let i = 0; i < n; i++) {
        const x = a.params[i];
        const y = b.params[i];
        a.params[i] = x === undefined ? y! : y === undefined ? x : this.unify(x, y, at);
      }
      a.ret = this.unify(a.ret ?? { s: "void" }, b.ret ?? { s: "void" }, at);
      for (const c of b.caps) this.addCap(a, c);
    }
    if (a.variants.length === 0) a.variants = b.variants;
    if (a.kind === "vec") {
      a.elem = a.elem === null ? b.elem : b.elem === null ? a.elem : this.unify(a.elem, b.elem, at);
    }
    for (const [name, sh] of b.fields) {
      const mine = a.fields.get(name);
      const both = mine === undefined ? sh : this.unify(mine, sh, at);
      // A field's null belongs to its declared type, whichever object literal this class met first. Reading
      // it back as anything else shows V8 a missing field where it has `null`. Elements keep their shape:
      // there, `undefined` comes from reading (noUncheckedIndexedAccess), and says nothing about holes.
      const declared =
        mine !== undefined && mine.s !== "opt" && "nul" in mine ? mine.nul : undefined;
      const other = sh.s !== "opt" && "nul" in sh ? sh.nul : undefined;
      a.fields.set(
        name,
        (both.s === "obj" || both.s === "vec" || both.s === "arr") &&
          both.nul === undefined &&
          (declared ?? other) !== undefined
          ? { ...both, nul: (declared ?? other)! }
          : both,
      );
    }
  }

  markEscape(sh: Shape | undefined): void {
    if (sh === undefined) return;
    if (sh.s === "opt") {
      this.markEscape(sh.of);
      return;
    }
    if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      const n = findNode(sh.node);
      if (!n.escapes) {
        n.escapes = true;
        this.changed = true;
      }
    }
  }

  markWritten(sh: Shape | undefined): void {
    if (sh === undefined) return;
    if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      const n = findNode(sh.node);
      if (!n.written) {
        n.written = true;
        this.changed = true;
      }
    }
  }

  /** Memory modes: this outlives the export call. What it can reach does too, by closeOverLong. */
  markLong(sh: Shape | undefined): void {
    if (sh === undefined || !this.mem) return;
    if (sh.s === "opt") {
      this.markLong(sh.of);
      return;
    }
    if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      const n = findNode(sh.node);
      if (!n.long || !n.escapes) {
        n.long = true;
        n.escapes = true;
        this.changed = true;
      }
    }
  }

  addCap(n0: HeapNode, sh: Shape): void {
    const n = findNode(n0);
    const inner = sh.s === "opt" ? sh.of : sh;
    if (inner.s !== "obj" && inner.s !== "arr" && inner.s !== "vec") return;
    const id = findNode(inner.node);
    if (n.caps.some((c) => c.s !== "num" && "node" in c && findNode(c.node) === id)) return;
    n.caps.push(inner);
    this.changed = true;
  }

  /**
   * Reachability, across what unification has merged: what a long-lived object holds is long-lived, what a
   * caller's memory is given has to last as long as the caller's memory, and an environment that escapes
   * takes what it captured with it.
   */
  closeOverLong(): void {
    for (let guard = 0; guard < 4096; guard++) {
      const before = this.changed;
      this.changed = false;
      for (const n0 of liveNodes()) {
        if (n0.parent !== null) continue;
        const inner: Shape[] = [...n0.fields.values(), ...n0.caps];
        if (n0.elem !== null) inner.push(n0.elem);
        if (n0.long || (n0.external && n0.written)) for (const s of inner) this.markLong(s);
        if (n0.kind === "fn" && n0.escapes) for (const s of n0.caps) this.markEscape(s);
        // In `rc`, only a count can tell what an object holds that it has died: one that holds a counted
        // reference is counted too, even if it would have stayed on the stack (SPEC 4.5).
        if (this.memory === "rc" && !n0.long && inner.some((s) => countedOf(s) !== null)) {
          this.markLong({ s: "obj", node: n0 });
        }
      }
      // In `rc`, what isn't on the stack is counted. The call arena has no way to free one iteration's
      // allocation, so a loop in one export call would run it out (SPEC 4.5, D39).
      if (this.memory === "rc") {
        for (const a of this.allocs) {
          if (a.node !== undefined && a.stack() === null && !findNode(a.node).long) {
            this.markLong({ s: "obj", node: a.node });
          }
        }
      }
      const again = this.changed;
      this.changed = before || again;
      if (!again) return;
    }
    throw new Error("closeOverLong did not settle");
  }

  markGlobal(sh: Shape | undefined, seen = new Set<HeapNode>()): void {
    if (sh === undefined) return;
    if (sh.s === "opt") {
      this.markGlobal(sh.of, seen);
      return;
    }
    if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      const n = findNode(sh.node);
      if (seen.has(n)) return;
      seen.add(n);
      if (!n.global) {
        n.global = true;
        n.escapes = true;
        this.changed = true;
      }
      this.markLong(sh);
      if (n.elem !== null) this.markGlobal(n.elem, seen);
      for (const f of n.fields.values()) this.markGlobal(f, seen);
    }
  }

  /** Values from JS can be anything their type allows, so their numbers are f64. */
  markExternal(sh: Shape, at: ts.Node, seen = new Set<HeapNode>()): void {
    switch (sh.s) {
      case "num":
        if (joinLoc(sh.loc, { float: true, lo: -Infinity, hi: Infinity, negz: true }))
          this.changed = true;
        return;
      case "opt":
        this.markExternal(sh.of, at, seen);
        return;
      case "fn":
        this.block("export-signature", at, "a function value can't cross from JS");
        return;
      case "arr":
      case "vec":
      case "obj": {
        const n = findNode(sh.node);
        if (seen.has(n)) return;
        seen.add(n);
        n.external = true;
        n.escapes = true;
        if (n.kind === "fn") {
          this.block("export-signature", at, "a function value can't cross from JS");
        }
        // Natively there's no JS on the other side: a caller just has a pointer (SPEC 4.5).
        if (n.klass !== null && !this.mem) {
          this.block("export-signature", at, `a ${n.klass} instance can't cross the boundary`);
        }
        if (n.elem !== null) this.markExternal(n.elem, at, seen);
        for (const f of n.fields.values()) this.markExternal(f, at, seen);
        return;
      }
      default:
        return;
    }
  }

  /** Numbers going to JS must keep -0, and an integer register can't. */
  markReturned(sh: Shape, at: ts.Node, seen = new Set<HeapNode>()): void {
    switch (sh.s) {
      case "num": {
        const l = findLoc(sh.loc);
        if (l.negz && !l.float) {
          l.float = true;
          this.changed = true;
        }
        return;
      }
      case "opt":
        this.markReturned(sh.of, at, seen);
        return;
      case "fn":
        this.block("closure-escape", at, "a function returned to JS");
        return;
      case "arr":
      case "vec":
      case "obj": {
        const n = findNode(sh.node);
        if (seen.has(n)) return;
        seen.add(n);
        this.markEscape(sh);
        // A result outlives the arena's next reset, so it isn't in the arena (SPEC 4.5, D36).
        this.markLong(sh);
        if (n.klass !== null && !this.mem) {
          this.block("export-signature", at, `a ${n.klass} instance can't cross the boundary`);
        }
        if (n.elem !== null) this.markReturned(n.elem, at, seen);
        for (const f of n.fields.values()) this.markReturned(f, at, seen);
        return;
      }
      default:
        return;
    }
  }

  slot(key: string, t: ts.Type, at: ts.Node): Shape {
    const hit = this.slots.get(key);
    if (hit !== undefined) return hit;
    const sh = this.shapeOf(t, at);
    this.slots.set(key, sh);
    return sh;
  }

  slotKey(node: ts.Node): string {
    return `${this.frame.path}@${node.getSourceFile().fileName.length}:${node.pos}:${node.end}${this.envKey()}`;
  }

  isForced(node: ts.Node): boolean {
    return this.forced.has(this.slotKey(node));
  }

  // --- facts

  factOf(te: TE): Fact {
    const r = range(te);
    return { float: isF(te), lo: r[0], hi: r[1], negz: te.negz === true };
  }

  join(loc: NumLoc, te: TE): void {
    if (joinLoc(loc, this.factOf(te))) this.changed = true;
  }

  /** An integer read as a float. -0 lost to an integer would show here, so the source becomes f64. */
  toFloat(te: TE): TE {
    if (isF(te)) return te;
    if (te.k === "lit") return mk(T.f64, { k: "lit", value: te.value }, { range: te.range! });
    if (te.negz === true) this.forceFloat(te);
    return mk(T.f64, { k: "conv", val: te }, { range: range(te) });
  }

  /** Same value without the -0 concern, for comparisons, where -0 and 0 are equal anyway. */
  toFloatCmp(te: TE): TE {
    if (isF(te)) return te;
    if (te.k === "lit") return mk(T.f64, { k: "lit", value: te.value }, { range: te.range! });
    return mk(T.f64, { k: "conv", val: te }, { range: range(te) });
  }

  forceFloat(te: TE): void {
    for (const d of te.deps ?? []) {
      if (typeof d === "string") {
        if (!this.forced.has(d)) {
          this.forced.add(d);
          this.changed = true;
        }
      } else {
        const l = findLoc(d as NumLoc);
        if (!l.float) {
          l.float = true;
          this.changed = true;
        }
      }
    }
  }

  coerceNum(te: TE, target: Ty): TE {
    if (target.k === "float") return this.toFloat(te);
    if (isF(te))
      return mk(target, { k: "builtin", name: "toI32", args: [te], loc: "transitional" });
    if (te.ty.k === "int" && target.k === "int" && te.ty.name !== target.name)
      return retype(te, target);
    return te;
  }

  // --- flow: a value going into a place with a shape

  flow(te0: TE, sh: Shape, at: ts.Node): TE {
    const te = te0;
    if (te.ty.k === "never") return te;
    if (this.isDyn(te.sh) && !this.isDyn(sh) && sh.s !== "void") return this.fromDyn(te, sh, at);
    if (this.isDyn(sh) && sh.s === "obj" && !this.isDyn(te.sh)) return this.toDyn(te, at);
    switch (sh.s) {
      case "num": {
        const v = this.narrowOpt(te, at);
        if (!isNum(v)) {
          if (v.ty.k === "nullish")
            this.block("union-mixed", at, "undefined flowing into a number");
          this.block("union-mixed", at, `a ${v.ty.k} flowing into a number`);
        }
        this.join(sh.loc, v);
        return this.coerceNum(v, locTy(sh.loc));
      }
      case "bool":
        return this.narrowOpt(te, at);
      case "str":
        return this.narrowOpt(te, at);
      case "fn":
        this.block("closure-escape", at, "a function value stored or passed where it isn't known");
        break;
      case "void":
        return te;
      case "opt": {
        if (te.ty.k === "nullish") return this.none(sh);
        if (te.ty.k === "opt") {
          const from = te.sh as Shape;
          if (from.s === "opt") {
            if (from.of.s === "num" && sh.of.s === "num") {
              const l = findLoc(from.of.loc);
              if (
                joinLoc(sh.of.loc, {
                  float: l.float,
                  lo: l.seen ? l.lo : 0,
                  hi: l.seen ? l.hi : 0,
                  negz: l.negz,
                })
              ) {
                this.changed = true;
              }
              const want = locTy(sh.of.loc);
              const have = locTy(from.of.loc);
              if (
                want.k === have.k &&
                (want.k !== "int" || have.k !== "int" || want.name === have.name)
              )
                return te;
              return this.withTemp(te, (t) => {
                const payload = mk(
                  have,
                  { k: "slice", val: t, from: 1, to: 2 },
                  { deps: [from.of.s === "num" ? from.of.loc : ""] },
                );
                return mk(
                  tyOf(sh),
                  {
                    k: "tuple",
                    items: [
                      mk(T.i32, { k: "slice", val: t, from: 0, to: 1 }),
                      this.coerceNum(payload, want),
                    ],
                  },
                  { sh },
                );
              });
            }
            return { ...te, sh } as TE;
          }
        }
        const inner = this.flow(te, sh.of, at);
        return mk(tyOf(sh), { k: "tuple", items: [lit32(1), inner] }, { sh });
      }
      case "arr":
      case "vec":
      case "obj": {
        if (this.isDyn(sh)) return this.toDyn(te, at);
        if (this.isDyn(te.sh)) return this.fromDyn(te, sh, at);
        if (te.ty.k === "nullish") return this.nullOf(sh);
        const from = te.sh as Shape | undefined;
        if (from === undefined || from.s !== sh.s) {
          this.block("union-mixed", at, `a ${te.ty.k} flowing into a ${sh.s}`);
        }
        this.unify(from, sh, at);
        return { ...te, sh } as TE;
      }
    }
    return te;
  }

  /** A nullable value read where the checker has already narrowed it: just the payload. */
  narrowOpt(te: TE, at: ts.Node): TE {
    if (te.ty.k !== "opt") return te;
    const sh = te.sh as Shape;
    if (sh.s !== "opt") this.block("unsupported", at, "an optional without a shape");
    return this.optPayload(te, sh);
  }

  optPayload(te: TE, sh: Extract<Shape, { s: "opt" }>): TE {
    const ty = tyOf(sh.of);
    const n = ty.k === "void" ? 1 : 2;
    const extra: Partial<TE> = { sh: sh.of };
    if (sh.of.s === "num") {
      const l = findLoc(sh.of.loc);
      extra.deps = [sh.of.loc];
      extra.range = [l.lo, l.hi];
      if (l.negz) extra.negz = true;
    }
    return mk(ty, { k: "slice", val: te, from: 1, to: n }, extra);
  }

  none(sh: Extract<Shape, { s: "opt" }>): TE {
    return mk(tyOf(sh), { k: "tuple", items: [lit32(0), this.zeroOf(sh.of)] }, { sh });
  }

  zeroOf(sh: Shape): TE {
    const ty = tyOf(sh);
    if (ty.k === "float") return mk(ty, { k: "lit", value: 0 }, { range: [0, 0] });
    if (ty.k === "int") return mk(ty, { k: "lit", value: 0 }, { range: [0, 0] });
    if (ty.k === "bool") return litBool(false);
    if (ty.k === "lits") return lit32(0);
    return nullPtr();
  }

  nullOf(sh: Shape): TE {
    if (sh.s === "arr") {
      return mk(tyOf(sh), { k: "tuple", items: [nullPtr(), litIx(0)] }, { sh });
    }
    return mk({ k: "ref" }, { k: "lit", value: 0 }, { sh });
  }

  // --- temps and small tree helpers

  newVar(ty: Ty, name = "$t"): Var {
    return { id: this.nextVar++, name, ty };
  }

  /** Safe to read twice with nothing between: a user's variable may have been assigned since. */
  isPure(te: TE): boolean {
    return (
      (te.k === "var" && te.v.name === "$t") ||
      te.k === "lit" ||
      te.k === "gaddr" ||
      te.k === "global"
    );
  }

  /** Evaluates once into a hidden variable, then builds the rest from reads of it. */
  withTemp(te: TE, f: (t: TE) => TE): TE {
    if (this.isPure(te)) return f(te);
    const body: Stmt[] = [];
    const t = this.temp(te, body);
    const r = f(t);
    return mk(r.ty, { k: "blockexpr", body, result: r }, this.carry(r));
  }

  carry(r: TE): Partial<TE> {
    const extra: Partial<TE> = {};
    if (r.sh !== undefined) extra.sh = r.sh;
    if (r.range !== undefined) extra.range = r.range;
    if (r.deps !== undefined) extra.deps = r.deps;
    if (r.negz === true) extra.negz = true;
    return extra;
  }

  temp(te: TE, out: Stmt[]): TE {
    if (this.isPure(te)) return te;
    const v = this.newVar(te.ty);
    out.push({ k: "let", v, init: te, constant: true });
    return mk(te.ty, { k: "var", v }, this.carry(te));
  }

  readVar(v: Var, extra?: Partial<TE>): TE {
    return mk(v.ty, { k: "var", v }, extra);
  }

  cmpTE(op: "eq" | "ne" | "lt" | "le" | "gt" | "ge", a: TE, b: TE): TE {
    return mk(T.bool, { k: "cmp", op, a, b });
  }

  not(a: TE): TE {
    if (a.k === "lit" && typeof a.value === "boolean") return litBool(!a.value);
    return mk(T.bool, { k: "not", a });
  }

  ixOf(te: TE): TE {
    if (te.ty.k === "int" && te.ty.name === "usize") return te;
    if (te.k === "lit" && typeof te.value === "number" && te.value >= 0) return litIx(te.value);
    if (isF(te)) return mk(T.usize, { k: "f2ix", val: te });
    return mk(T.usize, { k: "conv", val: te });
  }

  /** i32 from a length (always below 2^31: __alloc refuses anything larger). */
  i32OfLen(te: TE): TE {
    return mk(T.i32, { k: "conv", val: te }, { range: [0, I32_MAX] });
  }

  ptrOfArr(arr: TE): TE {
    return mk({ k: "ref" }, { k: "slice", val: arr, from: 0, to: 1 });
  }

  // --- module setup

  collectFiles(): void {
    const seen = new Set<ts.SourceFile>();
    const visit = (sf: ts.SourceFile): void => {
      if (seen.has(sf)) return;
      seen.add(sf);
      const deps: ts.SourceFile[] = [];
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
          if (st.importClause?.isTypeOnly === true) continue;
          const s = this.checker.getSymbolAtLocation(st.moduleSpecifier);
          const d = s?.valueDeclaration;
          if (
            d !== undefined &&
            ts.isSourceFile(d) &&
            !this.program.isSourceFileDefaultLibrary(d)
          ) {
            deps.push(d);
            visit(d);
          }
        }
      }
      this.importsOf.set(sf, deps);
      this.files.push(sf);
    };
    visit(this.rootSf);
    const owners = new Map<string, Set<ts.SourceFile>>();
    for (const sf of this.files)
      for (const st of sf.statements) {
        const names: string[] = [];
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined)
          names.push(st.name.text);
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name)) names.push(d.name.text);
        for (const n of names) owners.set(n, (owners.get(n) ?? new Set()).add(sf));
      }
    for (const [n, set] of owners) if (set.size > 1) this.sharedTop.add(n);
    this.scanMutations();
  }

  scanMutations(): void {
    const root = (e: ts.Expression): ts.Identifier | null => {
      let cur = strip(e);
      for (let g = 0; g < 64; g++) {
        if (ts.isNonNullExpression(cur)) cur = strip(cur.expression);
        else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
          cur = strip(cur.expression);
        else break;
      }
      return ts.isIdentifier(cur) ? cur : null;
    };
    const note = (e: ts.Expression): void => {
      const id = root(e);
      if (id === null) return;
      const s = this.symbolOf(id);
      if (s !== undefined) this.mutatedGlobals.add(s);
    };
    const MUTATORS = new Set([
      "fill",
      "set",
      "push",
      "pop",
      "sort",
      "reverse",
      "splice",
      "shift",
      "unshift",
      "copyWithin",
    ]);
    const walk = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        note(n.left);
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      )
        note(n.operand);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        MUTATORS.has(n.expression.name.text)
      )
        note(n.expression.expression);
      ts.forEachChild(n, walk);
    };
    for (const sf of this.files) walk(sf);
    if (this.mem) for (const sf of this.files) this.scanRebound(sf);
  }

  /**
   * The bindings a captured reference has to share, because something assigns them after they're made. A
   * for-let changed only by its own incrementor isn't one: each iteration has its own binding, and nothing
   * changes that binding during the iteration's body, so a closure can copy its value (SPEC 4.5).
   */
  scanRebound(sf: ts.SourceFile): void {
    const hasFn = (n: ts.Node | undefined): boolean => {
      if (n === undefined) return false;
      let found = false;
      const w = (x: ts.Node): void => {
        if (ts.isFunctionLike(x)) found = true;
        if (!found) ts.forEachChild(x, w);
      };
      w(n);
      return found;
    };
    const walk = (n: ts.Node, ownStep: Set<ts.Symbol> | null): void => {
      const note = (e: ts.Expression): void => {
        const id = strip(e);
        if (!ts.isIdentifier(id)) return;
        const s = this.symbolOf(id);
        if (s !== undefined && !(ownStep?.has(s) ?? false)) this.rebound.add(s);
      };
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        note(n.left);
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      )
        note(n.operand);
      if (ts.isForStatement(n)) {
        const own = new Set<ts.Symbol>();
        if (
          n.initializer !== undefined &&
          ts.isVariableDeclarationList(n.initializer) &&
          !hasFn(n.initializer) &&
          !hasFn(n.incrementor)
        ) {
          for (const d of n.initializer.declarations) {
            if (ts.isIdentifier(d.name)) {
              const s = this.symbolOf(d.name);
              if (s !== undefined) own.add(s);
            }
          }
        }
        if (n.initializer !== undefined) walk(n.initializer, null);
        if (n.condition !== undefined) walk(n.condition, null);
        if (n.incrementor !== undefined) walk(n.incrementor, own);
        walk(n.statement, null);
        return;
      }
      ts.forEachChild(n, (c) => {
        walk(c, ownStep);
      });
    };
    walk(sf, null);
  }

  // --- top level

  run(): DownResult {
    this.collectFiles();
    const roots = this.collectExports();
    let settled = false;
    for (this.round = 1; this.round <= MAX_ROUNDS; this.round++) {
      this.changed = false;
      this.visited = new Set();
      this.queue = [];
      this.allocs = [];
      this.nextLabel = 1;
      this.nextThrow = 0;
      this.warnings = [];
      this.warned = new Set();
      this.usesCharTable = false;
      this.usesHashKey = false;
      this.walkInit();
      for (const r of roots) {
        if (this.fallback.has(r)) continue;
        this.env = new Map();
        try {
          this.instOf(r, new Map(), new Map(), null, true, r);
        } catch (e) {
          if (!(e instanceof RetryRound)) throw e;
        }
      }
      for (let i = 0; i < this.queue.length; i++) {
        this.walkInst(this.queue[i]!);
        if (this.mem && i === this.queue.length - 1) {
          this.mapExportRoots();
          this.excRoots();
        }
      }
      if (this.mem) this.closeOverLong();
      if (!this.changed) {
        settled = true;
        break;
      }
    }
    if (!settled) throw new Error(`down-lowering did not settle in ${MAX_ROUNDS} rounds`);
    return this.finish(roots);
  }

  /** Everything the module exports, however it's written. Types have no run-time part to lower. */
  collectExports(): FnLike[] {
    const mod = this.checker.getSymbolAtLocation(this.rootSf);
    if (mod === undefined) return [];
    const roots: FnLike[] = [];
    const exports = [...this.checker.getExportsOfModule(mod)].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const ex of exports) {
      const sym = (ex.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(ex) : ex;
      if ((sym.flags & ts.SymbolFlags.Value) === 0) continue;
      const fn = this.topFunction(sym);
      if (fn !== null) {
        roots.push(fn);
        this.exportNames.set(fn, ex.name);
        continue;
      }
      // A class or value crossing to JS has no lowered form, so the JS copy provides it.
      const d = sym.valueDeclaration ?? sym.declarations?.[0];
      if (d !== undefined) {
        this.jsExports.push(ex.name);
        this.recordFallback(
          d,
          new Blocked("export-signature", d, `the export ${ex.name} isn't a function`),
        );
      }
    }
    return roots;
  }

  exportNames = new Map<FnLike, string>();
  jsExports: string[] = [];

  recordFallback(owner: ts.Node, e: Blocked): void {
    if (this.fallback.has(owner)) return;
    const node = (e.node as ts.Node | undefined) ?? owner;
    const sf = node.getSourceFile();
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const info: FallbackInfo = {
      blocker: e.blocker,
      detail: e.detail,
      line: pos.line + 1,
      col: pos.character + 1,
      file: repoRelative(sf.fileName),
      blockedCallers: [],
    };
    if (e.root !== undefined) {
      info.root = e.root;
      for (const f of this.fallback.values()) {
        if (f.root === undefined && e.root === f.line + ":" + f.file)
          f.blockedCallers.push(this.fnName(owner));
      }
    }
    this.fallback.set(owner, info);
    this.changed = true;
    // Module state a JS function touches can't also live in Wasm memory (SPEC 4.5, fallback).
    if (!ts.isSourceFile(owner)) {
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const s = this.symbolOf(n);
          if (s !== undefined && this.isModuleVar(s)) {
            const d = s.valueDeclaration as ts.VariableDeclaration;
            const isLet = (d.parent.flags & ts.NodeFlags.Const) === 0;
            if ((isLet || this.mutatedGlobals.has(s)) && !this.sharedGlobals.has(s)) {
              this.sharedGlobals.add(s);
              this.changed = true;
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(owner);
    }
  }

  isModuleVar(s: ts.Symbol): boolean {
    const d = s.valueDeclaration;
    if (d === undefined || !ts.isVariableDeclaration(d)) return false;
    return (
      ts.isVariableStatement(d.parent.parent) &&
      ts.isSourceFile(d.parent.parent.parent) &&
      !this.isLibSymbol(s)
    );
  }

  // --- instances

  instOf(
    decl: FnLike | ts.ClassLikeDeclaration,
    env: Env,
    lits: Map<number, number>,
    thisSh: Shape | null,
    exported: boolean,
    owner: ts.Node,
    lifted: Inst["lifted"] = null,
    liftKey = "",
  ): Inst {
    const litKey = [...lits].map(([i, v]) => `${i}=${v}`).join(",");
    const thisKey = thisSh !== null && thisSh.s === "obj" ? `#${findNode(thisSh.node).klass}` : "";
    const key = `${decl.getSourceFile().fileName}:${decl.pos}${this.envKey(env)}[${litKey}]${thisKey}${liftKey}`;
    let inst = this.insts.get(key);
    if (inst === undefined) {
      const n = (this.instCount.get(decl) ?? 0) + 1;
      this.instCount.set(decl, n);
      if (n > MAX_INSTANCES) {
        this.recordFallback(
          owner,
          new Blocked(
            "instantiation-cap",
            decl,
            `more than ${MAX_INSTANCES} instantiations of ${this.fnName(decl)}`,
          ),
        );
        throw new RetryRound();
      }
      const saved = { env: this.env, frame: this.frame };
      this.env = env;
      this.frame = { path: key, retSh: null, retLabel: null, retVar: null, stack: [] };
      let paramSh: Shape[];
      let retSh: Shape;
      try {
        paramSh = this.paramShapes(decl);
        retSh = this.returnShape(decl);
      } catch (e) {
        if (!(e instanceof Blocked)) throw e;
        // The signature blocks the callee, not the caller, which sees that next round.
        this.recordFallback(owner, e);
        throw new RetryRound();
      } finally {
        this.frame = saved.frame;
        this.env = saved.env;
      }
      const exportName = exported && !ts.isClassLike(decl) ? this.exportNames.get(decl) : undefined;
      const name = this.uniqueName(
        exportName ??
          `${this.fnName(decl)}${litKey !== "" ? `$${[...lits.values()].join("_")}` : ""}`,
      );
      inst = {
        key,
        decl,
        owner,
        env,
        lits,
        paramSh,
        retSh,
        thisSh,
        exported,
        lifted,
        run: false,
        fi: {
          key,
          tirName: name,
          jsName: name,
          params: [],
          ret: T.void,
          exported,
          attrs: exported ? ["export"] : [],
          body: [],
        },
      };
      this.insts.set(key, inst);
      this.changed = true;
    }
    if (lifted !== null) inst.lifted = lifted;
    // Whether this code can run after module init decides what its allocations may reach.
    const running = exported || (this.inst?.run ?? false);
    if (running && !inst.run) {
      inst.run = true;
      this.changed = true;
    }
    if (!this.visited.has(key)) {
      this.visited.add(key);
      this.queue.push(inst);
    }
    return inst;
  }

  uniqueName(base: string): string {
    const clean = base.replace(/[^\w.$<>]/g, "_").replace(/[<>]/g, "_");
    let name = clean === "" ? "fn" : clean;
    for (let i = 2; this.usedNames.has(name); i++) name = `${clean}$${i}`;
    this.usedNames.set(name, base);
    return name;
  }

  paramsOf(decl: FnLike | ts.ClassLikeDeclaration): readonly ts.ParameterDeclaration[] {
    if (ts.isClassLike(decl)) {
      const c = decl.members.find(ts.isConstructorDeclaration);
      if (c === undefined && this.mem) {
        // A derived class with no constructor takes its base's arguments, and passes them on.
        const b = this.baseDeclOf(decl);
        if (b !== null) return this.paramsOf(b);
      }
      return c?.parameters ?? [];
    }
    return decl.parameters;
  }

  paramShapes(decl: FnLike | ts.ClassLikeDeclaration): Shape[] {
    return this.paramsOf(decl).map((p, i) => {
      if (p.dotDotDotToken !== undefined) this.block("unsupported", p, "a rest parameter");
      const t = this.typeAt(p.name);
      if (this.isCallable(t) && !this.mem) {
        this.block("closure-escape", p, "a function parameter on a function that wasn't inlined");
      }
      const key = `${this.frame.path}#p${i}`;
      if (p.initializer !== undefined) {
        const sh = this.slot(key, t, p);
        if (sh.s === "num" || sh.s === "bool" || sh.s === "str") {
          return { s: "opt", of: sh, nul: "undefined" } as Shape;
        }
        return sh;
      }
      return this.slot(key, t, p);
    });
  }

  returnShape(decl: FnLike | ts.ClassLikeDeclaration): Shape {
    if (ts.isClassLike(decl) || ts.isConstructorDeclaration(decl)) return { s: "void" };
    if (ts.isFunctionLike(decl) && (decl as ts.FunctionDeclaration).asteriskToken !== undefined) {
      this.block("generator", decl, "a generator function");
    }
    if (decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) {
      this.block("async", decl, "an async function");
    }
    const sig = this.checker.getSignatureFromDeclaration(decl);
    if (sig === undefined) this.block("unsupported", decl, "no signature");
    const rt = this.subst(this.checker.getReturnTypeOfSignature(sig));
    if (hasFlag(rt, ts.TypeFlags.Never)) return { s: "void" };
    if (this.isCallable(rt) && !this.mem)
      this.block("closure-escape", decl, "a function that returns a function");
    return this.slot(`${this.frame.path}#ret`, rt, decl);
  }

  retTyOf(decl: FnLike | ts.ClassLikeDeclaration, retSh: Shape): Ty {
    if (!ts.isClassLike(decl) && !ts.isConstructorDeclaration(decl)) {
      const sig = this.checker.getSignatureFromDeclaration(decl);
      if (
        sig !== undefined &&
        hasFlag(this.checker.getReturnTypeOfSignature(sig), ts.TypeFlags.Never)
      )
        return NEVER_TY;
    }
    return tyOf(retSh);
  }

  walkInst(inst: Inst): void {
    if (this.fallback.has(inst.owner)) return;
    this.inst = inst;
    this.env = inst.env;
    this.scope = new Scope(null);
    this.nextVar = 1;
    this.loopDepth = 0;
    this.inInit = false;
    this.frame = {
      path: inst.key,
      retSh: inst.retSh,
      retLabel: null,
      retVar: null,
      stack: [],
    };
    try {
      this.walkBody(inst);
    } catch (e) {
      if (e instanceof RetryRound) return;
      if (e instanceof Blocked) {
        this.recordFallback(inst.owner, e);
        return;
      }
      throw e;
    }
  }

  walkBody(inst: Inst): void {
    const decl = inst.decl;
    const fi = inst.fi;
    const params: Var[] = [];
    const body: Stmt[] = [];
    if (inst.thisSh !== null) params.push(this.newVar({ k: "ref" }, "this"));
    if (inst.thisSh !== null) this.thisVar = { v: params[0]!, sh: inst.thisSh };
    else this.thisVar = null;
    if (inst.clo !== undefined) this.bindEnvironment(inst, params, body);
    if (inst.exported) {
      for (let i = 0; i < inst.paramSh.length; i++) {
        this.markExternal(
          inst.paramSh[i]!,
          ts.isClassLike(decl) || ts.isSourceFile(decl) ? decl : decl.parameters[i]!,
        );
      }
    }
    const ps = ts.isSourceFile(decl) ? [] : this.paramsOf(decl);
    ps.forEach((p, i) => {
      const sh = inst.paramSh[i]!;
      const v = this.newVar(tyOf(sh), p.name.getText());
      params.push(v);
      if (sh.s === "num") this.locOfVar.set(v, sh.loc);
      if (inst.clo !== undefined && p.initializer !== undefined && sh.s === "opt") {
        this.slots.set(`${this.frame.path}#p${i}`, sh.of);
      }
      const lit = inst.lits.get(i);
      this.bindParam(p, i, v, sh, lit, body);
    });
    if (inst.clo !== undefined) {
      // A closure with fewer parameters than its type's still takes them, as every call passes them.
      for (let i = ps.length; i < inst.paramSh.length; i++) {
        params.push(this.newVar(tyOf(inst.paramSh[i]!), `$unused${i}`));
      }
    }
    if (inst.lifted !== null) {
      const { captured, target, boxes, konsts } = inst.lifted;
      for (const sym of captured) {
        const sh = this.slots.get(`${inst.key}#cap${sym.name}`)!;
        const v = this.newVar(tyOf(sh), sym.name);
        params.push(v);
        const box = boxes?.get(sym);
        if (box !== undefined) this.scope.map.set(sym, { b: "box", v, node: box.node, sh: box.sh });
        else this.scope.map.set(sym, { b: "var", v, sh });
      }
      for (const [sym, b] of konsts ?? []) this.scope.map.set(sym, b);
      const self = this.symbolOfFn(target.decl);
      if (self !== undefined)
        this.scope.map.set(self, {
          b: "closure",
          targets: [{ ...target, scope: this.scope, round: this.round }],
          tag: null,
        });
    }
    fi.params = params;
    fi.ret = ts.isSourceFile(decl)
      ? T.void
      : inst.clo !== undefined
        ? tyOf(inst.retSh)
        : this.retTyOf(decl, inst.retSh);
    const derived = (c: ts.ClassLikeDeclaration): boolean =>
      this.mem && this.baseDeclOf(c) !== null;
    if (ts.isClassLike(decl)) {
      if (derived(decl)) {
        const args = params
          .slice(inst.thisSh !== null ? 1 : 0)
          .map((v, i) => this.varTE(v, inst.paramSh[i]!));
        body.push({ k: "expr", e: this.superCall(decl, args, decl) });
      } else this.classCtorBody(decl, body, inst);
    } else if (!ts.isSourceFile(decl)) {
      // A derived class's fields start after super() returns, which is where superCall puts them (D50).
      if (ts.isConstructorDeclaration(decl) && !derived(decl.parent))
        this.classCtorBody(decl.parent, body, inst);
      const b = decl.body;
      if (b === undefined) this.block("unsupported", decl, "a function without a body");
      if (ts.isBlock(b)) {
        this.hoist(b.statements);
        body.push(...this.stmts(b.statements));
        this.implicitReturn(body, inst.retSh);
      } else {
        const v = this.expr(b, inst.retSh.s === "void" ? undefined : inst.retSh);
        body.push(this.returnStmt(v, b));
      }
      if (inst.clo !== undefined && inst.retSh.s !== "void") {
        // Its own type may say void, where others that share this calling convention return a value.
        body.push({ k: "return", val: this.zeroOf(inst.retSh) });
      }
    }
    fi.body = body;
    if (inst.exported)
      this.markReturned(inst.retSh, ts.isClassLike(decl) || ts.isSourceFile(decl) ? decl : decl);
  }

  thisVar: { v: Var; sh: Shape } | null = null;
  locOfVar = new Map<Var, NumLoc>();

  implicitReturn(body: Stmt[], sh: Shape): void {
    if (sh.s === "void") return;
    if (sh.s === "opt" || sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      if (this.frame.retLabel !== null) {
        body.push({
          k: "expr",
          e: mk(T.void, {
            k: "setvar",
            v: this.frame.retVar!,
            val: this.flow(NULLISH, sh, this.rootSf),
          }),
        });
      } else body.push({ k: "return", val: this.flow(NULLISH, sh, this.rootSf) });
    }
  }

  bindParam(
    p: ts.ParameterDeclaration,
    i: number,
    v: Var,
    sh: Shape,
    lit: number | undefined,
    body: Stmt[],
  ): void {
    const read = this.varTE(v, sh);
    if (lit !== undefined) {
      if (sh.s === "num") {
        const l = litNum(lit);
        this.join(sh.loc, l);
        const sym = this.symbolOf(p.name)!;
        this.scope.map.set(sym, { b: "var", v, sh, konst: l });
        return;
      }
    }
    if (p.initializer !== undefined) {
      const key = `${this.frame.path}#p${i}`;
      const bodySh = this.slots.get(key) ?? sh;
      const dv = this.newVar(tyOf(bodySh), p.name.getText());
      if (sh.s === "opt") {
        const present = mk(T.bool, { k: "slice", val: read, from: 0, to: 1 });
        const def = this.flow(this.expr(p.initializer, bodySh), bodySh, p.initializer);
        body.push({
          k: "if",
          c: present,
          a: [{ k: "let", v: dv, init: this.optPayload(read, sh), constant: false }],
          b: [{ k: "let", v: dv, init: def, constant: false }],
        });
      } else {
        const isNull = this.cmpTE("eq", sh.s === "arr" ? read : read, nullPtr());
        const def = this.flow(this.expr(p.initializer, bodySh), bodySh, p.initializer);
        body.push({
          k: "if",
          c: isNull,
          a: [{ k: "let", v: dv, init: def, constant: false }],
          b: [{ k: "let", v: dv, init: read, constant: false }],
        });
      }
      this.bindName(p.name, dv, bodySh, body);
      this.bindParamProperty(p);
      return;
    }
    this.bindName(p.name, v, sh, body);
    this.bindParamProperty(p);
  }

  /**
   * `constructor(public k: number)`: the name has two symbols, the property's and the parameter's, and the body's uses of
   * `k` resolve to the parameter's. Both mean this binding.
   */
  bindParamProperty(p: ts.ParameterDeclaration): void {
    if (!this.mem || !ts.isIdentifier(p.name) || !ts.isParameterPropertyDeclaration(p, p.parent))
      return;
    const bound = this.scope.get(this.symbolOf(p.name)!);
    if (bound === undefined) return;
    for (const sym of this.checker.getSymbolsOfParameterPropertyDeclaration(p, p.name.text)) {
      this.scope.map.set(sym, bound);
    }
  }

  bindName(name: ts.BindingName, v: Var, sh: Shape, body: Stmt[]): void {
    if (ts.isIdentifier(name)) {
      const sym = this.symbolOf(name);
      if (sym !== undefined) this.bindVar(sym, v, sh, name, body);
      return;
    }
    this.bindPattern(name, this.varTE(v, sh), body);
  }

  /** Binds a name whose value is already in `v`. If a closure shares it, the value moves into a cell. */
  bindVar(sym: ts.Symbol, v: Var, sh: Shape, at: ts.Node, out: Stmt[]): void {
    if (!this.boxedSyms.has(sym)) {
      this.scope.map.set(sym, { b: "var", v, sh });
      return;
    }
    this.newBox(sym, this.varTE(v, sh), sh, at, out);
  }

  boxNode(sym: ts.Symbol, sh: Shape): HeapNode {
    const key = `box:${this.frame.path}:${(sym as unknown as { id?: number }).id ?? sym.name}:${sym.valueDeclaration?.pos ?? 0}`;
    let node = this.nodesByType.get(key);
    if (node === undefined) {
      node = newNode("obj");
      node.fields.set("v", sh);
      node.escapes = true;
      this.nodesByType.set(key, node);
      this.changed = true;
    }
    return node;
  }

  newBox(sym: ts.Symbol, init: TE | null, sh: Shape, at: ts.Node, out: Stmt[]): void {
    const node = this.boxNode(sym, sh);
    const objSh: Extract<Shape, { s: "obj" }> = { s: "obj", node };
    const p = this.newVar({ k: "ref" }, "$box");
    out.push({ k: "let", v: p, init: this.allocObj(objSh, at), constant: false });
    if (init !== null) {
      const val = this.flow(init, sh, at);
      out.push({ k: "expr", e: this.fieldStore(this.varTE(p, objSh), "v", node, val, true) });
    }
    this.scope.map.set(sym, { b: "box", v: p, node, sh });
  }

  boxRead(b: Extract<Binding, { b: "box" }>, at: ts.Node): TE {
    const r = this.fieldRead(this.varTE(b.v, { s: "obj", node: b.node }), "v", b.node, at);
    return this.narrowed(r, b.sh, at);
  }

  /** The bindings of an environment, loaded at entry: a closure's view of what it captured. */
  bindEnvironment(inst: Inst, params: Var[], body: Stmt[]): void {
    const clo = inst.clo!;
    const env = this.newVar({ k: "ref" }, "$env");
    params.push(env);
    const base = mk({ k: "ref" }, { k: "var", v: env });
    const load = (sh: Shape, off: number, name: string): Var => {
      const v = this.newVar(tyOf(sh), name);
      const te = mk(
        tyOf(sh),
        { k: "fload", base, mem: memOf(sh, off) },
        // `fld` (R3): the environment class's field, for class printing
        { sh, fld: { node: findNode(clo.node), name: envKey(inst.fi, off) } },
      );
      body.push({ k: "let", v, init: te, constant: false });
      return v;
    };
    for (const c of clo.caps) {
      switch (c.c) {
        case "value": {
          const v = load(c.sh, c.off, c.sym.name);
          if (c.dyn) {
            this.scope.map.set(c.sym, {
              b: "closure",
              tag: null,
              targets: [{ ...clo.target, key: "dyn:", round: this.round, dyn: { v, sh: c.sh } }],
            });
          } else this.scope.map.set(c.sym, { b: "var", v, sh: c.sh });
          break;
        }
        case "box": {
          const v = load({ s: "obj", node: c.node }, c.off, c.sym.name);
          this.scope.map.set(c.sym, { b: "box", v, node: c.node, sh: c.sh });
          break;
        }
        case "this":
          this.thisVar = { v: load(c.sh, c.off, "this"), sh: c.sh };
          break;
        case "same":
          this.scope.map.set(c.sym, c.b);
          break;
        case "closure":
          this.scope.map.set(c.sym, {
            b: "closure",
            tag: null,
            targets: c.targets.map((t) => ({ ...t, scope: this.scope, round: this.round })),
          });
          break;
      }
    }
  }

  /** What a closure uses from outside it, following the closures it would inline (SPEC 4.5). */
  freeOf(
    decl: FnLike,
    scope: Scope,
    seen: Set<FnLike>,
    out: Map<ts.Symbol, Binding>,
    st: { usesThis: boolean },
    root: FnLike,
  ): void {
    if (seen.has(decl)) return;
    seen.add(decl);
    const inside = (d: ts.Node): boolean => d.pos >= root.pos && d.end <= root.end;
    const walk = (n: ts.Node, thisIsOurs: boolean): void => {
      if (n.kind === ts.SyntaxKind.ThisKeyword && thisIsOurs) st.usesThis = true;
      if (ts.isIdentifier(n)) {
        const parent = n.parent;
        const isName =
          (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n);
        const s = isName
          ? undefined
          : ts.isShorthandPropertyAssignment(parent) && parent.name === n
            ? this.symbolOf(parent)
            : this.symbolOf(n);
        if (s !== undefined && !out.has(s)) {
          const d = s.valueDeclaration;
          const b = scope.get(s);
          if (b !== undefined && !(d !== undefined && inside(d) && d !== root.parent)) {
            out.set(s, b);
            if (b.b === "closure") {
              if (b.tag !== null)
                this.block("closure-escape", n, `a closure capturing ${s.name}, a selection`);
              for (const t of b.targets) {
                if (t.dyn === undefined) this.freeOf(t.decl, t.scope, seen, out, st, t.decl);
              }
            }
          } else if (
            b === undefined &&
            d !== undefined &&
            (ts.isVariableDeclaration(d) || ts.isParameter(d)) &&
            !inside(d) &&
            !this.isLibSymbol(s) &&
            !this.isModuleVar(s) &&
            this.topFunction(s) === null
          ) {
            this.block("closure-escape", n, `a closure made before ${s.name}, which it captures`);
          }
        }
      }
      ts.forEachChild(n, (c) => {
        walk(c, thisIsOurs && !(ts.isFunctionLike(c) && !ts.isArrowFunction(c)));
      });
    };
    walk(decl, true);
  }

  needsBox(s: ts.Symbol): boolean {
    return this.rebound.has(s);
  }

  /** The closure value for a known target: its environment struct, with the code pointer first. */
  materialize(t: Target, at: ts.Node): TE {
    if (t.dyn !== undefined) return this.varTE(t.dyn.v, t.dyn.sh);
    const saved = this.env;
    this.env = t.env;
    const fnT = this.subst(this.checker.getTypeAtLocation(t.decl)) as ts.ObjectType;
    let node: HeapNode;
    try {
      node = this.fnNode(fnT, at);
    } finally {
      this.env = saved;
    }
    const sh: Extract<Shape, { s: "obj" }> = { s: "obj", node };
    const free = new Map<ts.Symbol, Binding>();
    const st = { usesThis: false };
    this.freeOf(t.decl, t.scope, new Set(), free, st, t.decl);
    const self = this.symbolOfFn(t.decl);
    const caps: Capture[] = [];
    const stores: { off: number; sh: Shape; val: TE }[] = [];
    let off = 8;
    const place = (cap: Shape, val: TE): number => {
      const at0 = off;
      off += Math.ceil(sizeOf(cap) / 8) * 8;
      stores.push({ off: at0, sh: cap, val });
      this.markEscape(cap);
      this.addCap(node, cap);
      return at0;
    };
    if (st.usesThis) {
      if (this.thisVar === null) this.block("closure-escape", at, "this outside a method");
      const s = this.thisVar.sh;
      caps.push({ c: "this", off: place(s, this.varTE(this.thisVar.v, s)), sh: s });
    }
    for (const [sym, b] of free) {
      switch (b.b) {
        case "var":
          if (b.konst !== undefined) {
            caps.push({ c: "same", sym, b });
            break;
          }
          if (this.needsBox(sym) && !this.boxedSyms.has(sym)) {
            // Next round's walk binds it in a cell, and this round's tree is thrown away.
            this.boxedSyms.add(sym);
            this.changed = true;
          }
          caps.push({
            c: "value",
            sym,
            off: place(b.sh, this.varTE(b.v, b.sh)),
            sh: b.sh,
            dyn: false,
          });
          break;
        case "box": {
          const objSh: Shape = { s: "obj", node: b.node };
          const val = this.varTE(b.v, objSh);
          caps.push({ c: "box", sym, off: place(objSh, val), node: b.node, sh: b.sh });
          break;
        }
        case "closure": {
          const dyn = b.targets.find((x) => x.dyn !== undefined)?.dyn;
          if (dyn !== undefined) {
            const val = this.varTE(dyn.v, dyn.sh);
            caps.push({ c: "value", sym, off: place(dyn.sh, val), sh: dyn.sh, dyn: true });
          } else caps.push({ c: "closure", sym, targets: b.targets });
          break;
        }
        case "sroa":
          this.block("closure-escape", at, `a closure capturing the scalar-replaced ${sym.name}`);
      }
    }
    if (self !== undefined && !free.has(self) && this.selfRecursive(t.decl)) {
      caps.push({ c: "closure", sym: self, targets: [t] });
    }
    const inst = this.cloInst(t, node, caps, off, at);
    const size = off;
    const out: Stmt[] = [];
    const inLoop = this.loopDepth > 0 || !this.inst.run;
    const stack = (): number | null => {
      const m = findNode(node);
      return !m.escapes && !m.global && !inLoop ? size : null;
    };
    this.noteAlloc("closure environment", at, stack, node);
    const p = this.temp(
      mk(
        { k: "ref" },
        {
          k: "alloc",
          size: litIx(size),
          zero: false,
          stack,
          loc: this.loc(at),
          long: () => this.longAlloc(node),
          rcRefs: () => stores.map((s) => ({ off: s.off, sh: s.sh })),
        },
        { sh },
      ),
      out,
    );
    const code = mk({ k: "fn", params: [], ret: T.void }, { k: "fnref", inst: inst.fi });
    // `fld` (R3): class printing's environment class, whose kind field says which closure it is, and a field a capture
    const envFld = (name: string): { fld: { node: unknown; name: string } } => ({
      fld: { node: findNode(node), name },
    });
    out.push({
      k: "expr",
      e: mk(
        code.ty,
        { k: "fstore", base: p, mem: [{ t: "ptr", off: 0 }], val: code },
        envFld("$kind"),
      ),
    });
    for (const s of stores) {
      out.push({
        k: "expr",
        e: mk(
          s.val.ty,
          {
            k: "fstore",
            base: p,
            mem: memOf(s.sh, s.off),
            val: { ...s.val, sh: s.sh } as TE,
            rc: "init",
          },
          envFld(envKey(inst.fi, s.off)),
        ),
      });
    }
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: p }, { sh });
  }

  longAlloc(node: HeapNode): string | null {
    if (!findNode(node).long) return null;
    if (this.memory === "rc") return "__rc_new";
    return this.memory === "leak" ? "__leak_alloc" : "__heap_alloc";
  }

  /** A vector runtime function, for this class of vectors. A caller's buffer isn't this module's to free. */
  vecFn(base: string, node: HeapNode): string {
    const n = findNode(node);
    if (!this.mem || !n.long) return base;
    if (this.memory === "leak") return `${base}_leak`;
    if (this.memory === "rc") return `${base}_rc`;
    return n.external ? `${base}_heapk` : `${base}_heap`;
  }

  cloInst(t: Target, node: HeapNode, caps: Capture[], size: number, at: ts.Node): Inst {
    const key = `clo:${t.key}`;
    const n = findNode(node);
    if (t.decl.parameters.length > n.params.length) {
      this.block("closure-escape", at, "a function value with more parameters than its type");
    }
    let inst = this.insts.get(key);
    if (inst === undefined) {
      const name = this.uniqueName(`${this.fnName(t.decl)}$clo`);
      inst = {
        key,
        decl: t.decl,
        owner: this.inst.owner,
        env: t.env,
        lits: new Map(),
        paramSh: n.params,
        retSh: n.ret ?? { s: "void" },
        thisSh: null,
        exported: false,
        lifted: null,
        run: true,
        fi: {
          key,
          tirName: name,
          jsName: name,
          params: [],
          ret: T.void,
          exported: false,
          attrs: [],
          body: [],
        },
      };
      this.insts.set(key, inst);
      this.changed = true;
    }
    inst.paramSh = n.params;
    inst.retSh = n.ret ?? { s: "void" };
    inst.clo = { target: t, node, caps, size };
    // For class printing (R3): what an environment of this closure holds, keyed as its loads and stores' `fld`.
    inst.fi.cloEnv = {
      node: findNode(node),
      caps: caps.flatMap((c) =>
        c.c === "value" || c.c === "box" || c.c === "this"
          ? [
              {
                key: envKey(inst!.fi, c.off),
                name: c.c === "this" ? "self" : c.sym.name,
                sh: c.c === "box" ? ({ s: "obj", node: c.node } as Shape) : c.sh,
              },
            ]
          : [],
      ),
    };
    if (!this.visited.has(key)) {
      this.visited.add(key);
      this.queue.push(inst);
    }
    return inst;
  }

  /** A call through a closure value: code pointer from the environment, environment first (SPEC 4.5). */
  dynCall(fn: TE, args: Arg[], node: ts.Node): TE {
    const sh = fn.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj" || findNode(sh.node).kind !== "fn") {
      this.block("closure-escape", node, "calling something that isn't a closure");
    }
    const n = findNode(sh.node);
    const out: Stmt[] = [];
    const clo = this.temp({ ...fn }, out);
    const vals: TE[] = [];
    const params = [...n.params];
    params.forEach((p, i) => {
      const a = args[i];
      let te: TE;
      if (a?.targets !== undefined) {
        if (a.targets.length !== 1)
          this.block("closure-escape", node, "a selection as an argument");
        te = this.materialize(a.targets[0]!, node);
      } else te = a?.te ?? NULLISH;
      vals.push(p.s === "void" ? te : this.flow(te, p, node));
    });
    const ret = n.ret ?? { s: "void" as const };
    const ex: Partial<TE> = { sh: ret };
    if (ret.s === "num") {
      const l = findLoc(ret.loc);
      ex.deps = [ret.loc];
      if (l.seen) ex.range = [l.lo, l.hi];
      if (l.negz) ex.negz = true;
    }
    const call = mk(
      tyOf(ret),
      { k: "callclo", clo, args: vals, params: params.map(tyOf), ret: tyOf(ret) },
      ex,
    );
    const whole = this.withPrelude(out, call);
    return ret.s === "opt" && ts.isCallExpression(node) ? this.narrowed(whole, ret, node) : whole;
  }

  /** Whether a function-valued expression's target is known here, so a call can inline it. */
  isStaticFn(e0: ts.Expression): boolean {
    const e = strip(e0);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
    if (ts.isNonNullExpression(e)) return this.isStaticFn(e.expression);
    if (!ts.isIdentifier(e)) return false;
    const sym = this.symbolOf(e);
    if (sym === undefined) return false;
    const b = this.scope.get(sym);
    if (b !== undefined) return b.b === "closure";
    return this.topFunction(sym) !== null;
  }

  /** A closure value held in a variable, as a target: what callbacks and inlined callees take. */
  dynTarget(te: TE, at: ts.Node, out: Stmt[]): Target {
    const sh = te.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj") {
      this.block("closure-escape", at, "a function value that isn't a closure");
    }
    const v = this.newVar({ k: "ref" }, "$f");
    out.push({ k: "let", v, init: te, constant: true });
    return {
      decl: at as FnLike,
      scope: this.scope,
      env: this.env,
      key: "dyn:",
      round: this.round,
      dyn: { v, sh },
    };
  }

  symbolOfFn(decl: FnLike): ts.Symbol | undefined {
    if (ts.isFunctionDeclaration(decl) && decl.name !== undefined) return this.symbolOf(decl.name);
    const p = decl.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return this.symbolOf(p.name);
    return undefined;
  }

  classCtorBody(c: ts.ClassLikeDeclaration, body: Stmt[], inst: Inst): void {
    const thisTE = this.varTE(inst.fi.params[0]!, inst.thisSh!);
    const node = findNode((inst.thisSh as Extract<Shape, { s: "obj" }>).node);
    // A field's first store has no old value to release, unless an initialiser can already reach `this`.
    const usesThis = (n: ts.Node): boolean =>
      n.kind === ts.SyntaxKind.ThisKeyword || ts.forEachChild(n, usesThis) === true;
    // After a base constructor, a method it dispatched to may already have set a field.
    const fresh =
      !(this.mem && this.baseDeclOf(c) !== null) &&
      !c.members.some(
        (m) =>
          ts.isPropertyDeclaration(m) && m.initializer !== undefined && usesThis(m.initializer),
      );
    // Class field initialisers run first, then parameter properties, then the body, as tsc emits.
    const isStatic = (m: ts.ClassElement): boolean =>
      ts.canHaveModifiers(m) &&
      ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true;
    for (const m of c.members) {
      if (ts.isPropertyDeclaration(m) && m.initializer !== undefined && !isStatic(m)) {
        const name = this.fieldKeyOfDecl(m.name.getText(), c);
        const sh = node.fields.get(name);
        if (sh === undefined) this.block("unsupported", m, `no field ${name}`);
        const te = this.flow(this.expr(m.initializer, sh), sh, m.initializer);
        this.markEscape(sh);
        body.push({ k: "expr", e: this.fieldStore(thisTE, name, node, te, fresh) });
      }
    }
    const ctor = c.members.find(ts.isConstructorDeclaration);
    if (ctor !== undefined) {
      for (const p of ctor.parameters) {
        if (ts.isParameterPropertyDeclaration(p, ctor) && ts.isIdentifier(p.name)) {
          const name = this.fieldKeyOfDecl(p.name.text, c);
          const sh = findNode(node).fields.get(name);
          if (sh === undefined) this.block("unsupported", p, `no field ${name}`);
          const sym = this.scope.get(this.symbolOf(p.name)!);
          if (sym === undefined || sym.b !== "var")
            this.block("unsupported", p, "a parameter property without a binding");
          const te = this.flow(this.varTE(sym.v, sym.sh), sh, p);
          this.markEscape(sh);
          body.push({ k: "expr", e: this.fieldStore(thisTE, name, node, te, fresh) });
        }
      }
    }
  }

  // --- module init

  walkInit(): void {
    this.inst = this.initInst();
    this.env = new Map();
    this.scope = new Scope(null);
    this.nextVar = 1;
    this.loopDepth = 0;
    this.inInit = true;
    this.thisVar = null;
    this.frame = { path: "init", retSh: null, retLabel: null, retVar: null, stack: [] };
    const body: Stmt[] = [
      { k: "expr", e: mk(T.void, { k: "rtcall", name: "__arena_start", args: [] }) },
    ];
    for (const sf of this.files) {
      for (const st of sf.statements) {
        try {
          const out = this.initStatement(st);
          for (const x of out) this.initFiles.set(x, sf);
          body.push(...out);
        } catch (e) {
          if (e instanceof RetryRound) continue;
          if (!(e instanceof Blocked)) throw e;
          this.initStatementBlocked(st, e);
        }
      }
    }
    body.push({ k: "expr", e: mk(T.void, { k: "rtcall", name: "__arena_commit", args: [] }) });
    this.inst.fi.body = body;
    this.inInit = false;
  }

  initBlockedRoot: Blocked | null = null;

  initStatementBlocked(st: ts.Statement, e: Blocked): void {
    // Everything this statement touches is JS-only now, and so is whatever reads it.
    if (!this.fallback.has(st)) {
      this.recordFallback(st, e);
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const s = this.symbolOf(n);
          if (s !== undefined && this.isModuleVar(s) && !this.initBlocked.has(s)) {
            this.initBlocked.add(s);
            this.changed = true;
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(st);
    }
  }

  initInst(): Inst {
    const key = "<init>";
    let inst = this.insts.get(key);
    if (inst === undefined) {
      inst = {
        key,
        decl: this.rootSf,
        owner: this.rootSf,
        env: new Map(),
        lits: new Map(),
        paramSh: [],
        retSh: { s: "void" },
        thisSh: null,
        exported: true,
        lifted: null,
        run: false,
        fi: {
          key,
          tirName: "__init",
          jsName: "__init",
          params: [],
          ret: T.void,
          exported: true,
          attrs: ["export"],
          body: [],
        },
      };
      this.insts.set(key, inst);
    }
    return inst;
  }

  initStatement(st: ts.Statement): Stmt[] {
    if (this.fallback.has(st)) return [];
    if (ts.isClassDeclaration(st)) return this.initStatics(st);
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isImportDeclaration(st) ||
      ts.isEnumDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isModuleDeclaration(st) ||
      ts.isExportAssignment(st)
    )
      return [];
    if (ts.isVariableStatement(st)) {
      const out: Stmt[] = [];
      for (const d of st.declarationList.declarations) out.push(...this.initVar(d));
      return out;
    }
    return this.stmt(st);
  }

  initVar(d: ts.VariableDeclaration): Stmt[] {
    if (!ts.isIdentifier(d.name)) this.block("unsupported", d, "a destructuring at the top level");
    const init = d.initializer;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
      return [];
    const sym = this.symbolOf(d.name)!;
    const entry = this.globalEntry(sym, d);
    if (entry.konst !== undefined || entry.arrayDef !== undefined) return [];
    if (init === undefined) return [];
    const gname = entry.name;
    const te = this.flow(this.expr(init, entry.sh), entry.sh, init);
    this.markGlobal(entry.sh);
    return [{ k: "expr", e: this.globalStore(gname, entry.sh, te) }];
  }

  /** A module-level binding: a folded constant, a static typed array, or a slot written by __init. */
  globalEntry(sym: ts.Symbol, d: ts.VariableDeclaration): GlobalEntry {
    const hit = this.globals.get(sym);
    if (hit !== undefined) return hit;
    const isConst = (d.parent.flags & ts.NodeFlags.Const) !== 0;
    const t = this.checker.getTypeAtLocation(d.name);
    const name = `g.${this.uniqueName(this.topQualified(sym.name, d))}`;
    this.globalFiles.set(name, d.getSourceFile());
    const saved = { frame: this.frame, env: this.env };
    this.frame = { path: "init", retSh: null, retLabel: null, retVar: null, stack: [] };
    this.env = new Map();
    const entry: GlobalEntry = { name, sh: { s: "void" }, dynamicBlocked: false, isConst };
    const init = d.initializer;
    // A const number or literal folds; a const typed array of constants becomes initialised bytes.
    if (isConst && init !== undefined) {
      const c = this.foldConst(init);
      if (c !== null) entry.konst = c;
      const arr = c === null ? this.staticTypedArray(name, init) : null;
      if (arr !== null) {
        entry.arrayDef = arr;
        const node = newNode("arr");
        node.global = true;
        node.escapes = true;
        entry.sh = { s: "arr", elem: arr.array!.elem, node };
        this.globalDefs.set(name, arr);
      }
    }
    if (entry.konst === undefined && entry.arrayDef === undefined) {
      entry.sh = this.slot(`global:${name}`, t, d);
    } else if (entry.konst !== undefined) entry.sh = { s: "void" };
    this.frame = saved.frame;
    this.env = saved.env;
    this.globals.set(sym, entry);
    return entry;
  }

  foldConst(e0: ts.Expression): TE | null {
    const e = strip(e0);
    if (ts.isNumericLiteral(e)) return litNum(Number(e.text));
    if (ts.isStringLiteralLike(e)) return this.strLit(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return litBool(true);
    if (e.kind === ts.SyntaxKind.FalseKeyword) return litBool(false);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const c = litOf(this.foldConst(e.operand));
      return c !== null ? litNum(-c) : null;
    }
    return this.foldNumExpr(e);
  }

  foldNumExpr(e: ts.Expression): TE | null {
    const v = this.checker.getConstantValue(e as ts.PropertyAccessExpression);
    if (typeof v === "number") return litNum(v);
    if (ts.isBinaryExpression(e)) {
      const a = this.foldConst(e.left);
      const b = this.foldConst(e.right);
      if (a === null || b === null) return null;
      if (
        a.k !== "lit" ||
        b.k !== "lit" ||
        typeof a.value !== "number" ||
        typeof b.value !== "number"
      )
        return null;
      const r = foldBinary(e.operatorToken.kind, a.value, b.value);
      return r === null ? null : litNum(r);
    }
    if (ts.isIdentifier(e)) {
      const s = this.symbolOf(e);
      const d = s?.valueDeclaration;
      if (
        d !== undefined &&
        ts.isVariableDeclaration(d) &&
        (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
        d.initializer !== undefined &&
        this.isModuleVar(s!)
      ) {
        return this.foldConst(d.initializer);
      }
    }
    return null;
  }

  staticTypedArray(name: string, init0: ts.Expression): GlobalDef | null {
    const init = strip(init0);
    if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) return null;
    const elem = ELEM_BY_ARRAY[init.expression.text];
    if (elem === undefined || elem === "u64" || elem === "i64") return null;
    const sym = this.symbolOf(init.expression);
    if (sym === undefined || !this.isLibSymbol(sym)) return null;
    const arg = init.arguments?.[0];
    if (arg === undefined) return null;
    const t: Ty = { k: "arr", elem };
    const a = strip(arg);
    if (ts.isArrayLiteralExpression(a)) {
      const vals: number[] = [];
      for (const x of a.elements) {
        const c = litOf(this.foldConst(x));
        if (c === null) return null;
        vals.push(c);
      }
      const norm = normElems(elem, vals);
      return {
        name,
        jsName: name,
        ty: t,
        mutable: false,
        array: { elem, length: vals.length, bytes: packElems(elem, norm), values: norm },
      };
    }
    const c = litOf(this.foldConst(a));
    if (c !== null && Number.isInteger(c) && c >= 0) {
      return { name, jsName: name, ty: t, mutable: false, array: { elem, length: c } };
    }
    return null;
  }

  globalStore(name: string, sh: Shape, val: TE): TE {
    return mk(
      val.ty,
      { k: "fstore", base: mk({ k: "ref" }, { k: "gaddr", name }), mem: memOf(sh, 0), val },
      { ...this.carry(val), glob: { name, sh } },
    );
  }

  globalRead(sym: ts.Symbol, d: ts.VariableDeclaration, node: ts.Node): TE {
    if (this.initBlocked.has(sym)) {
      this.block("global-init", node, `${sym.name} has an initialiser lowered code can't run`);
    }
    if (this.sharedGlobals.has(sym)) {
      this.block("shared-state", node, `${sym.name} is shared with a function that stays JS`);
    }
    const entry = this.globalEntry(sym, d);
    if (entry.konst !== undefined) return entry.konst;
    if (entry.arrayDef !== undefined) {
      return mk(
        { k: "arr", elem: entry.arrayDef.array!.elem },
        { k: "global", g: entry.arrayDef },
        { sh: entry.sh },
      );
    }
    this.markGlobal(entry.sh);
    const sh = entry.sh;
    const base = mk({ k: "ref" }, { k: "gaddr", name: entry.name });
    return this.memRead(base, sh, node, entry.name);
  }

  memRead(base: TE, sh: Shape, node: ts.Node, glob?: string): TE {
    const extra: Partial<TE> = { sh };
    if (glob !== undefined) extra.glob = { name: glob, sh };
    if (sh.s === "num") {
      const l = findLoc(sh.loc);
      extra.deps = [sh.loc];
      if (l.seen) extra.range = [l.lo, l.hi];
      if (l.negz) extra.negz = true;
    }
    const te = mk(tyOf(sh), { k: "fload", base, mem: memOf(sh, 0) }, extra);
    return this.narrowed(te, sh, node);
  }

  /** Reads a nullable place: where the checker has narrowed it, only the payload is left. */
  narrowed(te: TE, sh: Shape, node: ts.Node): TE {
    if (sh.s !== "opt") return te;
    // tsc narrows `p.f` to what was assigned to it even where the assignment's right side reassigned `p` first (R3)
    if (this.unsoundlyNarrowed(node)) return te;
    const t = this.typeAt(node);
    if (this.nonNullable(t) && !hasFlag(t, ts.TypeFlags.Never)) return this.optPayload(te, sh);
    return te;
  }

  /** A loop's counter, read in its body, is within what its condition allows, as widened by writes there (`loopBound`). */
  narrowVar = new Map<Var, [number, number]>();

  varTE(v: Var, sh: Shape): TE {
    const extra: Partial<TE> = { sh };
    if (sh.s === "num") {
      const l = findLoc(sh.loc);
      extra.deps = [sh.loc];
      if (l.seen) {
        const n = this.narrowVar.get(v);
        extra.range = n === undefined ? [l.lo, l.hi] : [Math.max(l.lo, n[0]), Math.min(l.hi, n[1])];
        if (extra.range[0] > extra.range[1]) extra.range = [l.lo, l.hi];
      }
      if (l.negz) extra.negz = true;
    }
    return mk(v.ty, { k: "var", v }, extra);
  }

  fieldOffset(node: HeapNode, name0: string, at: ts.Node): { off: number; sh: Shape } {
    const n = findNode(node);
    const name = this.fkey(n, name0, at);
    const sh = n.fields.get(name);
    if (sh === undefined) this.block("unsupported", at, `no field ${name}`);
    return { off: layoutOf(n).offs.get(name)!, sh };
  }

  fieldStore(base: TE, name0: string, node: HeapNode, val: TE, init = false, at?: ts.Node): TE {
    const n = findNode(node);
    const name = this.fkey(n, name0, at);
    const sh = n.fields.get(name)!;
    const off = layoutOf(n).offs.get(name)!;
    this.markWritten({ s: "obj", node: n });
    if (n.global) this.markGlobal(sh);
    return mk(
      val.ty,
      { k: "fstore", base, mem: memOf(sh, off), val, ...(init ? { rc: "init" as const } : {}) },
      { ...this.carry(val), fld: { node: n, name } },
    );
  }

  fieldRead(base: TE, name: string, node: HeapNode, at: ts.Node): TE {
    const { off, sh } = this.fieldOffset(node, name, at);
    const extra: Partial<TE> = {
      sh,
      fld: { node: findNode(node), name: this.fkey(findNode(node), name, at) },
    };
    if (sh.s === "num") {
      const l = findLoc(sh.loc);
      extra.deps = [sh.loc];
      if (l.seen) extra.range = [l.lo, l.hi];
      if (l.negz) extra.negz = true;
    }
    return mk(tyOf(sh), { k: "fload", base, mem: memOf(sh, off) }, extra);
  }

  strLit(s: string): TE {
    if (this.strRt) return this.strStatic(s);
    if (!this.strings.has(s)) this.strings.set(s, this.strings.size + 1);
    return mk(
      { k: "lits", kind: "str", values: [s] },
      { k: "lit", value: s },
      { sh: { s: "str" } },
    );
  }

  // --- statements

  hoist(list: readonly ts.Statement[]): void {
    for (const st of list) {
      if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.body !== undefined) {
        const sym = this.symbolOf(st.name);
        if (sym !== undefined)
          this.scope.map.set(sym, { b: "closure", targets: [this.targetOf(st)], tag: null });
      }
    }
  }

  stmts(list: readonly ts.Statement[]): Stmt[] {
    const out: Stmt[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Using) !== 0) {
        if (!this.mem)
          this.block("try-catch", s, "using needs exceptions, which need a memory mode");
        out.push(...this.usingRest(s.declarationList, list.slice(i + 1)));
        return out;
      }
      out.push(...this.stmt(s));
    }
    return out;
  }

  inBlock<R>(f: () => R): R {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return f();
    } finally {
      this.scope = saved;
    }
  }

  blockOf(s: ts.Statement): Stmt[] {
    return this.inBlock(() => {
      if (ts.isBlock(s)) {
        this.hoist(s.statements);
        return this.stmts(s.statements);
      }
      return this.stmt(s);
    });
  }

  stmt(s: ts.Statement): Stmt[] {
    switch (s.kind) {
      case ts.SyntaxKind.Block:
        return [{ k: "block", body: this.blockOf(s) }];
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        return [];
      case ts.SyntaxKind.VariableStatement:
        return this.varList((s as ts.VariableStatement).declarationList);
      case ts.SyntaxKind.ExpressionStatement:
        return [{ k: "expr", e: this.exprStmt((s as ts.ExpressionStatement).expression) }];
      case ts.SyntaxKind.IfStatement: {
        const st = s as ts.IfStatement;
        const c = this.condition(st.expression);
        if (c.k === "lit") {
          if (c.value === true) return [{ k: "block", body: this.blockOf(st.thenStatement) }];
          return st.elseStatement !== undefined
            ? [{ k: "block", body: this.blockOf(st.elseStatement) }]
            : [];
        }
        const a = this.blockOf(st.thenStatement);
        const b = st.elseStatement !== undefined ? this.blockOf(st.elseStatement) : null;
        return [{ k: "if", c, a, b }];
      }
      case ts.SyntaxKind.WhileStatement: {
        const st = s as ts.WhileStatement;
        this.loopDepth++;
        const c = this.condition(st.expression);
        const bound = this.loopBound(st.expression, c, [st.statement]);
        if (bound !== null) this.narrowVar.set(bound.v, bound.range);
        let body: Stmt[];
        try {
          body = this.blockOf(st.statement);
        } finally {
          if (bound !== null) this.narrowVar.delete(bound.v);
        }
        this.loopDepth--;
        return [{ k: "while", c, body }];
      }
      case ts.SyntaxKind.DoStatement: {
        const st = s as ts.DoStatement;
        this.loopDepth++;
        const body = this.blockOf(st.statement);
        const c = this.condition(st.expression);
        this.loopDepth--;
        return [{ k: "do", body, c }];
      }
      case ts.SyntaxKind.ForStatement:
        return this.forStmt(s as ts.ForStatement);
      case ts.SyntaxKind.ForOfStatement:
        return this.forOf(s as ts.ForOfStatement);
      case ts.SyntaxKind.ForInStatement:
        this.block("computed-key", s, "for...in needs run-time keys");
        break;
      case ts.SyntaxKind.SwitchStatement:
        return this.switchStmt(s as ts.SwitchStatement);
      case ts.SyntaxKind.ReturnStatement: {
        const st = s as ts.ReturnStatement;
        if (st.expression === undefined) {
          if (this.frame.retSh !== null && this.frame.retSh.s !== "void") {
            return [this.returnStmt(NULLISH, st)];
          }
          return this.frame.retLabel !== null
            ? [{ k: "break", label: this.frame.retLabel }]
            : [{ k: "return", val: null }];
        }
        const te = this.expr(st.expression, this.frame.retSh ?? undefined);
        return [this.returnStmt(te, st.expression)];
      }
      case ts.SyntaxKind.BreakStatement:
        return [{ k: "break", label: (s as ts.BreakStatement).label?.text ?? null }];
      case ts.SyntaxKind.ContinueStatement:
        return [{ k: "continue", label: (s as ts.ContinueStatement).label?.text ?? null }];
      case ts.SyntaxKind.LabeledStatement: {
        const st = s as ts.LabeledStatement;
        const inner = this.stmt(st.statement);
        const last = inner[inner.length - 1];
        // A for...of is its setup and then a loop, and `continue label` needs the label on the loop.
        if (inner.length > 1 && last !== undefined && (last.k === "for" || last.k === "while")) {
          return [...inner.slice(0, -1), { k: "label", name: st.label.text, body: last }];
        }
        const body: Stmt = inner.length === 1 ? inner[0]! : { k: "block", body: inner };
        return [{ k: "label", name: st.label.text, body }];
      }
      case ts.SyntaxKind.ThrowStatement: {
        const x = (s as ts.ThrowStatement).expression;
        if (this.mem && !this.excOn) {
          // Nothing can catch: the trap path, if it can say this (4.5). Otherwise everything is an exception (D49).
          try {
            if (this.isStaticThrow(x)) return [{ k: "expr", e: this.throwTE(x, s) }];
          } catch (err) {
            if (!(err instanceof Blocked) || err.blocker !== "throw-non-error") throw err;
          }
        }
        if (this.mem) return [{ k: "expr", e: this.raiseTE(this.expr(x), s) }];
        return [{ k: "expr", e: this.throwTE(x, s) }];
      }
      case ts.SyntaxKind.TryStatement:
        if (this.mem) return this.tryStmt(s as ts.TryStatement);
        this.block("try-catch", s, "try/catch needs unwinding, and a thrown value a memory mode");
        break;
      case ts.SyntaxKind.ClassDeclaration:
        if (this.mem) {
          this.localClass(s as ts.ClassDeclaration);
          return [];
        }
        this.block("unsupported", s, "a class declared inside a function");
        break;
      default:
        this.block("unsupported", s, `the statement ${ts.SyntaxKind[s.kind]}`);
    }
    return [];
  }

  returnStmt(te: TE, at: ts.Node): Stmt {
    const f = this.frame;
    const sh = f.retSh ?? { s: "void" as const };
    if (te.ty.k === "never") return { k: "expr", e: te };
    if (sh.s === "fn") this.block("closure-escape", at, "a function returned from a function");
    const v = sh.s === "void" ? te : this.flow(te, sh, at);
    if (f.retLabel === null) this.markEscape(sh);
    if (f.retLabel !== null) {
      const body: Stmt[] = [];
      if (sh.s === "void" || f.retVar === null) body.push({ k: "expr", e: v });
      else body.push({ k: "expr", e: mk(v.ty, { k: "setvar", v: f.retVar, val: v }) });
      body.push({ k: "break", label: f.retLabel });
      return { k: "block", body };
    }
    if (sh.s === "void") {
      return {
        k: "block",
        body: [
          { k: "expr", e: v },
          { k: "return", val: null },
        ],
      };
    }
    return { k: "return", val: v };
  }

  forStmt(s: ts.ForStatement): Stmt[] {
    return this.inBlock(() => {
      const init: Stmt[] = [];
      if (s.initializer !== undefined) {
        if (ts.isVariableDeclarationList(s.initializer)) init.push(...this.varList(s.initializer));
        else init.push({ k: "expr", e: this.exprStmt(s.initializer) });
      }
      this.loopDepth++;
      const boxed = this.mem ? this.loopBoxes(s) : [];
      for (const b of boxed) init.push(...this.copyBox(b, s));
      const c = s.condition !== undefined ? this.condition(s.condition) : null;
      const bound =
        c !== null && s.condition !== undefined
          ? this.loopBound(s.condition, c, [
              s.statement,
              ...(s.incrementor !== undefined ? [s.incrementor] : []),
            ])
          : null;
      if (bound !== null) this.narrowVar.set(bound.v, bound.range);
      let body: Stmt[];
      const step: TE[] = [];
      try {
        body = this.blockOf(s.statement);
        // Each iteration has its own binding: a closure from the last one keeps that one's cell.
        const fresh = boxed.flatMap((b) => this.copyBox(b, s));
        if (fresh.length > 0) step.push(mk(T.void, { k: "blockexpr", body: fresh, result: VOID }));
        if (s.incrementor !== undefined) step.push(this.exprStmt(s.incrementor));
      } finally {
        if (bound !== null) this.narrowVar.delete(bound.v);
      }
      this.loopDepth--;
      return [{ k: "for", init, c, step, body } as Stmt];
    });
  }

  /**
   * A loop's condition bounds a counter it compares (SPEC 4.5): `for (...; i < e; ...)` and `while (i < e)`, with `<=`, `>` and
   * `>=` and either side. In the body, and a `for`'s incrementor, a read of `i` is within that bound, widened by each write
   * to `i` in walk order (`narrowVar`), which is sound because the range only grows and every write's value is computed from
   * it. So `i + 1` is proved to fit i32 when `e`'s range does, as an array's length does, and `i` stays an integer; bounded
   * by an `f64`, as an exported parameter is, its arithmetic is `f64`. Nothing narrows a counter written anywhere but by a
   * plain assignment, compound assignment or `++`/`--` outside any inner loop, or one a closure in the loop can see.
   */
  loopBound(
    condNode: ts.Expression,
    c: TE,
    scan: ts.Node[],
  ): { v: Var; range: [number, number] } | null {
    const cond = strip(condNode);
    if (!ts.isBinaryExpression(cond) || c.k !== "cmp") return null;
    const left = strip(cond.left);
    const right = strip(cond.right);
    const local = (x: ts.Expression): ts.Symbol | undefined => {
      if (!ts.isIdentifier(x)) return undefined;
      const sym = this.symbolOf(x);
      const b = sym !== undefined ? this.scope.get(sym) : undefined;
      return b?.b === "var" && b.sh.s === "num" ? sym : undefined;
    };
    const onLeft = local(left) !== undefined;
    const sym = onLeft ? local(left) : local(right);
    if (sym === undefined) return null;
    const b = this.scope.get(sym) as Extract<Binding, { b: "var" }>;
    // `i < e` and `e > i` both say i is below e.
    let op = c.op as string;
    if (!onLeft)
      op = ({ lt: "gt", le: "ge", gt: "lt", ge: "le" } as Record<string, string>)[op] ?? op;
    if (op !== "lt" && op !== "le" && op !== "gt" && op !== "ge") return null;
    const other = range(onLeft ? c.b : c.a);
    const target = (x: ts.Expression): boolean =>
      ts.isIdentifier(strip(x)) && this.symbolOf(strip(x) as ts.Identifier) === sym;
    let bad = false;
    let inFn = 0;
    let inLoop = 0;
    const visit = (n: ts.Node): void => {
      if (bad) return;
      if (inFn > 0 && ts.isIdentifier(n) && this.symbolOf(n) === sym) bad = true;
      const write =
        (ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          (target(n.left) ||
            ts.isArrayLiteralExpression(strip(n.left)) ||
            ts.isObjectLiteralExpression(strip(n.left)))) ||
        ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken ||
            n.operator === ts.SyntaxKind.MinusMinusToken) &&
          target(n.operand));
      // A destructuring assignment could write it by a path that isn't a plain store; a write in an inner loop repeats.
      if (write && (inLoop > 0 || !(ts.isBinaryExpression(n) ? target(n.left) : true))) bad = true;
      const fn = ts.isFunctionLike(n);
      const loop = ts.isIterationStatement(n, false);
      if (fn) inFn++;
      if (loop) inLoop++;
      ts.forEachChild(n, visit);
      if (fn) inFn--;
      if (loop) inLoop--;
    };
    for (const n of scan) visit(n);
    if (bad) return null;
    if (op === "lt") return { v: b.v, range: [-Infinity, other[1] - 1] };
    if (op === "le") return { v: b.v, range: [-Infinity, other[1]] };
    if (op === "gt") return { v: b.v, range: [other[0] + 1, Infinity] };
    return { v: b.v, range: [other[0], Infinity] };
  }

  loopBoxes(s: ts.ForStatement): Extract<Binding, { b: "box" }>[] {
    const out: Extract<Binding, { b: "box" }>[] = [];
    if (s.initializer === undefined || !ts.isVariableDeclarationList(s.initializer)) return out;
    for (const d of s.initializer.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      const sym = this.symbolOf(d.name);
      const b = sym !== undefined ? this.scope.get(sym) : undefined;
      if (b?.b === "box") out.push(b);
    }
    return out;
  }

  copyBox(b: Extract<Binding, { b: "box" }>, at: ts.Node): Stmt[] {
    const objSh: Extract<Shape, { s: "obj" }> = { s: "obj", node: b.node };
    const out: Stmt[] = [];
    const old = this.temp(this.boxRead(b, at), out);
    const next = this.temp(this.allocObj(objSh, at), out);
    out.push({ k: "expr", e: this.fieldStore(next, "v", b.node, old, true) });
    out.push({ k: "expr", e: mk(next.ty, { k: "setvar", v: b.v, val: next }) });
    return out;
  }

  forOf(s: ts.ForOfStatement): Stmt[] {
    if (s.awaitModifier !== undefined) this.block("async", s, "for await");
    if (this.mem && this.isItemSource(this.typeAt(s.expression))) return this.forOfItems(s);
    return this.inBlock(() => {
      const out: Stmt[] = [];
      const seq = this.seqOf(this.expr(s.expression), s.expression, out);
      const iv = this.newVar(T.i32, "$i");
      out.push({ k: "let", v: iv, init: lit32(0), constant: false });
      this.loopDepth++;
      const body: Stmt[] = [];
      const i = this.readVar(iv, { range: [0, I32_MAX] });
      const item = seq.at(i, s);
      const list = s.initializer;
      if (!ts.isVariableDeclarationList(list))
        this.block("unsupported", s, "for...of without a declaration");
      const d = list.declarations[0]!;
      if (ts.isIdentifier(d.name)) {
        const sh = this.slot(this.slotKey(d.name), this.typeAt(d.name), d);
        const v = this.newVar(tyOf(sh), d.name.text);
        body.push({ k: "let", v, init: this.flow(item, sh, d), constant: false });
        this.bindVar(this.symbolOf(d.name)!, v, sh, d, body);
      } else this.bindPattern(d.name, item, body);
      body.push(...this.blockOf(s.statement));
      this.loopDepth--;
      const step = mk(T.i32, {
        k: "setvar",
        v: iv,
        val: mk(T.i32, { k: "arith", op: "add", a: i, b: lit32(1), wrap: false, loc: this.loc(s) }),
      });
      out.push({ k: "for", init: [], c: this.cmpTE("lt", i, seq.len()), step: [step], body });
      return out;
    });
  }

  switchStmt(s: ts.SwitchStatement): Stmt[] {
    const out: Stmt[] = [];
    const val0 = this.expr(s.expression);
    const val1 =
      val0.ty.k === "opt"
        ? this.block("union-mixed", s.expression, "a switch on a nullable value")
        : val0;
    const val = this.temp(val1, out);
    const clauses = s.caseBlock.clauses;
    const keys: (TE | null)[] = clauses.map((c) =>
      ts.isCaseClause(c) ? this.expr(c.expression) : null,
    );
    const direct =
      (isInt(val) || val.ty.k === "lits" || val.ty.k === "bool") &&
      keys.every(
        (k) =>
          k === null ||
          (k.k === "lit" && typeof k.value !== "number") ||
          (k?.k === "lit" && isInt(k)),
      );
    const scoped = this.inBlock(() => {
      for (const c of clauses) this.hoist(c.statements);
      return clauses.map((c) => this.stmts(c.statements));
    });
    if (direct) {
      out.push({
        k: "switch",
        val,
        clauses: clauses.map((c, i) => ({
          keys: keys[i] !== null ? [keys[i]!] : [],
          isDefault: ts.isDefaultClause(c),
          body: scoped[i]!,
        })),
      });
      return out;
    }
    // Case values that aren't integer constants compare in order, as JS does, to choose a clause.
    const sel = this.newVar(T.i32, "$sel");
    const def = clauses.findIndex((c) => ts.isDefaultClause(c));
    let chain: Stmt[] = [{ k: "expr", e: mk(T.i32, { k: "setvar", v: sel, val: lit32(def) }) }];
    for (let i = clauses.length - 1; i >= 0; i--) {
      const key = keys[i];
      if (key === null || key === undefined) continue;
      chain = [
        {
          k: "if",
          c: this.compare("eq", val, key, s),
          a: [{ k: "expr", e: mk(T.i32, { k: "setvar", v: sel, val: lit32(i) }) }],
          b: chain,
        },
      ];
    }
    out.push({ k: "let", v: sel, init: lit32(-1), constant: false }, ...chain);
    out.push({
      k: "switch",
      val: this.readVar(sel),
      clauses: clauses.map((c, i) => ({ keys: [lit32(i)], isDefault: false, body: scoped[i]! })),
    });
    return out;
  }

  varList(list: ts.VariableDeclarationList): Stmt[] {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
      // `var` is function-scoped in JS, and hoisting would change meaning here.
      this.block("unsupported", list, "var declarations");
    }
    const out: Stmt[] = [];
    for (const d of list.declarations) this.varDecl(d, isConst, out);
    return out;
  }

  varDecl(d: ts.VariableDeclaration, isConst: boolean, out: Stmt[]): void {
    const init = d.initializer;
    if (!ts.isIdentifier(d.name)) {
      if (init === undefined) this.block("unsupported", d, "a pattern without an initialiser");
      if (ts.isArrayBindingPattern(d.name)) {
        this.destructureArray(d.name, init, out);
        return;
      }
      this.bindPattern(d.name, this.expr(init), out);
      return;
    }
    const sym = this.symbolOf(d.name)!;
    const t = this.declaredIfUnsound(d) ?? this.typeAt(d.name);
    if (
      this.isCallable(t) &&
      (!this.mem || (isConst && init !== undefined && this.isStaticFn(init)))
    ) {
      this.closureDecl(d, sym, isConst, out);
      return;
    }
    if (isConst && init !== undefined && this.sroaEligible(d, init, sym)) {
      this.sroaDecl(d, init as ts.ObjectLiteralExpression, sym, out);
      return;
    }
    const sh = this.slot(this.slotKey(d.name), t, d);
    const v = this.newVar(tyOf(sh), d.name.text);
    const binding: Binding = { b: "var", v, sh };
    if (init !== undefined) {
      const te0 = this.expr(init, sh);
      if (isConst && te0.k === "lit" && (sh.s === "num" || sh.s === "str" || sh.s === "bool")) {
        binding.konst = te0;
        this.scope.map.set(sym, binding);
        return;
      }
      const te = this.flow(te0, sh, init);
      out.push({ k: "let", v, init: te, constant: isConst });
    } else if (sh.s === "opt" || sh.s === "arr" || sh.s === "obj" || sh.s === "vec") {
      out.push({ k: "let", v, init: this.flow(NULLISH, sh, d), constant: false });
    }
    if (this.boxedSyms.has(sym)) {
      // `let x;` first assigned later: a cell of zeroes, and nothing reads it first (tsc checks that).
      const has =
        init !== undefined || sh.s === "opt" || sh.s === "arr" || sh.s === "obj" || sh.s === "vec";
      this.newBox(sym, has ? this.varTE(v, sh) : null, sh, d, out);
      return;
    }
    this.scope.map.set(sym, binding);
  }

  /** `const p = { ... }` whose every use is `p.field` needs no memory: each field is a variable. */
  sroaEligible(d: ts.VariableDeclaration, init0: ts.Expression, sym: ts.Symbol): boolean {
    const init = strip(init0);
    if (!ts.isObjectLiteralExpression(init) || init0 !== init) return false;
    for (const p of init.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
      if (ts.isComputedPropertyName(p.name)) return false;
    }
    let scope: ts.Node = d;
    while (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isFunctionLike(scope) &&
      scope.parent !== undefined
    )
      scope = scope.parent;
    if (ts.isSourceFile(scope)) return false;
    let ok = true;
    if (this.mem) {
      // A closure might be lifted, and then it needs a value it can capture.
      for (const p of init.properties) {
        if (this.isCallable(this.typeAt(p.name!))) return false;
      }
    }
    const walk = (n: ts.Node): void => {
      if (!ok) return;
      if (
        this.mem &&
        ts.isIdentifier(n) &&
        ts.isShorthandPropertyAssignment(n.parent) &&
        this.checker.getShorthandAssignmentValueSymbol(n.parent) === sym
      ) {
        // The checker's symbol at a shorthand is the property's, so the test below doesn't see this use.
        ok = false;
      }
      if (
        this.mem &&
        ts.isIdentifier(n) &&
        n !== d.name &&
        this.checker.getSymbolAtLocation(n) === sym
      ) {
        for (let up: ts.Node = n; up !== scope; up = up.parent) {
          if (ts.isFunctionLike(up)) ok = false;
        }
      }
      if (ts.isIdentifier(n) && n !== d.name && this.checker.getSymbolAtLocation(n) === sym) {
        const p = n.parent;
        if (!ts.isPropertyAccessExpression(p) || p.expression !== n) ok = false;
        else {
          const name = p.name.text;
          if (!init.properties.some((x) => x.name?.getText() === name)) ok = false;
        }
      }
      if (ok) ts.forEachChild(n, walk);
    };
    walk(scope);
    return ok;
  }

  sroaDecl(
    d: ts.VariableDeclaration,
    init: ts.ObjectLiteralExpression,
    sym: ts.Symbol,
    out: Stmt[],
  ): void {
    const fields = new Map<string, { v: Var; sh: Shape }>();
    const lt = this.typeAt(init);
    for (const p of init.properties) {
      const name = p.name!.getText();
      const prop = lt.getProperty(name);
      if (prop === undefined) this.block("unsupported", p, `no property ${name}`);
      const pt = this.checker.getTypeOfSymbolAtLocation(prop, p);
      if (this.isCallable(pt) && !this.mem)
        this.block("closure-escape", p, `the field ${name} holds a function`);
      const key = `${this.slotKey(d.name)}.${name}`;
      const sh = this.slot(key, pt, p);
      const v = this.newVar(tyOf(sh), name);
      const value = ts.isPropertyAssignment(p)
        ? p.initializer
        : (p as ts.ShorthandPropertyAssignment).name;
      const te = this.flow(this.expr(value, sh), sh, p);
      out.push({ k: "let", v, init: te, constant: false });
      fields.set(name, { v, sh });
    }
    this.scope.map.set(sym, { b: "sroa", fields });
  }

  bindPattern(pat: ts.BindingPattern, val: TE, out: Stmt[]): void {
    const base = this.temp(val, out);
    if (ts.isArrayBindingPattern(pat) && (base.sh as Shape | undefined)?.s === "obj") {
      const sh = base.sh as Extract<Shape, { s: "obj" }>;
      pat.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken !== undefined) this.block("unsupported", el, "a rest element");
        this.bindElement(el, this.fieldRead(base, String(i), sh.node, el), out);
      });
      return;
    }
    if (ts.isArrayBindingPattern(pat)) {
      const seq = this.seqOf(base, pat, out);
      pat.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken !== undefined) this.block("unsupported", el, "a rest element");
        this.bindElement(el, seq.opt(lit32(i), el), out);
      });
      return;
    }
    const sh = base.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj") {
      this.block("unsupported", pat, "destructuring a value that isn't a known shape");
    }
    for (const el of pat.elements) {
      if (el.dotDotDotToken !== undefined) this.block("unsupported", el, "an object rest element");
      const pn = el.propertyName ?? el.name;
      if (
        ts.isComputedPropertyName(pn) ||
        ts.isObjectBindingPattern(pn) ||
        ts.isArrayBindingPattern(pn)
      ) {
        this.block("computed-key", el, "a computed key in a pattern");
      }
      this.bindElement(el, this.fieldRead(base, pn.getText(), sh.node, el), out);
    }
  }

  bindElement(el: ts.BindingElement, val0: TE, out: Stmt[]): void {
    let val = val0;
    if (el.initializer !== undefined) val = this.defaulted(val, el.initializer, el, out);
    if (ts.isIdentifier(el.name)) {
      const sym = this.symbolOf(el.name)!;
      const sh = this.slot(this.slotKey(el.name), this.typeAt(el.name), el);
      const v = this.newVar(tyOf(sh), el.name.text);
      out.push({ k: "let", v, init: this.flow(val, sh, el), constant: false });
      this.bindVar(sym, v, sh, el, out);
    } else this.bindPattern(el.name, val, out);
  }

  defaulted(val: TE, def: ts.Expression, at: ts.Node, out: Stmt[]): TE {
    const t = this.temp(val, out);
    const d = this.expr(def);
    if (t.ty.k === "opt") {
      const present = mk(T.bool, { k: "slice", val: t, from: 0, to: 1 });
      return this.conditionalTE(
        present,
        this.optPayload(t, t.sh as Extract<Shape, { s: "opt" }>),
        d,
        at,
      );
    }
    if (t.ty.k === "ref" || t.ty.k === "arr")
      return this.conditionalTE(this.cmpTE("ne", t, nullPtr()), t, d, at);
    return t;
  }

  /** `const [a, b] = c ? [x, y] : [p, q]` needs no array at all: it becomes scalars on each path. */
  destructureArray(pat: ts.ArrayBindingPattern, init0: ts.Expression, out: Stmt[]): void {
    const init = strip(init0);
    const vars: { el: ts.BindingElement; v: Var; sh: Shape }[] = [];
    if (
      ts.isArrayLiteralExpression(init) ||
      (ts.isConditionalExpression(init) && this.allLiterals(init))
    ) {
      for (const el of pat.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (
          !ts.isIdentifier(el.name) ||
          el.dotDotDotToken !== undefined ||
          el.initializer !== undefined
        ) {
          this.bindPattern(pat, this.expr(init0), out);
          return;
        }
        const sh = this.slot(this.slotKey(el.name), this.typeAt(el.name), el);
        const v = this.newVar(tyOf(sh), el.name.text);
        out.push({ k: "let", v, init: null, constant: false });
        vars.push({ el, v, sh });
      }
      const assign = (e0: ts.Expression): Stmt[] => {
        const e = strip(e0);
        if (ts.isConditionalExpression(e)) {
          return [
            {
              k: "if",
              c: this.condition(e.condition),
              a: assign(e.whenTrue),
              b: assign(e.whenFalse),
            },
          ];
        }
        const lit = e as ts.ArrayLiteralExpression;
        const body: Stmt[] = [];
        const values = lit.elements.map((x) => this.temp(this.expr(x), body));
        let i = 0;
        for (const el of pat.elements) {
          if (!ts.isOmittedExpression(el)) {
            const slot = vars.find((x) => x.el === el)!;
            const te = values[i] ?? NULLISH;
            body.push({
              k: "expr",
              e: mk(slot.v.ty, { k: "setvar", v: slot.v, val: this.flow(te, slot.sh, el) }),
            });
          }
          i++;
        }
        return body;
      };
      out.push(...assign(init));
      for (const x of vars) this.bindVar(this.symbolOf(x.el.name)!, x.v, x.sh, x.el, out);
      return;
    }
    this.bindPattern(pat, this.expr(init0), out);
  }

  allLiterals(e0: ts.Expression): boolean {
    const e = strip(e0);
    if (ts.isArrayLiteralExpression(e)) return !e.elements.some(ts.isSpreadElement);
    if (ts.isConditionalExpression(e))
      return this.allLiterals(e.whenTrue) && this.allLiterals(e.whenFalse);
    return false;
  }

  // --- closures

  targetOf(decl: FnLike): Target {
    return {
      decl,
      scope: this.scope,
      env: this.env,
      key: `${this.frame.path}@${decl.pos}`,
      round: this.round,
    };
  }

  closureDecl(d: ts.VariableDeclaration, sym: ts.Symbol, isConst: boolean, out: Stmt[]): void {
    const init = d.initializer;
    if (init === undefined)
      this.block("closure-escape", d, "a function variable without an initialiser");
    const strippedInit = strip(init);
    if (isConst && (ts.isArrowFunction(strippedInit) || ts.isFunctionExpression(strippedInit))) {
      this.scope.map.set(sym, { b: "closure", targets: [this.targetOf(strippedInit)], tag: null });
      return;
    }
    const key = this.slotKey(d);
    const set = this.closureSets.get(key) ?? [];
    this.closureSets.set(key, set);
    const tagInit = this.closureTag(set, init);
    if (set.length === 1 && isConst) {
      this.scope.map.set(sym, { b: "closure", targets: set, tag: null });
      return;
    }
    const v = this.newVar(T.i32, d.name.getText());
    out.push({ k: "let", v, init: tagInit, constant: false });
    this.scope.map.set(sym, { b: "closure", targets: set, tag: v });
  }

  /**
   * Stored in a variable from an outer scope, a closure can outlive a binding it captures, and each
   * iteration of a loop has its own. Inlining reads the current value, which would be another's.
   */
  checkOutlives(b: Binding, sym: ts.Symbol, e: ts.BinaryExpression): void {
    let holder: Scope | null = this.scope;
    while (holder !== null && holder.map.get(sym) !== b) holder = holder.parent;
    if (holder === null || holder === this.scope) return;
    const inner: Scope[] = [];
    for (let s: Scope | null = this.scope; s !== null && s !== holder; s = s.parent) inner.push(s);
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const s = this.symbolOf(n);
        if (s !== undefined && inner.some((x) => x.map.has(s))) {
          this.block(
            "closure-escape",
            e,
            `a closure stored past the scope of ${s.name}, which it captures`,
          );
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(e.right);
  }

  /** The small integer naming which target `e` selects, adding any new targets to the set. */
  closureTag(set: Target[], e0: ts.Expression): TE {
    const e = strip(e0);
    if (ts.isConditionalExpression(e)) {
      const c = this.condition(e.condition);
      const a = this.closureTag(set, e.whenTrue);
      const b = this.closureTag(set, e.whenFalse);
      if (c.k === "lit") return c.value === true ? a : b;
      return mk(T.i32, { k: "cond", c, a, b });
    }
    const cv = this.closureOf(e);
    if (cv.targets.length !== 1) {
      this.block(
        "closure-escape",
        e,
        "copying a closure variable that already selects among targets",
      );
    }
    const t = cv.targets[0]!;
    let at = set.findIndex((x) => x.key === t.key);
    if (at < 0) {
      at = set.length;
      set.push(t);
      this.changed = true;
    } else set[at] = t;
    return lit32(at);
  }

  /** What a function-valued expression can be: its known targets, and a tag if there are several. */
  closureOf(e0: ts.Expression, out?: Stmt[]): { targets: Target[]; tag: TE | null } {
    const e = strip(e0);
    if (this.mem && out !== undefined && !this.isStaticFn(e)) {
      return { targets: [this.dynTarget(this.exprNonNull(e), e, out)], tag: null };
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      return { targets: [this.targetOf(e)], tag: null };
    if (ts.isNonNullExpression(e)) return this.closureOf(e.expression);
    if (ts.isIdentifier(e)) {
      const sym = this.symbolOf(e);
      if (sym !== undefined) {
        const b = this.scope.get(sym);
        if (b?.b === "closure")
          return { targets: b.targets, tag: b.tag !== null ? this.readVar(b.tag) : null };
        const top = this.topFunction(sym);
        if (top !== null) return { targets: [this.topTarget(top)], tag: null };
      }
    }
    if (ts.isConditionalExpression(e)) {
      const set: Target[] = [];
      const tag = this.closureTag(set, e);
      return { targets: set, tag };
    }
    this.block("closure-escape", e, "a function value whose target isn't known here");
  }

  topTarget(decl: FnLike): Target {
    return {
      decl,
      scope: new Scope(null),
      env: new Map(),
      key: `top:${decl.pos}`,
      round: this.round,
    };
  }

  topFunction(sym: ts.Symbol): FnLike | null {
    const d = sym.valueDeclaration;
    if (d === undefined || this.isLibSymbol(sym)) return null;
    if (
      ts.isFunctionDeclaration(d) &&
      d.parent !== undefined &&
      ts.isSourceFile(d.parent) &&
      d.body !== undefined
    )
      return d;
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined && this.isModuleVar(sym)) {
      const i = strip(d.initializer);
      if (
        (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) &&
        (d.parent.flags & ts.NodeFlags.Const) !== 0
      )
        return i;
    }
    return null;
  }

  selfRecursive(decl: FnLike): boolean {
    const self = this.symbolOfFn(decl);
    if (self === undefined || decl.body === undefined) return false;
    let found = false;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && this.checker.getSymbolAtLocation(n) === self) found = true;
      if (!found) ts.forEachChild(n, walk);
    };
    walk(decl.body);
    return found;
  }

  callTargets(targets: Target[], tag: TE | null, args: Arg[], node: ts.Node): TE {
    for (const t of targets) {
      if (t.round !== this.round && !t.key.startsWith("top:")) {
        this.block(
          "closure-escape",
          node,
          "a closure variable assigned after this call on a later iteration",
        );
      }
    }
    if (targets.length === 1) return this.inlineCall(targets[0]!, args, node);
    if (targets.length === 0) this.block("closure-escape", node, "a closure with no known target");
    const out: Stmt[] = [];
    const held = args.map((a): Arg => (a.te !== undefined ? { te: this.temp(a.te, out) } : a));
    const ct = this.checker.getTypeAtLocation(node);
    const sh = hasFlag(ct, ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)
      ? ({ s: "void" } as Shape)
      : this.slot(`${this.slotKey(node)}#sel`, this.subst(ct), node);
    const rv = sh.s === "void" ? null : this.newVar(tyOf(sh), "$r");
    if (rv !== null) out.push({ k: "let", v: rv, init: null, constant: false });
    const clauses = targets.map((t, i) => {
      const r = this.inlineCall(t, held, node, `#${i}`);
      const body: Stmt[] = [];
      if (rv !== null && r.ty.k !== "never")
        body.push({ k: "expr", e: mk(rv.ty, { k: "setvar", v: rv, val: this.flow(r, sh, node) }) });
      else body.push({ k: "expr", e: r });
      body.push({ k: "break", label: null });
      return { keys: [lit32(i)], isDefault: false, body };
    });
    out.push({ k: "switch", val: tag!, clauses });
    return mk(
      rv !== null ? rv.ty : T.void,
      { k: "blockexpr", body: out, result: rv !== null ? this.varTE(rv, sh) : VOID },
      rv !== null ? this.carry(this.varTE(rv, sh)) : undefined,
    );
  }

  /** Walks the closure's body in place, in its defining scope: captures just resolve. */
  inlineCall(t: Target, args: Arg[], node: ts.Node, suffix = ""): TE {
    if (t.dyn !== undefined) return this.dynCall(this.varTE(t.dyn.v, t.dyn.sh), args, node);
    if (t.key.startsWith("top:") && !this.anyClosureArg(args) && !this.isCallableParams(t.decl)) {
      const fn = t.decl;
      return this.callFunctionArgs(fn, args, node);
    }
    if (this.selfRecursive(t.decl) && !t.key.startsWith("top:"))
      return this.liftedCall(t, args, node);
    if (this.frame.stack.includes(t.decl) || this.frame.stack.length >= MAX_INLINE_DEPTH) {
      this.block(
        "closure-recursive",
        node,
        "a recursive call through a closure or callback can't be inlined",
      );
    }
    const saved = { scope: this.scope, frame: this.frame, env: this.env };
    const path = `${this.frame.path}>${node.pos}${suffix}:${t.decl.pos}`;
    const stack = [...this.frame.stack, t.decl];
    const out: Stmt[] = [];
    // Arguments belong to the caller's scope, so they were evaluated before this point.
    this.scope = new Scope(t.scope);
    this.env = t.env;
    const rt = this.closureReturnShape(t.decl, path);
    const label = `$r${this.nextLabel++}`;
    const retVar = rt.s === "void" ? null : this.newVar(tyOf(rt), "$ret");
    this.frame = { path, retSh: rt, retLabel: label, retVar, stack };
    try {
      t.decl.parameters.forEach((p, i) => {
        if (p.dotDotDotToken !== undefined) this.block("unsupported", p, "a rest parameter");
        const a = args[i];
        if (a?.targets !== undefined) {
          if (!ts.isIdentifier(p.name))
            this.block("unsupported", p, "a pattern for a function argument");
          const tagVar = a.tag ?? null;
          this.scope.map.set(this.symbolOf(p.name)!, {
            b: "closure",
            targets: a.targets,
            tag: tagVar,
          });
          return;
        }
        const pt = this.typeAt(p.name);
        let te = a?.te ?? NULLISH;
        if (te.ty.k === "nullish" && hasFlag(pt, ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
          // Array.from({ length }, (_, i) => ...): the element is undefined, typed unknown.
          this.bindName(p.name, this.newVar(T.void, p.name.getText()), { s: "void" }, out);
          return;
        }
        const sh = this.slot(`${path}#p${i}`, pt, p);
        const v = this.newVar(tyOf(sh), p.name.getText());
        if (p.initializer !== undefined) {
          te = this.defaultArg(te, p.initializer, out, p);
        }
        out.push({ k: "let", v, init: this.flow(te, sh, p), constant: false });
        this.bindName(p.name, v, sh, out);
      });
      const b = t.decl.body;
      if (b === undefined) this.block("unsupported", t.decl, "a function without a body");
      if (retVar !== null) out.push({ k: "let", v: retVar, init: null, constant: false });
      const inner: Stmt[] = [];
      if (ts.isBlock(b)) {
        this.hoist(b.statements);
        inner.push(...this.stmts(b.statements));
        this.implicitReturn(inner, rt);
      } else {
        const v = this.expr(b, rt.s === "void" ? undefined : rt);
        inner.push(this.returnStmt(v, b));
      }
      out.push({ k: "label", name: label, body: { k: "block", body: inner } });
      const result = retVar !== null ? this.varTE(retVar, rt) : VOID;
      const never = this.isNeverReturn(t.decl);
      return mk(
        never ? NEVER_TY : result.ty,
        { k: "blockexpr", body: out, result },
        this.carry(result),
      );
    } finally {
      this.scope = saved.scope;
      this.frame = saved.frame;
      this.env = saved.env;
    }
  }

  isNeverReturn(decl: FnLike): boolean {
    const sig = this.checker.getSignatureFromDeclaration(decl);
    return (
      sig !== undefined && hasFlag(this.checker.getReturnTypeOfSignature(sig), ts.TypeFlags.Never)
    );
  }

  defaultArg(te: TE, init: ts.Expression, out: Stmt[], at: ts.Node): TE {
    if (te.ty.k === "nullish") return this.expr(init);
    if (te.ty.k === "opt" || te.ty.k === "ref" || te.ty.k === "arr")
      return this.defaulted(te, init, at, out);
    return te;
  }

  closureReturnShape(decl: FnLike, path: string): Shape {
    if (decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) {
      this.block("async", decl, "an async closure");
    }
    if ((decl as ts.FunctionExpression).asteriskToken !== undefined)
      this.block("generator", decl, "a generator closure");
    const sig = this.checker.getSignatureFromDeclaration(decl);
    if (sig === undefined) this.block("unsupported", decl, "no signature");
    const rt = this.subst(this.checker.getReturnTypeOfSignature(sig));
    if (hasFlag(rt, ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined))
      return { s: "void" };
    if (this.isCallable(rt) && !this.mem)
      this.block("closure-escape", decl, "a closure that returns a function");
    return this.slot(`${path}#ret`, rt, decl);
  }

  /** A recursive local function: captures become parameters, which only const captures allow. */
  liftedCall(t: Target, args: Arg[], node: ts.Node): TE {
    const decl = t.decl;
    const captured: ts.Symbol[] = [];
    const self = this.symbolOfFn(decl);
    const seen = new Set<ts.Symbol>();
    const konsts: [ts.Symbol, Binding][] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const s = this.symbolOf(n);
        if (s !== undefined && s !== self && !seen.has(s)) {
          seen.add(s);
          const b = t.scope.get(s);
          const own =
            s.valueDeclaration !== undefined &&
            s.valueDeclaration.pos >= decl.pos &&
            s.valueDeclaration.end <= decl.end;
          if (b !== undefined && !own) {
            if (this.mem && b.b === "closure" && b.tag === null && b.targets.length === 1) {
              captured.push(s);
              ts.forEachChild(n, walk);
              return;
            }
            if (this.mem && b.b === "box") {
              captured.push(s);
              ts.forEachChild(n, walk);
              return;
            }
            if (b.b === "closure" || b.b === "sroa" || b.b === "box") {
              this.block(
                "closure-recursive",
                n,
                `a recursive closure capturing ${s.name}, which has no single value`,
              );
            }
            if (b.konst !== undefined) konsts.push([s, b]);
            else {
              if (this.mem && this.needsBox(s)) {
                // Next round's walk binds it in a cell, which every activation shares.
                if (!this.boxedSyms.has(s)) {
                  this.boxedSyms.add(s);
                  this.changed = true;
                }
              } else if (this.mutatedGlobals.has(s) && !this.mem) {
                this.block(
                  "closure-recursive",
                  n,
                  `a recursive closure capturing the mutated variable ${s.name}`,
                );
              }
              captured.push(s);
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(decl.body!);
    const inst = this.instOf(
      decl,
      t.env,
      new Map(),
      null,
      false,
      this.inst.owner,
      { captured, target: t },
      `lift:${t.key}`,
    );
    const boxes = new Map<ts.Symbol, { node: HeapNode; sh: Shape }>();
    if (this.mem) {
      inst.lifted!.boxes = boxes;
      inst.lifted!.konsts = konsts;
    }
    const capArgs = captured.map((s) => {
      const b = this.scope.get(s);
      const key = `${inst.key}#cap${s.name}`;
      if (this.mem && b?.b === "box") {
        const sh: Shape = { s: "obj", node: b.node };
        boxes.set(s, { node: b.node, sh: b.sh });
        this.slots.set(key, sh);
        return this.varTE(b.v, sh);
      }
      if (this.mem && b?.b === "closure") {
        const te = this.materialize(b.targets[0]!, node);
        this.slots.set(key, te.sh as Shape);
        return te;
      }
      if (b === undefined || b.b !== "var")
        this.block("closure-recursive", node, `the capture ${s.name} isn't a plain variable`);
      let sh = this.slots.get(key);
      if (sh === undefined) {
        sh = b.sh.s === "num" ? { s: "num", loc: newLoc() } : b.sh;
        this.slots.set(key, sh);
        this.changed = true;
      }
      return this.flow(this.varTE(b.v, b.sh), sh, node);
    });
    if (konsts.length > 0 && !this.mem) {
      this.block("closure-recursive", node, "a recursive closure capturing a folded constant");
    }
    return this.callInst(
      inst,
      null,
      args.map((a) => a.te ?? NULLISH),
      node,
      capArgs,
    );
  }

  anyClosureArg(args: Arg[]): boolean {
    return args.some((a) => a.targets !== undefined);
  }

  isCallableParams(decl: FnLike): boolean {
    return decl.parameters.some((p) => this.isCallable(this.checker.getTypeAtLocation(p.name)));
  }

  // --- calls

  argsFor(decl: FnLike | null, nodes: readonly ts.Expression[], out: Stmt[]): Arg[] {
    return nodes.map((a, i) => {
      if (ts.isSpreadElement(a)) this.block("unsupported", a, "a spread argument to a function");
      const p = decl?.parameters[i];
      const t = this.checker.getTypeAtLocation(a);
      const isFn =
        this.isCallable(t) ||
        (p !== undefined && this.isCallable(this.checker.getTypeAtLocation(p.name)));
      if (isFn) {
        if (this.mem && !this.isStaticFn(a)) {
          const te = this.expr(a);
          if (te.ty.k === "nullish") return { te };
          return { targets: [this.dynTarget(te, a, out)], tag: null };
        }
        const cv = this.closureOf(a);
        let tag: Var | null = null;
        if (cv.tag !== null) {
          tag = this.newVar(T.i32, "$tag");
          out.push({ k: "let", v: tag, init: cv.tag, constant: true });
        }
        return { targets: cv.targets, tag };
      }
      return { te: this.expr(a) };
    });
  }

  withPrelude(out: Stmt[], te: TE): TE {
    if (out.length === 0) return te;
    return mk(te.ty, { k: "blockexpr", body: out, result: te }, this.carry(te));
  }

  callFunction(decl: FnLike, e: ts.CallExpression): TE {
    const out: Stmt[] = [];
    const args = this.argsFor(decl, e.arguments, out);
    return this.withPrelude(out, this.callFunctionArgs(decl, args, e));
  }

  callFunctionArgs(decl: FnLike, args: Arg[], node: ts.Node): TE {
    if (this.fallback.has(decl)) return this.shimCall(decl, args, node);
    const env = ts.isCallExpression(node) ? this.inferEnv(decl, node) : new Map<number, ts.Type>();
    if (
      this.mem &&
      (this.anyClosureArg(args) || this.isCallableParams(decl)) &&
      (this.selfRecursive(decl) ||
        this.frame.stack.includes(decl) ||
        this.frame.stack.length >= MAX_INLINE_DEPTH)
    ) {
      // It can't be inlined into itself, so here a callback is a value it's passed.
      const values = args.map((a): Arg => {
        if (a.targets === undefined) return a;
        if (a.targets.length !== 1)
          this.block("closure-escape", node, "a selection as an argument");
        return { te: this.materialize(a.targets[0]!, node) };
      });
      return this.specialise(decl, env, new Map(), values, 0, node);
    }
    if (this.anyClosureArg(args) || this.isCallableParams(decl)) {
      const t: Target = {
        decl,
        scope: new Scope(null),
        env,
        key: `top:${decl.pos}${this.envKey(env)}`,
        round: this.round,
      };
      return this.inlineCall({ ...t, key: `top:${t.key}` }, args, node);
    }
    return this.specialise(decl, env, new Map(), args, 0, node);
  }

  /** A parameter with a literal-union type gets one clone per value, chosen at the call. */
  specialise(
    decl: FnLike,
    env: Env,
    lits: Map<number, number>,
    args: Arg[],
    from: number,
    node: ts.Node,
  ): TE {
    for (let i = from; i < decl.parameters.length; i++) {
      const values = this.literalUnion(decl.parameters[i]!);
      if (values === null) continue;
      const a = args[i]?.te;
      if (a === undefined) continue;
      if (a.k === "lit" && typeof a.value === "number") {
        if (!values.includes(a.value)) continue;
        const next = new Map(lits);
        next.set(i, a.value);
        return this.specialise(decl, env, next, args, i + 1, node);
      }
      if (a.ty.k === "opt") continue;
      const out: Stmt[] = [];
      const held = this.temp(
        isF(a) ? mk(T.i32, { k: "builtin", name: "toI32", args: [a], loc: this.loc(node) }) : a,
        out,
      );
      const newArgs = args.map((x, j) =>
        j === i ? { te: held } : x.te !== undefined ? { te: this.temp(x.te, out) } : x,
      );
      const ct = this.checker.getTypeAtLocation(node);
      const isVoid = hasFlag(ct, ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never);
      const sh = isVoid
        ? ({ s: "void" } as Shape)
        : this.slot(`${this.slotKey(node)}#spec${i}`, this.subst(ct), node);
      const rv = sh.s === "void" ? null : this.newVar(tyOf(sh), "$r");
      if (rv !== null) out.push({ k: "let", v: rv, init: null, constant: false });
      const clauses = values.map((value) => {
        const next = new Map(lits);
        next.set(i, value);
        const r = this.specialise(decl, env, next, newArgs, i + 1, node);
        const body: Stmt[] = [];
        if (rv !== null && r.ty.k !== "never")
          body.push({
            k: "expr",
            e: mk(rv.ty, { k: "setvar", v: rv, val: this.flow(r, sh, node) }),
          });
        else body.push({ k: "expr", e: r });
        body.push({ k: "break", label: null });
        return { keys: [lit32(value)], isDefault: false, body };
      });
      clauses.push({
        keys: [],
        isDefault: true,
        body: [
          {
            k: "expr",
            e: mk(NEVER_TY, { k: "trapnow", kind: "convert", code: 4, loc: this.loc(node) }),
          },
        ],
      });
      out.push({ k: "switch", val: held, clauses });
      const result = rv !== null ? this.varTE(rv, sh) : VOID;
      return mk(result.ty, { k: "blockexpr", body: out, result }, this.carry(result));
    }
    const inst = this.instOf(decl, env, lits, null, false, decl);
    return this.callInst(
      inst,
      null,
      args.map((a) => a.te ?? NULLISH),
      node,
    );
  }

  literalUnion(p: ts.ParameterDeclaration): number[] | null {
    const t = this.checker.getTypeAtLocation(p.name);
    const parts = t.isUnion() ? t.types : [t];
    const out: number[] = [];
    for (const x of parts) {
      if (!x.isNumberLiteral() || !Number.isInteger(x.value)) return null;
      out.push(x.value);
    }
    return out.length >= 1 && out.length <= 4 ? out.sort((a, b) => a - b) : null;
  }

  inferEnv(decl: FnLike, call: ts.CallExpression): Env {
    const env: Env = new Map();
    const tps = decl.typeParameters;
    if (tps === undefined || tps.length === 0) return env;
    const sig = this.checker.getResolvedSignature(call);
    if (sig === undefined) this.block("any-type", call, "no resolved signature for a generic call");
    const bind = (tn: ts.TypeNode | undefined, actual0: ts.Type | undefined): void => {
      if (tn === undefined || actual0 === undefined) return;
      const actual = this.subst(actual0);
      const declared = this.checker.getTypeFromTypeNode(tn);
      if (hasFlag(declared, ts.TypeFlags.TypeParameter)) {
        const id = (declared as unknown as { id: number }).id;
        if (!env.has(id) && !hasFlag(actual, ts.TypeFlags.TypeParameter)) {
          if (this.mentionsTypeParam(actual)) {
            this.block(
              "instantiation-cap",
              call,
              "polymorphic recursion needs unboundedly many instantiations",
            );
          }
          env.set(id, this.widenLit(actual));
        }
        return;
      }
      if (ts.isArrayTypeNode(tn)) {
        const a = this.checker.getTypeArguments(actual as ts.TypeReference);
        bind(tn.elementType, a[0]);
        return;
      }
      if (ts.isTypeReferenceNode(tn) && tn.typeArguments !== undefined) {
        const a =
          (actual as ts.TypeReference).aliasTypeArguments ??
          this.checker.getTypeArguments(actual as ts.TypeReference);
        tn.typeArguments.forEach((x, i) => {
          bind(x, a[i]);
        });
        return;
      }
      if (ts.isFunctionTypeNode(tn)) {
        const s = actual.getCallSignatures()[0];
        if (s === undefined) return;
        tn.parameters.forEach((p, i) => {
          const sp = s.parameters[i];
          if (sp !== undefined) bind(p.type, this.checker.getTypeOfSymbolAtLocation(sp, call));
        });
        bind(tn.type, this.checker.getReturnTypeOfSignature(s));
      }
    };
    if (call.typeArguments !== undefined) {
      tps.forEach((tp, i) => {
        const a = call.typeArguments![i];
        if (a !== undefined) {
          const given = this.subst(this.checker.getTypeFromTypeNode(a));
          if (this.mentionsTypeParam(given)) {
            this.block(
              "instantiation-cap",
              call,
              "polymorphic recursion needs unboundedly many instantiations",
            );
          }
          env.set((this.checker.getTypeAtLocation(tp) as unknown as { id: number }).id, given);
        }
      });
    }
    decl.parameters.forEach((p, i) => {
      const sp = sig.parameters[i];
      if (sp !== undefined) bind(p.type, this.checker.getTypeOfSymbolAtLocation(sp, call));
    });
    bind(decl.type, this.checker.getReturnTypeOfSignature(sig));
    for (const tp of tps) {
      const id = (this.checker.getTypeAtLocation(tp) as unknown as { id: number }).id;
      if (!env.has(id))
        this.block("any-type", call, `can't resolve the type parameter ${tp.name.text}`);
    }
    return env;
  }

  /** Whether a type still has a type parameter inside it, so it means nothing outside this generic. */
  mentionsTypeParam(t: ts.Type, depth = 0): boolean {
    if (depth > 6) return false;
    if (hasFlag(t, ts.TypeFlags.TypeParameter)) return true;
    if (t.isUnion()) return t.types.some((x) => this.mentionsTypeParam(x, depth + 1));
    if (!hasFlag(t, ts.TypeFlags.Object)) return false;
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) {
      return this.checker
        .getTypeArguments(t as ts.TypeReference)
        .some((x) => this.mentionsTypeParam(x, depth + 1));
    }
    if (this.libName(t) !== null) return false;
    return t.getProperties().some((p) => {
      const d = p.valueDeclaration ?? p.declarations?.[0];
      return (
        d !== undefined &&
        this.mentionsTypeParam(this.checker.getTypeOfSymbolAtLocation(p, d), depth + 1)
      );
    });
  }

  widenLit(t: ts.Type): ts.Type {
    return this.checker.getBaseTypeOfLiteralType(t);
  }

  callInst(inst: Inst, self: TE | null, args: TE[], node: ts.Node, extra: TE[] = []): TE {
    const list: TE[] = [];
    if (self !== null) list.push(self);
    inst.paramSh.forEach((sh, i) => {
      list.push(this.flow(args[i] ?? NULLISH, sh, node));
    });
    list.push(...extra);
    const decl = inst.decl as FnLike;
    const ty = this.retTyOf(decl, inst.retSh);
    const sh = inst.retSh;
    const ex: Partial<TE> = { sh };
    if (sh.s === "num") {
      const l = findLoc(sh.loc);
      ex.deps = [sh.loc];
      if (l.seen) ex.range = [l.lo, l.hi];
      if (l.negz) ex.negz = true;
    }
    const te = mk(ty, { k: "call", inst: inst.fi, args: list }, ex);
    if (sh.s === "opt" && ts.isCallExpression(node)) return this.narrowed(te, sh, node);
    return te;
  }

  /** A call from lowered code into a function that stayed JS, if its values can cross (SPEC 4.5). */
  shimCall(decl: FnLike, args: Arg[], node: ts.Node): TE {
    const info = this.fallback.get(decl)!;
    const name = this.fnName(decl);
    const rootKey = info.root ?? `${info.line}:${info.file}`;
    const refuse = (why: string): never =>
      this.block("callee", node, `${name} stayed JS (${info.blocker}), and ${why}`, rootKey);
    if (this.anyClosureArg(args) || (decl.typeParameters?.length ?? 0) > 0)
      refuse("this call can't cross the boundary");
    if (!ts.isFunctionDeclaration(decl)) refuse("only plain functions have a shim");
    const key = `shim:${decl.pos}`;
    const params: Shape[] = [];
    try {
      decl.parameters.forEach((p, i) => {
        params.push(this.slot(`${key}#p${i}`, this.checker.getTypeAtLocation(p.name), p));
      });
    } catch (e) {
      if (e instanceof Blocked) refuse(`a parameter can't cross: ${e.detail}`);
      throw e;
    }
    const sig = this.checker.getSignatureFromDeclaration(decl)!;
    const rt = this.checker.getReturnTypeOfSignature(sig);
    let ret: Shape = { s: "void" };
    try {
      if (!hasFlag(rt, ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never))
        ret = this.slot(`${key}#ret`, rt, decl);
    } catch (e) {
      if (e instanceof Blocked) refuse(`its result can't cross: ${e.detail}`);
      throw e;
    }
    const crossable = (s: Shape): boolean =>
      s.s === "num" || s.s === "bool" || s.s === "str" || s.s === "arr" || s.s === "void";
    if (!params.every(crossable)) refuse("a parameter is an object, which a shim doesn't copy");
    if (!crossable(ret)) refuse("its result is an object, which a shim doesn't copy");
    for (const p of params) {
      this.markExternal(p, decl);
      this.markWritten(p);
    }
    this.markExternal(ret, decl);
    const list = params.map((sh, i) => {
      const te = this.flow(args[i]?.te ?? NULLISH, sh, node);
      return sh.s === "num" ? this.toFloat(te) : te;
    });
    const extName = `js.${name}`;
    if (!this.externs.has(extName)) {
      this.changed = true;
    }
    this.externs.set(extName, {
      ext: { name: extName, params: params.flatMap((p) => leavesOf(p)), rets: leavesOf(ret) },
      meta: { js: name, params: [], ret: { k: "void" } },
    });
    this.shimShapes.set(extName, { params, ret });
    if (this.loopDepth > 0) {
      const key2 = `${this.loc(node)}`;
      if (!this.warned.has(key2)) {
        this.warned.add(key2);
        this.warnings.push({
          code: "TSLD0100",
          fn: this.fnName(this.inst.owner),
          callee: name,
          loc: key2,
          detail: `a call in a loop to ${name}, which stayed JS, is probably a performance problem`,
        });
      }
    }
    return mk(
      tyOf(ret),
      { k: "rtcall", name: extName, args: list },
      ret.s === "void" ? undefined : this.readExtras(ret),
    );
  }

  shimShapes = new Map<string, { params: Shape[]; ret: Shape }>();

  readExtras(sh: Shape): Partial<TE> {
    const ex: Partial<TE> = { sh };
    if (sh.s === "num") {
      const l = findLoc(sh.loc);
      ex.deps = [sh.loc];
      if (l.seen) ex.range = [l.lo, l.hi];
      if (l.negz) ex.negz = true;
    }
    return ex;
  }

  classEnv(t: ts.Type, c: ts.ClassLikeDeclaration): Env {
    const tps = c.typeParameters;
    // In a generic, a type argument can still mention the type parameters in scope, which have to keep their meaning.
    const env: Env = this.mem && tps !== undefined ? new Map(this.env) : new Map();
    if (tps === undefined) return env;
    // `this.m()` in a generic class: the receiver's type is `this`, and what it means is what it meant here.
    if (this.mem && hasFlag(t, ts.TypeFlags.TypeParameter)) return this.env;
    const args = this.checker.getTypeArguments(t as ts.TypeReference);
    tps.forEach((tp, i) => {
      const a = args[i];
      if (a === undefined) return;
      const s = this.subst(a);
      if (hasFlag(s, ts.TypeFlags.TypeParameter))
        this.block("any-type", tp, "an unresolved class type argument");
      env.set((this.checker.getTypeAtLocation(tp) as unknown as { id: number }).id, s);
    });
    return env;
  }

  newExpr(e: ts.NewExpression, want?: Shape): TE {
    if (!ts.isIdentifier(e.expression))
      this.block("unsupported", e, "new of a computed constructor");
    const sym = this.symbolOf(e.expression);
    if (sym === undefined) this.block("unsupported", e, "an unresolved constructor");
    if (this.isLibSymbol(sym)) {
      const rt = this.mem ? this.errorRtName(sym.name) : null;
      if (rt !== null) {
        const d = this.rtDecl(rt) as ts.ClassDeclaration;
        return this.newOfClass(
          d,
          this.checker.getTypeAtLocation(d),
          () => (e.arguments ?? []).map((a) => this.expr(a)),
          e,
        );
      }
      return this.newLib(sym.name, e, want);
    }
    const c = sym.declarations?.find(ts.isClassLike);
    if (c === undefined) this.block("unsupported", e, `new ${sym.name}`);
    const t = this.typeAt(e);
    if (this.mem)
      return this.newOfClass(c, t, () => (e.arguments ?? []).map((a) => this.expr(a)), e);
    const env = this.classEnv(t, c);
    const saved = this.env;
    this.env = env;
    const sh = this.objectShape(t as ts.ObjectType, e);
    this.env = saved;
    const ctor = c.members.find(ts.isConstructorDeclaration);
    const owner: ts.Node = ctor ?? c;
    if (this.fallback.has(owner)) {
      this.block(
        "callee",
        e,
        `${c.name?.text ?? "class"}'s constructor stayed JS, and objects don't cross a shim`,
        this.fallbackRoot(owner),
      );
    }
    const out: Stmt[] = [];
    const self = this.temp(this.allocObj(sh as Extract<Shape, { s: "obj" }>, e), out);
    const args = (e.arguments ?? []).map((a) => this.expr(a));
    const inst = this.instOf(ctor ?? c, env, new Map(), sh, false, owner);
    out.push({ k: "expr", e: this.callInst(inst, self, args, e) });
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: self }, { sh });
  }

  fallbackRoot(owner: ts.Node): string {
    const f = this.fallback.get(owner)!;
    return f.root ?? `${f.line}:${f.file}`;
  }

  noteAlloc(what: string, at: ts.Node, stack: () => number | null, node?: HeapNode): void {
    const site: AllocSite = { fn: this.fnName(this.inst.owner), loc: this.loc(at), what, stack };
    if (this.mem && node !== undefined) site.long = () => findNode(node).long;
    if (node !== undefined) site.node = node;
    this.allocs.push(site);
  }

  checkAlloc(node: HeapNode, at: ts.Node): void {
    if (findNode(node).global && this.inst.run && !this.mem) {
      this.block(
        "escape-global",
        at,
        "an allocation that is reachable from module state, beyond the export call",
      );
    }
  }

  allocObj(sh: Extract<Shape, { s: "obj" }>, at: ts.Node): TE {
    this.checkAlloc(sh.node, at);
    const inLoop = this.loopDepth > 0 || !this.inst.run;
    const size = allocBytes(layoutOf(sh.node).size);
    const stack = (): number | null => {
      const m = findNode(sh.node);
      return !m.escapes && !m.global && !inLoop ? allocBytes(layoutOf(m).size) : null;
    };
    this.noteAlloc("object", at, stack, sh.node);
    const long = this.mem ? { long: () => this.longAlloc(sh.node) } : {};
    return mk(
      { k: "ref" },
      { k: "alloc", size: litIx(size), zero: true, stack, loc: this.loc(at), ...long },
      { sh },
    );
  }

  allocArr(sh: Extract<Shape, { s: "arr" }>, len: TE, at: ts.Node, out: Stmt[], zero = true): TE {
    this.checkAlloc(sh.node, at);
    const inLoop = this.loopDepth > 0 || !this.inst.run;
    const held = this.temp(len, out);
    const es = elemSize(sh.elem);
    const constLen = held.k === "lit" && typeof held.value === "number" ? held.value : null;
    const stack = (): number | null => {
      const m = findNode(sh.node);
      if (m.escapes || m.global || inLoop || constLen === null) return null;
      const bytes = constLen * es;
      return bytes <= 65536 ? Math.max(8, Math.ceil(bytes / 8) * 8) : null;
    };
    this.noteAlloc(`${sh.elem} array`, at, stack, sh.node);
    const ix = this.ixOf(held);
    const bytes = mk(T.usize, {
      k: "arith",
      op: "mul",
      a: ix,
      b: litIx(es),
      wrap: false,
      loc: this.loc(at),
    });
    const long = this.mem ? { long: () => this.longAlloc(sh.node) } : {};
    const p = mk(
      { k: "ref" },
      { k: "alloc", size: bytes, zero, stack, loc: this.loc(at), ...long },
    );
    return mk({ k: "arr", elem: sh.elem }, { k: "tuple", items: [p, ix] }, { sh });
  }

  newLib(name: string, e: ts.NewExpression, _want?: Shape): TE {
    if (this.mem && (name === "Map" || name === "Set")) return this.newMapLike(name, e);
    const elem = ELEM_BY_ARRAY[name];
    const args = e.arguments ?? [];
    if (elem !== undefined) {
      if (elem === "u64" || elem === "i64") this.block("bigint", e, `${name} holds bigints`);
      const sh = this.slot(this.slotKey(e), this.typeAt(e), e) as Extract<Shape, { s: "arr" }>;
      const a0 = args[0];
      const out: Stmt[] = [];
      if (a0 === undefined) return this.withPrelude(out, this.allocArr(sh, lit32(0), e, out));
      if (args.length > 1) this.block("reflection", e, "a typed array over an ArrayBuffer");
      const stripped = strip(a0);
      const t0 = this.typeAt(a0);
      if (hasFlag(t0, ts.TypeFlags.NumberLike)) {
        const n = this.expr(a0);
        const len = isF(n)
          ? mk(T.i32, {
              k: "builtin",
              name: "toI32",
              args: [mk(T.f64, { k: "builtin", name: "Math.trunc", args: [n], loc: this.loc(e) })],
              loc: this.loc(e),
            })
          : n;
        return this.withPrelude(out, this.allocArr(sh, len, e, out));
      }
      if (ts.isArrayLiteralExpression(stripped) && !stripped.elements.some(ts.isSpreadElement)) {
        const made = this.temp(this.allocArr(sh, lit32(stripped.elements.length), e, out), out);
        this.markWritten(sh);
        stripped.elements.forEach((x, i) => {
          const v = this.storeValue(this.expr(x), elem);
          out.push({
            k: "expr",
            e: mk(v.ty, { k: "storeelem", ptr: this.ptrOfArr(made), idx: litIx(i), elem, val: v }),
          });
        });
        return this.withPrelude(out, made);
      }
      // A copy of a typed array or vector.
      const src = this.seqOf(this.expr(a0), a0, out);
      const n = this.temp(src.len(), out);
      const made = this.temp(this.allocArr(sh, n, e, out), out);
      const iv = this.newVar(T.i32, "$i");
      const i = this.readVar(iv, { range: [0, I32_MAX] });
      out.push({ k: "let", v: iv, init: lit32(0), constant: false });
      const body: Stmt[] = [{ k: "expr", e: this.storeAt(made, elem, i, src.at(i, e)) }];
      out.push(this.countedLoop(iv, n, body, e));
      return this.withPrelude(out, made);
    }
    if (name === "WeakRef") {
      const sh = this.slot(this.slotKey(e), this.typeAt(e), e) as Extract<Shape, { s: "obj" }>;
      const target = findNode(sh.node).weakOf!;
      const a0 = args[0];
      if (a0 === undefined) this.block("weakref", e, "a WeakRef with no target");
      const val = this.flow(this.expr(a0, target), target, a0);
      this.markLong(target);
      this.markLong(sh);
      this.noteAlloc("WeakRef", e, () => null, sh.node);
      return mk({ k: "ref" }, { k: "rtcall", name: "__rc_weak_new", args: [val] }, { sh });
    }
    if (name === "Array") {
      const sh = this.slot(this.slotKey(e), this.typeAt(e), e) as Extract<Shape, { s: "vec" }>;
      if (args.length > 1) return this.vecLiteral(args, sh, e);
      const a0 = args[0];
      const len = a0 === undefined ? lit32(0) : this.expr(a0);
      const elemSh = findNode(sh.node).elem!;
      if (elemSh.s === "num" || elemSh.s === "bool" || elemSh.s === "str") {
        const p = e.parent;
        const isFilled = this.isWholeFill(p, e);
        if (!isFilled && (len.k !== "lit" || len.value !== 0)) {
          this.block(
            "unsupported",
            e,
            "new Array(n) of scalars has holes, which scalar slots can't hold; use .fill",
          );
        }
      }
      if (this.excOn && len.k !== "lit") {
        // Where something can catch it, a bad length is V8's RangeError, not a trap (3.10).
        const out: Stmt[] = [];
        const l = this.temp(len, out);
        const bad = isF(l)
          ? this.not(
              mk(T.bool, {
                k: "logic",
                op: "and",
                a: this.cmpTE("ge", l, mk(T.f64, { k: "lit", value: 0 })),
                b: mk(T.bool, {
                  k: "logic",
                  op: "and",
                  a: this.cmpTE("le", l, mk(T.f64, { k: "lit", value: 4294967295 })),
                  b: this.cmpTE(
                    "eq",
                    l,
                    mk(T.f64, { k: "builtin", name: "Math.trunc", args: [l], loc: this.loc(e) }),
                  ),
                }),
              }),
            )
          : this.cmpTE("lt", l, lit32(0));
        out.push({
          k: "if",
          c: bad,
          a: [{ k: "expr", e: this.raiseNew("TmkRangeError", "Invalid array length", e) }],
          b: null,
        });
        return this.withPrelude(
          out,
          this.vecNew(
            sh,
            isF(l) ? mk(T.i32, { k: "builtin", name: "toI32", args: [l], loc: this.loc(e) }) : l,
            e,
          ),
        );
      }
      return this.vecNew(
        sh,
        isF(len) ? mk(T.i32, { k: "builtin", name: "toI32", args: [len], loc: this.loc(e) }) : len,
        e,
      );
    }
    if (name === "Error" || name === "TypeError" || name === "RangeError") {
      this.block("throw-non-error", e, "an Error used as a value, not thrown");
    }
    const hit = LIB_BLOCKERS[name];
    if (hit !== undefined) this.block(hit[0], e, hit[1]);
    this.block("unsupported", e, `new ${name}`);
  }

  /** Array(n).fill(x) with no range: every slot gets a value, so scalar slots never hold a hole. */
  isWholeFill(p: ts.Node, e: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(p) || p.name.text !== "fill" || p.expression !== e)
      return false;
    const c = p.parent;
    return ts.isCallExpression(c) && c.expression === p && c.arguments.length === 1;
  }

  // --- vectors and typed arrays as sequences

  elemLocs = new Map<string, NumLoc>();

  elemShape(elem: ElemName): Shape {
    let l = this.elemLocs.get(elem);
    if (l === undefined) {
      l = newLoc();
      const ranges: Partial<Record<ElemName, [number, number]>> = {
        u8: [0, 255],
        i8: [-128, 127],
        u16: [0, 65535],
        i16: [-32768, 32767],
        u32: [0, U32_MAX],
        i32: [I32_MIN, I32_MAX],
      };
      const r = ranges[elem];
      if (r !== undefined) joinLoc(l, { float: false, lo: r[0], hi: r[1], negz: false });
      else joinLoc(l, { float: true, lo: -Infinity, hi: Infinity, negz: true });
      this.elemLocs.set(elem, l);
    }
    return { s: "num", loc: l };
  }

  elemRep(raw: TE, elem: ElemName): TE {
    const sh = this.elemShape(elem);
    const l = findLoc((sh as Extract<Shape, { s: "num" }>).loc);
    const extra: Partial<TE> = { range: [l.lo, l.hi] };
    if (elem === "f32" || elem === "f64") {
      extra.negz = true;
      if (elem === "f64") return { ...raw, ...extra } as TE;
      return mk(T.f64, { k: "conv", val: raw }, extra);
    }
    if (elem === "u32") return { ...raw, ty: T.u32, ...extra } as TE;
    if (elem === "i32") return { ...raw, ...extra } as TE;
    return mk(T.i32, { k: "conv", val: raw }, extra);
  }

  /** The JS conversion a typed-array store performs: modular for integers, rounding for f32. */
  storeValue(v0: TE, elem: ElemName): TE {
    const v = v0;
    if (elem === "f32" || elem === "f64") return this.toFloat(v);
    if (isF(v)) return mk(T.i32, { k: "builtin", name: "wrapI32", args: [v], loc: "store" }, {});
    if (v.ty.k === "bool")
      return this.block("union-mixed", this.rootSf, "a boolean stored to a typed array");
    return v;
  }

  storeAt(arr: TE, elem: ElemName, i: TE, val: TE): TE {
    return mk(T.void, {
      k: "storeelem",
      ptr: this.ptrOfArr(arr),
      idx: this.ixOf(i),
      elem,
      val: this.storeValue(val, elem),
    });
  }

  countedLoop(iv: Var, n: TE, body: Stmt[], at: ts.Node): Stmt {
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    return {
      k: "for",
      init: [],
      c: this.cmpTE("lt", i, n),
      step: [
        mk(T.i32, {
          k: "setvar",
          v: iv,
          val: mk(T.i32, {
            k: "arith",
            op: "add",
            a: i,
            b: lit32(1),
            wrap: true,
            loc: this.loc(at),
          }),
        }),
      ],
      body,
    };
  }

  seqOf(te0: TE, at: ts.Node, out: Stmt[]): Seq {
    const te = this.temp(te0, out);
    const sh = te.sh as Shape | undefined;
    if (sh === undefined || (sh.s !== "arr" && sh.s !== "vec")) {
      this.block("unsupported", at, "a sequence operation on something that isn't an array");
    }
    if (sh.s === "arr") {
      const elem = sh.elem;
      const elemSh = this.elemShape(elem);
      const lenIx = (): TE => mk(T.usize, { k: "len", arr: te });
      const load = (ix: TE): TE =>
        this.elemRep(
          mk(this.elemTy(elem), { k: "loadelem", ptr: this.ptrOfArr(te), idx: ix, elem }),
          elem,
        );
      return {
        te,
        sh,
        elemSh,
        len: () => this.i32OfLen(lenIx()),
        at: (i) => load(this.ixOf(i)),
        opt: (i) => {
          const body: Stmt[] = [];
          const ix = this.temp(this.ixOf(i), body);
          const loaded = load(ix);
          const osh: Shape = { s: "opt", of: elemSh, nul: "undefined" };
          const ty = tyOf(osh);
          const has = mk(ty, { k: "tuple", items: [lit32(1), loaded] });
          const c = mk(
            ty,
            { k: "cond", c: this.cmpTE("lt", ix, lenIx()), a: has, b: this.none(osh) },
            { sh: osh },
          );
          return mk(ty, { k: "blockexpr", body, result: c }, { sh: osh });
        },
        trap: (i, node) => {
          return this.elemRep(
            mk(this.elemTy(elem), { k: "index", arr: te, idx: this.ixOf(i), loc: this.loc(node) }),
            elem,
          );
        },
      };
    }
    const n = findNode(sh.node);
    const elemSh = n.elem ?? { s: "void" };
    const slot = Math.max(1, sizeOf(elemSh));
    const lenIx = (): TE => mk(T.usize, { k: "fload", base: te, mem: [{ t: "ix", off: VEC_LEN }] });
    const data = (): TE =>
      mk({ k: "ref" }, { k: "fload", base: te, mem: [{ t: "ptr", off: VEC_DATA }] });
    const load = (ix: TE): TE => {
      const base = mk({ k: "ref" }, { k: "elemaddr", base: data(), idx: ix, scale: slot });
      return mk(tyOf(elemSh), { k: "fload", base, mem: memOf(elemSh, 0) }, this.readExtras(elemSh));
    };
    const isScalar = elemSh.s === "num" || elemSh.s === "bool" || elemSh.s === "str";
    return {
      te,
      sh,
      elemSh,
      len: () => this.i32OfLen(lenIx()),
      at: (i) => load(this.ixOf(i)),
      opt: (i) => {
        const body: Stmt[] = [];
        const ix = this.temp(this.ixOf(i), body);
        const inRange = this.cmpTE("lt", ix, lenIx());
        const osh: Shape = isScalar ? { s: "opt", of: elemSh, nul: "undefined" } : elemSh;
        const ty = tyOf(osh);
        const has = isScalar
          ? mk(ty, { k: "tuple", items: [lit32(1), load(ix)] }, { sh: osh })
          : load(ix);
        const none = osh.s === "opt" ? this.none(osh) : this.nullOf(osh);
        const c = mk(ty, { k: "cond", c: inRange, a: has, b: none }, { sh: osh });
        return mk(ty, { k: "blockexpr", body, result: c }, { sh: osh });
      },
      trap: (i, node) => {
        const body: Stmt[] = [];
        const ix = this.temp(this.ixOf(i), body);
        const loc = this.loc(node);
        body.push({
          k: "expr",
          e: mk(T.void, {
            k: "builtin",
            name: "assert",
            args: [this.cmpTE("lt", ix, lenIx()), lit32(2)],
            loc,
          }),
        });
        const v = load(ix);
        return mk(v.ty, { k: "blockexpr", body, result: v }, this.carry(v));
      },
    };
  }

  elemTy(elem: ElemName): Ty {
    return T[elem];
  }

  vecNew(sh: Extract<Shape, { s: "vec" }>, len: TE, at: ts.Node): TE {
    this.checkAlloc(sh.node, at);
    this.noteAlloc("vector", at, () => null, sh.node);
    const n = findNode(sh.node);
    const slot = Math.max(1, sizeOf(n.elem ?? { s: "void" }));
    return mk(
      { k: "ref" },
      { k: "rtcall", name: this.vecFn("__vec_new", sh.node), args: [this.ixOf(len), litIx(slot)] },
      { sh },
    );
  }

  vecLiteral(
    elements: readonly ts.Expression[],
    sh: Extract<Shape, { s: "vec" }>,
    at: ts.Node,
  ): TE {
    const out: Stmt[] = [];
    const hasSpread = elements.some(ts.isSpreadElement);
    const initial = hasSpread ? 0 : elements.length;
    const v = this.temp(this.vecNew(sh, lit32(initial), at), out);
    elements.forEach((x, i) => {
      if (ts.isSpreadElement(x) && this.mem && this.isItemSource(this.typeAt(x.expression))) {
        this.loopItems(x.expression, out, (item, body) => {
          this.vecPush(v, item.whole(), sh, x, body);
        });
        return;
      }
      if (ts.isSpreadElement(x)) {
        const src = this.seqOf(this.expr(x.expression), x, out);
        const n = this.temp(src.len(), out);
        const iv = this.newVar(T.i32, "$i");
        out.push({ k: "let", v: iv, init: lit32(0), constant: false });
        const body: Stmt[] = [];
        const r = this.readVar(iv, { range: [0, I32_MAX] });
        this.vecPush(v, src.at(r, x), sh, x, body);
        out.push(this.countedLoop(iv, n, body, x));
        return;
      }
      if (ts.isOmittedExpression(x)) {
        this.block("unsupported", x, "an array literal with holes");
      }
      const elemSh = findNode(sh.node).elem!;
      const te = this.flow(this.expr(x, elemSh), elemSh, x);
      this.markEscape(elemSh);
      if (hasSpread) this.vecPush(v, te, sh, x, out);
      else {
        const seq = this.seqOf(v, x, out);
        const base = this.elemPlace(seq, this.ixOf(lit32(i)));
        out.push({
          k: "expr",
          e: mk(te.ty, { k: "fstore", base, mem: memOf(elemSh, 0), val: te, rc: "init" }),
        });
      }
    });
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: v }, { sh });
  }

  elemPlace(seq: Seq, ix: TE): TE {
    const sh = seq.sh;
    const n = findNode((sh as Extract<Shape, { s: "vec" }>).node);
    const slot = Math.max(1, sizeOf(n.elem ?? { s: "void" }));
    const data = mk({ k: "ref" }, { k: "fload", base: seq.te, mem: [{ t: "ptr", off: VEC_DATA }] });
    if (this.rcOptions.cowProbe === true) {
      // A measurement only (SPEC 4.5, D42): the test a copy-on-write array would need before every write, never true here.
      const cap = mk(T.i32, { k: "fload", base: seq.te, mem: [{ t: "i32", off: VEC_CAP + 4 }] });
      const body: Stmt[] = [
        {
          k: "if",
          c: this.cmpTE("lt", cap, lit32(0)),
          a: [
            {
              k: "expr",
              e: mk(NEVER_TY, { k: "trapnow", kind: "convert", code: 4, loc: "cow probe" }),
            },
          ],
          b: null,
        },
      ];
      return mk(
        { k: "ref" },
        {
          k: "blockexpr",
          body,
          result: mk({ k: "ref" }, { k: "elemaddr", base: data, idx: ix, scale: slot }),
        },
      );
    }
    return mk({ k: "ref" }, { k: "elemaddr", base: data, idx: ix, scale: slot });
  }

  vecPush(v: TE, val: TE, sh: Extract<Shape, { s: "vec" }>, at: ts.Node, out: Stmt[]): void {
    this.checkAlloc(sh.node, at);
    const n = findNode(sh.node);
    const elemSh = n.elem!;
    const te = this.flow(val, elemSh, at);
    this.markEscape(elemSh);
    this.markWritten(sh);
    const held = this.temp(te, out);
    const seq = this.seqOf(v, at, out);
    const len = this.temp(
      mk(T.usize, { k: "fload", base: v, mem: [{ t: "ix", off: VEC_LEN }] }),
      out,
    );
    const slot = Math.max(1, sizeOf(elemSh));
    const next = mk(T.usize, {
      k: "arith",
      op: "add",
      a: len,
      b: litIx(1),
      wrap: true,
      loc: this.loc(at),
    });
    out.push({
      k: "expr",
      e: mk(T.void, {
        k: "rtcall",
        name: this.vecFn("__vec_reserve", sh.node),
        args: [v, next, litIx(slot)],
      }),
    });
    out.push({
      k: "expr",
      e: mk(held.ty, {
        k: "fstore",
        base: this.elemPlace(seq, len),
        mem: memOf(elemSh, 0),
        val: held,
        rc: "init",
      }),
    });
    out.push({
      k: "expr",
      e: mk(T.void, { k: "fstore", base: v, mem: [{ t: "ix", off: VEC_LEN }], val: next }),
    });
  }

  /** a[i] = v on a vector: past the end grows it, and holes need nullable slots (SPEC 4.5). */
  vecSet(
    v: TE,
    iTE: TE,
    val: TE,
    sh: Extract<Shape, { s: "vec" }>,
    at: ts.Node,
    out: Stmt[],
  ): void {
    const n = findNode(sh.node);
    const elemSh = n.elem!;
    const te = this.flow(val, elemSh, at);
    this.markEscape(elemSh);
    this.markWritten(sh);
    const held = this.temp(te, out);
    const ix = this.temp(this.ixOf(iTE), out);
    const len = mk(T.usize, { k: "fload", base: v, mem: [{ t: "ix", off: VEC_LEN }] });
    const loc = this.loc(at);
    const slot = Math.max(1, sizeOf(elemSh));
    const grow: Stmt[] = [];
    if (n.global && this.inst.run && !this.mem) {
      grow.push({ k: "expr", e: mk(NEVER_TY, { k: "trapnow", kind: "sparse", code: 15, loc }) });
    } else {
      grow.push({
        k: "if",
        c: this.cmpTE("gt", ix, litIx(I32_MAX)),
        a: [{ k: "expr", e: mk(NEVER_TY, { k: "trapnow", kind: "sparse", code: 15, loc }) }],
        b: null,
      });
      if (elemSh.s === "num" || elemSh.s === "bool" || elemSh.s === "str") {
        grow.push({
          k: "if",
          c: this.cmpTE("gt", ix, len),
          a: [{ k: "expr", e: mk(NEVER_TY, { k: "trapnow", kind: "sparse", code: 15, loc }) }],
          b: null,
        });
      }
      const next = this.temp(
        mk(T.usize, { k: "arith", op: "add", a: ix, b: litIx(1), wrap: true, loc }),
        grow,
      );
      grow.push({
        k: "expr",
        e: mk(T.void, {
          k: "rtcall",
          name: this.vecFn("__vec_reserve", sh.node),
          args: [v, next, litIx(slot)],
        }),
      });
      grow.push({
        k: "expr",
        e: mk(T.void, { k: "fstore", base: v, mem: [{ t: "ix", off: VEC_LEN }], val: next }),
      });
    }
    out.push({ k: "if", c: this.cmpTE("ge", ix, len), a: grow, b: null });
    const seq = this.seqOf(v, at, out);
    out.push({
      k: "expr",
      e: mk(held.ty, {
        k: "fstore",
        base: this.elemPlace(seq, ix),
        mem: memOf(elemSh, 0),
        val: held,
      }),
    });
  }

  // --- reading and writing places

  indexKey(e: ts.ElementAccessExpression): string | null {
    const a = strip(e.argumentExpression);
    if (ts.isStringLiteralLike(a)) return a.text;
    return null;
  }

  elementRead(e: ts.ElementAccessExpression, trap: boolean, whole: ts.Node): TE {
    const key = this.indexKey(e);
    if (key !== null) return this.property(e.expression, key, e);
    const baseT = this.typeAt(e.expression);
    if (this.mem) {
      const special = this.elementReadRt(e, baseT, trap, whole);
      if (special !== null) return special;
    }
    if (!this.isIndexable(baseT)) {
      this.block("computed-key", e, "an element access on something that isn't an array");
    }
    const out: Stmt[] = [];
    const seq = this.seqOf(this.exprNonNull(e.expression), e, out);
    const idxT = this.typeAt(e.argumentExpression);
    if (!hasFlag(idxT, ts.TypeFlags.NumberLike)) {
      this.block("computed-key", e, "an index that isn't a number");
    }
    const i = this.expr(e.argumentExpression);
    const v = trap ? seq.trap(i, e) : seq.opt(i, e);
    let r = v;
    if (trap) {
      const sh = seq.elemSh;
      if (sh.s === "opt") r = this.nonNullOpt(v, sh, whole);
      else if (sh.s === "obj" || sh.s === "vec" || sh.s === "arr")
        r = mk(v.ty, { k: "nonnull", val: v, loc: this.loc(whole) }, this.carry(v));
    } else if (r.ty.k === "opt") {
      r = this.narrowed(r, r.sh as Shape, whole);
    }
    return this.withPrelude(out, r);
  }

  isIndexable(t0: ts.Type): boolean {
    const t = this.subst(t0);
    if (t.isUnion())
      return t.types.every(
        (x) => hasFlag(x, ts.TypeFlags.Null | ts.TypeFlags.Undefined) || this.isIndexable(x),
      );
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) return true;
    const lib = this.libName(t);
    return lib !== null && (ELEM_BY_ARRAY[lib] !== undefined || lib === "ReadonlyArray");
  }

  nonNullOpt(v: TE, sh: Extract<Shape, { s: "opt" }>, at: ts.Node): TE {
    const body: Stmt[] = [];
    const t = this.temp(v, body);
    const loc = this.loc(at);
    body.push({
      k: "expr",
      e: mk(T.void, {
        k: "builtin",
        name: "assert",
        args: [mk(T.bool, { k: "slice", val: t, from: 0, to: 1 }), lit32(6)],
        loc,
      }),
    });
    const p = this.optPayload({ ...t, sh } as TE, sh);
    return mk(p.ty, { k: "blockexpr", body, result: p }, this.carry(p));
  }

  /** The base of a member access: a nullable one has been narrowed or asserted by here. */
  exprNonNull(e: ts.Expression): TE {
    return this.expr(e);
  }

  property(baseNode: ts.Expression, name: string, whole: ts.Expression): TE {
    const base = strip(baseNode);
    if (ts.isIdentifier(base)) {
      const sym = this.symbolOf(base);
      if (sym !== undefined) {
        const b = this.scope.get(sym);
        if (b?.b === "sroa") {
          const f = b.fields.get(name);
          if (f === undefined) this.block("unsupported", whole, `no field ${name}`);
          return this.narrowed(this.varTE(f.v, f.sh), f.sh, whole);
        }
        if (this.isLibSymbol(sym)) return this.libProperty(sym.name, name, whole);
        const decl = sym.valueDeclaration;
        if (decl !== undefined && ts.isEnumDeclaration(decl)) {
          const mem = this.checker.getConstantValue(whole as ts.PropertyAccessExpression);
          if (typeof mem === "number") return litNum(mem);
          if (typeof mem === "string") return this.strLit(mem);
          this.block("unsupported", whole, "an enum member without a constant value");
        }
      }
    }
    if (name === "prototype" || name === "__proto__" || name === "constructor") {
      this.block("prototype-mutation", whole, `access to ${name}`);
    }
    const stat = this.staticMember(base, name);
    if (stat !== null) return this.narrowDyn(this.staticRead(stat, whole), whole);
    const bt = this.typeAt(baseNode);
    if (name === "length" && this.isIndexable(bt)) {
      const out: Stmt[] = [];
      const seq = this.seqOf(this.exprNonNull(baseNode), whole, out);
      return this.withPrelude(out, seq.len());
    }
    if (this.mem && name === "length" && this.isStringType(bt)) {
      this.needStr(whole, "the length of a string");
      return this.strLength(this.exprNonNull(baseNode));
    }
    if (hasFlag(bt, ts.TypeFlags.StringLike) || hasFlag(bt, ts.TypeFlags.NumberLike)) {
      this.block("string-use", whole, `the property ${name} on a primitive`);
    }
    if (this.isIndexable(bt)) this.block("reflection", whole, `the array property ${name}`);
    const prop =
      bt.getProperty(name) ??
      (bt.isUnion()
        ? bt.types.map((x) => x.getProperty(name)).find((x) => x !== undefined)
        : undefined);
    if (prop !== undefined && (prop.flags & ts.SymbolFlags.Method) !== 0) {
      this.block("closure-escape", whole, `the method ${name} used as a value`);
    }
    const te = this.exprNonNull(baseNode);
    const sh = te.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj") {
      this.block("unsupported", whole, `the property ${name} on a ${sh?.s ?? te.ty.k}`);
    }
    if (prop !== undefined && (prop.flags & ts.SymbolFlags.Accessor) !== 0) {
      const g = prop.declarations?.find(ts.isGetAccessor);
      if (g === undefined) this.block("unsupported", whole, `the write-only accessor ${name}`);
      if (this.mem)
        return this.narrowDyn(
          this.dispatch(g, te, sh, bt, () => [], whole, "get"),
          whole,
        );
      const inst = this.methodInst(g, sh, bt);
      return this.callInst(inst, te, [], whole);
    }
    const n = findNode(sh.node);
    if (this.mem && name === "stack" && prop !== undefined && this.isLibSymbol(prop)) {
      // Divergence 13 (3.10): the header line V8 starts its stack with, and no frames.
      return this.toStrTE(te, bt, whole);
    }
    if (!n.fields.has(this.fkey(n, name, whole)))
      this.block("unsupported", whole, `no field ${name}`);
    const r = this.fieldRead(te, name, n, whole);
    return this.narrowDyn(this.narrowed(r, r.sh as Shape, whole), whole);
  }

  methodInst(decl: FnLike, sh: Shape, recvT: ts.Type): Inst {
    const c = decl.parent;
    if (this.fallback.has(decl)) {
      this.block(
        "callee",
        decl,
        `the method ${this.fnName(decl)} stayed JS, and objects don't cross a shim`,
        this.fallbackRoot(decl),
      );
    }
    const env = ts.isClassLike(c) ? this.classEnv(recvT, c) : new Map<number, ts.Type>();
    return this.instOf(decl, env, new Map(), sh, false, decl);
  }

  libProperty(ns: string, name: string, node: ts.Node): TE {
    if (ns === "Math" && MATH_CONST[name] !== undefined) return litNum(MATH_CONST[name]);
    if (ns === "Number" && NUMBER_CONST[name] !== undefined) return litNum(NUMBER_CONST[name]);
    const hit = LIB_BLOCKERS[ns];
    if (hit !== undefined) this.block(hit[0], node, hit[1]);
    this.block("unsupported", node, `${ns}.${name}`);
  }

  /** A writable place: evaluates its base once, then can be read and written. */
  lvalue(e0: ts.Expression, out: Stmt[]): LV {
    const e = strip(e0);
    if (ts.isNonNullExpression(e)) return this.lvalue(e.expression, out);
    if (ts.isIdentifier(e)) {
      const sym = this.symbolOf(e);
      if (sym === undefined) this.block("unsupported", e, "an unresolved name");
      const b = this.scope.get(sym);
      if (b?.b === "var") {
        if (b.konst !== undefined)
          this.block("unsupported", e, "an assignment to a folded constant");
        return {
          sh: b.sh,
          read: () => this.narrowed(this.varTE(b.v, b.sh), b.sh, e),
          write: (val, at) => {
            const te = this.flow(val, b.sh, at);
            // A loop's counter, narrowed by its condition: from here it may also be what's written (loopBound).
            const n = this.narrowVar.get(b.v);
            if (n !== undefined) {
              const r = range(te);
              n[0] = Math.min(n[0], r[0]);
              n[1] = Math.max(n[1], r[1]);
            }
            return mk(te.ty, { k: "setvar", v: b.v, val: te }, this.carry(te));
          },
        };
      }
      if (b?.b === "box") {
        const objSh: Shape = { s: "obj", node: b.node };
        return {
          sh: b.sh,
          read: () => this.boxRead(b, e),
          write: (val, at) => {
            const te = this.flow(val, b.sh, at);
            return this.fieldStore(this.varTE(b.v, objSh), "v", b.node, te);
          },
        };
      }
      if (b !== undefined) this.block("closure-escape", e, "an assignment to a function variable");
      const d = sym.valueDeclaration;
      if (d !== undefined && ts.isVariableDeclaration(d) && this.isModuleVar(sym)) {
        const entry = this.globalEntry(sym, d);
        return {
          sh: entry.sh,
          read: () => this.globalRead(sym, d, e),
          write: (val, at) => {
            if (this.initBlocked.has(sym))
              this.block(
                "global-init",
                at,
                `${sym.name} has an initialiser lowered code can't run`,
              );
            if (this.sharedGlobals.has(sym))
              this.block("shared-state", at, `${sym.name} is shared with a function that stays JS`);
            const te = this.flow(val, entry.sh, at);
            if (entry.sh.s === "arr" || entry.sh.s === "vec" || entry.sh.s === "obj") {
              if (this.inst.run && !this.mem)
                this.block(
                  "escape-global",
                  at,
                  `a reference stored in the module-level ${sym.name}`,
                );
              this.markGlobal(entry.sh);
            }
            return this.globalStore(entry.name, entry.sh, te);
          },
        };
      }
      this.block("unsupported", e, `an assignment to ${sym.name}`);
    }
    if (ts.isPropertyAccessExpression(e)) {
      if (ts.isIdentifier(e.expression) || e.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const sym = ts.isIdentifier(e.expression) ? this.symbolOf(e.expression) : undefined;
        const b = sym !== undefined ? this.scope.get(sym) : undefined;
        if (b?.b === "sroa") {
          const f = b.fields.get(e.name.text);
          if (f === undefined) this.block("unsupported", e, `no field ${e.name.text}`);
          return {
            sh: f.sh,
            read: () => this.narrowed(this.varTE(f.v, f.sh), f.sh, e),
            write: (val, at) => {
              const te = this.flow(val, f.sh, at);
              return mk(te.ty, { k: "setvar", v: f.v, val: te }, this.carry(te));
            },
          };
        }
      }
      const stat = this.staticMember(e.expression, e.name.text);
      if (stat !== null) return this.staticPlace(stat, e);
      return this.fieldPlace(e.expression, e.name.text, e, out);
    }
    if (ts.isElementAccessExpression(e)) {
      const key = this.indexKey(e);
      if (key !== null) return this.fieldPlace(e.expression, key, e, out);
      return this.elementPlace(e, e0, out);
    }
    this.block("unsupported", e, "an assignment to this kind of place");
  }

  fieldPlace(baseNode: ts.Expression, name: string, whole: ts.Expression, out: Stmt[]): LV {
    if (name === "prototype" || name === "__proto__")
      this.block("prototype-mutation", whole, `writing ${name}`);
    if (name === "length" && this.isIndexable(this.typeAt(baseNode))) {
      return this.lengthPlace(baseNode, whole, out);
    }
    const bt = this.typeAt(baseNode);
    const baseTe = this.temp(this.exprNonNull(baseNode), out);
    const sh = baseTe.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj")
      this.block("unsupported", whole, `the field ${name} on a ${sh?.s ?? baseTe.ty.k}`);
    const prop = bt.getProperty(name);
    if (prop !== undefined && (prop.flags & ts.SymbolFlags.Accessor) !== 0) {
      const g = prop.declarations?.find(ts.isGetAccessor);
      const st = prop.declarations?.find(ts.isSetAccessor);
      if (st === undefined) this.block("unsupported", whole, `the read-only accessor ${name}`);
      return {
        sh: { s: "void" },
        read: () => {
          if (g === undefined) this.block("unsupported", whole, `the write-only accessor ${name}`);
          return this.callInst(this.methodInst(g, sh, bt), baseTe, [], whole);
        },
        write: (val, at) => {
          const body: Stmt[] = [];
          const v = this.temp(val, body);
          body.push({ k: "expr", e: this.callInst(this.methodInst(st, sh, bt), baseTe, [v], at) });
          return mk(v.ty, { k: "blockexpr", body, result: v }, this.carry(v));
        },
      };
    }
    const n = findNode(sh.node);
    const key = this.fkey(n, name, whole);
    if (!n.fields.has(key)) this.block("unsupported", whole, `no field ${name}`);
    const fieldSh = n.fields.get(key)!;
    return {
      sh: fieldSh,
      read: () => {
        const r = this.fieldRead(baseTe, key, n, whole);
        return this.narrowDyn(this.narrowed(r, r.sh as Shape, whole), whole);
      },
      write: (val, at) => {
        const live = findNode(n).fields.get(key)!;
        const te = this.flow(val, live, at);
        this.markEscape(live);
        return this.fieldStore(baseTe, key, n, te);
      },
    };
  }

  elementPlace(e: ts.ElementAccessExpression, whole: ts.Expression, out: Stmt[]): LV {
    const seqBase = this.temp(this.exprNonNull(e.expression), out);
    const sh = seqBase.sh as Shape | undefined;
    if (sh === undefined || (sh.s !== "arr" && sh.s !== "vec")) {
      this.block("computed-key", e, "a computed write to something that isn't an array");
    }
    const idxT = this.typeAt(e.argumentExpression);
    if (!hasFlag(idxT, ts.TypeFlags.NumberLike))
      this.block("computed-key", e, "an index that isn't a number");
    const i = this.temp(this.expr(e.argumentExpression), out);
    const seq = this.seqOf(seqBase, e, out);
    this.markWritten(sh);
    const trap = ts.isNonNullExpression(strip(whole));
    if (sh.s === "arr") {
      return {
        sh: seq.elemSh,
        read: () => (trap ? seq.trap(i, e) : seq.opt(i, e)),
        write: (val) => {
          // Silently a no-op out of bounds, as in JS, unlike TSL proper (SPEC 4.5).
          const body: Stmt[] = [];
          const v = this.temp(val.ty.k === "opt" ? this.narrowOpt(val, e) : val, body);
          const ix = this.temp(this.ixOf(i), body);
          const elem = sh.elem;
          const inRange = this.cmpTE("lt", ix, mk(T.usize, { k: "len", arr: seqBase }));
          body.push({
            k: "if",
            c: inRange,
            a: [
              {
                k: "expr",
                e: mk(T.void, {
                  k: "storeelem",
                  ptr: this.ptrOfArr(seqBase),
                  idx: ix,
                  elem,
                  val: this.storeValue(v, elem),
                }),
              },
            ],
            b: null,
          });
          return mk(v.ty, { k: "blockexpr", body, result: v }, this.carry(v));
        },
      };
    }
    return {
      sh: seq.elemSh,
      read: () => {
        const v = trap ? seq.trap(i, e) : seq.opt(i, e);
        const es = seq.elemSh;
        if (trap && es.s === "opt") return this.nonNullOpt(v, es, e);
        if (trap && (es.s === "obj" || es.s === "vec" || es.s === "arr"))
          return mk(v.ty, { k: "nonnull", val: v, loc: this.loc(e) }, this.carry(v));
        return v;
      },
      write: (val, at) => {
        const body: Stmt[] = [];
        const v = this.temp(val, body);
        this.vecSet(seqBase, i, v, sh, at, body);
        return mk(v.ty, { k: "blockexpr", body, result: v }, this.carry(v));
      },
    };
  }

  // --- expressions

  exprStmt(e: ts.Expression): TE {
    return this.expr(e);
  }

  /** A condition in JS's truthiness, folded when it's constant. */
  condition(e0: ts.Expression): TE {
    const e = strip(e0);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      return this.not(this.condition(e.operand));
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const a = this.condition(e.left);
        const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
        if (a.k === "lit") {
          if (a.value === isAnd) return this.condition(e.right);
          return litBool(!isAnd);
        }
        const b = this.condition(e.right);
        return mk(T.bool, { k: "logic", op: isAnd ? "and" : "or", a, b });
      }
    }
    return this.truthy(this.expr(e0), e0);
  }

  truthy(te: TE, at: ts.Node): TE {
    switch (te.ty.k) {
      case "bool":
        return te;
      case "int":
        if (te.k === "lit") return litBool(te.value !== 0);
        return this.cmpTE("ne", te, retype(lit32(0), te.ty));
      case "float": {
        if (te.k === "lit")
          return litBool(typeof te.value === "number" && te.value !== 0 && !Number.isNaN(te.value));
        // NaN and both zeros are falsy, and |x| > 0 says exactly that.
        const abs = mk(T.f64, { k: "builtin", name: "Math.abs", args: [te], loc: "truthy" });
        return this.cmpTE("gt", abs, mk(T.f64, { k: "lit", value: 0 }));
      }
      case "ref":
      case "arr":
        if (this.isStr(te.sh)) return this.strTruthy(te);
        // An `unknown` is a pointer, but a box of false, 0, NaN or "" is falsy, as the value in it is (JS's ToBoolean).
        if (this.isDyn(te.sh))
          return this.rtCall(this.strRt ? "tmkDynTruthy" : "tmkDynTruthyNoStr", [te], at);
        return this.cmpTE("ne", te, nullPtr());
      case "opt": {
        const sh = te.sh as Extract<Shape, { s: "opt" }>;
        const body: Stmt[] = [];
        const t = this.temp(te, body);
        const tag = mk(T.bool, { k: "slice", val: t, from: 0, to: 1 });
        const r = mk(T.bool, {
          k: "logic",
          op: "and",
          a: tag,
          b: this.truthy(this.optPayload({ ...t, sh } as TE, sh), at),
        });
        return mk(T.bool, { k: "blockexpr", body, result: r });
      }
      case "lits": {
        if (te.k === "lit") return litBool(te.value !== "" && te.value !== 0);
        const empty = this.strings.get("");
        if (empty === undefined) return litBool(true);
        return this.cmpTE("ne", te, lit32(empty));
      }
      case "nullish":
      case "void":
        return litBool(false);
      default:
        return this.block("unsupported", at, `the truthiness of a ${te.ty.k}`);
    }
  }

  expr(e: ts.Expression, want?: Shape, wrap = false): TE {
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return litNum(Number((e as ts.NumericLiteral).text));
      case ts.SyntaxKind.BigIntLiteral:
        return this.block("bigint", e, "a plain bigint literal");
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return this.strLitChecked(e as ts.StringLiteralLike);
      case ts.SyntaxKind.TemplateExpression:
        this.needStr(e, "a template string outside a thrown message");
        return this.template(e as ts.TemplateExpression);
      case ts.SyntaxKind.RegularExpressionLiteral:
        return this.block("regexp", e, "a regular expression");
      case ts.SyntaxKind.TrueKeyword:
        return litBool(true);
      case ts.SyntaxKind.FalseKeyword:
        return litBool(false);
      case ts.SyntaxKind.NullKeyword:
        return this.mem ? { ...NULLISH, isNull: true } : NULLISH;
      case ts.SyntaxKind.Identifier:
        return this.identifier(e as ts.Identifier);
      case ts.SyntaxKind.ThisKeyword: {
        if (this.thisVar === null) this.block("unsupported", e, "this outside a method");
        return this.varTE(this.thisVar.v, this.thisVar.sh);
      }
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.expr((e as ts.ParenthesizedExpression).expression, want, wrap);
      case ts.SyntaxKind.SatisfiesExpression:
        return this.expr((e as ts.SatisfiesExpression).expression, want, wrap);
      case ts.SyntaxKind.AsExpression: {
        const x = e as ts.AsExpression;
        if (isAnyTypeNode(x.type)) this.block("any-type", x, "a cast to any or unknown");
        const inner = this.expr(x.expression, want, wrap);
        if (!this.isDyn(inner.sh)) this.checkCast(x);
        // `e as Error` on an `unknown`: a narrowing as a type predicate's is, with the class id checked, and a lie traps 17
        // (3.10), where V8 would read on and find undefined. A test build can leave the check out, to show tests catch it.
        if (this.isDyn(inner.sh)) {
          this.castUnchecked = this.rcOptions.rtFault === "cast-unchecked";
          try {
            return this.narrowDyn(inner, x);
          } finally {
            this.castUnchecked = false;
          }
        }
        return inner;
      }
      case ts.SyntaxKind.NonNullExpression:
        return this.nonNull(e as ts.NonNullExpression);
      case ts.SyntaxKind.PropertyAccessExpression: {
        const x = e as ts.PropertyAccessExpression;
        if (x.questionDotToken !== undefined) return this.optionalChain(x);
        return this.property(x.expression, x.name.text, x);
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const x = e as ts.ElementAccessExpression;
        if (x.questionDotToken !== undefined) this.block("unsupported", x, "?.[ ]");
        return this.elementRead(x, false, x);
      }
      case ts.SyntaxKind.CallExpression:
        return this.call(e as ts.CallExpression, want);
      case ts.SyntaxKind.NewExpression:
        return this.newExpr(e as ts.NewExpression, want);
      case ts.SyntaxKind.BinaryExpression:
        return this.binary(e as ts.BinaryExpression, want, wrap);
      case ts.SyntaxKind.PrefixUnaryExpression:
        return this.prefix(e as ts.PrefixUnaryExpression, wrap);
      case ts.SyntaxKind.PostfixUnaryExpression:
        return this.update(e as ts.PostfixUnaryExpression, false);
      case ts.SyntaxKind.ConditionalExpression:
        return this.conditional(e as ts.ConditionalExpression, want);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const x = e as ts.ArrayLiteralExpression;
        const sh = this.slot(this.slotKey(x), this.typeAt(x), x);
        if (sh.s === "obj" && this.mem) return this.tupleLiteral(x, sh);
        if (sh.s !== "vec") this.block("unsupported", x, "an array literal with no vector shape");
        return this.vecLiteral(x.elements, sh, x);
      }
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.objectLit(e as ts.ObjectLiteralExpression);
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        if (this.mem) return this.materialize(this.targetOf(e as ts.ArrowFunction), e);
        return this.block(
          "closure-escape",
          e,
          "a function value that isn't called or passed to a known callee",
        );
      case ts.SyntaxKind.AwaitExpression:
        return this.block("async", e, "await");
      case ts.SyntaxKind.YieldExpression:
        return this.block("generator", e, "yield");
      case ts.SyntaxKind.TypeOfExpression:
        if (this.mem) return this.typeofValue((e as ts.TypeOfExpression).expression, e);
        return this.block("reflection", e, "typeof at run time");
      case ts.SyntaxKind.DeleteExpression:
        return this.block("computed-key", e, "delete changes an object's shape");
      case ts.SyntaxKind.VoidExpression: {
        const inner = this.expr((e as ts.VoidExpression).expression);
        return mk({ k: "nullish" }, { k: "seq", items: [inner], result: VOID });
      }
      case ts.SyntaxKind.SpreadElement:
        return this.block("unsupported", e, "a spread here");
      case ts.SyntaxKind.ClassExpression:
        return this.block("unsupported", e, "a class expression");
      default:
        return this.block("unsupported", e, `the expression ${ts.SyntaxKind[e.kind]}`);
    }
  }

  strLitChecked(e: ts.StringLiteralLike): TE {
    if (this.strRt) return this.strLit(e.text);
    const ct = this.checker.getTypeAtLocation(e);
    const context = this.checker.getContextualType(e);
    const lit = hasFlag(ct, ts.TypeFlags.StringLiteral);
    if (
      !lit ||
      (context !== undefined && hasFlag(context, ts.TypeFlags.String) && !context.isUnion())
    ) {
      this.needStr(e, "a string used as a run-time value");
    }
    return this.strLit(e.text);
  }

  identifier(e: ts.Identifier): TE {
    if (e.text === "undefined") {
      const s0 = this.checker.getSymbolAtLocation(e);
      if (s0 === undefined || this.isLibSymbol(s0) || s0.name === "undefined") return NULLISH;
    }
    const parent = e.parent;
    const sym =
      ts.isShorthandPropertyAssignment(parent) && parent.name === e
        ? this.symbolOf(parent)
        : this.symbolOf(e);
    if (sym === undefined) this.block("unsupported", e, `the name ${e.text}`);
    const b = this.scope.get(sym);
    if (b !== undefined) {
      if (b.b === "closure") {
        if (!this.mem) this.block("closure-escape", e, `the closure ${e.text} used as a value`);
        if (b.targets.length !== 1 || b.tag !== null) {
          this.block("closure-escape", e, `the selection ${e.text} used as a value`);
        }
        return this.materialize(b.targets[0]!, e);
      }
      if (b.b === "box") return this.boxRead(b, e);
      if (b.b === "sroa") this.block("unsupported", e, `the scalar-replaced ${e.text} used whole`);
      if (b.konst !== undefined) return b.konst;
      return this.narrowDyn(this.narrowed(this.varTE(b.v, b.sh), b.sh, e), e);
    }
    if (this.isLibSymbol(sym)) {
      if (e.text === "NaN") return litNum(Number.NaN);
      if (e.text === "Infinity") return litNum(Infinity);
      const hit = LIB_BLOCKERS[e.text];
      if (hit !== undefined) this.block(hit[0], e, hit[1]);
      this.block("unsupported", e, `the global ${e.text}`);
    }
    const d = sym.valueDeclaration;
    if (d !== undefined && ts.isVariableDeclaration(d) && this.isModuleVar(sym)) {
      const top = this.topFunction(sym);
      if (top !== null) {
        if (this.mem) return this.materialize(this.topTarget(top), e);
        this.block("closure-escape", e, `the function ${e.text} used as a value`);
      }
      return this.globalRead(sym, d, e);
    }
    if (d !== undefined && ts.isFunctionDeclaration(d)) {
      const top = this.topFunction(sym);
      if (this.mem && top !== null) return this.materialize(this.topTarget(top), e);
      this.block("closure-escape", e, `the function ${e.text} used as a value`);
    }
    if (d !== undefined && ts.isEnumMember(d)) {
      const v = this.checker.getConstantValue(d);
      if (typeof v === "number") return litNum(v);
    }
    this.block("unsupported", e, `the name ${e.text}, declared outside any lowered scope`);
  }

  nonNull(e: ts.NonNullExpression): TE {
    const inner = strip(e.expression);
    if (ts.isElementAccessExpression(inner) && this.indexKey(inner) === null)
      return this.elementRead(inner, true, e);
    const t = this.typeAt(e.expression);
    if (this.nonNullable(t)) return this.expr(e.expression);
    const te = this.expr(e.expression);
    if (te.ty.k === "opt") return this.nonNullOpt(te, te.sh as Extract<Shape, { s: "opt" }>, e);
    if (te.ty.k === "nullish")
      return mk(NEVER_TY, { k: "trapnow", kind: "null", code: 6, loc: this.loc(e) });
    if (te.ty.k === "ref" || te.ty.k === "arr")
      return mk(te.ty, { k: "nonnull", val: te, loc: this.loc(e) }, this.carry(te));
    return te;
  }

  optionalChain(x: ts.PropertyAccessExpression): TE {
    const out: Stmt[] = [];
    const base = this.temp(this.expr(x.expression), out);
    const sh = this.slot(this.slotKey(x), this.typeAt(x), x);
    const hide = base.sh as Shape;
    let read: TE;
    if ((hide.s === "arr" || hide.s === "vec") && x.name.text === "length") {
      read = this.seqOf(base, x, out).len();
    } else if (hide.s === "obj") read = this.fieldRead(base, x.name.text, hide.node, x);
    else this.block("unsupported", x, "?. on something that isn't an object");
    const r = mk(
      tyOf(sh),
      {
        k: "cond",
        c: this.cmpTE("ne", base, nullPtr()),
        a: this.flow(read, sh, x),
        b: this.flow(NULLISH, sh, x),
      },
      this.readExtras(sh),
    );
    return this.withPrelude(out, this.narrowed(r, sh, x));
  }

  conditional(e: ts.ConditionalExpression, want?: Shape): TE {
    const c = this.condition(e.condition);
    if (c.k === "lit") return this.expr(c.value === true ? e.whenTrue : e.whenFalse, want);
    const a = this.expr(e.whenTrue, want);
    const b = this.expr(e.whenFalse, want);
    return this.conditionalTE(c, a, b, e);
  }

  /** Both arms as one value: f64 if either needs it, and nullable if either is. */
  conditionalTE(c: TE, a: TE, b: TE, at: ts.Node): TE {
    if (a.ty.k === "never") return mk(b.ty, { k: "cond", c, a, b }, this.carry(b));
    if (b.ty.k === "never") return mk(a.ty, { k: "cond", c, a, b }, this.carry(a));
    if (a.ty.k === "nullish" && b.ty.k === "nullish") return NULLISH;
    if (a.ty.k === "nullish" || b.ty.k === "nullish") {
      const other = a.ty.k === "nullish" ? b : a;
      const osh = other.sh as Shape | undefined;
      let sh: Shape;
      if (
        osh !== undefined &&
        (osh.s === "arr" || osh.s === "vec" || osh.s === "obj" || osh.s === "opt")
      )
        sh = osh;
      else {
        const inner: Shape = isNum(other)
          ? { s: "num", loc: this.exprLoc(at, other) }
          : other.ty.k === "bool"
            ? { s: "bool" }
            : { s: "str" };
        const nul = this.nullishOf(this.typeAt(at)).null ? "null" : "undefined";
        sh = { s: "opt", of: inner, nul };
      }
      const ax = this.flow(a, sh, at);
      const bx = this.flow(b, sh, at);
      return mk(tyOf(sh), { k: "cond", c, a: ax, b: bx }, { sh });
    }
    if (a.ty.k === "opt" || b.ty.k === "opt") {
      const osh = (a.ty.k === "opt" ? a.sh : b.sh) as Extract<Shape, { s: "opt" }>;
      const key = this.slotKey(at);
      const hit = this.slots.get(`${key}#c`) as Extract<Shape, { s: "opt" }> | undefined;
      const sh: Extract<Shape, { s: "opt" }> =
        hit ??
        (osh.of.s === "num" ? { s: "opt", of: { s: "num", loc: newLoc() }, nul: osh.nul } : osh);
      if (hit === undefined) this.slots.set(`${key}#c`, sh);
      const ax = this.flow(a, sh, at);
      const bx = this.flow(b, sh, at);
      return mk(tyOf(sh), { k: "cond", c, a: ax, b: bx }, { sh });
    }
    if (isNum(a) && isNum(b)) {
      const [x, y] = this.sameRep(a, b);
      const ra = range(x);
      const rb = range(y);
      const extra: Partial<TE> = { range: [Math.min(ra[0], rb[0]), Math.max(ra[1], rb[1])] };
      const deps = [...(x.deps ?? []), ...(y.deps ?? [])];
      if (deps.length > 0) extra.deps = deps;
      if (x.negz === true || y.negz === true) extra.negz = true;
      return mk(x.ty, { k: "cond", c, a: x, b: y }, extra);
    }
    if (a.ty.k === "ref" || a.ty.k === "arr") {
      const sa = a.sh as Shape;
      const sb = b.sh as Shape | undefined;
      if (sb === undefined || sa.s !== sb.s)
        this.block("union-mixed", at, "two arms with different shapes");
      this.unify(sa, sb, at);
      return mk(a.ty, { k: "cond", c, a, b }, { sh: sa });
    }
    if (a.ty.k !== b.ty.k) this.block("union-mixed", at, `arms of type ${a.ty.k} and ${b.ty.k}`);
    return mk(a.ty, { k: "cond", c, a, b }, this.carry(a));
  }

  /** A location for an expression's facts when a nullable wraps a number with no slot of its own. */
  exprLoc(at: ts.Node, te: TE): NumLoc {
    const key = `${this.slotKey(at)}#l`;
    let sh = this.slots.get(key);
    if (sh === undefined) {
      sh = { s: "num", loc: newLoc() };
      this.slots.set(key, sh);
    }
    const loc = (sh as Extract<Shape, { s: "num" }>).loc;
    this.join(loc, te);
    return loc;
  }

  sameRep(a: TE, b: TE): [TE, TE] {
    if (!isF(a) && !isF(b)) {
      const ra = range(a);
      const rb = range(b);
      const lo = Math.min(ra[0], rb[0]);
      const hi = Math.max(ra[1], rb[1]);
      if (lo >= I32_MIN && hi <= I32_MAX) return [retype(a, T.i32), retype(b, T.i32)];
      if (lo >= 0 && hi <= U32_MAX) return [retype(a, T.u32), retype(b, T.u32)];
    }
    return [this.toFloat(a), this.toFloat(b)];
  }

  // --- operators

  binary(e: ts.BinaryExpression, want: Shape | undefined, wrap: boolean): TE {
    const op = e.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.CommaToken: {
        const a = this.expr(e.left);
        const b = this.expr(e.right, want, wrap);
        return mk(b.ty, { k: "seq", items: [a], result: b }, this.carry(b));
      }
      case ts.SyntaxKind.EqualsToken:
        return this.assign(e);
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
        return this.logicalValue(e, op === ts.SyntaxKind.AmpersandAmpersandToken, want);
      case ts.SyntaxKind.QuestionQuestionToken:
        return this.nullishCoalesce(e, want);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return this.comparison(e);
      case ts.SyntaxKind.InstanceOfKeyword:
        if (this.mem) return this.instanceOf(e);
        return this.block("reflection", e, "instanceof needs run-time types");
      case ts.SyntaxKind.InKeyword:
        return this.block("reflection", e, "in needs run-time keys");
      default:
        break;
    }
    if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) {
      return this.compound(e, op);
    }
    const lt = this.typeAt(e.left);
    const rt = this.typeAt(e.right);
    if (hasFlag(lt, ts.TypeFlags.BigIntLike) || hasFlag(rt, ts.TypeFlags.BigIntLike)) {
      this.block("bigint", e, "plain bigint arithmetic");
    }
    if (
      op === ts.SyntaxKind.PlusToken &&
      (hasFlag(lt, ts.TypeFlags.StringLike) || hasFlag(rt, ts.TypeFlags.StringLike))
    ) {
      this.needStr(e, "string concatenation");
      return this.concat(e.left, e.right, e);
    }
    const bitOp = isBitOp(op);
    const inner =
      bitOp ||
      (wrap &&
        (op === ts.SyntaxKind.PlusToken ||
          op === ts.SyntaxKind.MinusToken ||
          op === ts.SyntaxKind.AsteriskToken));
    const a = this.expr(e.left, undefined, inner);
    const b = this.expr(e.right, undefined, inner);
    return this.binaryTE(op, a, b, e, wrap);
  }

  binaryTE(op: ts.SyntaxKind, a0: TE, b0: TE, node: ts.Node, wrap: boolean): TE {
    const a = this.numOperand(a0, node);
    const b = this.numOperand(b0, node);
    if (
      a.k === "lit" &&
      b.k === "lit" &&
      typeof a.value === "number" &&
      typeof b.value === "number"
    ) {
      const r = foldBinary(op, a.value, b.value);
      if (r !== null) return litNum(r);
    }
    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return this.arith("add", a, b, node, wrap);
      case ts.SyntaxKind.MinusToken:
        return this.arith("sub", a, b, node, wrap);
      case ts.SyntaxKind.AsteriskToken:
        return this.arith("mul", a, b, node, wrap);
      case ts.SyntaxKind.SlashToken:
        return this.divide(a, b);
      case ts.SyntaxKind.PercentToken:
        return this.remainder(a, b, node);
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return this.mathPow(a, b);
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.CaretToken:
        return this.bitop(op, a, b);
      case ts.SyntaxKind.LessThanLessThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return this.shift(op, a, b);
      default:
        return this.block("unsupported", node, `the operator ${ts.SyntaxKind[op]}`);
    }
  }

  numOperand(te: TE, node: ts.Node): TE {
    if (te.ty.k === "opt") return this.narrowOpt(te, node);
    if (isNum(te) || te.ty.k === "never") return te;
    return this.block("union-mixed", node, `arithmetic on a ${te.ty.k}, which JS would coerce`);
  }

  arith(op: "add" | "sub" | "mul", a: TE, b: TE, node: ts.Node, wrap: boolean): TE {
    const ra = range(a);
    const rb = range(b);
    let r: [number, number];
    if (op === "add") r = [iadd(ra[0], rb[0]), iadd(ra[1], rb[1])];
    else if (op === "sub") r = [iadd(ra[0], -rb[1]), iadd(ra[1], -rb[0])];
    else {
      const c = [imul(ra[0], rb[0]), imul(ra[0], rb[1]), imul(ra[1], rb[0]), imul(ra[1], rb[1])];
      r = [Math.min(...c), Math.max(...c)];
    }
    const zeroIn = (x: readonly [number, number]): boolean => x[0] <= 0 && x[1] >= 0;
    const negz =
      op === "add"
        ? a.negz === true && b.negz === true
        : op === "sub"
          ? a.negz === true && (zeroIn(rb) || b.negz !== true)
          : a.negz === true ||
            b.negz === true ||
            (zeroIn(ra) && rb[0] < 0) ||
            (zeroIn(rb) && ra[0] < 0);
    const float = isF(a) || isF(b);
    const key = this.slotKey(node);
    if (wrap && !float && Math.abs(r[0]) <= 2 ** 53 && Math.abs(r[1]) <= 2 ** 53) {
      // Under a bit operation JS keeps only the low bits of an exact value, and wrapping gives those.
      return mk(
        T.i32,
        {
          k: "arith",
          op,
          a: retype(a, T.i32),
          b: retype(b, T.i32),
          wrap: true,
          loc: this.loc(node),
        },
        { range: r },
      );
    }
    // An integer result its operands' ranges don't prove fits i32 is f64, which is exactly JS's number: a check there would
    // trap where V8 gives a result (4.5). A loop's counter is bounded by its condition (`loopBound`), so it stays i32.
    const fits = r[0] >= I32_MIN && r[1] <= I32_MAX;
    const useFloat =
      float ||
      isU32(a) ||
      isU32(b) ||
      this.forced.has(key) ||
      (!wrap && !fits) ||
      (wrap && (op === "mul" || Math.abs(r[0]) > 2 ** 53 || Math.abs(r[1]) > 2 ** 53));
    if (useFloat) {
      const floatNegz =
        isF(a) || isF(b) ? (op === "mul" ? ra[0] < 0 || rb[0] < 0 || negz : negz) : negz;
      const extra: Partial<TE> = { range: r };
      if (floatNegz) extra.negz = true;
      return mk(T.f64, { k: "farith", op, a: this.toFloat(a), b: this.toFloat(b) }, extra);
    }
    const proved = r[0] >= I32_MIN && r[1] <= I32_MAX;
    const extra: Partial<TE> = {
      range: proved ? r : [Math.max(r[0], I32_MIN), Math.min(r[1], I32_MAX)],
    };
    if (negz) {
      extra.negz = true;
      extra.deps = [key];
    }
    return mk(
      T.i32,
      {
        k: "arith",
        op,
        a: retype(a, T.i32),
        b: retype(b, T.i32),
        wrap: proved,
        loc: this.loc(node),
      },
      extra,
    );
  }

  divide(a: TE, b: TE): TE {
    if (b.k === "lit" && b.value === 1) return a;
    const ra = range(a);
    const rb = range(b);
    const nonneg = ra[0] >= 0 && rb[0] >= 0 && a.negz !== true && b.negz !== true;
    const extra: Partial<TE> = { range: nonneg ? [0, Infinity] : [-Infinity, Infinity] };
    if (!nonneg) extra.negz = true;
    return mk(T.f64, { k: "farith", op: "div", a: this.toFloat(a), b: this.toFloat(b) }, extra);
  }

  remainder(a: TE, b: TE, node: ts.Node): TE {
    const ra = range(a);
    const rb = range(b);
    const key = this.slotKey(node);
    if (!isF(a) && !isF(b) && !this.forced.has(key)) {
      const unsigned = isU32(a) || isU32(b);
      if (unsigned && (ra[0] < 0 || rb[0] < 0)) return this.remFloat(a, b, ra);
      const ty = unsigned ? T.u32 : T.i32;
      const m = Math.max(Math.abs(rb[0]), Math.abs(rb[1])) - 1;
      const lo = ra[0] < 0 ? -Math.min(m, -ra[0]) : 0;
      const hi = Math.min(Math.max(ra[1], 0), Math.max(m, 0));
      const extra: Partial<TE> = { range: [lo, hi] };
      if (ra[0] < 0 || a.negz === true) {
        extra.negz = true;
        extra.deps = [key];
      }
      return mk(
        ty,
        {
          k: "arith",
          op: "rem",
          a: retype(a, ty),
          b: retype(b, ty),
          wrap: false,
          loc: this.loc(node),
        },
        extra,
      );
    }
    return this.remFloat(a, b, ra);
  }

  remFloat(a: TE, b: TE, ra: readonly [number, number]): TE {
    const extra: Partial<TE> = { range: [ra[0] >= 0 ? 0 : -Infinity, ra[1] <= 0 ? 0 : Infinity] };
    if (ra[0] < 0 || a.negz === true) extra.negz = true;
    return mk(T.f64, { k: "farith", op: "rem", a: this.toFloat(a), b: this.toFloat(b) }, extra);
  }

  mathPow(a: TE, b: TE): TE {
    return mk(
      T.f64,
      { k: "intrinsic", name: "math.pow", args: [this.toFloat(a), this.toFloat(b)] },
      { negz: true },
    );
  }

  bitop(op: ts.SyntaxKind, a: TE, b: TE): TE {
    const ra = this.i32Range(a);
    const rb = this.i32Range(b);
    let r: [number, number] = [I32_MIN, I32_MAX];
    const nnA = ra[0] >= 0;
    const nnB = rb[0] >= 0;
    let name: "and" | "or" | "xor";
    if (op === ts.SyntaxKind.AmpersandToken) {
      name = "and";
      if (nnA && nnB) r = [0, Math.min(ra[1], rb[1])];
      else if (nnA) r = [0, ra[1]];
      else if (nnB) r = [0, rb[1]];
    } else {
      name = op === ts.SyntaxKind.BarToken ? "or" : "xor";
      if (nnA && nnB) r = [0, bitsUpper(Math.max(ra[1], rb[1]))];
    }
    return mk(T.i32, { k: "bit", op: name, a, b }, { range: r });
  }

  /** The range a value has after ToInt32: anything outside i32 could become anything. */
  i32Range(te: TE): readonly [number, number] {
    const r = range(te);
    if (isF(te) || r[0] < I32_MIN || r[1] > I32_MAX) return [I32_MIN, I32_MAX];
    return r;
  }

  shift(op: ts.SyntaxKind, a: TE, b: TE): TE {
    const ra = this.i32Range(a);
    const n = b.k === "lit" && typeof b.value === "number" ? b.value & 31 : null;
    if (op === ts.SyntaxKind.LessThanLessThanToken) {
      let r: [number, number] = [I32_MIN, I32_MAX];
      if (n !== null) {
        const lo = ra[0] * 2 ** n;
        const hi = ra[1] * 2 ** n;
        if (lo >= I32_MIN && hi <= I32_MAX) r = [lo, hi];
      }
      return mk(T.i32, { k: "bit", op: "shl", a, b }, { range: r });
    }
    if (op === ts.SyntaxKind.GreaterThanGreaterThanToken) {
      let r: [number, number] = ra[0] >= 0 ? [0, ra[1]] : [ra[0], Math.max(ra[1], -1)];
      if (n !== null) r = [Math.floor(ra[0] / 2 ** n), Math.floor(ra[1] / 2 ** n)];
      return mk(T.i32, { k: "bit", op: "shr", a, b }, { range: r });
    }
    // >>> : the bit pattern read as unsigned, so a non-negative i32 stays what it was.
    const full = range(a);
    const nn = !isF(a) && full[0] >= 0 && full[1] <= U32_MAX;
    let hi = nn ? full[1] : U32_MAX;
    if (n !== null) hi = Math.floor(hi / 2 ** n);
    const ty = hi <= I32_MAX ? T.i32 : T.u32;
    return mk(ty, { k: "bit", op: "ushr", a, b }, { range: [0, hi] });
  }

  prefix(e: ts.PrefixUnaryExpression, wrap: boolean): TE {
    switch (e.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return this.not(this.condition(e.operand));
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        return this.update(e, true);
      case ts.SyntaxKind.PlusToken: {
        const v = this.numOperand(this.expr(e.operand), e);
        return v;
      }
      case ts.SyntaxKind.MinusToken: {
        const v = this.numOperand(this.expr(e.operand, undefined, false), e);
        if (v.k === "lit" && typeof v.value === "number") return litNum(-v.value);
        const r = range(v);
        const zero = r[0] <= 0 && r[1] >= 0;
        const key = this.slotKey(e);
        if (isF(v) || isU32(v) || this.forced.has(key) || -r[0] > I32_MAX) {
          const ex: Partial<TE> = { range: [-r[1], -r[0]] };
          if (zero || v.negz === true) ex.negz = true;
          return mk(T.f64, { k: "neg", a: this.toFloat(v), loc: this.loc(e) }, ex);
        }
        const ex: Partial<TE> = { range: [Math.max(-r[1], I32_MIN), Math.min(-r[0], I32_MAX)] };
        if (zero) {
          ex.negz = true;
          ex.deps = [key];
        }
        void wrap;
        return mk(T.i32, { k: "neg", a: v, loc: this.loc(e) }, ex);
      }
      case ts.SyntaxKind.TildeToken: {
        const v = this.numOperand(this.expr(e.operand, undefined, true), e);
        if (v.k === "lit" && typeof v.value === "number") return litNum(~v.value);
        return mk(T.i32, { k: "bitnot", a: v });
      }
      default:
        return this.block("unsupported", e, "this unary operator");
    }
  }

  update(e: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, isPrefix: boolean): TE {
    const out: Stmt[] = [];
    const lv = this.lvalue(e.operand, out);
    const old = this.temp(this.numOperand(lv.read(), e), out);
    const op =
      e.operator === ts.SyntaxKind.PlusPlusToken
        ? ts.SyntaxKind.PlusToken
        : ts.SyntaxKind.MinusToken;
    const next = this.binaryTE(op, old, lit32(1), e, false);
    const written = lv.write(next, e);
    if (isPrefix)
      return mk(written.ty, { k: "blockexpr", body: out, result: written }, this.carry(written));
    out.push({ k: "expr", e: written });
    return mk(old.ty, { k: "blockexpr", body: out, result: old }, this.carry(old));
  }

  assign(e: ts.BinaryExpression): TE {
    const left = strip(e.left);
    if (ts.isArrayLiteralExpression(left)) return this.assignPattern(left, e);
    if (ts.isObjectLiteralExpression(left)) {
      this.block("unsupported", left, "a destructuring assignment");
    }
    if (ts.isIdentifier(left)) {
      const sym = this.symbolOf(left);
      const b = sym !== undefined ? this.scope.get(sym) : undefined;
      if (b?.b === "closure") {
        if (b.tag === null) this.block("closure-escape", e, "assigning to a const closure");
        this.checkOutlives(b, sym!, e);
        const tag = this.closureTag(b.targets, e.right);
        return mk(T.i32, { k: "setvar", v: b.tag, val: tag });
      }
    }
    if (process.env.TMK_TEST_DOWN !== "narrow-reassigned") this.noteReassignedTarget(e);
    const out: Stmt[] = [];
    const lv = this.lvalue(e.left, out);
    const val = this.expr(e.right, lv.sh.s === "void" ? undefined : lv.sh);
    const w = lv.write(val, e);
    return this.withPrelude(out, w);
  }

  /**
   * Places whose type tsc narrows unsoundly (R3): after `p.f = ((p = q), v)`, tsc takes `p.f` to hold v's type, but v went
   * into the first p's f, and the p read later is q, whose f may still be null. JS evaluates the target's object before the
   * right side, as the lowering does (`fieldPlace` holds it in a temporary); what was wrong was trusting that narrowing, so
   * such a place's later reads are checked as its declared type says.
   */
  unsoundPaths = new Set<string>();
  symIds = new Map<ts.Symbol, number>();

  /** A reference's key, by symbol: `p`, `this`, `p.a.f`; null for anything else (a call, an element by a variable, ...). */
  refKey(n0: ts.Node): string | null {
    const n = ts.isExpression(n0) ? strip(n0) : n0;
    if (n.kind === ts.SyntaxKind.ThisKeyword) return "this";
    if (ts.isIdentifier(n)) {
      const sym = this.symbolOf(n);
      if (sym === undefined) return null;
      let id = this.symIds.get(sym);
      if (id === undefined) {
        id = this.symIds.size + 1;
        this.symIds.set(sym, id);
      }
      return `#${id}`;
    }
    if (ts.isNonNullExpression(n)) return this.refKey(n.expression);
    if (ts.isPropertyAccessExpression(n)) {
      const b = this.refKey(n.expression);
      return b === null ? null : `${b}.${n.name.text}`;
    }
    if (ts.isElementAccessExpression(n) && ts.isLiteralExpression(n.argumentExpression)) {
      const b = this.refKey(n.expression);
      return b === null ? null : `${b}[${n.argumentExpression.text}]`;
    }
    return null;
  }

  /**
   * Whether tsc's type at `node` may be such an unsound narrowing: the place itself, or a variable whose initialiser read
   * it (`const n = p.f`, typed as what was assigned), so its type can't rule out null.
   */
  unsoundlyNarrowed(node: ts.Node): boolean {
    if (this.unsoundPaths.size === 0) return false;
    const k = this.refKey(node);
    if (k !== null && this.unsoundPaths.has(k)) return true;
    const n = ts.isExpression(node) ? strip(node) : node;
    if (!ts.isIdentifier(n)) return false;
    const d = this.symbolOf(n)?.valueDeclaration;
    if (d === undefined || !ts.isVariableDeclaration(d) || d.initializer === undefined)
      return false;
    const ik = this.refKey(d.initializer);
    return ik !== null && this.unsoundPaths.has(ik);
  }

  /** `const n = p.f` where tsc's narrowing of `p.f` is unsound: the type `f` is declared with, not the narrowed one. */
  declaredIfUnsound(d: ts.VariableDeclaration): ts.Type | null {
    if (d.type !== undefined || d.initializer === undefined || !this.unsoundlyNarrowed(d.name))
      return null;
    const init = strip(d.initializer);
    const name = ts.isPropertyAccessExpression(init)
      ? init.name
      : ts.isElementAccessExpression(init)
        ? init.argumentExpression
        : null;
    const prop = name !== null ? this.checker.getSymbolAtLocation(name) : undefined;
    return prop !== undefined ? this.checker.getTypeOfSymbol(prop) : null;
  }

  /** `a.b.f = rhs` where rhs assigns `a` or `a.b`: `a.b.f`'s narrowing by this assignment isn't sound. */
  noteReassignedTarget(e: ts.BinaryExpression): void {
    const left = strip(e.left);
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
    const target = this.refKey(left);
    if (target === null) return;
    const assigned = (x: ts.Node): boolean => {
      if (ts.isFunctionLike(x)) return false;
      if (
        ts.isBinaryExpression(x) &&
        x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        x.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const k = this.refKey(x.left);
        if (k !== null && target.startsWith(k) && /^[.[]/.test(target.slice(k.length))) return true;
      }
      return ts.forEachChild(x, assigned) === true;
    };
    if (assigned(e.right)) this.unsoundPaths.add(target);
  }

  /** `[a.n, b.n] = [b.n, a.n]`, as a statement: the values first, then each place in order, as JS does. */
  assignPattern(left: ts.ArrayLiteralExpression, e: ts.BinaryExpression): TE {
    const right = strip(e.right);
    if (
      !ts.isArrayLiteralExpression(right) ||
      right.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x)) ||
      !ts.isExpressionStatement(e.parent)
    ) {
      this.block("unsupported", left, "a destructuring assignment that isn't of an array literal");
    }
    const out: Stmt[] = [];
    const vals = right.elements.map((x) => this.temp(this.expr(x), out));
    left.elements.forEach((target, i) => {
      if (ts.isOmittedExpression(target)) return;
      if (ts.isSpreadElement(target) || ts.isBinaryExpression(target)) {
        this.block("unsupported", target, "a default or rest in a destructuring assignment");
      }
      const lv = this.lvalue(target, out);
      out.push({ k: "expr", e: lv.write(vals[i] ?? NULLISH, target) });
    });
    return mk(T.void, { k: "blockexpr", body: out, result: VOID });
  }

  compound(e: ts.BinaryExpression, op: ts.SyntaxKind): TE {
    const out: Stmt[] = [];
    const lv = this.lvalue(e.left, out);
    if (
      op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    ) {
      this.block("unsupported", e, "a logical assignment");
    }
    const base = compoundBase(op);
    const lt = this.typeAt(e.left);
    if (hasFlag(lt, ts.TypeFlags.StringLike)) {
      this.needStr(e, "string concatenation");
      const r = this.rtCall("strConcat", [lv.read(), this.toStr(e.right)], e);
      return this.withPrelude(out, lv.write(r, e));
    }
    if (hasFlag(lt, ts.TypeFlags.BigIntLike)) this.block("bigint", e, "plain bigint arithmetic");
    const a = this.temp(this.numOperand(lv.read(), e), out);
    const bit = isBitOp(base);
    const b = this.expr(e.right, undefined, bit);
    const r = this.binaryTE(base, a, b, e, false);
    return this.withPrelude(out, lv.write(r, e));
  }

  logicalValue(e: ts.BinaryExpression, isAnd: boolean, want: Shape | undefined): TE {
    const lt = this.typeAt(e.left);
    const rt = this.typeAt(e.right);
    if (hasFlag(lt, ts.TypeFlags.BooleanLike) && hasFlag(rt, ts.TypeFlags.BooleanLike))
      return this.condition(e);
    const out: Stmt[] = [];
    const a = this.temp(this.expr(e.left, want), out);
    const c = this.truthy(a, e);
    const b = this.expr(e.right, want);
    const r = isAnd ? this.conditionalTE(c, b, a, e) : this.conditionalTE(c, a, b, e);
    return this.withPrelude(out, r);
  }

  nullishCoalesce(e: ts.BinaryExpression, want: Shape | undefined): TE {
    const out: Stmt[] = [];
    const a = this.temp(this.expr(e.left, want), out);
    if (a.ty.k === "nullish") return this.withPrelude(out, this.expr(e.right, want));
    if (a.ty.k === "opt") {
      const sh = a.sh as Extract<Shape, { s: "opt" }>;
      const present = mk(T.bool, { k: "slice", val: a, from: 0, to: 1 });
      const b = this.expr(e.right, want);
      const r = this.conditionalTE(present, this.optPayload(a, sh), b, e);
      return this.withPrelude(out, r);
    }
    if (a.ty.k === "ref" || a.ty.k === "arr") {
      const b = this.expr(e.right, want);
      const r = this.conditionalTE(this.cmpTE("ne", a, nullPtr()), a, b, e);
      return this.withPrelude(out, r);
    }
    return this.withPrelude(out, a); // the left side can't be nullish
  }

  comparison(e: ts.BinaryExpression): TE {
    const op = e.operatorToken.kind;
    const eq =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    const loose =
      op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (eq || ne) {
      const s = this.stringSpreadCompare(e, ne);
      if (s !== null) return s;
      if (this.mem) {
        const l = strip(e.left);
        const r = strip(e.right);
        const [tof, lit] = ts.isTypeOfExpression(l)
          ? [l, r]
          : ts.isTypeOfExpression(r)
            ? [r, l]
            : [null, null];
        if (tof !== null && lit !== null && ts.isStringLiteralLike(lit)) {
          const t = this.typeofTest(tof.expression, lit.text, e);
          return ne ? this.not(t) : t;
        }
      }
    }
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    if (this.mem) {
      const isFn = (x: TE): boolean => {
        const s = x.sh as Shape | undefined;
        return s?.s === "obj" && findNode(s.node).kind === "fn";
      };
      // A closure's environment is made where it's used as a value, so one function can have several.
      if (isFn(a) && isFn(b)) this.block("closure-escape", e, "comparing function values");
    }
    if (loose && a.ty.k !== "nullish" && b.ty.k !== "nullish") {
      const same = (isNum(a) && isNum(b)) || a.ty.k === b.ty.k;
      if (!same) this.block("union-mixed", e, "== between different types coerces");
    }
    const name = eq
      ? "eq"
      : ne
        ? "ne"
        : op === ts.SyntaxKind.LessThanToken
          ? "lt"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "le"
            : op === ts.SyntaxKind.GreaterThanToken
              ? "gt"
              : "ge";
    return this.compare(name, a, b, e, loose);
  }

  compare(
    op: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
    a0: TE,
    b0: TE,
    node: ts.Node,
    loose = false,
  ): TE {
    let a = a0;
    let b = b0;
    if (a.ty.k === "nullish" || b.ty.k === "nullish") {
      const x = a.ty.k === "nullish" ? b : a;
      const nullNode =
        a.ty.k === "nullish"
          ? (node as ts.BinaryExpression).left
          : (node as ts.BinaryExpression).right;
      const isEq = op === "eq";
      if (x.ty.k === "nullish") {
        const side = ts.isBinaryExpression(node)
          ? a.ty.k === "nullish"
            ? node.right
            : node.left
          : node;
        const sameKind = loose || this.sameNullKind(side, nullNode);
        return litBool(isEq === sameKind);
      }
      if (this.isDyn(x.sh)) {
        const lit = a.ty.k === "nullish" ? a : b;
        const t = this.dynNullTest(x, lit.isNull === true, loose, node);
        return isEq ? t : this.not(t);
      }
      // The checker has already excluded the wrong kind of nullish, or this always differs.
      const side = ts.isBinaryExpression(node)
        ? a.ty.k === "nullish"
          ? node.right
          : node.left
        : node;
      if (!loose && !this.typeHasKind(side, nullNode) && !this.unsoundlyNarrowed(side))
        return litBool(!isEq);
      if (x.ty.k === "opt") {
        const tag = mk(T.bool, { k: "slice", val: x, from: 0, to: 1 });
        return isEq ? this.not(tag) : tag;
      }
      if (x.ty.k === "ref" || x.ty.k === "arr") return this.cmpTE(isEq ? "eq" : "ne", x, nullPtr());
      return litBool(!isEq);
    }
    if (a.ty.k === "opt" || b.ty.k === "opt") {
      if (op !== "eq" && op !== "ne") {
        // A relational operator on undefined is false, whichever way round: a NaN compare in JS.
        const o = a.ty.k === "opt" ? a : b;
        const sh = o.sh as Extract<Shape, { s: "opt" }>;
        const body: Stmt[] = [];
        const t = this.temp(o, body);
        const present = mk(T.bool, { k: "slice", val: t, from: 0, to: 1 });
        const c =
          a.ty.k === "opt"
            ? this.compare(op, this.optPayload(t, sh), b, node)
            : this.compare(op, a, this.optPayload(t, sh), node);
        return mk(T.bool, {
          k: "blockexpr",
          body,
          result: mk(T.bool, { k: "logic", op: "and", a: present, b: c }),
        });
      }
      const o = a.ty.k === "opt" ? a : b;
      const other = a.ty.k === "opt" ? b : a;
      const sh = o.sh as Extract<Shape, { s: "opt" }>;
      const body: Stmt[] = [];
      const t = this.temp(o, body);
      const h = other.ty.k === "opt" ? other : this.temp(other, body);
      if (h.ty.k === "opt") {
        this.block("unsupported", node, "comparing two nullable scalars");
      }
      const present = mk(T.bool, { k: "slice", val: t, from: 0, to: 1 });
      const payload = this.optPayload(t, sh);
      const same = mk(T.bool, {
        k: "logic",
        op: "and",
        a: present,
        b: this.compare("eq", payload, h, node),
      });
      return mk(T.bool, { k: "blockexpr", body, result: op === "eq" ? same : this.not(same) });
    }
    if (a.k === "lit" && b.k === "lit") {
      const x = a.value;
      const y = b.value;
      const r =
        op === "eq"
          ? x === y
          : op === "ne"
            ? x !== y
            : op === "lt"
              ? x < y
              : op === "le"
                ? x <= y
                : op === "gt"
                  ? x > y
                  : x >= y;
      return litBool(r);
    }
    if (isNum(a) && isNum(b)) {
      if (isF(a) || isF(b)) {
        a = this.toFloatCmp(a);
        b = this.toFloatCmp(b);
      } else {
        const ra = range(a);
        const rb = range(b);
        const lo = Math.min(ra[0], rb[0]);
        const hi = Math.max(ra[1], rb[1]);
        if (lo >= I32_MIN && hi <= I32_MAX) {
          a = retype(a, T.i32);
          b = retype(b, T.i32);
        } else if (lo >= 0 && hi <= U32_MAX) {
          a = retype(a, T.u32);
          b = retype(b, T.u32);
        } else {
          a = this.toFloatCmp(a);
          b = this.toFloatCmp(b);
        }
      }
      return this.cmpTE(op, a, b);
    }
    if (this.isStr(a.sh) && this.isStr(b.sh)) return this.strCompare(op, a, b, node);
    if (
      a.ty.k === b.ty.k &&
      (a.ty.k === "bool" || a.ty.k === "lits" || a.ty.k === "ref" || a.ty.k === "arr")
    ) {
      if (op !== "eq" && op !== "ne")
        this.block("union-mixed", node, `a relational operator on a ${a.ty.k}`);
      return this.cmpTE(op, a, b);
    }
    return this.block("union-mixed", node, `comparing a ${a.ty.k} with a ${b.ty.k}`);
  }

  isUndefinedNode(n: ts.Node): boolean {
    return ts.isIdentifier(n) && n.text === "undefined";
  }

  typeHasKind(side: ts.Node, nullNode: ts.Node): boolean {
    const k = this.nullishOf(this.typeAt(side));
    return this.isUndefinedNode(nullNode) ? k.undef : k.null;
  }

  sameNullKind(side: ts.Node, nullNode: ts.Node): boolean {
    return this.isUndefinedNode(side) === this.isUndefinedNode(nullNode);
  }

  /** String.fromCharCode(...bytes) === "lit" compares bytes with no string at all (SPEC 4.5). */
  stringSpreadCompare(e: ts.BinaryExpression, negate: boolean): TE | null {
    const isCall = (x: ts.Expression): x is ts.CallExpression => {
      const s = strip(x);
      return (
        ts.isCallExpression(s) &&
        ts.isPropertyAccessExpression(s.expression) &&
        s.expression.name.text === "fromCharCode" &&
        ts.isIdentifier(s.expression.expression) &&
        s.expression.expression.text === "String"
      );
    };
    const l = strip(e.left);
    const r = strip(e.right);
    const callNode = isCall(l) ? l : isCall(r) ? r : null;
    if (callNode === null) return null;
    const other = callNode === l ? r : l;
    const call = callNode as ts.CallExpression;
    if (!ts.isStringLiteralLike(other)) {
      if (this.mem) return null; // a run-time string, compared as any other
      this.block(
        "string-from-spread",
        call,
        "String.fromCharCode(...x) compared with a non-literal",
      );
    }
    if (call.arguments.length !== 1 || !ts.isSpreadElement(call.arguments[0]!)) {
      if (this.mem) return null;
      this.block(
        "string-from-spread",
        call,
        "String.fromCharCode without a single spread argument",
      );
    }
    const out: Stmt[] = [];
    const seq = this.seqOf(
      this.expr((call.arguments[0] as ts.SpreadElement).expression),
      call,
      out,
    );
    const text = other.text;
    const lenOk = this.cmpTE("eq", seq.len(), lit32(text.length));
    let cond: TE = lenOk;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const item = seq.at(lit32(i), call);
      // fromCharCode reduces each value mod 65536, and bytes need nothing more.
      const value = isF(item)
        ? mk(T.i32, { k: "builtin", name: "wrapU16", args: [item], loc: this.loc(call) })
        : item;
      cond = mk(T.bool, {
        k: "logic",
        op: "and",
        a: cond,
        b: this.cmpTE("eq", retype(value, T.i32), lit32(code)),
      });
    }
    return this.withPrelude(out, negate ? this.not(cond) : cond);
  }

  /**
   * A cast the checker can't vouch for may name a field the object doesn't have, or drop a null it
   * does. A JS read gets `undefined` or a TypeError, and a struct has no way to say so (SPEC 3.10).
   */
  checkCast(x: ts.AsExpression): void {
    const to = this.checker.getTypeFromTypeNode(x.type);
    const toObj = this.checker.getNonNullableType(to);
    const objectLike = (t: ts.Type): boolean =>
      (t.isUnion() ? t.types : [t]).every(
        (m) => (m.flags & ts.TypeFlags.Object) !== 0 && this.libName(m) === null,
      );
    if (!objectLike(toObj)) return;
    const from = this.checker.getTypeAtLocation(x.expression);
    if (!this.checker.isTypeAssignableTo(from, to)) {
      this.block(
        "unsound-cast",
        x,
        `${this.checker.typeToString(from)} as ${this.checker.typeToString(to)} isn't an upcast, so it may name a field the object lacks`,
      );
    }
  }

  /**
   * Values of one TS type share a struct holding every field that flowed into it. If this literal
   * reaches JS without one of them, JS must not see that field, and the struct can't tell it apart
   * from a real zero. A discriminated union can: its tag says which fields are there.
   */
  checkWidened(e: ts.ObjectLiteralExpression, node: HeapNode, given: Set<string>): void {
    if (!node.escapes || node.variants.length > 0) return;
    for (const [name, f] of node.fields) {
      const optional =
        f.s === "opt" || ((f.s === "arr" || f.s === "vec" || f.s === "obj") && f.nul !== undefined);
      if (optional || given.has(name)) continue;
      this.block(
        "shape-widened",
        e,
        `this object has no field ${name}, but a wider shape unified into its type, so a struct would show ${name} as 0`,
      );
    }
  }

  objectLit(e: ts.ObjectLiteralExpression): TE {
    const lt = this.typeAt(e);
    const sh = this.slot(this.slotKey(e), lt, e);
    if (sh.s !== "obj") this.block("unsupported", e, "an object literal with no object shape");
    const out: Stmt[] = [];
    const self = this.temp(this.allocObj(sh, e), out);
    const node = (): HeapNode => findNode(sh.node);
    const given = new Set<string>();
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        given.add("...");
        this.spreadInto(self, node(), p, out);
        for (const f of this.checker.getPropertiesOfType(this.typeAt(p.expression)))
          given.add(f.name);
        continue;
      }
      if (ts.isMethodDeclaration(p) || ts.isAccessor(p)) {
        this.block("unsupported", p, "a method or accessor in an object literal");
      }
      if (ts.isComputedPropertyName(p.name)) this.block("computed-key", p, "a computed key");
      const name =
        ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.name)
          ? p.name.text
          : p.name.getText();
      given.add(name);
      const field = node().fields.get(name);
      if (field === undefined) this.block("unsupported", p, `no field ${name}`);
      const value = ts.isPropertyAssignment(p) ? p.initializer : p.name;
      if (this.isCallable(this.typeAt(value)) && !this.mem)
        this.block("closure-escape", p, `the field ${name} holds a function`);
      const te = this.flow(this.expr(value, field), field, p);
      this.markEscape(field);
      out.push({ k: "expr", e: this.fieldStore(self, name, node(), te, !given.has(`...`)) });
    }
    this.checkWidened(e, node(), given);
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: self }, { sh });
  }

  /** {...x}: x's fields one at a time, into whichever of them this object has. */
  spreadInto(self: TE, node: HeapNode, p: ts.SpreadAssignment, out: Stmt[]): void {
    const srcT = this.typeAt(p.expression);
    if (!this.nonNullable(srcT)) this.block("unsupported", p, "a spread of a nullable value");
    const inner = strip(p.expression);
    const sym = ts.isIdentifier(inner) ? this.symbolOf(inner) : undefined;
    const b = sym !== undefined ? this.scope.get(sym) : undefined;
    if (b?.b === "sroa") {
      for (const [name, f] of b.fields) {
        const target = findNode(node).fields.get(name);
        if (target === undefined) this.block("unsupported", p, `no field ${name}`);
        out.push({
          k: "expr",
          e: this.fieldStore(self, name, node, this.flow(this.varTE(f.v, f.sh), target, p)),
        });
      }
      return;
    }
    const src = this.temp(this.expr(p.expression), out);
    const sh = src.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj")
      this.block("unsupported", p, "a spread of something that isn't a known shape");
    const srcNode = findNode(sh.node);
    if (srcT.isUnion()) this.block("unsupported", p, "a spread of a union");
    for (const prop of this.checker.getPropertiesOfType(srcT)) {
      const name = prop.name;
      if (!srcNode.fields.has(name)) continue;
      const target = findNode(node).fields.get(name);
      if (target === undefined) continue;
      const read = this.fieldRead(src, name, srcNode, p);
      this.markEscape(target);
      out.push({ k: "expr", e: this.fieldStore(self, name, node, this.flow(read, target, p)) });
    }
  }

  throwTE(x0: ts.Expression, node: ts.Node): TE {
    const x = strip(x0);
    let ctor = "";
    let args: readonly ts.Expression[] = [];
    if ((ts.isNewExpression(x) || ts.isCallExpression(x)) && ts.isIdentifier(x.expression)) {
      const sym = this.symbolOf(x.expression);
      if (
        sym !== undefined &&
        this.isLibSymbol(sym) &&
        /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError)$/.test(
          sym.name,
        )
      ) {
        ctor = sym.name;
        args = x.arguments ?? [];
      }
    }
    if (ctor === "")
      this.block("throw-non-error", x0, "a throw of something that isn't new Error(...)");
    if (args.length > 1) this.block("throw-non-error", x0, "an Error with options");
    const parts: (string | { a: number; k: string })[] = [];
    const vals: TE[] = [];
    const m = args[0];
    if (m !== undefined) {
      const s = strip(m);
      if (ts.isStringLiteralLike(s)) parts.push(s.text);
      else if (ts.isTemplateExpression(s)) {
        parts.push(s.head.text);
        for (const span of s.templateSpans) {
          let v = this.narrowOpt(this.expr(span.expression), span);
          if (this.strRt && (this.isStr(v.sh) || !(isNum(v) || v.ty.k === "bool"))) {
            v = this.toStrTE(v, this.typeAt(span.expression), span);
          }
          if (!isNum(v) && v.ty.k !== "bool" && v.ty.k !== "lits" && !this.isStr(v.sh)) {
            this.block("throw-non-error", span, "a thrown message part that isn't a scalar");
          }
          if (vals.length >= TRAP_ARGS_SLOTS)
            this.block("throw-non-error", span, "too many parts in a thrown message");
          const k = this.isStr(v.sh)
            ? "s"
            : v.ty.k === "bool"
              ? "bool"
              : v.ty.k === "lits"
                ? "str"
                : isF(v)
                  ? "f64"
                  : isU32(v)
                    ? "u32"
                    : "i32";
          parts.push({ a: vals.length, k });
          vals.push(v);
          parts.push(span.literal.text);
        }
      } else if (this.mem && this.isStringType(this.typeAt(s))) {
        this.needStr(s, "a thrown message that isn't a literal");
        parts.push({ a: 0, k: "s" });
        vals.push(this.expr(s));
      } else this.block("throw-non-error", m, "a thrown message that isn't a literal or template");
    }
    const code = THROW_CODE_BASE + this.nextThrow++;
    return mk(NEVER_TY, {
      k: "throwjs",
      args: vals,
      msg: JSON.stringify({ ctor, parts }),
      code,
      loc: this.loc(node),
    });
  }

  // --- calls of every kind

  call(e: ts.CallExpression, want?: Shape): TE {
    if (e.questionDotToken !== undefined) {
      if (!this.mem) this.block("unsupported", e, "an optional call");
      const out: Stmt[] = [];
      const fn = this.temp(this.expr(strip(e.expression)), out);
      const call = (): TE => {
        const pre: Stmt[] = [];
        const args = this.argsFor(null, e.arguments, pre);
        return this.withPrelude(pre, this.dynCall(fn, args, e));
      };
      return this.optionalCall(fn, call, e, out);
    }
    const callee = strip(e.expression);
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      const ctor = this.inst.decl;
      if (!this.mem || !ts.isConstructorDeclaration(ctor) || this.frame.retLabel !== null)
        this.block("inheritance", e, "super() outside a lowered constructor");
      return this.superCall(
        ctor.parent,
        e.arguments.map((a) => this.expr(a)),
        e,
      );
    }
    if (callee.kind === ts.SyntaxKind.ImportKeyword) this.block("async", e, "a dynamic import");
    if (ts.isPropertyAccessExpression(callee)) return this.methodCall(e, callee, want);
    if (ts.isIdentifier(callee)) {
      const sym = this.symbolOf(callee);
      if (sym === undefined) this.block("unsupported", e, `the function ${callee.text}`);
      if (this.mem && this.isRtIntrinsic(sym)) return this.intrinsicCall(callee.text, e);
      const b = this.scope.get(sym);
      if (b?.b === "closure")
        return this.callClosure(b.targets, b.tag !== null ? this.readVar(b.tag) : null, e);
      if (b !== undefined) {
        if (this.mem) return this.callValue(callee, e);
        this.block("closure-escape", e, `calling ${callee.text}, whose target isn't known`);
      }
      if (this.isLibSymbol(sym)) return this.libCall(sym.name, e, want);
      const top = this.topFunction(sym);
      if (top !== null) return this.callFunction(top, e);
      if (this.mem && this.isModuleVar(sym)) return this.callValue(callee, e);
      this.block("closure-escape", e, `calling ${callee.text}, whose target isn't known`);
    }
    if (this.mem && !this.isStaticFn(callee)) return this.callValue(callee, e);
    const cv = this.closureOf(callee);
    return this.callClosure(cv.targets, cv.tag, e);
  }

  callValue(callee: ts.Expression, e: ts.CallExpression): TE {
    const out: Stmt[] = [];
    const fn = this.temp(this.exprNonNull(callee), out);
    const args = this.argsFor(null, e.arguments, out);
    return this.withPrelude(out, this.dynCall(fn, args, e));
  }

  /** `x?.m()` and `f?.()`, in a memory mode: null gives undefined, with no call and no arguments evaluated. */
  optionalCall(base: TE, call: () => TE, e: ts.CallExpression, out: Stmt[]): TE {
    const present = this.cmpTE("ne", base, nullPtr());
    const made = call();
    if (made.ty.k === "void" || hasFlag(this.typeAt(e), ts.TypeFlags.Void)) {
      out.push({ k: "if", c: present, a: [{ k: "expr", e: made }], b: null });
      return mk(T.void, { k: "blockexpr", body: out, result: VOID });
    }
    const sh = this.slot(this.slotKey(e), this.typeAt(e), e);
    const r = mk(
      tyOf(sh),
      {
        k: "cond",
        c: present,
        a: this.flow(made, sh, e),
        b: this.flow(NULLISH, sh, e),
      },
      this.readExtras(sh),
    );
    return this.withPrelude(out, this.narrowed(r, sh, e));
  }

  callClosure(targets: Target[], tag: TE | null, e: ts.CallExpression): TE {
    const out: Stmt[] = [];
    const decl = targets[0]?.dyn !== undefined ? null : (targets[0]?.decl ?? null);
    const args = this.argsFor(decl, e.arguments, out);
    return this.withPrelude(out, this.callTargets(targets, tag, args, e));
  }

  libCall(name: string, e: ts.CallExpression, _want?: Shape): TE {
    const a = e.arguments;
    switch (name) {
      case "Number": {
        const t = a[0] !== undefined ? this.typeAt(a[0]) : null;
        if (t !== null && hasFlag(t, ts.TypeFlags.NumberLike)) return this.expr(a[0]!);
        if (this.mem) return this.numberOf(e);
        return this.block("string-use", e, "Number() of something that isn't a number");
      }
      case "Boolean":
        return a[0] !== undefined ? this.truthy(this.expr(a[0]), e) : litBool(false);
      case "isNaN":
      case "isFinite":
        return this.numberPredicate(name, e);
      case "String":
      case "parseInt":
      case "parseFloat":
        if (this.mem) return this.stringFn(name, e);
        return this.block("string-use", e, `${name}() works on strings`);
      case "Array": {
        const sh = this.slot(this.slotKey(e), this.typeAt(e), e) as Extract<Shape, { s: "vec" }>;
        const len = a[0] !== undefined ? this.expr(a[0]) : lit32(0);
        const p = e.parent;
        const filled = this.isWholeFill(p, e);
        const es = findNode(sh.node).elem!;
        if (!filled && (es.s === "num" || es.s === "bool" || es.s === "str")) {
          this.block(
            "unsupported",
            e,
            "Array(n) of scalars has holes, which scalar slots can't hold; use .fill",
          );
        }
        return this.vecNew(
          sh,
          isF(len)
            ? mk(T.i32, { k: "builtin", name: "toI32", args: [len], loc: this.loc(e) })
            : len,
          e,
        );
      }
      case "Error":
      case "TypeError":
      case "RangeError":
        return this.block("throw-non-error", e, "an Error used as a value, not thrown");
      default: {
        const hit = LIB_BLOCKERS[name];
        if (hit !== undefined) return this.block(hit[0], e, hit[1]);
        return this.block("unsupported", e, `the global function ${name}`);
      }
    }
  }

  /** `Object.is` on scalars of a known type is `===`, but for NaN, which is itself, and -0, which isn't +0. */
  objectIs(e: ts.CallExpression): TE {
    const [x0, y0] = e.arguments;
    if (x0 === undefined || y0 === undefined) {
      return this.block("reflection", e, "Object.is with fewer than two arguments");
    }
    const tx = this.typeAt(x0);
    const ty = this.typeAt(y0);
    const both = (f: ts.TypeFlags): boolean => hasFlag(tx, f) && hasFlag(ty, f);
    if (both(ts.TypeFlags.NumberLike)) {
      const x = this.numOperand(this.expr(x0), e);
      const y = this.numOperand(this.expr(y0), e);
      if (!isF(x) && !isF(y)) return this.compare("eq", x, y, e);
      const fx = this.toFloat(x);
      const fy = this.toFloat(y);
      return this.withTemp(fx, (a) =>
        this.withTemp(fy, (b) => {
          const zero = mk(T.f64, { k: "lit", value: 0 });
          const one = mk(T.f64, { k: "lit", value: 1 });
          const inv = (v: TE): TE => mk(T.f64, { k: "farith", op: "div", a: one, b: v });
          const same = this.cmpTE("eq", inv(a), inv(b));
          return mk(T.bool, {
            k: "cond",
            c: this.cmpTE("eq", a, b),
            a: mk(T.bool, { k: "logic", op: "or", a: this.cmpTE("ne", a, zero), b: same }),
            b: mk(T.bool, {
              k: "logic",
              op: "and",
              a: this.cmpTE("ne", a, a),
              b: this.cmpTE("ne", b, b),
            }),
          });
        }),
      );
    }
    if (
      both(ts.TypeFlags.BooleanLike) ||
      both(ts.TypeFlags.BigIntLike) ||
      (this.mem && both(ts.TypeFlags.StringLike))
    ) {
      return this.compare("eq", this.expr(x0), this.expr(y0), e);
    }
    return this.block(
      "reflection",
      e,
      "Object.is on something that isn't a number, boolean, bigint or, in a memory mode, a string",
    );
  }

  numberPredicate(name: string, e: ts.CallExpression): TE {
    const x = this.numOperand(this.expr(e.arguments[0]!), e);
    if (!isF(x)) {
      const whole = name !== "isNaN";
      return mk(T.bool, { k: "seq", items: [x], result: litBool(whole) });
    }
    return this.withTemp(x, (t) => {
      const abs = mk(T.f64, { k: "builtin", name: "Math.abs", args: [t], loc: this.loc(e) });
      const inf = mk(T.f64, { k: "lit", value: Infinity });
      if (name === "isNaN") return this.cmpTE("ne", t, t);
      const finite = this.cmpTE("lt", abs, inf);
      if (name === "isFinite") return finite;
      const tr = mk(T.f64, { k: "builtin", name: "Math.trunc", args: [t], loc: this.loc(e) });
      return mk(T.bool, { k: "logic", op: "and", a: finite, b: this.cmpTE("eq", tr, t) });
    });
  }

  methodCall(e: ts.CallExpression, callee: ts.PropertyAccessExpression, want?: Shape): TE {
    if (callee.questionDotToken !== undefined && !this.mem)
      this.block("unsupported", e, "an optional method call");
    if (callee.questionDotToken !== undefined) {
      const name = callee.name.text;
      const sym = this.checker.getSymbolAtLocation(callee.name);
      const decl = sym?.declarations?.find(ts.isMethodDeclaration);
      const out: Stmt[] = [];
      const base = this.temp(this.expr(callee.expression), out);
      const sh = base.sh as Shape | undefined;
      if (decl === undefined) {
        if (sh?.s !== "obj") this.block("unsupported", e, `?.${name} on something else`);
        const field = this.fieldRead(base, name, sh.node, e);
        const call = (): TE => {
          const pre: Stmt[] = [];
          const args = this.argsFor(null, e.arguments, pre);
          return this.withPrelude(pre, this.dynCall(field, args, e));
        };
        return this.optionalCall(base, call, e, out);
      }
      if (sh?.s !== "obj")
        this.block("unsupported", e, `?.${name} on something that isn't an object`);
      const recv = this.checker.getNonNullableType(this.typeAt(callee.expression));
      const inst = this.methodInst(decl, sh, recv);
      return this.optionalCall(
        base,
        () =>
          this.callInst(
            inst,
            base,
            e.arguments.map((x) => this.expr(x)),
            e,
          ),
        e,
        out,
      );
    }
    const name = callee.name.text;
    const base = strip(callee.expression);
    if (base.kind === ts.SyntaxKind.SuperKeyword) return this.superMethodCall(e, callee);
    const stat = this.staticMember(base, name);
    if (stat !== null) return this.staticCall(stat, e);
    if (ts.isIdentifier(base)) {
      const sym = this.symbolOf(base);
      if (sym !== undefined && this.scope.get(sym) === undefined && this.isLibSymbol(sym)) {
        switch (sym.name) {
          case "Math":
            return this.mathCall(name, e, want);
          case "Number":
            if (
              name === "isInteger" ||
              name === "isSafeInteger" ||
              name === "isNaN" ||
              name === "isFinite"
            ) {
              if (name === "isSafeInteger") this.block("unsupported", e, "Number.isSafeInteger");
              return this.numberPredicate(name, e);
            }
            if (this.mem && (name === "parseInt" || name === "parseFloat"))
              return this.stringFn(name, e);
            return this.block("string-use", e, `Number.${name}`);
          case "Array":
            if (name === "from") return this.arrayFrom(e);
            if (name === "isArray")
              this.block("reflection", e, "Array.isArray needs run-time types");
            return this.block("unsupported", e, `Array.${name}`);
          case "String":
            if (this.mem && (name === "fromCharCode" || name === "fromCodePoint"))
              return this.stringFromCode(name, e);
            return this.block(
              "string-use",
              e,
              `String.${name} outside a comparison with a literal`,
            );
          default: {
            if (sym.name === "Object" && name === "is") return this.objectIs(e);
            const hit = LIB_BLOCKERS[sym.name];
            if (hit !== undefined) this.block(hit[0], e, hit[1]);
            return this.block("unsupported", e, `${sym.name}.${name}`);
          }
        }
      }
    }
    const rt = this.typeAt(callee.expression);
    if (this.mem) {
      const special = this.methodCallRt(name, e, callee, rt);
      if (special !== null) return special;
    }
    if (hasFlag(rt, ts.TypeFlags.StringLike))
      this.block("string-use", e, `the string method ${name}`);
    if (hasFlag(rt, ts.TypeFlags.NumberLike))
      this.block("string-use", e, `the number method ${name}, which yields a string`);
    if (hasFlag(rt, ts.TypeFlags.BigIntLike)) this.block("bigint", e, `the bigint method ${name}`);
    if (this.isIndexable(rt)) return this.seqMethod(name, e, callee);
    if (this.libName(rt) === "WeakRef" && name === "deref") {
      const self = this.exprNonNull(callee.expression);
      const sh = self.sh as Extract<Shape, { s: "obj" }>;
      const target = findNode(sh.node).weakOf! as Extract<Shape, { s: "obj" | "vec" }>;
      const rsh = { ...target, nul: "undefined" as const };
      this.markLong(target);
      return mk({ k: "ref" }, { k: "rtcall", name: "__rc_weak_deref", args: [self] }, { sh: rsh });
    }
    const sym = this.checker.getSymbolAtLocation(callee.name);
    const decl = sym?.declarations?.find(ts.isMethodDeclaration);
    if (decl === undefined && this.mem && name === "toString" && e.arguments.length === 0) {
      const self = this.exprNonNull(callee.expression);
      if (self.sh !== undefined && (self.sh as Shape).s === "obj")
        return this.toStrTE(self, this.checker.getNonNullableType(rt), e);
    }
    if (decl === undefined) {
      if (sym !== undefined && this.isLibSymbol(sym)) {
        const lib = this.libName(rt);
        const hit = lib !== null ? LIB_BLOCKERS[lib] : undefined;
        if (hit !== undefined) this.block(hit[0], e, hit[1]);
        this.block("unsupported", e, `the library method ${name}`);
      }
      if (this.mem) return this.callValue(callee, e);
      this.block("closure-escape", e, `calling the function-valued field ${name}`);
    }
    const self = this.exprNonNull(callee.expression);
    const sh = self.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "obj")
      this.block("unsupported", e, `the method ${name} on a ${sh?.s ?? self.ty.k}`);
    if (this.mem)
      return this.dispatch(
        decl,
        self,
        sh,
        rt,
        () => e.arguments.map((x) => this.expr(x)),
        e,
        "method",
      );
    const inst = this.methodInst(decl, sh, rt);
    if (
      !this.mem &&
      decl.parameters.some((p) => this.isCallable(this.checker.getTypeAtLocation(p.name)))
    ) {
      this.block("closure-escape", e, "a callback passed to a method");
    }
    const args = e.arguments.map((x) => this.expr(x));
    return this.callInst(inst, self, args, e);
  }

  mathCall(name: string, e: ts.CallExpression, want?: Shape): TE {
    const a = e.arguments;
    const loc = this.loc(e);
    switch (name) {
      case "floor":
      case "ceil":
      case "round":
      case "trunc":
        return this.mathRound(name, e, want);
      case "abs": {
        const x = this.numOperand(this.expr(a[0]!), e);
        const r = range(x);
        if (isF(x))
          return mk(
            T.f64,
            { k: "builtin", name: "Math.abs", args: [x], loc },
            { range: [0, Math.max(Math.abs(r[0]), Math.abs(r[1]))] },
          );
        if (r[0] >= 0) return x;
        if (isU32(x)) return x;
        return mk(
          T.i32,
          { k: "builtin", name: "Math.abs", args: [x], loc },
          { range: [0, Math.min(I32_MAX, Math.max(Math.abs(r[0]), Math.abs(r[1])))] },
        );
      }
      case "sqrt": {
        const x = this.toFloat(this.numOperand(this.expr(a[0]!), e));
        const r = range(x);
        const extra: Partial<TE> =
          r[0] >= 0 && x.negz !== true ? { range: [0, Infinity] } : { negz: true };
        return mk(T.f64, { k: "builtin", name: "Math.sqrt", args: [x], loc }, extra);
      }
      case "fround": {
        const x = this.toFloat(this.numOperand(this.expr(a[0]!), e));
        return mk(
          T.f64,
          { k: "conv", val: mk(T.f32, { k: "builtin", name: "Math.fround", args: [x], loc }) },
          { negz: true },
        );
      }
      case "imul": {
        const x = this.numOperand(this.expr(a[0]!, undefined, true), e);
        const y = this.numOperand(this.expr(a[1]!, undefined, true), e);
        return mk(T.i32, { k: "builtin", name: "Math.imul", args: [x, y], loc });
      }
      case "clz32": {
        const x = this.numOperand(this.expr(a[0]!, undefined, true), e);
        return mk(T.i32, { k: "builtin", name: "Math.clz32", args: [x], loc }, { range: [0, 32] });
      }
      case "sign": {
        const x = this.numOperand(this.expr(a[0]!), e);
        const f = this.toFloat(x);
        return this.withTemp(f, (t) => {
          // NaN and both zeros come back as they went in.
          const pos = this.cmpTE("gt", t, mk(T.f64, { k: "lit", value: 0 }));
          const neg = this.cmpTE("lt", t, mk(T.f64, { k: "lit", value: 0 }));
          const inner = mk(T.f64, {
            k: "cond",
            c: neg,
            a: mk(T.f64, { k: "lit", value: -1 }),
            b: t,
          });
          return mk(
            T.f64,
            { k: "cond", c: pos, a: mk(T.f64, { k: "lit", value: 1 }), b: inner },
            { negz: true, range: [-1, 1] },
          );
        });
      }
      case "min":
      case "max":
        return this.minMax(name === "min", e);
      case "pow":
      case "atan2": {
        const x = this.toFloat(this.numOperand(this.expr(a[0]!), e));
        const y = this.toFloat(this.numOperand(this.expr(a[1]!), e));
        this.usedMath.add(`math.${name}`);
        return mk(T.f64, { k: "intrinsic", name: `math.${name}`, args: [x, y] }, { negz: true });
      }
      default:
        break;
    }
    if (MATH_F1.has(name)) {
      const x = this.toFloat(this.numOperand(this.expr(a[0]!), e));
      this.usedMath.add(`math.${name}`);
      return mk(T.f64, { k: "intrinsic", name: `math.${name}`, args: [x] }, { negz: true });
    }
    return this.block("unsupported", e, `Math.${name}`);
  }

  /** Math.floor and its kin: integer again afterwards, trapping if the value doesn't fit i32. */
  mathRound(name: "floor" | "ceil" | "round" | "trunc", e: ts.CallExpression, want?: Shape): TE {
    const argNode = e.arguments[0]!;
    const stripped = strip(argNode);
    const loc = this.loc(e);
    const key = this.slotKey(e);
    const wantsFloat = this.forced.has(key) || (want?.s === "num" && locTy(want.loc).k === "float");
    if (
      name === "floor" &&
      ts.isBinaryExpression(stripped) &&
      stripped.operatorToken.kind === ts.SyntaxKind.SlashToken
    ) {
      const a = this.numOperand(this.expr(stripped.left), e);
      const b = this.numOperand(this.expr(stripped.right), e);
      const ra = range(a);
      const rb = range(b);
      const provable =
        isInt(a) &&
        isInt(b) &&
        !isU32(a) &&
        !isU32(b) &&
        ra[0] >= 0 &&
        rb[0] >= 0 &&
        ra[1] <= I32_MAX &&
        rb[1] <= I32_MAX;
      if (
        a.k === "lit" &&
        b.k === "lit" &&
        typeof a.value === "number" &&
        typeof b.value === "number"
      ) {
        return litNum(Math.floor(a.value / b.value));
      }
      if (provable) {
        // Proved non-negative: integer division. A zero divisor traps, where JS would give Infinity.
        return mk(T.i32, { k: "arith", op: "idiv", a, b, wrap: false, loc }, { range: [0, ra[1]] });
      }
      return this.finishRound(name, this.divide(a, b), wantsFloat, key, loc);
    }
    const x = this.numOperand(this.expr(argNode), e);
    if (x.k === "lit" && typeof x.value === "number") {
      return litNum(Math[name](x.value));
    }
    if (!isF(x)) return x; // already an integer, -0 included
    return this.finishRound(name, x, wantsFloat, key, loc);
  }

  finishRound(
    name: "floor" | "ceil" | "round" | "trunc",
    x: TE,
    wantsFloat: boolean,
    key: string,
    loc: string,
  ): TE {
    const r = range(x);
    const fn = Math[name];
    const lo = Number.isFinite(r[0]) ? fn(r[0]) + 0 : r[0];
    const hi = Number.isFinite(r[1]) ? fn(r[1]) + 0 : r[1];
    const raw = mk(
      T.f64,
      { k: "builtin", name: `Math.${name}`, args: [x], loc },
      { range: [lo, hi] },
    );
    const couldBeNegZero = x.negz === true || (name !== "floor" && r[0] < 0);
    if (wantsFloat) return couldBeNegZero ? ({ ...raw, negz: true } as TE) : raw;
    const extra: Partial<TE> = { range: [Math.max(lo, I32_MIN), Math.min(hi, I32_MAX)] };
    if (couldBeNegZero) {
      extra.negz = true;
      extra.deps = [key];
    }
    return mk(T.i32, { k: "builtin", name: "toI32", args: [raw], loc }, extra);
  }

  minMax(isMin: boolean, e: ts.CallExpression): TE {
    const args = e.arguments;
    const loc = this.loc(e);
    if (args.length === 0) return litNum(isMin ? Infinity : -Infinity);
    const spread = args.length === 1 && ts.isSpreadElement(args[0]!);
    if (spread) return this.minMaxSpread(isMin, args[0] as ts.SpreadElement, e);
    if (args.some(ts.isSpreadElement))
      this.block("unsupported", e, "a spread among other arguments");
    let acc = this.numOperand(this.expr(args[0]!), e);
    for (let i = 1; i < args.length; i++) {
      const next = this.numOperand(this.expr(args[i]!), e);
      acc = this.minMax2(isMin, acc, next, loc);
    }
    return acc;
  }

  minMax2(isMin: boolean, a: TE, b: TE, loc: string): TE {
    const ra = range(a);
    const rb = range(b);
    const r: [number, number] = isMin
      ? [Math.min(ra[0], rb[0]), Math.min(ra[1], rb[1])]
      : [Math.max(ra[0], rb[0]), Math.max(ra[1], rb[1])];
    const [x, y] = this.sameRep(a, b);
    const extra: Partial<TE> = { range: r };
    if (a.negz === true || b.negz === true) {
      extra.negz = true;
      const deps = [...(a.deps ?? []), ...(b.deps ?? [])];
      if (deps.length > 0) extra.deps = deps;
    }
    return mk(
      x.ty,
      { k: "builtin", name: isMin ? "Math.min" : "Math.max", args: [x, y], loc },
      extra,
    );
  }

  /** Math.max(...arr) is a loop. With integers, an empty array has no integer answer, so it traps. */
  minMaxSpread(isMin: boolean, sp: ts.SpreadElement, e: ts.CallExpression): TE {
    const out: Stmt[] = [];
    const seq = this.seqOf(this.expr(sp.expression), sp, out);
    const n = this.temp(seq.len(), out);
    const sh = this.slot(`${this.slotKey(e)}#acc`, this.typeAt(e), e);
    const accSh = sh as Extract<Shape, { s: "num" }>;
    const loc = this.loc(e);
    const elem = seq.elemSh;
    if (elem.s !== "num") this.block("unsupported", sp, "Math.max of something that isn't numbers");
    const first = seq.at(lit32(0), sp);
    this.join(accSh.loc, first);
    const acc = this.newVar(tyOf(accSh));
    if (tyOf(accSh).k === "float") {
      const start = litNum(isMin ? Infinity : -Infinity);
      out.push({ k: "let", v: acc, init: start, constant: false });
    } else {
      out.push({
        k: "expr",
        e: mk(T.void, {
          k: "builtin",
          name: "assert",
          args: [this.cmpTE("gt", n, lit32(0)), lit32(4)],
          loc,
        }),
      });
      out.push({ k: "let", v: acc, init: this.flow(first, accSh, sp), constant: false });
    }
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const body: Stmt[] = [];
    const held = this.temp(seq.at(i, sp), body);
    const merged = this.minMax2(isMin, this.varTE(acc, accSh), held, loc);
    body.push({
      k: "expr",
      e: mk(acc.ty, { k: "setvar", v: acc, val: this.flow(merged, accSh, e) }),
    });
    out.push(this.countedLoop(iv, n, body, e));
    const res = this.varTE(acc, accSh);
    return mk(res.ty, { k: "blockexpr", body: out, result: res }, this.carry(res));
  }

  /** Array.from({ length }, fn), or a copy of an array. */
  arrayFrom(e: ts.CallExpression): TE {
    const sh = this.slot(this.slotKey(e), this.typeAt(e), e);
    if (sh.s !== "vec") this.block("unsupported", e, "Array.from with no vector result");
    const src = strip(e.arguments[0]!);
    if (this.mem && this.isItemSource(this.typeAt(src))) return this.arrayFromItems(e, sh, src);
    const out: Stmt[] = [];
    const fnNode = e.arguments[1];
    const cv = fnNode !== undefined ? this.closureOf(fnNode, out) : null;
    let n: TE;
    let item: ((i: TE) => TE) | null = null;
    if (ts.isObjectLiteralExpression(src)) {
      const lenProp = src.properties.find((p) => p.name?.getText() === "length");
      if (lenProp === undefined || !ts.isPropertyAssignment(lenProp))
        this.block("unsupported", e, "Array.from of an object without a plain length");
      const l = this.expr(lenProp.initializer);
      n = this.temp(
        isF(l)
          ? mk(T.i32, {
              k: "builtin",
              name: "toI32",
              args: [mk(T.f64, { k: "builtin", name: "Math.trunc", args: [l], loc: this.loc(e) })],
              loc: this.loc(e),
            })
          : l,
        out,
      );
    } else {
      const seq = this.seqOf(this.expr(e.arguments[0]!), e, out);
      n = this.temp(seq.len(), out);
      item = (i) => seq.at(i, e);
    }
    const v = this.temp(this.vecNew(sh, lit32(0), e), out);
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    this.loopDepth++;
    const body: Stmt[] = [];
    const value = item !== null ? item(i) : NULLISH;
    let result = value;
    if (cv !== null) {
      const tag = this.holdTag(cv, out);
      result = this.callTargets(cv.targets, tag, [{ te: value }, { te: i }], fnNode as ts.Node);
    }
    this.vecPush(v, result, sh, e, body);
    this.loopDepth--;
    out.push(this.countedLoop(iv, n, body, e));
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: v }, { sh });
  }

  holdTag(cv: { tag: TE | null }, out: Stmt[]): TE | null {
    if (cv.tag === null) return null;
    return this.temp(cv.tag, out);
  }

  /** Array and typed-array methods become loops with the callback inlined (SPEC 4.5). */
  seqMethod(name: string, e: ts.CallExpression, callee: ts.PropertyAccessExpression): TE {
    const out: Stmt[] = [];
    const a = e.arguments;
    const recv = this.exprNonNull(callee.expression);
    const seq = this.seqOf(recv, e, out);
    const sh = seq.sh;
    const isArr = sh.s === "arr";
    const done = (te: TE): TE => this.withPrelude(out, te);
    const loc = this.loc(e);
    const hole = (item: TE, f: () => Stmt[]): Stmt[] => {
      // Vector holes are skipped by callbacks, as in JS. Only reference slots can hold one.
      if (!isArr && (seq.elemSh.s === "obj" || seq.elemSh.s === "vec" || seq.elemSh.s === "arr")) {
        const typeArg = this.checker.getTypeArguments(
          this.typeAt(callee.expression) as ts.TypeReference,
        )[0];
        if (typeArg !== undefined && this.nonNullable(typeArg))
          return [{ k: "if", c: this.cmpTE("ne", item, nullPtr()), a: f(), b: null }];
      }
      return f();
    };
    const each = (fn: (item: TE, i: TE, body: Stmt[]) => void, nOverride?: TE): void => {
      const n = nOverride ?? this.temp(seq.len(), out);
      const iv = this.newVar(T.i32, "$i");
      out.push({ k: "let", v: iv, init: lit32(0), constant: false });
      const i = this.readVar(iv, { range: [0, I32_MAX] });
      this.loopDepth++;
      const body: Stmt[] = [];
      const item = this.temp(seq.at(i, e), body);
      fn(item, i, body);
      this.loopDepth--;
      out.push(this.countedLoop(iv, n, body, e));
    };
    const callback = (node: ts.Expression | undefined): ((item: TE, i: TE) => TE) => {
      if (node === undefined) this.block("unsupported", e, `${name} without a callback`);
      const cv = this.closureOf(node, out);
      const tag = this.holdTag(cv, out);
      return (item, i) => {
        const first = cv.targets[0]!;
        const count =
          first.dyn !== undefined
            ? findNode((first.dyn.sh as Extract<Shape, { s: "obj" }>).node).params.length
            : first.decl.parameters.length;
        const args: Arg[] = [{ te: item }, { te: i }];
        if (count > 2) args.push({ te: seq.te });
        return this.callTargets(cv.targets, tag, args, node);
      };
    };
    switch (name) {
      case "forEach": {
        const f = callback(a[0]);
        each((item, i, body) => {
          body.push(...hole(item, () => [{ k: "expr", e: f(item, i) }]));
        });
        return done(VOID);
      }
      case "map": {
        const rsh = this.slot(this.slotKey(e), this.typeAt(e), e);
        const f = callback(a[0]);
        if (rsh.s === "arr") {
          const n = this.temp(seq.len(), out);
          const made = this.temp(this.allocArr(rsh, n, e, out), out);
          this.markWritten(rsh);
          each((item, i, body) => {
            const r = f(item, i);
            body.push({ k: "expr", e: this.storeAt(made, rsh.elem, i, this.numOperand(r, e)) });
          }, n);
          return done(made);
        }
        if (rsh.s !== "vec") this.block("unsupported", e, "map with no array result");
        const n = this.temp(seq.len(), out);
        const made = this.temp(this.vecNew(rsh, n, e), out);
        each((item, i, body) => {
          body.push(
            ...hole(item, () => {
              const inner: Stmt[] = [];
              const r = f(item, i);
              const es = findNode(rsh.node).elem!;
              const te = this.flow(r, es, e);
              this.markEscape(es);
              const place = this.elemPlace(this.seqOf(made, e, inner), this.ixOf(i));
              inner.push({
                k: "expr",
                e: mk(te.ty, { k: "fstore", base: place, mem: memOf(es, 0), val: te, rc: "init" }),
              });
              return inner;
            }),
          );
        }, n);
        return done(made);
      }
      case "filter": {
        const rsh = this.slot(this.slotKey(e), this.typeAt(e), e);
        const f = callback(a[0]);
        if (rsh.s !== "vec") this.block("unsupported", e, "filter on a typed array");
        const made = this.temp(this.vecNew(rsh, lit32(0), e), out);
        each((item, i, body) => {
          body.push(
            ...hole(item, () => {
              const keep = this.truthy(f(item, i), e);
              const inner: Stmt[] = [];
              this.vecPush(made, item, rsh, e, inner);
              return [{ k: "if", c: keep, a: inner, b: null }];
            }),
          );
        });
        return done(made);
      }
      case "reduce": {
        const f = a[0];
        if (f === undefined) this.block("unsupported", e, "reduce without a callback");
        const cv = this.closureOf(f, out);
        const tag = this.holdTag(cv, out);
        const accSh = this.slot(`${this.slotKey(e)}#acc`, this.typeAt(e), e);
        const acc = this.newVar(tyOf(accSh), "$acc");
        const n = this.temp(seq.len(), out);
        const iv = this.newVar(T.i32, "$i");
        if (a[1] !== undefined) {
          out.push({
            k: "let",
            v: acc,
            init: this.flow(this.expr(a[1], accSh), accSh, a[1]),
            constant: false,
          });
          out.push({ k: "let", v: iv, init: lit32(0), constant: false });
        } else {
          out.push({
            k: "expr",
            e: mk(T.void, {
              k: "builtin",
              name: "assert",
              args: [this.cmpTE("gt", n, lit32(0)), lit32(4)],
              loc,
            }),
          });
          out.push({
            k: "let",
            v: acc,
            init: this.flow(seq.at(lit32(0), e), accSh, e),
            constant: false,
          });
          out.push({ k: "let", v: iv, init: lit32(1), constant: false });
        }
        const i = this.readVar(iv, { range: [0, I32_MAX] });
        this.loopDepth++;
        const body: Stmt[] = [];
        const item = this.temp(seq.at(i, e), body);
        const r = this.callTargets(
          cv.targets,
          tag,
          [{ te: this.varTE(acc, accSh) }, { te: item }, { te: i }],
          f,
        );
        body.push({
          k: "expr",
          e: mk(acc.ty, { k: "setvar", v: acc, val: this.flow(r, accSh, e) }),
        });
        this.loopDepth--;
        out.push(this.countedLoop(iv, n, body, e));
        const res = this.varTE(acc, accSh);
        return mk(res.ty, { k: "blockexpr", body: out, result: res }, this.carry(res));
      }
      case "find":
      case "findIndex":
      case "some":
      case "every":
      case "includes":
      case "indexOf": {
        return this.seqSearch(name, e, seq, out);
      }
      case "fill":
        return this.seqFill(e, seq, recv, out);
      case "subarray":
        return this.subarray(e, seq, out);
      case "slice":
        return this.seqSlice(e, seq, out);
      case "set":
        return this.typedSet(e, seq, out);
      case "shift":
        return this.seqShift(e, seq, out);
      case "splice":
        return this.seqSplice(e, seq, out);
      case "push": {
        if (sh.s !== "vec") this.block("unsupported", e, "push on a typed array");
        for (const x of a) {
          const es = findNode(sh.node).elem!;
          if (ts.isSpreadElement(x)) this.block("unsupported", x, "push with a spread");
          this.vecPush(seq.te, this.expr(x, es), sh, e, out);
        }
        return done(seq.len());
      }
      case "pop": {
        if (sh.s !== "vec") this.block("unsupported", e, "pop on a typed array");
        this.markWritten(sh);
        const lenIx = mk(T.usize, { k: "fload", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }] });
        const body: Stmt[] = [];
        const es = findNode(sh.node).elem!;
        const osh: Shape =
          es.s === "num" || es.s === "bool" || es.s === "str"
            ? { s: "opt", of: es, nul: "undefined" }
            : es;
        const rv = this.newVar(tyOf(osh), "$r");
        const next = this.temp(
          mk(T.usize, { k: "arith", op: "sub", a: lenIx, b: litIx(1), wrap: true, loc }),
          body,
        );
        const place = this.elemPlace(seq, next);
        const loaded = mk(
          tyOf(es),
          { k: "fload", base: place, mem: memOf(es, 0) },
          this.readExtras(es),
        );
        const value =
          osh.s === "opt"
            ? mk(tyOf(osh), { k: "tuple", items: [lit32(1), loaded] }, { sh: osh })
            : loaded;
        body.push({ k: "expr", e: mk(rv.ty, { k: "setvar", v: rv, val: value }) });
        if (this.memory === "rc") body.push(this.clearSlot(seq, next, es));
        body.push({
          k: "expr",
          e: mk(T.void, { k: "fstore", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }], val: next }),
        });
        out.push({
          k: "let",
          v: rv,
          init: osh.s === "opt" ? this.none(osh) : this.nullOf(osh),
          constant: false,
        });
        out.push({ k: "if", c: this.cmpTE("gt", lenIx, litIx(0)), a: body, b: null });
        return done(this.narrowed(this.varTE(rv, osh), osh, e));
      }
      default: {
        if (this.mem) {
          const r = this.seqMethodRt(name, e, callee, seq);
          if (r !== null) return done(r);
        }
        return this.block(
          name === "join" || name === "toString" ? "string-use" : "unsupported",
          e,
          `the array method ${name}`,
        );
      }
    }
  }

  /** A slot given up, so what it held is released in `rc`. Everywhere else, it only has to read as a hole. */
  clearSlot(seq: Seq, ix: TE, es: Shape): Stmt {
    const isRef = es.s === "obj" || es.s === "vec" || es.s === "arr";
    if (!isRef) return { k: "block", body: [] };
    const nothing = this.nullOf(es);
    return {
      k: "expr",
      e: mk(nothing.ty, {
        k: "fstore",
        base: this.elemPlace(seq, ix),
        mem: memOf(es, 0),
        val: nothing,
      }),
    };
  }

  /** One element to another slot, with nothing else changing: in `rc`, its count goes with it. */
  moveSlot(from: TE, to: TE, es: Shape): Stmt {
    const loaded = mk(tyOf(es), { k: "fload", base: from, mem: memOf(es, 0) }, this.readExtras(es));
    return {
      k: "expr",
      e: mk(loaded.ty, { k: "fstore", base: to, mem: memOf(es, 0), val: loaded, rc: "move" }),
    };
  }

  /**
   * Array.prototype.shift: every later element moves down one, so it costs what the array's length costs. V8's
   * left-trimming makes it cheaper there. A vector has no offset to do the same with (SPEC 4.5).
   */
  seqShift(e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const sh = seq.sh;
    if (sh.s !== "vec") this.block("unsupported", e, "shift on a typed array");
    this.markWritten(sh);
    const loc = this.loc(e);
    const lenIx = mk(T.usize, { k: "fload", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }] });
    const es = findNode(sh.node).elem!;
    const isScalar = es.s === "num" || es.s === "bool" || es.s === "str";
    const osh: Shape = isScalar ? { s: "opt", of: es, nul: "undefined" } : es;
    const rv = this.newVar(tyOf(osh), "$r");
    out.push({
      k: "let",
      v: rv,
      init: osh.s === "opt" ? this.none(osh) : this.nullOf(osh),
      constant: false,
    });
    const body: Stmt[] = [];
    const first = litIx(0);
    const loaded = mk(
      tyOf(es),
      { k: "fload", base: this.elemPlace(seq, first), mem: memOf(es, 0) },
      this.readExtras(es),
    );
    const value =
      osh.s === "opt"
        ? mk(tyOf(osh), { k: "tuple", items: [lit32(1), loaded] }, { sh: osh })
        : loaded;
    body.push({ k: "expr", e: mk(rv.ty, { k: "setvar", v: rv, val: value }) });
    body.push(this.clearSlot(seq, first, es));
    const last = this.temp(
      mk(T.usize, { k: "arith", op: "sub", a: lenIx, b: litIx(1), wrap: true, loc }),
      body,
    );
    const iv = this.newVar(T.i32, "$i");
    body.push({ k: "let", v: iv, init: lit32(1), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const before = mk(T.usize, {
      k: "arith",
      op: "sub",
      a: this.ixOf(i),
      b: litIx(1),
      wrap: true,
      loc,
    });
    const moves = [
      this.moveSlot(this.elemPlace(seq, this.ixOf(i)), this.elemPlace(seq, before), es),
    ];
    body.push(this.countedLoop(iv, this.i32OfLen(lenIx), moves, e));
    // The top slot's value moved down, so it's only a stale copy now, and it must read as a hole.
    if (!isScalar) {
      const nothing = this.nullOf(es);
      body.push({
        k: "expr",
        e: mk(nothing.ty, {
          k: "fstore",
          base: this.elemPlace(seq, last),
          mem: memOf(es, 0),
          val: nothing,
          rc: "move",
        }),
      });
    }
    body.push({
      k: "expr",
      e: mk(T.void, { k: "fstore", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }], val: last }),
    });
    out.push({ k: "if", c: this.cmpTE("gt", lenIx, litIx(0)), a: body, b: null });
    return this.withPrelude(out, this.narrowed(this.varTE(rv, osh), osh, e));
  }

  /** Array.prototype.splice. What's removed moves to the result, and the tail moves: no count changes for either. */
  seqSplice(e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const sh = seq.sh;
    if (sh.s !== "vec") this.block("unsupported", e, "splice on a typed array");
    this.checkAlloc(sh.node, e);
    this.markWritten(sh);
    const loc = this.loc(e);
    const a = e.arguments;
    for (const x of a)
      if (ts.isSpreadElement(x)) this.block("unsupported", x, "splice with a spread");
    const rsh = this.slot(this.slotKey(e), this.typeAt(e), e) as Extract<Shape, { s: "vec" }>;
    this.unify(rsh, sh, e);
    const es = findNode(sh.node).elem!;
    const lenIx = (): TE =>
      mk(T.usize, { k: "fload", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }] });
    const len = this.temp(seq.len(), out);
    const start = this.temp(this.clampIndex(a[0], len, lit32(0), out), out);
    const room = mk(
      T.i32,
      { k: "arith", op: "sub", a: len, b: start, wrap: true, loc },
      { range: [0, I32_MAX] },
    );
    let del: TE;
    if (a.length === 0) del = lit32(0);
    else if (a.length === 1) del = room;
    else {
      const raw = this.numOperand(this.expr(a[1]!), a[1]!);
      const n = this.temp(
        isF(raw)
          ? mk(T.i32, { k: "builtin", name: "fptosi.sat", args: [raw], loc })
          : retype(raw, T.i32),
        out,
      );
      del = this.minMax2(true, this.minMax2(false, n, lit32(0), loc), room, loc);
    }
    const count = this.temp(retype(del, T.i32), out);
    const items = a.slice(2).map((x) => {
      const te = this.flow(this.expr(x, es), es, x);
      this.markEscape(es);
      return this.temp(te, out);
    });
    const made = this.temp(this.vecNew(rsh, count, e), out);
    const madeSeq = this.seqOf(made, e, out);
    const counter = (init: TE): { v: Var; read: TE } => {
      const v = this.newVar(T.i32, "$i");
      out.push({ k: "let", v, init, constant: false });
      return { v, read: this.readVar(v, { range: [I32_MIN, I32_MAX] }) };
    };
    const add = (x: TE, y: TE): TE =>
      mk(T.i32, { k: "arith", op: "add", a: x, b: y, wrap: true, loc }, { range: [0, I32_MAX] });
    const sub = (x: TE, y: TE): TE =>
      mk(
        T.i32,
        { k: "arith", op: "sub", a: x, b: y, wrap: true, loc },
        { range: [I32_MIN, I32_MAX] },
      );
    const at = (x: TE): TE => this.ixOf(x);
    // Removed elements to the result.
    const c1 = counter(lit32(0));
    out.push(
      this.countedLoop(
        c1.v,
        count,
        [
          this.moveSlot(
            this.elemPlace(seq, at(add(start, c1.read))),
            this.elemPlace(madeSeq, at(c1.read)),
            es,
          ),
        ],
        e,
      ),
    );
    const n2 = lit32(items.length);
    const nextLen = this.temp(add(sub(len, count), n2), out);
    out.push({
      k: "expr",
      e: mk(
        T.void,
        {
          k: "rtcall",
          name: this.vecFn("__vec_reserve", sh.node),
          args: [seq.te, at(nextLen), litIx(Math.max(1, sizeOf(es)))],
        },
        // the tail moves up into the new room before the length says so: a JsArray's length goes first (R3)
        { grows: true },
      ),
    });
    // The tail: down from its front when it moves down, and up from its back when it moves up.
    const tailFrom = this.temp(add(start, count), out);
    const tailTo = this.temp(add(start, n2), out);
    const tail = this.temp(sub(len, tailFrom), out);
    const moveAt = (i: TE): Stmt =>
      this.moveSlot(
        this.elemPlace(seq, at(add(tailFrom, i))),
        this.elemPlace(seq, at(add(tailTo, i))),
        es,
      );
    const c2 = counter(lit32(0));
    const down = this.countedLoop(c2.v, tail, [moveAt(c2.read)], e);
    const c3 = counter(sub(tail, lit32(1)));
    const up: Stmt = {
      k: "while",
      c: this.cmpTE("ge", c3.read, lit32(0)),
      body: [
        moveAt(c3.read),
        { k: "expr", e: mk(T.i32, { k: "setvar", v: c3.v, val: sub(c3.read, lit32(1)) }) },
      ],
    };
    out.push({ k: "if", c: this.cmpTE("gt", tailTo, tailFrom), a: [up], b: [down] });
    // What's past the new end is a stale copy, and a hole to anyone who reads it.
    if (es.s === "obj" || es.s === "vec" || es.s === "arr") {
      const c4 = counter(nextLen);
      const nothing = this.nullOf(es);
      out.push(
        this.countedLoop(
          c4.v,
          len,
          [
            {
              k: "expr",
              e: mk(nothing.ty, {
                k: "fstore",
                base: this.elemPlace(seq, at(c4.read)),
                mem: memOf(es, 0),
                val: nothing,
                rc: "move",
              }),
            },
          ],
          e,
        ),
      );
    }
    items.forEach((item, j) => {
      out.push({
        k: "expr",
        e: mk(item.ty, {
          k: "fstore",
          base: this.elemPlace(seq, at(add(start, lit32(j)))),
          mem: memOf(es, 0),
          val: item,
          rc: "init",
        }),
      });
    });
    out.push({
      k: "expr",
      e: mk(T.void, {
        k: "fstore",
        base: seq.te,
        mem: [{ t: "ix", off: VEC_LEN }],
        val: at(nextLen),
      }),
    });
    void lenIx;
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: made }, { sh: rsh });
  }

  /** `a.length = n`: giving up slots releases them. Growing leaves holes, which only reference slots can hold. */
  lengthPlace(baseNode: ts.Expression, whole: ts.Expression, out: Stmt[]): LV {
    const seqBase = this.temp(this.exprNonNull(baseNode), out);
    const sh = seqBase.sh as Shape | undefined;
    if (sh === undefined || sh.s !== "vec")
      this.block("unsupported", whole, "assigning a typed array's length");
    this.markWritten(sh);
    const seq = this.seqOf(seqBase, whole, out);
    return {
      sh: { s: "num", loc: newLoc() },
      read: () => seq.len(),
      write: (val, at) => {
        const loc = this.loc(at);
        const body: Stmt[] = [];
        const raw = this.numOperand(val, at);
        const n = this.temp(
          isF(raw)
            ? mk(
                T.i32,
                { k: "builtin", name: "toI32", args: [raw], loc },
                { range: [I32_MIN, I32_MAX] },
              )
            : retype(raw, T.i32),
          body,
        );
        // JS throws RangeError on these, so this is a trap with a code V8's run shows as a throw (3.10, item 1).
        body.push({
          k: "expr",
          e: mk(T.void, {
            k: "builtin",
            name: "assert",
            args: [this.cmpTE("ge", n, lit32(0)), lit32(4)],
            loc,
          }),
        });
        const es = findNode(sh.node).elem!;
        const old = this.temp(seq.len(), body);
        const isRef = es.s === "obj" || es.s === "vec" || es.s === "arr";
        if (isRef) {
          const iv = this.newVar(T.i32, "$i");
          body.push({ k: "let", v: iv, init: n, constant: false });
          const i = this.readVar(iv, { range: [0, I32_MAX] });
          body.push(this.countedLoop(iv, old, [this.clearSlot(seq, this.ixOf(i), es)], at));
          body.push({
            k: "expr",
            e: mk(T.void, {
              k: "rtcall",
              name: this.vecFn("__vec_reserve", sh.node),
              args: [seqBase, this.ixOf(n), litIx(Math.max(1, sizeOf(es)))],
            }),
          });
        } else {
          body.push({
            k: "if",
            c: this.cmpTE("gt", n, old),
            a: [{ k: "expr", e: mk(NEVER_TY, { k: "trapnow", kind: "sparse", code: 15, loc }) }],
            b: null,
          });
        }
        body.push({
          k: "expr",
          e: mk(T.void, {
            k: "fstore",
            base: seqBase,
            mem: [{ t: "ix", off: VEC_LEN }],
            val: this.ixOf(n),
          }),
        });
        return mk(n.ty, { k: "blockexpr", body, result: n }, this.carry(n));
      },
    };
  }

  seqSearch(name: string, e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const n = this.temp(seq.len(), out);
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const hitIdx = this.newVar(T.i32, "$hit");
    out.push({ k: "let", v: hitIdx, init: lit32(-1), constant: false });
    const hitRead = this.readVar(hitIdx, { range: [-1, I32_MAX] });
    const label = `$s${this.nextLabel++}`;
    this.loopDepth++;
    const body: Stmt[] = [];
    const item = this.temp(seq.at(i, e), body);
    let test: TE;
    if (name === "includes" || name === "indexOf") {
      const arg = e.arguments[0];
      if (arg === undefined) this.block("unsupported", e, `${name} without an argument`);
      if (e.arguments.length > 1) this.block("unsupported", e, `${name} with a start index`);
      test = this.compare("eq", item, this.expr(arg), e);
      if (name === "includes" && isF(item)) {
        // includes finds NaN, where === doesn't.
        const nanArg = this.expr(arg);
        if (isF(nanArg)) {
          test = mk(T.bool, {
            k: "logic",
            op: "or",
            a: test,
            b: mk(T.bool, {
              k: "logic",
              op: "and",
              a: this.cmpTE("ne", item, item),
              b: this.cmpTE("ne", nanArg, nanArg),
            }),
          });
        }
      }
    } else {
      const f = e.arguments[0];
      if (f === undefined) this.block("unsupported", e, `${name} without a callback`);
      const cv = this.closureOf(f, out);
      const tag = this.holdTag(cv, out);
      test = this.truthy(this.callTargets(cv.targets, tag, [{ te: item }, { te: i }], f), e);
    }
    if (name === "every") test = this.not(test);
    body.push({
      k: "if",
      c: test,
      a: [
        { k: "expr", e: mk(T.i32, { k: "setvar", v: hitIdx, val: i }) },
        { k: "break", label },
      ],
      b: null,
    });
    this.loopDepth--;
    out.push({ k: "label", name: label, body: this.countedLoop(iv, n, body, e) });
    const found = this.cmpTE("ge", hitRead, lit32(0));
    switch (name) {
      case "some":
      case "includes":
        return this.withPrelude(out, found);
      case "every":
        return this.withPrelude(out, this.not(found));
      case "findIndex":
      case "indexOf":
        return this.withPrelude(out, hitRead);
      default: {
        // find: the element or undefined.
        const es = seq.elemSh;
        if (es.s === "num" || es.s === "bool" || es.s === "str") {
          const osh: Shape = { s: "opt", of: es, nul: "undefined" };
          const c = mk(
            tyOf(osh),
            {
              k: "cond",
              c: found,
              a: mk(tyOf(osh), { k: "tuple", items: [lit32(1), seq.at(hitRead, e)] }),
              b: this.none(osh),
            },
            { sh: osh },
          );
          return this.withPrelude(out, this.narrowed(c, osh, e));
        }
        const c = mk(
          tyOf(es),
          { k: "cond", c: found, a: seq.at(hitRead, e), b: this.nullOf(es) },
          { sh: es },
        );
        return this.withPrelude(out, c);
      }
    }
  }

  /** A relative index as JS clamps it: negative counts from the end, and it stays within [0, len]. */
  clampIndex(arg: ts.Expression | undefined, len: TE, dflt: TE, out: Stmt[]): TE {
    if (arg === undefined) return dflt;
    const raw = this.numOperand(this.expr(arg), arg);
    const i = isF(raw)
      ? mk(T.i32, { k: "builtin", name: "fptosi.sat", args: [raw], loc: this.loc(arg) })
      : raw;
    const v = this.temp(retype(i, T.i32), out);
    const back = mk(
      T.i32,
      { k: "arith", op: "add", a: len, b: v, wrap: true, loc: this.loc(arg) },
      { range: [0, I32_MAX] },
    );
    const neg = this.minMax2(false, back, lit32(0), this.loc(arg));
    const pos = this.minMax2(true, v, len, this.loc(arg));
    return mk(
      T.i32,
      { k: "cond", c: this.cmpTE("lt", v, lit32(0)), a: neg, b: pos },
      { range: [0, I32_MAX] },
    );
  }

  subarray(e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const sh = seq.sh;
    if (sh.s !== "arr") this.block("unsupported", e, "subarray on a plain array");
    const a = e.arguments;
    const len = this.temp(seq.len(), out);
    const start = this.temp(this.clampIndex(a[0], len, lit32(0), out), out);
    const end = this.temp(this.clampIndex(a[1], len, len, out), out);
    const size = mk(T.i32, {
      k: "arith",
      op: "sub",
      a: end,
      b: start,
      wrap: true,
      loc: this.loc(e),
    });
    const clamped = this.minMax2(
      false,
      { ...size, range: [I32_MIN, I32_MAX] } as TE,
      lit32(0),
      this.loc(e),
    );
    const p = mk(
      { k: "ref" },
      {
        k: "elemaddr",
        base: this.ptrOfArr(seq.te),
        idx: this.ixOf(start),
        scale: elemSize(sh.elem),
      },
    );
    const r = mk(
      { k: "arr", elem: sh.elem },
      { k: "tuple", items: [p, this.ixOf(clamped)] },
      { sh },
    );
    return this.withPrelude(out, r);
  }

  seqFill(e: ts.CallExpression, seq: Seq, _recv: TE, out: Stmt[]): TE {
    const sh = seq.sh;
    const a = e.arguments;
    this.markWritten(sh);
    if (a[0] === undefined) this.block("unsupported", e, "fill with no value");
    const es = seq.elemSh;
    const value = this.temp(this.expr(a[0], sh.s === "vec" ? es : undefined), out);
    const len = this.temp(seq.len(), out);
    const start = this.temp(this.clampIndex(a[1], len, lit32(0), out), out);
    const end = this.temp(this.clampIndex(a[2], len, len, out), out);
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: start, constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const body: Stmt[] = [];
    if (sh.s === "arr") {
      body.push({ k: "expr", e: this.storeAt(seq.te, sh.elem, i, this.numOperand(value, e)) });
    } else {
      const live = findNode((sh as Extract<Shape, { s: "vec" }>).node).elem!;
      const te = this.flow(value, live, e);
      this.markEscape(live);
      body.push({
        k: "expr",
        e: mk(te.ty, {
          k: "fstore",
          base: this.elemPlace(seq, this.ixOf(i)),
          mem: memOf(live, 0),
          val: te,
        }),
      });
    }
    out.push(this.countedLoop(iv, end, body, e));
    return this.withPrelude(out, seq.te);
  }

  seqSlice(e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const sh = seq.sh;
    const a = e.arguments;
    const len = this.temp(seq.len(), out);
    const start = this.temp(this.clampIndex(a[0], len, lit32(0), out), out);
    const end = this.temp(this.clampIndex(a[1], len, len, out), out);
    const sizeRaw = mk(
      T.i32,
      { k: "arith", op: "sub", a: end, b: start, wrap: true, loc: this.loc(e) },
      { range: [I32_MIN, I32_MAX] },
    );
    const size = this.temp(this.minMax2(false, sizeRaw, lit32(0), this.loc(e)), out);
    const rsh = this.slot(this.slotKey(e), this.typeAt(e), e);
    if (rsh.s === "arr" && sh.s === "arr") {
      const made = this.temp(this.allocArr(rsh, size, e, out, false), out);
      this.markWritten(rsh);
      const es = elemSize(sh.elem);
      const src = mk(
        { k: "ref" },
        { k: "elemaddr", base: this.ptrOfArr(seq.te), idx: this.ixOf(start), scale: es },
      );
      const bytes = mk(T.usize, {
        k: "arith",
        op: "mul",
        a: this.ixOf(size),
        b: litIx(es),
        wrap: true,
        loc: this.loc(e),
      });
      out.push({
        k: "expr",
        e: mk(T.void, {
          k: "intrinsic",
          name: "mem.copy",
          args: [this.ptrOfArr(made), src, bytes],
        }),
      });
      return this.withPrelude(out, made);
    }
    if (rsh.s !== "vec") this.block("unsupported", e, "slice with no array result");
    const made = this.temp(this.vecNew(rsh, size, e), out);
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const body: Stmt[] = [];
    const from = mk(
      T.i32,
      { k: "arith", op: "add", a: i, b: start, wrap: true, loc: this.loc(e) },
      { range: [0, I32_MAX] },
    );
    const es = findNode(rsh.node).elem!;
    const te = this.flow(seq.at(from, e), es, e);
    this.markEscape(es);
    const place = this.elemPlace(this.seqOf(made, e, body), this.ixOf(i));
    body.push({
      k: "expr",
      e: mk(te.ty, { k: "fstore", base: place, mem: memOf(es, 0), val: te, rc: "init" }),
    });
    out.push(this.countedLoop(iv, size, body, e));
    return this.withPrelude(out, made);
  }

  typedSet(e: ts.CallExpression, seq: Seq, out: Stmt[]): TE {
    const sh = seq.sh;
    if (sh.s !== "arr") this.block("unsupported", e, "set on a plain array");
    this.markWritten(sh);
    const a = e.arguments;
    const offRaw = a[1] !== undefined ? this.numOperand(this.expr(a[1]), e) : lit32(0);
    const off = this.temp(
      isF(offRaw)
        ? mk(T.i32, {
            k: "builtin",
            name: "toI32",
            args: [
              mk(T.f64, { k: "builtin", name: "Math.trunc", args: [offRaw], loc: this.loc(e) }),
            ],
            loc: this.loc(e),
          })
        : offRaw,
      out,
    );
    const srcSeq = this.seqOf(this.expr(a[0]!), e, out);
    const n = this.temp(srcSeq.len(), out);
    const loc = this.loc(e);
    const end = mk(T.i32, { k: "arith", op: "add", a: off, b: n, wrap: false, loc });
    // JS throws RangeError here, before writing anything.
    out.push({
      k: "expr",
      e: mk(T.void, {
        k: "builtin",
        name: "assert",
        args: [
          mk(T.bool, {
            k: "logic",
            op: "and",
            a: this.cmpTE("ge", off, lit32(0)),
            b: this.cmpTE("le", end, seq.len()),
          }),
          lit32(4),
        ],
        loc,
      }),
    });
    if (srcSeq.sh.s === "arr" && srcSeq.sh.elem === sh.elem) {
      const es = elemSize(sh.elem);
      const dst = mk(
        { k: "ref" },
        { k: "elemaddr", base: this.ptrOfArr(seq.te), idx: this.ixOf(off), scale: es },
      );
      const bytes = mk(T.usize, {
        k: "arith",
        op: "mul",
        a: this.ixOf(n),
        b: litIx(es),
        wrap: true,
        loc,
      });
      out.push({
        k: "expr",
        e: mk(T.void, {
          k: "intrinsic",
          name: "mem.copy",
          args: [dst, this.ptrOfArr(srcSeq.te), bytes],
        }),
      });
      return this.withPrelude(out, VOID);
    }
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    const to = mk(
      T.i32,
      { k: "arith", op: "add", a: off, b: i, wrap: true, loc },
      { range: [0, I32_MAX] },
    );
    const body: Stmt[] = [
      { k: "expr", e: this.storeAt(seq.te, sh.elem, to, this.numOperand(srcSeq.at(i, e), e)) },
    ];
    out.push(this.countedLoop(iv, n, body, e));
    return this.withPrelude(out, VOID);
  }

  // --- output

  /** A class inside a function that captures nothing of the function's is a class like any other: types say what it is. */
  localClass(c: ts.ClassDeclaration): void {
    const inside = (d: ts.Node): boolean => d.pos >= c.pos && d.end <= c.end;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const parent = n.parent;
        const isName =
          (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
          (ts.isPropertyAssignment(parent) && parent.name === n) ||
          (ts.isPropertyDeclaration(parent) && parent.name === n) ||
          (ts.isMethodDeclaration(parent) && parent.name === n);
        const sym = isName ? undefined : this.symbolOf(n);
        const d = sym?.valueDeclaration;
        if (
          d !== undefined &&
          !inside(d) &&
          !this.isLibSymbol(sym!) &&
          (ts.isVariableDeclaration(d) || ts.isParameter(d)) &&
          !this.isModuleVar(sym!)
        ) {
          this.block(
            "unsupported",
            n,
            `a class inside a function, capturing ${n.text}, which is the function's`,
          );
        }
        if (
          d !== undefined &&
          !inside(d) &&
          ts.isFunctionDeclaration(d) &&
          !ts.isSourceFile(d.parent)
        ) {
          this.block(
            "unsupported",
            n,
            `a class inside a function, calling its local function ${n.text}`,
          );
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(c);
  }

  // --- run-time strings, `Map` and `Set` (SPEC 3.5, 4.5, D42). All of it is behind a memory mode: `strict` never gets here.

  needStr(at: ts.Node, what: string): void {
    if (!this.mem) this.block("string-use", at, what);
    if (!this.strRt) throw new RestartStrRt();
  }

  strShape(): Extract<Shape, { s: "obj" }> {
    return { s: "obj", node: this.strNode };
  }

  isStr(sh: unknown): boolean {
    const s = sh as Shape | undefined;
    return s !== undefined && s.s === "obj" && findNode(s.node) === findNode(this.strNode);
  }

  isStringType(t0: ts.Type): boolean {
    const t = this.subst(t0);
    if (t.isUnion()) {
      const rest = t.types.filter(
        (p) => !hasFlag(p, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void),
      );
      return rest.length > 0 && rest.every((p) => hasFlag(p, ts.TypeFlags.StringLike));
    }
    return hasFlag(t, ts.TypeFlags.StringLike);
  }

  rtMember(t0: ts.Type): ts.Type {
    return this.checker.getNonNullableType(this.subst(t0));
  }

  isMapType(t0: ts.Type): "map" | "set" | null {
    const lib = this.libName(this.rtMember(t0));
    if (lib === "Map" || lib === "ReadonlyMap") return "map";
    if (lib === "Set" || lib === "ReadonlySet") return "set";
    return null;
  }

  isIterType(t0: ts.Type): boolean {
    const lib = this.libName(this.rtMember(t0));
    return lib === "MapIterator" || lib === "SetIterator" || lib === "IterableIterator";
  }

  isItemSource(t: ts.Type): boolean {
    return this.isStringType(t) || this.isMapType(t) !== null || this.isIterType(t);
  }

  private rtDecls: Map<string, ts.FunctionDeclaration | ts.ClassDeclaration> | null = null;

  rtDecl(name: string): ts.FunctionDeclaration | ts.ClassDeclaration {
    if (this.rtDecls === null) {
      this.rtDecls = new Map();
      for (const f of ["str", "map", "array", "num", "case", "exc"]) {
        const sf = this.program.getSourceFile(rtFilePath(f));
        if (sf === undefined) throw new Error(`the runtime file ${f} isn't in this program`);
        for (const st of sf.statements) {
          if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name !== undefined)
            this.rtDecls.set(st.name.text, st);
        }
      }
    }
    const d = this.rtDecls.get(name);
    if (d === undefined) throw new Error(`no runtime function ${name}`);
    return d;
  }

  rtEnv(decl: ts.FunctionDeclaration | ts.ClassDeclaration, types: ts.Type[]): Env {
    const env: Env = new Map(this.env);
    (decl.typeParameters ?? []).forEach((tp, i) => {
      const a = types[i];
      if (a === undefined)
        throw new Error(`a runtime type parameter with no argument: ${tp.name.text}`);
      env.set((this.checker.getTypeAtLocation(tp) as unknown as { id: number }).id, this.subst(a));
    });
    return env;
  }

  rtCallArgs(name: string, args: Arg[], node: ts.Node, types: ts.Type[] = []): TE {
    const decl = this.rtDecl(name) as ts.FunctionDeclaration;
    this.rtBlockedCheck(decl, node);
    const env = this.rtEnv(decl, types);
    if (this.anyClosureArg(args)) {
      const key = `top:top:${decl.pos}${this.envKey(env)}`;
      return this.inlineCall(
        { decl, scope: new Scope(null), env, key, round: this.round },
        args,
        node,
      );
    }
    const inst = this.instOf(decl, env, new Map(), null, false, decl);
    return this.callInst(
      inst,
      null,
      args.map((a) => a.te ?? NULLISH),
      node,
    );
  }

  /** Runtime code that can't be lowered for these types blocks whoever asked for it, with the same root cause. */
  rtBlockedCheck(decl: ts.Node, node: ts.Node): void {
    const f = this.fallback.get(decl);
    if (f !== undefined)
      this.block(f.blocker, node, `the runtime, for these types: ${f.detail}`, f.root);
  }

  rtCall(name: string, args: TE[], node: ts.Node, types: ts.Type[] = []): TE {
    return this.rtCallArgs(
      name,
      args.map((te) => ({ te })),
      node,
      types,
    );
  }

  // --- literals and static data

  strStatic(s: string): TE {
    let name = this.strLits.get(s);
    if (name === undefined) {
      name = `__strlit_${this.strLits.size}`;
      this.strLits.set(s, name);
    }
    return mk({ k: "ref" }, { k: "gaddr", name, off: RC_HDR }, { sh: this.strShape() });
  }

  strGlobals(): Global[] {
    const out: Global[] = [];
    for (const [s, name] of this.strLits) out.push(strLiteralGlobal(name, s));
    if (this.usesCharTable) out.push(charTableGlobal("__s_chars"));
    return out;
  }

  hashGlobals(): Global[] {
    return [hashKeyGlobal("__hash_key")];
  }

  strLength(s: TE): TE {
    return mk(T.i32, { k: "fload", base: s, mem: [{ t: "i32", off: 0 }] }, { range: [0, I32_MAX] });
  }

  strTruthy(te: TE): TE {
    return this.withTemp(te, (t) =>
      mk(T.bool, {
        k: "logic",
        op: "and",
        a: this.cmpTE("ne", t, nullPtr()),
        b: this.cmpTE("ne", this.strLength(t), lit32(0)),
      }),
    );
  }

  strCompare(op: "eq" | "ne" | "lt" | "le" | "gt" | "ge", a: TE, b: TE, node: ts.Node): TE {
    if (op === "eq") return this.rtCall("strEq", [a, b], node);
    if (op === "ne") return this.not(this.rtCall("strEq", [a, b], node));
    return this.cmpTE(op, this.rtCall("strCmp", [a, b], node), lit32(0));
  }

  private strCond(c: TE, a: TE, b: TE): TE {
    return mk({ k: "ref" }, { k: "cond", c, a, b }, { sh: this.strShape() });
  }

  /** ToString, for a value of this TS type. `join` is Array.prototype.join's, where null and undefined are empty. */
  toStrTE(te: TE, t0: ts.Type, at: ts.Node, join = false): TE {
    if (te.ty.k === "never") return te;
    const t = this.subst(t0);
    const nullText = (nul: Nul | undefined): TE =>
      this.strLit(join ? "" : nul === "null" ? "null" : "undefined");
    if (te.ty.k === "nullish") {
      const isNull = hasFlag(t, ts.TypeFlags.Null) || this.nullishOf(t).null;
      return mk(
        { k: "ref" },
        { k: "seq", items: [te], result: nullText(isNull ? "null" : "undefined") },
        { sh: this.strShape() },
      );
    }
    if (this.isDyn(te.sh)) return this.rtCall("tmkDynStr", [te], at);
    if (isNum(te)) {
      if (isF(te) || isU32(te)) return this.rtCall("numStr", [this.toFloat(te)], at);
      return this.rtCall("i32Str", [te], at);
    }
    if (te.ty.k === "bool") return this.rtCall("boolStr", [te], at);
    if (te.ty.k === "lits") this.needStr(at, "a literal as a run-time string");
    const sh = te.sh as Shape | undefined;
    if (te.ty.k === "opt") {
      const osh = te.sh as Extract<Shape, { s: "opt" }>;
      return this.withTemp(te, (x) =>
        this.strCond(
          mk(T.bool, { k: "slice", val: x, from: 0, to: 1 }),
          this.toStrTE(this.optPayload(x, osh), this.rtMember(t), at, join),
          nullText(osh.nul),
        ),
      );
    }
    if (sh === undefined) this.block("string-use", at, `the text of a ${te.ty.k}`);
    if (sh.s === "arr") this.block("string-use", at, "the text of a typed array");
    if (sh.s !== "vec" && sh.s !== "obj") this.block("string-use", at, `the text of a ${sh.s}`);
    const nullable = sh.nul !== undefined || !this.nonNullable(t);
    if (this.isStr(sh) && !nullable) return te;
    return this.withTemp(te, (x) => {
      const present = this.cmpTE("ne", x, nullPtr());
      const inner = this.toStrPresent(x, sh, this.rtMember(t), at);
      return nullable
        ? this.strCond(
            present,
            inner,
            nullText(sh.nul ?? (this.nullishOf(t).null ? "null" : "undefined")),
          )
        : inner;
    });
  }

  private toStrPresent(
    x: TE,
    sh: Extract<Shape, { s: "vec" | "obj" }>,
    t: ts.Type,
    at: ts.Node,
  ): TE {
    if (this.isStr(sh)) return x;
    if (sh.s === "vec") {
      const elem =
        this.checker.getTypeArguments(t as ts.TypeReference)[0] ?? this.checker.getUndefinedType();
      return this.rtCall("arrJoin", [x, this.strLit(",")], at, [elem]);
    }
    const n = findNode(sh.node);
    if (n.kind === "fn") this.block("string-use", at, "the text of a function");
    if (n.tupleLen !== undefined)
      this.block("string-use", at, "the text of a tuple of mixed types");
    if (this.mapKind(n) !== null) {
      return this.strLit(this.mapKind(n) === "map" ? "[object Map]" : "[object Set]");
    }
    const value = t.getProperty("valueOf");
    if (value !== undefined && !this.isLibSymbol(value)) {
      this.block("string-use", at, "an object with its own valueOf");
    }
    const m = t.getProperty("toString");
    if (
      this.mem &&
      n.classes !== undefined &&
      n.classes.size > 0 &&
      (m === undefined || this.isLibSymbol(m))
    ) {
      // A class's own toString, or Error's, which is the runtime's (D50).
      const staticRec = this.classOfType(t);
      const recs = this.classesOf(n).filter(
        (r) => staticRec === null || this.isSubclass(r, staticRec),
      );
      const impls = recs.map((r) => this.resolveMember(r, "toString", "method"));
      if (impls.length > 0 && impls.every((x) => x !== null)) {
        return this.dispatch(
          impls[0]!,
          x,
          sh as Extract<Shape, { s: "obj" }>,
          t,
          () => [],
          at,
          "method",
        );
      }
      if (impls.some((x) => x !== null))
        this.block("string-use", at, "a toString some classes here have and some don't");
    }
    if (m !== undefined && !this.isLibSymbol(m)) {
      const decl = m.declarations?.find(ts.isMethodDeclaration);
      if (decl === undefined) this.block("string-use", at, "a toString that isn't a method");
      return this.callInst(this.methodInst(decl, sh, t), x, [], at);
    }
    return this.strLit("[object Object]");
  }

  toStr(e: ts.Expression): TE {
    return this.toStrTE(this.expr(e), this.typeAt(e), e);
  }

  concat(l: ts.Expression, r: ts.Expression, at: ts.Node): TE {
    return this.rtCall("strConcat", [this.toStr(l), this.toStr(r)], at);
  }

  template(e: ts.TemplateExpression): TE {
    let cur: TE | null = e.head.text !== "" ? this.strLit(e.head.text) : null;
    const add = (x: TE): void => {
      cur = cur === null ? x : this.rtCall("strConcat", [cur, x], e);
    };
    for (const span of e.templateSpans) {
      add(this.toStr(span.expression));
      if (span.literal.text !== "") add(this.strLit(span.literal.text));
    }
    return cur ?? this.strLit("");
  }

  numberOf(e: ts.CallExpression): TE {
    const a = e.arguments[0];
    if (a === undefined) return lit32(0);
    const t = this.typeAt(a);
    if (this.isStringType(t) && this.nonNullable(t)) {
      this.needStr(a, "Number() of a string");
      return this.rtCall("strToNumber", [this.expr(a)], e);
    }
    if (hasFlag(t, ts.TypeFlags.BooleanLike)) {
      return mk(T.i32, { k: "cond", c: this.expr(a), a: lit32(1), b: lit32(0) }, { range: [0, 1] });
    }
    if (hasFlag(t, ts.TypeFlags.Null))
      return mk(T.i32, { k: "seq", items: [this.expr(a)], result: lit32(0) }, { range: [0, 0] });
    if (this.mem && hasFlag(t, ts.TypeFlags.Unknown)) {
      // JS's ToNumber of an `unknown` (D49): a box gives its value, null 0, undefined NaN, and an object NaN, as its
      // valueOf gives itself and its text isn't a number, unless a class that can be here has its own valueOf or toString.
      const x = this.expr(a);
      if (this.isDyn(x.sh)) {
        for (const tn of findNode(this.dynNode).dynTargets ?? [])
          for (const r of this.classesOf(tn))
            for (const name of ["valueOf", "toString"]) {
              const own = this.resolveMember(r, name, "method");
              if (own !== null && own.getSourceFile().fileName !== rtFilePath("exc"))
                this.block(
                  "string-use",
                  e,
                  `Number() of an unknown that can be a ${r.jsName}, with its own ${name}`,
                );
            }
        return this.rtCall("tmkDynNum", [x], e);
      }
    }
    return this.block("string-use", e, "Number() of something with no single conversion");
  }

  stringFn(name: string, e: ts.CallExpression): TE {
    const a = e.arguments;
    this.needStr(e, `${name}() works on strings`);
    if (name === "String") {
      if (a[0] === undefined) return this.strLit("");
      return this.toStr(a[0]);
    }
    const s = a[0] !== undefined ? this.toStr(a[0]) : this.strLit("undefined");
    if (name === "parseFloat") return this.rtCall("strParseFloat", [s], e);
    return this.rtCall("strParseInt", [s, a[1] !== undefined ? this.expr(a[1]) : NULLISH], e);
  }

  stringFromCode(name: string, e: ts.CallExpression): TE {
    this.needStr(e, `String.${name}`);
    const fn = name === "fromCharCode" ? "strFromCode" : "strFromCodePoint";
    const a = e.arguments;
    if (a.length === 1 && ts.isSpreadElement(a[0]!)) {
      const out: Stmt[] = [];
      const seq = this.seqOf(this.expr(a[0].expression), a[0], out);
      const acc = this.newVar({ k: "ref" }, "$acc");
      const sh = this.strShape();
      out.push({ k: "let", v: acc, init: this.strLit(""), constant: false });
      const n = this.temp(seq.len(), out);
      const iv = this.newVar(T.i32, "$i");
      out.push({ k: "let", v: iv, init: lit32(0), constant: false });
      const i = this.readVar(iv, { range: [0, I32_MAX] });
      this.loopDepth++;
      const body: Stmt[] = [];
      const ch = this.rtCall(fn, [seq.at(i, e)], e);
      const next = this.rtCall("strConcat", [this.varTE(acc, sh), ch], e);
      body.push({ k: "expr", e: mk(acc.ty, { k: "setvar", v: acc, val: next }) });
      this.loopDepth--;
      out.push(this.countedLoop(iv, n, body, e));
      return this.withPrelude(out, this.varTE(acc, sh));
    }
    let cur: TE | null = null;
    for (const x of a) {
      const c = this.rtCall(fn, [this.numOperand(this.expr(x), e)], e);
      cur = cur === null ? c : this.rtCall("strConcat", [cur, c], e);
    }
    return cur ?? this.strLit("");
  }

  // --- tuples whose elements have no single representation, which `[K, V]` usually is

  private tupleKinds = new Map<string, boolean>();

  isStructTuple(t: ts.ObjectType, at: ts.Node): boolean {
    const key = `${(t as unknown as { id: number }).id}${this.envKey()}`;
    const hit = this.tupleKinds.get(key);
    if (hit !== undefined) return hit;
    this.tupleKinds.set(key, false);
    const kinds = new Set<string>();
    for (const a of this.checker.getTypeArguments(t as ts.TypeReference)) {
      const s = this.shapeOf(a, at);
      const k = s.s === "opt" ? s.of.s : s.s;
      if (k !== "void") kinds.add(k === "obj" && this.isStr(s) ? "string" : k);
    }
    const mixed = kinds.size > 1;
    this.tupleKinds.set(key, mixed);
    return mixed;
  }

  tupleNode(t: ts.ObjectType, at: ts.Node): HeapNode {
    const key = `tup${(t as unknown as { id: number }).id}${this.envKey()}`;
    const hit = this.nodesByType.get(key);
    if (hit !== undefined) return hit;
    const node = newNode("obj");
    this.nodesByType.set(key, node);
    const args = this.checker.getTypeArguments(t as ts.TypeReference);
    node.tupleLen = args.length;
    args.forEach((a, i) => {
      node.fields.set(String(i), this.shapeOf(a, at));
    });
    return node;
  }

  tupleLiteral(x: ts.ArrayLiteralExpression, sh: Extract<Shape, { s: "obj" }>): TE {
    const n = findNode(sh.node);
    if (n.tupleLen === undefined)
      this.block("unsupported", x, "an array literal with no vector shape");
    const out: Stmt[] = [];
    const self = this.temp(this.allocObj(sh, x), out);
    x.elements.forEach((el, i) => {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) {
        this.block("unsupported", el, "a spread or a hole in a tuple of mixed types");
      }
      const f = n.fields.get(String(i));
      if (f === undefined) this.block("unsupported", el, "a tuple literal longer than its type");
      const te = this.flow(this.expr(el, f), f, el);
      this.markEscape(f);
      out.push({ k: "expr", e: this.fieldStore(self, String(i), n, te, true) });
    });
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: self }, { sh });
  }

  elementReadRt(
    e: ts.ElementAccessExpression,
    baseT: ts.Type,
    trap: boolean,
    whole: ts.Node,
  ): TE | null {
    if (this.isStringType(baseT)) {
      this.needStr(e, "an index into a string");
      const r = this.rtCall(
        "strIndex",
        [this.exprNonNull(e.expression), this.expr(e.argumentExpression)],
        e,
      );
      return trap ? mk(r.ty, { k: "nonnull", val: r, loc: this.loc(whole) }, this.carry(r)) : r;
    }
    const t = this.rtMember(baseT);
    if (!this.checker.isTupleType(t)) return null;
    const self = this.exprNonNull(e.expression);
    const sh = self.sh as Shape | undefined;
    if (sh?.s !== "obj") {
      if (sh?.s === "vec") {
        const out: Stmt[] = [];
        const seq = this.seqOf(self, e, out);
        const i = this.expr(e.argumentExpression);
        const v = trap ? seq.trap(i, e) : seq.opt(i, e);
        let r = v;
        if (trap) {
          const es = seq.elemSh;
          if (es.s === "opt") r = this.nonNullOpt(v, es, whole);
          else if (es.s === "obj" || es.s === "vec" || es.s === "arr") {
            r = mk(v.ty, { k: "nonnull", val: v, loc: this.loc(whole) }, this.carry(v));
          }
        } else if (r.ty.k === "opt") r = this.narrowed(r, r.sh as Shape, whole);
        return this.withPrelude(out, r);
      }
      return null;
    }
    const a = strip(e.argumentExpression);
    if (!ts.isNumericLiteral(a)) {
      this.block("computed-key", e, "a computed index into a tuple of mixed types");
    }
    const r = this.fieldRead(self, a.text, sh.node, e);
    return this.narrowed(r, r.sh as Shape, whole);
  }

  // --- `Map`, `Set` and their iterators

  rtClassShape(name: string, types: ts.Type[], at: ts.Node): Extract<Shape, { s: "obj" }> {
    const decl = this.rtDecl(name) as ts.ClassDeclaration;
    const env = this.rtEnv(decl, types);
    const saved = this.env;
    this.env = env;
    try {
      const dt = this.checker.getTypeAtLocation(decl) as ts.ObjectType;
      return { s: "obj", node: this.objNode(dt, at) };
    } finally {
      this.env = saved;
    }
  }

  mapShape(
    kind: "map" | "set",
    keyT: ts.Type,
    valT: ts.Type,
    at: ts.Node,
  ): Extract<Shape, { s: "obj" }> {
    const k = this.subst(keyT);
    const v = this.subst(valT);
    const ks = this.shapeOf(k, at);
    if (ks.s === "str" || (ks.s === "opt" && ks.of.s === "str")) {
      this.needStr(at, "a string as a key"); // a literal union, until now a small integer
    }
    if (ks.s === "arr") {
      this.block(
        "map-set",
        at,
        "a typed array as a key: a pointer and a length, with no identity of its own",
      );
    }
    if (ks.s === "obj" && findNode(ks.node).kind === "fn") {
      this.block("map-set", at, "a function as a key: a function value has no one identity here");
    }
    if (kind === "map" && this.nullishOf(v).null) {
      this.block(
        "nullish-both",
        at,
        "a Map value that can be null: get gives null or undefined, and neither has its own form",
      );
    }
    const sh = this.rtClassShape("TmkMap", [k, v], at);
    const n = findNode(sh.node);
    if (!this.mapNodes.has(n) && this.mapKind(n) === null) {
      const env = this.rtEnv(this.rtDecl("TmkMap"), [k, v]);
      this.mapNodes.set(n, { kind, env, keyT: k, valT: v });
    }
    return sh;
  }

  mapKind(n0: HeapNode): "map" | "set" | null {
    return this.mapInfoOf(n0)?.kind ?? null;
  }

  mapInfoOf(n0: HeapNode): { kind: "map" | "set"; env: Env; keyT: ts.Type; valT: ts.Type } | null {
    const n = findNode(n0);
    for (const [k, v] of this.mapNodes) if (findNode(k) === n) return v;
    return null;
  }

  mapTypes(t0: ts.Type, kind: "map" | "set"): [ts.Type, ts.Type] {
    const args = this.checker.getTypeArguments(this.rtMember(t0) as ts.TypeReference);
    const k = args[0]!;
    return [k, kind === "map" ? args[1]! : this.checker.getUndefinedType()];
  }

  rtLibShape(t: ts.ObjectType, lib: string, at: ts.Node): Shape | null {
    switch (lib) {
      case "Map":
      case "ReadonlyMap": {
        const [k, v] = this.mapTypes(t, "map");
        return this.mapShape("map", k, v, at);
      }
      case "Set":
      case "ReadonlySet": {
        const [k, v] = this.mapTypes(t, "set");
        return this.mapShape("set", k, v, at);
      }
      case "MapIterator":
      case "SetIterator":
      case "IterableIterator":
        return this.rtClassShape(
          "TmkIter",
          [this.checker.getTypeArguments(t as ts.TypeReference)[0]!],
          at,
        );
      case "IteratorYieldResult":
        return this.resultShape(this.checker.getTypeArguments(t as ts.TypeReference)[0]!, at);
      case "IteratorReturnResult":
        return { s: "void" };
      default:
        return null;
    }
  }

  resultShape(arg: ts.Type, at: ts.Node): Shape {
    return this.rtClassShape("TmkResult", [arg], at);
  }

  unionOfParams(t: ts.UnionType, at: ts.Node): Shape {
    const flat: ts.Type[] = [];
    for (const p0 of t.types) {
      const p = this.subst(p0);
      if (p.isUnion()) flat.push(...p.types);
      else flat.push(p);
    }
    const isNull = flat.some((p) => hasFlag(p, ts.TypeFlags.Null));
    const isUndef = flat.some((p) => hasFlag(p, ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    if (isNull && isUndef) {
      this.block("nullish-both", at, `${this.checker.typeToString(t)} has both null and undefined`);
    }
    const rest = flat.filter(
      (p) => !hasFlag(p, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void),
    );
    const nul: Nul = isNull ? "null" : "undefined";
    const all = (f: ts.TypeFlags): boolean => rest.every((p) => hasFlag(p, f));
    let sh: Shape;
    if (rest.length === 0) return { s: "void" };
    if (all(ts.TypeFlags.BooleanLike)) sh = { s: "bool" };
    else if (all(ts.TypeFlags.NumberLike | ts.TypeFlags.EnumLike)) sh = { s: "num", loc: newLoc() };
    else if (all(ts.TypeFlags.StringLike)) {
      this.needStr(at, "a union of strings");
      sh = this.strShape();
    } else if (rest.length === 1) sh = this.shapeOf(rest[0]!, at);
    else
      this.block("union-mixed", at, `no single representation for ${this.checker.typeToString(t)}`);
    if (!isNull && !isUndef) return sh;
    if (sh.s === "num" || sh.s === "bool") return { s: "opt", of: sh, nul };
    if (sh.s === "arr" || sh.s === "vec" || sh.s === "obj") {
      if (sh.nul !== undefined && sh.nul !== nul) {
        this.block(
          "nullish-both",
          at,
          `${this.checker.typeToString(t)} has both null and undefined`,
        );
      }
      return { ...sh, nul };
    }
    return sh;
  }

  newRtObject(
    sh: Extract<Shape, { s: "obj" }>,
    name: string,
    env: Env,
    e: ts.Node,
    out: Stmt[],
  ): TE {
    const c = this.rtDecl(name) as ts.ClassDeclaration;
    const self = this.temp(this.allocObj(sh, e), out);
    const inst = this.instOf(c, env, new Map(), sh, false, c);
    out.push({ k: "expr", e: this.callInst(inst, self, [], e) });
    return self;
  }

  /**
   * `new Map()` with no type arguments is TS's first overload, Map<any, any>, whatever it's assigned to. The destination's
   * declared type says what it is: a field, a variable, a parameter or a return. With no destination it stays any.
   */
  typeOfNewMapLike(e: ts.NewExpression, name: string): ts.Type {
    const t = this.typeAt(e);
    if (e.typeArguments !== undefined) return t;
    const anyArg = this.checker
      .getTypeArguments(this.rtMember(t) as ts.TypeReference)
      .some((a) => hasFlag(a, ts.TypeFlags.Any));
    if (!anyArg) return t;
    const ctx = this.checker.getContextualType(e);
    if (ctx === undefined) return t;
    const sub = this.subst(ctx);
    const parts = sub.isUnion() ? sub.types : [sub];
    const hit = parts.find((p) => p.getSymbol()?.name === name);
    return hit ?? t;
  }

  newMapLike(name: "Map" | "Set" | string, e: ts.NewExpression): TE {
    const kind = name === "Map" ? "map" : "set";
    const t = this.typeOfNewMapLike(e, name);
    const [k, v] = this.mapTypes(t, kind);
    const sh = this.mapShape(kind, k, v, e);
    const env = this.mapInfoOf(sh.node)!.env;
    const out: Stmt[] = [];
    const self = this.newRtObject(sh, "TmkMap", env, e, out);
    const arg = e.arguments?.[0];
    if (arg !== undefined && this.typeAt(arg).flags !== ts.TypeFlags.Null) {
      const argT = this.typeAt(arg);
      if (!hasFlag(argT, ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
        this.loopItems(arg, out, (item, body) => {
          if (kind === "set") {
            body.push({ k: "expr", e: this.mapOp(self, sh, "add", [item.whole()], e) });
            return;
          }
          const [kt, vt] = item.pair !== null ? item.pair() : this.pairOf(item.whole(), arg, body);
          body.push({ k: "expr", e: this.mapOp(self, sh, "set", [kt, vt], e) });
        });
      }
    }
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: self }, { sh });
  }

  pairOf(whole: TE, at: ts.Node, body: Stmt[]): [TE, TE] {
    const p = this.temp(whole, body);
    const sh = p.sh as Shape | undefined;
    if (sh?.s === "obj") {
      return [this.fieldRead(p, "0", sh.node, at), this.fieldRead(p, "1", sh.node, at)];
    }
    const seq = this.seqOf(p, at, body);
    return [seq.at(lit32(0), at), seq.at(lit32(1), at)];
  }

  /** A method of the class behind `Map` and `Set`, on a receiver that's already evaluated. */
  mapOp(self: TE, sh: Extract<Shape, { s: "obj" }>, name: string, args: TE[], node: ts.Node): TE {
    const c = this.rtDecl("TmkMap") as ts.ClassDeclaration;
    const decl = c.members.find(
      (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText() === name,
    );
    if (decl === undefined) throw new Error(`no method ${name} on the runtime's map`);
    this.rtBlockedCheck(decl, node);
    const env = this.mapInfoOf(sh.node)!.env;
    const inst = this.instOf(decl, env, new Map(), sh, false, decl);
    return this.callInst(inst, self, args, node);
  }

  mapMethod(
    name: string,
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    rt: ts.Type,
    kind: "map" | "set",
  ): TE {
    const [k, v] = this.mapTypes(rt, kind);
    const a = e.arguments;
    const out: Stmt[] = [];
    const self = this.temp(this.exprNonNull(callee.expression), out);
    const sh = self.sh as Extract<Shape, { s: "obj" }>;
    const keyArg = (): TE => (a[0] !== undefined ? this.expr(a[0]) : NULLISH);
    const done = (te: TE): TE => this.withPrelude(out, te);
    const elemK = (x: TE): TE => x;
    switch (name) {
      case "get":
        if (kind !== "map") break;
        return done(
          this.narrowed(
            this.mapOp(self, sh, "get", [elemK(keyArg())], e),
            this.mapGetShape(self, sh, e),
            e,
          ),
        );
      case "has":
      case "delete":
        return done(this.mapOp(self, sh, name, [keyArg()], e));
      case "set":
        if (kind !== "map") break;
        out.push({
          k: "expr",
          e: this.mapOp(
            self,
            sh,
            "set",
            [keyArg(), a[1] !== undefined ? this.expr(a[1]) : NULLISH],
            e,
          ),
        });
        return done(self);
      case "add":
        if (kind !== "set") break;
        out.push({ k: "expr", e: this.mapOp(self, sh, "add", [keyArg()], e) });
        return done(self);
      case "clear":
        return done(this.mapOp(self, sh, "clear", [], e));
      case "keys":
        return done(this.rtCall("keysIter", [self], e, [k, v]));
      case "values":
        return done(this.rtCall(kind === "set" ? "keysIter" : "valsIter", [self], e, [k, v]));
      case "entries":
        return done(
          this.rtCall(kind === "set" ? "setEntriesIter" : "entriesIter", [self], e, [k, v]),
        );
      case "forEach": {
        const f = a[0];
        if (f === undefined) this.block("unsupported", e, "forEach without a callback");
        if (a[1] !== undefined) this.block("unsupported", e, "forEach with a this argument");
        const fnDecl = this.rtDecl(
          kind === "set" ? "setForEach" : "mapForEach",
        ) as ts.FunctionDeclaration;
        const args = this.argsFor(fnDecl, [f], out);
        const r = this.rtCallArgs(fnDecl.name!.text, [{ te: self }, ...args], e, [k, v]);
        return done(r);
      }
      default:
        break;
    }
    return this.block("map-set", e, `the ${kind === "map" ? "Map" : "Set"} method ${name}`);
  }

  private mapGetShape(_self: TE, sh: Extract<Shape, { s: "obj" }>, at: ts.Node): Shape {
    const n = findNode(sh.node);
    const vals = n.fields.get("vals") as Extract<Shape, { s: "vec" }>;
    const es = findNode(vals.node).elem!;
    void at;
    return es.s === "num" || es.s === "bool" ? { s: "opt", of: es, nul: "undefined" } : es;
  }

  methodCallRt(
    name: string,
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    rt: ts.Type,
  ): TE | null {
    if (this.isStringType(rt)) return this.stringMethod(name, e, callee);
    const a = e.arguments;
    if (hasFlag(rt, ts.TypeFlags.NumberLike)) {
      if (name === "toString") {
        this.needStr(e, "a number's text");
        const x = this.numOperand(this.expr(callee.expression), e);
        if (a[0] === undefined) return this.toStrTE(x, rt, e);
        return this.rtCall("numToRadix", [this.toFloat(x), this.expr(a[0])], e);
      }
      if (name === "toFixed") {
        this.needStr(e, "a number's text");
        const x = this.numOperand(this.expr(callee.expression), e);
        return this.rtCall(
          "numToFixed",
          [this.toFloat(x), a[0] !== undefined ? this.expr(a[0]) : lit32(0)],
          e,
        );
      }
      return null;
    }
    if (hasFlag(rt, ts.TypeFlags.BooleanLike) && name === "toString") {
      this.needStr(e, "a boolean's text");
      return this.rtCall("boolStr", [this.expr(callee.expression)], e);
    }
    const kind = this.isMapType(rt);
    if (kind !== null) return this.mapMethod(name, e, callee, rt, kind);
    if (this.isIterType(rt) && name === "next") {
      const T1 = this.checker.getTypeArguments(this.rtMember(rt) as ts.TypeReference)[0]!;
      return this.rtCall("iterNext", [this.exprNonNull(callee.expression)], e, [T1]);
    }
    return null;
  }

  stringMethod(name: string, e: ts.CallExpression, callee: ts.PropertyAccessExpression): TE {
    this.needStr(e, `the string method ${name}`);
    const a = e.arguments;
    const self = (): TE => this.exprNonNull(callee.expression);
    const num0 = (x: ts.Expression | undefined): TE =>
      x !== undefined ? this.numOperand(this.expr(x), x) : lit32(0);
    const optN = (x: ts.Expression | undefined): TE => (x !== undefined ? this.expr(x) : NULLISH);
    const strA = (x: ts.Expression | undefined): TE =>
      x !== undefined ? this.toStr(x) : this.strLit("undefined");
    const optS = (x: ts.Expression | undefined): TE => (x !== undefined ? this.expr(x) : NULLISH);
    switch (name) {
      case "toString":
      case "valueOf":
        return self();
      case "charCodeAt":
        return this.rtCall("strCharCodeAt", [self(), num0(a[0])], e);
      case "charAt":
        return this.rtCall("strCharAt", [self(), num0(a[0])], e);
      case "at":
        return this.rtCall("strAt", [self(), num0(a[0])], e);
      case "codePointAt":
        return this.rtCall("strCodePointAt", [self(), num0(a[0])], e);
      case "slice":
        return this.rtCall("strSlice", [self(), optN(a[0]), optN(a[1])], e);
      case "substring":
        return this.rtCall("strSubstring", [self(), optN(a[0]), optN(a[1])], e);
      case "indexOf":
        return this.rtCall("strIndexOf", [self(), strA(a[0]), optN(a[1])], e);
      case "lastIndexOf":
        return this.rtCall("strLastIndexOf", [self(), strA(a[0]), optN(a[1])], e);
      case "includes":
        return this.rtCall("strIncludes", [self(), strA(a[0]), optN(a[1])], e);
      case "startsWith":
        return this.rtCall("strStartsWith", [self(), strA(a[0]), optN(a[1])], e);
      case "endsWith":
        return this.rtCall("strEndsWith", [self(), strA(a[0]), optN(a[1])], e);
      case "split":
        return this.rtCall("strSplit", [self(), optS(a[0]), optN(a[1])], e);
      case "trim":
        return this.rtCall("strTrim", [self()], e);
      case "trimStart":
        return this.rtCall("strTrimStart", [self()], e);
      case "trimEnd":
        return this.rtCall("strTrimEnd", [self()], e);
      case "repeat":
        return this.rtCall("strRepeat", [self(), num0(a[0])], e);
      case "padStart":
        return this.rtCall("strPadStart", [self(), num0(a[0]), optS(a[1])], e);
      case "padEnd":
        return this.rtCall("strPadEnd", [self(), num0(a[0]), optS(a[1])], e);
      case "replace":
      case "replaceAll": {
        const r = a[1];
        if (r === undefined || !this.isStringType(this.typeAt(r))) {
          this.block("string-use", e, `${name} with a callback`);
        }
        return this.rtCall(
          name === "replace" ? "strReplace" : "strReplaceAll",
          [self(), strA(a[0]), this.expr(r)],
          e,
        );
      }
      case "concat": {
        let cur = self();
        for (const x of a) cur = this.rtCall("strConcat", [cur, this.toStr(x)], e);
        return cur;
      }
      case "toUpperCase":
      case "toLowerCase":
        return this.rtCall(name === "toUpperCase" ? "strUpper" : "strLower", [self()], e);
      case "localeCompare":
      case "normalize":
      case "toLocaleUpperCase":
      case "toLocaleLowerCase":
        return this.block("string-use", e, `${name} needs locale or Unicode normalization data`);
      default:
        return this.block("string-use", e, `the string method ${name}`);
    }
  }

  seqMethodRt(
    name: string,
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    seq: Seq,
  ): TE | null {
    if (seq.sh.s !== "vec") return null;
    const a = e.arguments;
    const t = this.rtMember(this.typeAt(callee.expression));
    const elem = this.checker.getTypeArguments(t as ts.TypeReference)[0];
    if (elem === undefined) return null;
    switch (name) {
      case "join":
      case "toString": {
        this.needStr(e, `the array method ${name}`);
        const sep = name === "join" && a[0] !== undefined ? this.toStr(a[0]) : this.strLit(",");
        return this.rtCall("arrJoin", [seq.te, sep], e, [elem]);
      }
      case "reverse":
        this.markWritten(seq.sh);
        return this.rtCall("arrReverse", [seq.te], e, [elem]);
      case "at":
        return this.rtCall(
          "arrAt",
          [seq.te, this.numOperand(a[0] !== undefined ? this.expr(a[0]) : lit32(0), e)],
          e,
          [elem],
        );
      case "concat": {
        let cur: TE = seq.te;
        for (const x of a) {
          if (!this.isIndexable(this.typeAt(x)))
            this.block("unsupported", x, "concat of something that isn't an array");
          cur = this.rtCall("arrConcat", [cur, this.expr(x)], e, [elem]);
        }
        return a.length > 0 ? cur : this.rtCall("arrConcat", [cur, cur], e, [elem]);
      }
      case "sort": {
        this.markWritten(seq.sh);
        const f = a[0];
        if (f === undefined) {
          const es = findNode(seq.sh.node).elem!;
          if (es.s === "obj" && !this.isStr(es) && findNode(es.node).kind === "fn") {
            this.block("string-use", e, "the default sort of functions");
          }
          this.needStr(e, "the default sort, which compares text");
          return this.rtCall("arrSortDefault", [seq.te], e, [elem]);
        }
        const out: Stmt[] = [];
        const decl = this.rtDecl("arrSort") as ts.FunctionDeclaration;
        const args = this.argsFor(decl, [f], out);
        return this.withPrelude(
          out,
          this.rtCallArgs(
            "arrSort",
            [{ te: seq.te }, { targets: args[0]!.targets!, tag: args[0]!.tag ?? null }],
            e,
            [elem],
          ),
        );
      }
      default:
        return null;
    }
  }

  // --- going over anything iterable, as for...of, spread, Array.from and `new Map(...)` all do

  loopItems(
    node: ts.Expression,
    out: Stmt[],
    f: (item: { whole: () => TE; pair: (() => [TE, TE]) | null }, body: Stmt[]) => void,
  ): void {
    const e0 = strip(node);
    const t = this.typeAt(e0);
    if (ts.isCallExpression(e0) && ts.isPropertyAccessExpression(e0.expression)) {
      const inner = e0.expression;
      const kind = this.isMapType(this.typeAt(inner.expression));
      const nm = inner.name.text;
      if (kind !== null && (nm === "keys" || nm === "values" || nm === "entries")) {
        this.loopMap(
          inner.expression,
          kind,
          kind === "set" && nm === "values" ? "keys" : nm,
          out,
          f,
          node,
        );
        return;
      }
    }
    const kind = this.isMapType(t);
    if (kind !== null) {
      this.loopMap(e0, kind, kind === "map" ? "entries" : "keys", out, f, node);
      return;
    }
    if (this.isStringType(t)) {
      this.needStr(node, "going over a string");
      const s = this.temp(this.expr(e0), out);
      const n = this.temp(this.strLength(s), out);
      const iv = this.newVar(T.i32, "$i");
      const cv = this.newVar(T.i32, "$cp");
      out.push({ k: "let", v: iv, init: lit32(0), constant: false });
      out.push({ k: "let", v: cv, init: lit32(1), constant: false });
      const i = this.readVar(iv, { range: [0, I32_MAX] });
      const cp = this.readVar(cv, { range: [1, 2] });
      this.loopDepth++;
      const body: Stmt[] = [];
      body.push({
        k: "expr",
        e: mk(T.i32, { k: "setvar", v: cv, val: this.rtCall("strCpLen", [s, i], node) }),
      });
      f({ whole: () => this.rtCall("strSub", [s, i, cp], node), pair: null }, body);
      this.loopDepth--;
      const step = mk(T.i32, {
        k: "setvar",
        v: iv,
        val: mk(
          T.i32,
          { k: "arith", op: "add", a: i, b: cp, wrap: true, loc: this.loc(node) },
          { range: [0, I32_MAX] },
        ),
      });
      out.push({ k: "for", init: [], c: this.cmpTE("lt", i, n), step: [step], body });
      return;
    }
    if (this.isIterType(t)) {
      const T1 = this.checker.getTypeArguments(this.rtMember(t) as ts.TypeReference)[0]!;
      const it = this.temp(this.expr(e0), out);
      this.loopDepth++;
      const body: Stmt[] = [];
      f({ whole: () => this.rtCall("iterRead", [it], node, [T1]), pair: null }, body);
      const c = this.rtCall("iterStep", [it], node, [T1]);
      this.loopDepth--;
      out.push({ k: "while", c, body });
      return;
    }
    // An array: live length, as JS's array iterator has it.
    const seq = this.seqOf(this.expr(e0), node, out);
    const iv = this.newVar(T.i32, "$i");
    out.push({ k: "let", v: iv, init: lit32(0), constant: false });
    const i = this.readVar(iv, { range: [0, I32_MAX] });
    this.loopDepth++;
    const body: Stmt[] = [];
    f({ whole: () => seq.at(i, node), pair: null }, body);
    this.loopDepth--;
    const step = mk(T.i32, {
      k: "setvar",
      v: iv,
      val: mk(T.i32, {
        k: "arith",
        op: "add",
        a: i,
        b: lit32(1),
        wrap: false,
        loc: this.loc(node),
      }),
    });
    out.push({ k: "for", init: [], c: this.cmpTE("lt", i, seq.len()), step: [step], body });
  }

  private loopMap(
    src: ts.Expression,
    kind: "map" | "set",
    mode: string,
    out: Stmt[],
    f: (item: { whole: () => TE; pair: (() => [TE, TE]) | null }, body: Stmt[]) => void,
    node: ts.Node,
  ): void {
    const srcT = this.typeAt(src);
    const [k, v] = this.mapTypes(srcT, kind);
    const m = this.temp(this.expr(src), out);
    const c = this.temp(this.rtCall("mapCursor", [m], node, [k, v]), out);
    const key = (): TE => this.rtCall("curKey", [m, c], node, [k, v]);
    const val = (): TE => this.rtCall("curVal", [m, c], node, [k, v]);
    this.loopDepth++;
    const body: Stmt[] = [];
    if (mode === "keys") f({ whole: key, pair: null }, body);
    else if (mode === "values") f({ whole: val, pair: null }, body);
    else {
      const second = kind === "set" ? key : val;
      const secondT = kind === "set" ? k : v;
      f(
        {
          whole: () => this.rtCall("mkPair", [key(), second()], node, [k, secondT]),
          pair: () => [key(), second()],
        },
        body,
      );
    }
    const adv = this.rtCall("mapAdvance", [m, c], node, [k, v]);
    this.loopDepth--;
    out.push({ k: "while", c: adv, body });
  }

  forOfItems(s: ts.ForOfStatement): Stmt[] {
    return this.inBlock(() => {
      const out: Stmt[] = [];
      const list = s.initializer;
      if (!ts.isVariableDeclarationList(list)) {
        this.block("unsupported", s, "for...of without a declaration");
      }
      const d = list.declarations[0]!;
      this.loopItems(s.expression, out, (item, body) => {
        if (ts.isIdentifier(d.name)) {
          const sh = this.slot(this.slotKey(d.name), this.typeAt(d.name), d);
          const v = this.newVar(tyOf(sh), d.name.text);
          body.push({ k: "let", v, init: this.flow(item.whole(), sh, d), constant: false });
          this.bindVar(this.symbolOf(d.name)!, v, sh, d, body);
        } else if (ts.isArrayBindingPattern(d.name) && item.pair !== null) {
          const [a, b] = item.pair();
          const els = d.name.elements;
          const tryBind = (el: ts.ArrayBindingElement | undefined, te: TE): void => {
            if (el === undefined || ts.isOmittedExpression(el)) return;
            if (el.dotDotDotToken !== undefined) this.block("unsupported", el, "a rest element");
            this.bindElement(el, te, body);
          };
          tryBind(els[0], a);
          tryBind(els[1], b);
        } else this.bindPattern(d.name, item.whole(), body);
        body.push(...this.blockOf(s.statement));
      });
      return out;
    });
  }

  arrayFromItems(e: ts.CallExpression, sh: Extract<Shape, { s: "vec" }>, src: ts.Expression): TE {
    const out: Stmt[] = [];
    const fnNode = e.arguments[1];
    const cv = fnNode !== undefined ? this.closureOf(fnNode, out) : null;
    const v = this.temp(this.vecNew(sh, lit32(0), e), out);
    const nv = this.newVar(T.i32, "$n");
    out.push({ k: "let", v: nv, init: lit32(0), constant: false });
    this.loopItems(src, out, (item, body) => {
      let r = item.whole();
      if (cv !== null) {
        const tag = this.holdTag(cv, out);
        const i = this.readVar(nv, { range: [0, I32_MAX] });
        r = this.callTargets(cv.targets, tag, [{ te: r }, { te: i }], fnNode as ts.Node);
      }
      this.vecPush(v, r, sh, e, body);
      body.push({
        k: "expr",
        e: mk(T.i32, {
          k: "setvar",
          v: nv,
          val: mk(T.i32, {
            k: "arith",
            op: "add",
            a: this.readVar(nv, { range: [0, I32_MAX] }),
            b: lit32(1),
            wrap: true,
            loc: this.loc(e),
          }),
        }),
      });
    });
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: v }, { sh });
  }

  // --- what a native caller uses to build a `Map` or a `Set` it passes (SPEC 4.5, D36)

  private mapExportNames = new Map<HeapNode, MapSurface>();

  /** The flow classes an export's parameters or result can reach: what a native caller can be handed or can hand in. */
  private boundaryNodes(): Set<HeapNode> {
    const out = new Set<HeapNode>();
    const visit = (sh: Shape): void => {
      if (sh.s === "opt") {
        visit(sh.of);
        return;
      }
      if (sh.s !== "obj" && sh.s !== "vec" && sh.s !== "arr") return;
      const n = findNode(sh.node);
      if (out.has(n)) return;
      out.add(n);
      if (n.elem !== null) visit(n.elem);
      for (const f of n.fields.values()) visit(f);
    };
    for (const inst of this.insts.values()) {
      if (!inst.exported) continue;
      inst.paramSh.forEach(visit);
      visit(inst.retSh);
    }
    return out;
  }

  /**
   * What a native caller builds a `Map` or a `Set` with, if one can be passed in, and reads one with, if one can cross either
   * way: the map's layout is the runtime's own, and changes as the runtime does (SPEC 4.5, D36, D47).
   */
  mapExportRoots(): void {
    const crossing = this.boundaryNodes();
    for (const [n0, info] of this.mapNodes) {
      const n = findNode(n0);
      if (!n.external && !crossing.has(n)) continue;
      const types = [info.keyT, info.valT];
      const saved = { env: this.env, inst: this.inst };
      this.env = new Map();
      // A caller hands what `make` gives to `put` and to the export: one class, one layout, whatever each thinks it is.
      const self: Shape = { s: "obj", node: n };
      const one = (name: string, selfAt: "ret" | "param"): string => {
        const d = this.rtDecl(name) as ts.FunctionDeclaration;
        const inst = this.instOf(d, this.rtEnv(d, types), new Map(), null, true, d);
        this.unify(selfAt === "ret" ? inst.retSh : inst.paramSh[0]!, self, d);
        return inst.fi.tirName;
      };
      const surface: MapSurface = {
        make: "",
        put: "",
        size: one("mapLen", "param"),
        has: one("mapHas", "param"),
        iter: one("mapIter", "param"),
        step: one("mapStep", "param"),
        key: one("mapKey", "param"),
        val: info.kind === "map" ? one("mapVal", "param") : "",
      };
      if (n.external) {
        surface.make = one("mapNew", "ret");
        surface.put = one(info.kind === "map" ? "mapPut" : "setPut", "param");
      }
      this.mapExportNames.set(n, surface);
      this.env = saved.env;
      this.inst = saved.inst;
    }
  }

  /** With exceptions, what a native caller describes a thrown value with (D36, D49). */
  excRoots(): void {
    if (!this.excOn) return;
    const d = this.rtDecl("tmkExcDescribe") as ts.FunctionDeclaration;
    const saved = { env: this.env, inst: this.inst };
    this.env = new Map();
    const inst = this.instOf(d, new Map(), new Map(), null, false, d);
    if (!inst.run) {
      inst.run = true;
      this.changed = true;
    }
    this.excDescribe = inst;
    const o = this.rtDecl("tmkStackOverflow") as ts.FunctionDeclaration;
    const oi = this.instOf(o, new Map(), new Map(), null, false, o);
    if (!oi.run) {
      oi.run = true;
      this.changed = true;
    }
    this.excOverflow = oi;
    this.env = saved.env;
    this.inst = saved.inst;
  }

  excDescribe: Inst | null = null;
  excOverflow: Inst | null = null;

  mapExportsOf(n: HeapNode, heap: DownMeta["heap"]): ObjDesc["map"] | null {
    const info = this.mapInfoOf(n);
    if (info === null) return null;
    const names = this.mapExportNames.get(findNode(n)) ?? {
      make: "",
      put: "",
      size: "",
      has: "",
      iter: "",
      step: "",
      key: "",
      val: "",
    };
    const elemOf = (field: string): Desc => {
      const f = findNode(n).fields.get(field) as Extract<Shape, { s: "vec" }>;
      return this.descOf(findNode(f.node).elem ?? { s: "void" }, heap);
    };
    return { kind: info.kind, ...names, keyDesc: elemOf("keys"), valDesc: elemOf("vals") };
  }

  // --- what a call to a `declare function` in compiler/rt/intrinsics.ts is

  isRtIntrinsic(sym: ts.Symbol): boolean {
    const d = sym.valueDeclaration;
    return d !== undefined && d.getSourceFile().fileName === rtFilePath("intrinsics");
  }

  private strData(s: TE): TE {
    const off = mk(T.usize, { k: "fload", base: s, mem: [{ t: "ix", off: 8 }] });
    return mk({ k: "ref" }, { k: "elemaddr", base: s, idx: off, scale: 1 });
  }

  private typeArg(e: ts.CallExpression): ts.Type {
    return this.subst(this.checker.getTypeFromTypeNode(e.typeArguments![0]!));
  }

  intrinsicCall(name: string, e: ts.CallExpression): TE {
    const a = e.arguments;
    const loc = this.loc(e);
    const out: Stmt[] = [];
    const done = (te: TE): TE => this.withPrelude(out, te);
    const ix = (x: ts.Expression): TE => this.ixOf(this.expr(x));
    const i32 = (x: ts.Expression): TE => this.coerceNum(this.expr(x), T.i32);
    const litArg = (x: ts.Expression): number => {
      // A named code (`__trap(Trap.Conversion)`, D71) is its literal type.
      const t = this.checker.getTypeAtLocation(x);
      if (t.isNumberLiteral()) return t.value;
      const v = litOf(this.expr(x));
      if (v === null) throw new Error(`the runtime's ${name} needs a constant`);
      return v;
    };
    const sstr = this.strShape();
    // What class printing prints in place of the expansion, as a call on @tsl/jsrt's JsString (D67): the intrinsic and
    // the operands it was given, each of which is in the expansion too. Nothing else reads it, so the TIR is the same.
    const tag = (te: TE, args: TE[], op = name): TE => ({ ...te, strop: { op, args } }) as TE;
    const allocStr = (size: TE, refs: () => { off: number; sh: unknown }[]): TE =>
      mk(
        { k: "ref" },
        {
          k: "alloc",
          size,
          zero: true,
          stack: () => null,
          loc,
          long: () => this.longAlloc(this.strNode),
          rcRefs: refs,
        },
        { sh: sstr },
      );
    const store = (base: TE, t: "i32" | "ix", off: number, val: TE): Stmt => ({
      k: "expr",
      e: mk(t === "i32" ? T.i32 : T.usize, { k: "fstore", base, mem: [{ t, off }], val }),
    });
    switch (name) {
      case "__dyn_class_name":
        return this.dynClassName(this.expr(a[0]!));
      case "__s_len":
        return this.strLength(this.expr(a[0]!));
      case "__s_unit": {
        const s0 = this.expr(a[0]!);
        const s = this.temp(s0, out);
        const i0 = ix(a[1]!);
        const raw = mk(T.u16, { k: "loadelem", ptr: this.strData(s), idx: i0, elem: "u16" });
        return tag(done(this.elemRep(raw, "u16")), [s0, i0]);
      }
      case "__s_alloc": {
        const hdr = litArg(a[0]!);
        const n0 = i32(a[1]!);
        const n = this.temp(n0, out);
        const size = mk(T.usize, {
          k: "arith",
          op: "add",
          a: litIx(hdr),
          b: mk(T.usize, { k: "arith", op: "mul", a: this.ixOf(n), b: litIx(2), wrap: true, loc }),
          wrap: true,
          loc,
        });
        const p = this.temp(
          allocStr(size, () => []),
          out,
        );
        out.push(store(p, "i32", 0, n));
        out.push(store(p, "ix", 8, litIx(hdr)));
        return tag(
          mk({ k: "ref" }, { k: "blockexpr", body: out, result: p }, { sh: sstr }),
          hdr === 16 ? [n0] : [],
          hdr === 16 ? "__s_flat" : name,
        );
      }
      case "__s_put": {
        const s0 = this.expr(a[0]!);
        const s = this.temp(s0, out);
        const i0 = ix(a[1]!);
        const idx = this.temp(i0, out);
        const v0 = this.expr(a[2]!);
        out.push({
          k: "expr",
          e: mk(T.void, {
            k: "storeelem",
            ptr: this.strData(s),
            idx,
            elem: "u16",
            val: this.storeValue(v0, "u16"),
          }),
        });
        return tag(mk(T.void, { k: "blockexpr", body: out, result: VOID }), [s0, i0, v0]);
      }
      case "__s_copy": {
        const x0 = [this.expr(a[0]!), ix(a[1]!), this.expr(a[2]!), ix(a[3]!), ix(a[4]!)] as const;
        const d = this.temp(x0[0], out);
        const di = this.temp(x0[1], out);
        const s = this.temp(x0[2], out);
        const si = this.temp(x0[3], out);
        const n = this.temp(x0[4], out);
        const place = (x: TE, i: TE): TE =>
          mk({ k: "ref" }, { k: "elemaddr", base: this.strData(x), idx: i, scale: 2 });
        const bytes = mk(T.usize, { k: "arith", op: "mul", a: n, b: litIx(2), wrap: true, loc });
        out.push({
          k: "expr",
          e: mk(T.void, {
            k: "intrinsic",
            name: "mem.copy",
            args: [place(d, di), place(s, si), bytes],
          }),
        });
        return tag(mk(T.void, { k: "blockexpr", body: out, result: VOID }), [...x0]);
      }
      case "__s_view": {
        const owner = this.temp(this.expr(a[0]!), out);
        const start = this.temp(i32(a[1]!), out);
        const n = this.temp(i32(a[2]!), out);
        const p = this.temp(
          allocStr(litIx(32), () => [{ off: 16, sh: sstr }]),
          out,
        );
        const data = mk(
          { k: "ref" },
          { k: "elemaddr", base: this.strData(owner), idx: this.ixOf(start), scale: 2 },
        );
        out.push(store(p, "i32", 0, n));
        out.push(
          store(
            p,
            "ix",
            8,
            mk(T.usize, { k: "builtin", name: "tmk.ptrdiff", args: [data, p], loc }),
          ),
        );
        out.push({
          k: "expr",
          e: mk(
            { k: "ref" },
            {
              k: "fstore",
              base: p,
              mem: [{ t: "ptr", off: 16 }],
              val: { ...owner, sh: sstr } as TE,
              rc: this.rcOptions.rtFault === "view-uncounted" ? "move" : "init",
            },
            { sh: sstr },
          ),
        });
        out.push(store(p, "i32", 24, start));
        return mk({ k: "ref" }, { k: "blockexpr", body: out, result: p }, { sh: sstr });
      }
      case "__s_owner":
        return mk(
          { k: "ref" },
          { k: "fload", base: this.expr(a[0]!), mem: [{ t: "ptr", off: 16 }] },
          { sh: sstr },
        );
      case "__s_get": {
        const s0 = this.expr(a[0]!);
        const off = litArg(a[1]!);
        const te = mk(T.i32, { k: "fload", base: s0, mem: [{ t: "i32", off }] });
        // D42's hash word, which strHash reads and JsString keeps as its own (pipe-h): `s.hashWord`.
        return off === 4 ? tag(te, [s0], "__s_hash_get") : te;
      }
      case "__s_set": {
        const s0 = this.expr(a[0]!);
        const off = litArg(a[1]!);
        const v0 = i32(a[2]!);
        const te = mk(T.void, {
          k: "seq",
          items: [mk(T.i32, { k: "fstore", base: s0, mem: [{ t: "i32", off }], val: v0 })],
          result: VOID,
        });
        return off === 4 ? tag(te, [s0, v0], "__s_hash_set") : te;
      }
      case "__s_same":
        return this.cmpTE("eq", this.expr(a[0]!), this.expr(a[1]!));
      case "__s_null":
        return this.cmpTE("eq", this.expr(a[0]!), nullPtr());
      case "__s_char": {
        this.usesCharTable = true;
        const base = mk({ k: "ref" }, { k: "gaddr", name: "__s_chars", off: RC_HDR });
        return mk(
          { k: "ref" },
          { k: "elemaddr", base, idx: ix(a[0]!), scale: STR_CHAR_SIZE },
          { sh: sstr },
        );
      }
      case "__hash_k": {
        this.usesHashKey = true;
        const w = litArg(a[0]!);
        const te = mk(T.i32, {
          k: "fload",
          base: mk({ k: "ref" }, { k: "gaddr", name: "__hash_key" }),
          mem: [{ t: "i32", off: w * 4 }],
        });
        // Class printing with strings prints the key's two words as module state (pipe-h).
        return tag(te, [], `__hash_k${w}`);
      }
      case "__f64_hi":
      case "__f64_lo":
        return mk(T.i32, {
          k: "builtin",
          name: name === "__f64_hi" ? "tmk.f64hi" : "tmk.f64lo",
          args: [this.toFloat(this.expr(a[0]!))],
          loc,
        });
      case "__f64_make":
        return mk(
          T.f64,
          { k: "builtin", name: "tmk.f64make", args: [i32(a[0]!), i32(a[1]!)], loc },
          { range: [-Infinity, Infinity], negz: true },
        );
      case "__fault":
        return litBool(this.rcOptions.rtFault === (strip(a[0]!) as ts.StringLiteral).text);
      case "__trap":
        return mk(NEVER_TY, { k: "trapnow", kind: "convert", code: litArg(a[0]!), loc });
      case "__f64":
        return mk(
          T.f64,
          { k: "seq", items: [], result: this.toFloat(this.expr(a[0]!)) },
          { range: [-Infinity, Infinity] },
        );
      case "__f_floor":
      case "__f_ceil":
      case "__f_trunc": {
        const x = this.toFloat(this.expr(a[0]!));
        const fn =
          name === "__f_floor" ? "Math.floor" : name === "__f_ceil" ? "Math.ceil" : "Math.trunc";
        return mk(
          T.f64,
          { k: "builtin", name: fn, args: [x], loc },
          { range: [-Infinity, Infinity], negz: true },
        );
      }
      case "__v_at": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        return done(seq.at(this.expr(a[1]!), e));
      }
      case "__v_put": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        const es = seq.elemSh;
        this.markWritten(seq.sh);
        const val = this.flow(this.expr(a[2]!, es), es, e);
        const base = this.elemPlace(seq, ix(a[1]!));
        this.markEscape(es);
        out.push({ k: "expr", e: mk(val.ty, { k: "fstore", base, mem: memOf(es, 0), val }) });
        return mk(T.void, { k: "blockexpr", body: out, result: VOID });
      }
      case "__v_clear": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        this.markWritten(seq.sh);
        const i = this.temp(ix(a[1]!), out);
        out.push(this.clearSlot(seq, i, seq.elemSh));
        return mk(T.void, { k: "blockexpr", body: out, result: VOID });
      }
      case "__v_move": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        this.markWritten(seq.sh);
        const from = this.temp(ix(a[1]!), out);
        const to = this.temp(ix(a[2]!), out);
        out.push(this.moveSlot(this.elemPlace(seq, from), this.elemPlace(seq, to), seq.elemSh));
        return mk(T.void, { k: "blockexpr", body: out, result: VOID });
      }
      case "__v_cut": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        this.markWritten(seq.sh);
        const n = this.temp(i32(a[1]!), out);
        const es = seq.elemSh;
        if (es.s === "obj" || es.s === "vec" || es.s === "arr") {
          const iv = this.newVar(T.i32, "$i");
          out.push({ k: "let", v: iv, init: n, constant: false });
          const i = this.readVar(iv, { range: [0, I32_MAX] });
          const nothing = this.nullOf(es);
          const body: Stmt[] = [
            {
              k: "expr",
              e: mk(nothing.ty, {
                k: "fstore",
                base: this.elemPlace(seq, this.ixOf(i)),
                mem: memOf(es, 0),
                val: nothing,
                rc: "move",
              }),
            },
          ];
          out.push(this.countedLoop(iv, this.temp(seq.len(), out), body, e));
        }
        out.push({
          k: "expr",
          e: mk(T.void, {
            k: "fstore",
            base: seq.te,
            mem: [{ t: "ix", off: VEC_LEN }],
            val: this.ixOf(n),
          }),
        });
        return mk(T.void, { k: "blockexpr", body: out, result: VOID });
      }
      case "__v_size": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        if (seq.sh.s !== "vec") this.block("unsupported", e, "__v_size of a typed array");
        this.markWritten(seq.sh);
        const cap = this.temp(this.ixOf(i32(a[1]!)), out);
        const n = this.temp(this.ixOf(i32(a[2]!)), out);
        out.push({
          k: "expr",
          e: mk(T.void, {
            k: "rtcall",
            name: this.vecFn("__vec_reserve", seq.sh.node),
            args: [seq.te, cap, litIx(Math.max(1, sizeOf(seq.elemSh)))],
          }),
        });
        out.push({
          k: "expr",
          e: mk(T.void, { k: "fstore", base: seq.te, mem: [{ t: "ix", off: VEC_LEN }], val: n }),
        });
        return mk(T.void, { k: "blockexpr", body: out, result: VOID });
      }
      case "__v_hole": {
        const seq = this.seqOf(this.expr(a[0]!), e, out);
        const es = seq.elemSh;
        if (es.s === "obj" || es.s === "vec" || es.s === "arr") {
          const t =
            es.s === "arr"
              ? this.ptrOfArr(seq.at(this.expr(a[1]!), e))
              : seq.at(this.expr(a[1]!), e);
          return done(this.cmpTE("eq", t, nullPtr()));
        }
        return done(litBool(false));
      }
      case "__k_hash":
        return this.keyHash(this.expr(a[0]!), e);
      case "__k_same":
        return this.keySame(this.expr(a[0]!), this.expr(a[1]!), e);
      case "__k_norm": {
        const k = this.expr(a[0]!);
        if (isF(k)) {
          return mk(
            T.f64,
            { k: "farith", op: "add", a: k, b: mk(T.f64, { k: "lit", value: 0 }) },
            { range: range(k) },
          );
        }
        return k;
      }
      case "__has_vals":
        return litBool(!hasFlag(this.typeArg(e), ts.TypeFlags.Undefined));
      case "__is_str":
        return litBool(this.isStringType(this.typeArg(e)) && this.nonNullable(this.typeArg(e)));
      case "__to_str":
        return this.toStr(a[0]!);
      case "__join_str":
        return this.toStrTE(this.expr(a[0]!), this.typeAt(a[0]!), e, true);
      case "__hole":
        return NULLISH;
      default:
        throw new Error(`no intrinsic ${name}`);
    }
  }

  keyHash(k: TE, at: ts.Node): TE {
    if (k.ty.k === "nullish" || k.ty.k === "void") {
      return mk(T.i32, { k: "seq", items: [k], result: lit32(0x5bd1e995) });
    }
    if (isNum(k)) {
      if (isF(k) || isU32(k)) return this.rtCall("hashF64", [this.toFloat(k)], at);
      return this.rtCall("hashI32", [k], at);
    }
    if (k.ty.k === "bool") {
      return this.rtCall(
        "hashI32",
        [mk(T.i32, { k: "cond", c: k, a: lit32(1), b: lit32(0) }, { range: [0, 1] })],
        at,
      );
    }
    if (k.ty.k === "opt") {
      const sh = k.sh as Extract<Shape, { s: "opt" }>;
      return this.withTemp(k, (x) =>
        mk(T.i32, {
          k: "cond",
          c: mk(T.bool, { k: "slice", val: x, from: 0, to: 1 }),
          a: this.keyHash(this.optPayload(x, sh), at),
          b: lit32(0x5bd1e995),
        }),
      );
    }
    const sh = k.sh as Shape | undefined;
    if (sh === undefined || sh.s === "arr") {
      this.block(
        "map-set",
        at,
        "a typed array as a key: a pointer and a length, with no identity of its own",
      );
    }
    if (sh.s !== "vec" && sh.s !== "obj") this.block("map-set", at, `a ${sh.s} as a key`);
    if (sh.s === "obj" && findNode(sh.node).kind === "fn") {
      this.block("map-set", at, "a function as a key: a function value has no one identity here");
    }
    if (this.isStr(sh)) {
      return this.withTemp(k, (x) =>
        mk(T.i32, {
          k: "cond",
          c: this.cmpTE("ne", x, nullPtr()),
          a: this.rtCall("strHash", [x], at),
          b: lit32(0x5bd1e995),
        }),
      );
    }
    // An address, inside the table only: iteration is by insertion, and nothing else reads this (SPEC 4.5).
    return this.rtCall(
      "hashI32",
      [mk(T.i32, { k: "builtin", name: "tmk.addrlo", args: [k], loc: this.loc(at) })],
      at,
    );
  }

  keySame(a: TE, b: TE, at: ts.Node): TE {
    if (a.ty.k === "nullish" || a.ty.k === "void")
      return mk(T.bool, { k: "seq", items: [a, b], result: litBool(true) });
    if (isNum(a) && isNum(b)) {
      if (!isF(a) && !isF(b)) return this.compare("eq", a, b, at);
      return this.rtCall("sameF64", [this.toFloat(a), this.toFloat(b)], at);
    }
    if (a.ty.k === "opt" || b.ty.k === "opt") {
      if (a.ty.k !== "opt" || b.ty.k !== "opt")
        this.block("map-set", at, "a key that is nullable in only one place");
      const shA = a.sh as Extract<Shape, { s: "opt" }>;
      const shB = b.sh as Extract<Shape, { s: "opt" }>;
      const body: Stmt[] = [];
      const x = this.temp(a, body);
      const y = this.temp(b, body);
      const tx = mk(T.bool, { k: "slice", val: x, from: 0, to: 1 });
      const ty = mk(T.bool, { k: "slice", val: y, from: 0, to: 1 });
      const both = mk(T.bool, { k: "logic", op: "and", a: tx, b: ty });
      const same = mk(T.bool, {
        k: "cond",
        c: both,
        a: this.keySame(this.optPayload(x, shA), this.optPayload(y, shB), at),
        b: this.cmpTE("eq", tx, ty),
      });
      return mk(T.bool, { k: "blockexpr", body, result: same });
    }
    if (this.isStr(a.sh) && this.isStr(b.sh)) return this.rtCall("strEq", [a, b], at);
    return this.cmpTE("eq", a, b);
  }

  descOf(sh: Shape, heap: DownMeta["heap"]): Desc {
    switch (sh.s) {
      case "num": {
        const t = locTy(sh.loc);
        return {
          k: "num",
          rep: t.k === "float" ? "f64" : t.k === "int" && t.name === "u32" ? "u32" : "i32",
        };
      }
      case "bool":
        return { k: "bool" };
      case "str":
        return { k: "str" };
      case "void":
      case "fn":
        return { k: "void" };
      case "opt":
        return { k: "opt", of: this.descOf(sh.of, heap), nul: sh.nul, off: optValueOff(sh) };
      case "arr": {
        const d: Desc = { k: "arr", elem: sh.elem, written: findNode(sh.node).written };
        if (sh.nul !== undefined) d.nul = sh.nul;
        if (this.mem && findNode(sh.node).long) d.long = true;
        return d;
      }
      case "obj":
      case "vec": {
        const n = findNode(sh.node);
        if (n === findNode(this.strNode)) {
          const d: Desc = { k: "string" };
          if (sh.nul !== undefined) d.nul = sh.nul;
          return d;
        }
        if (n.kind === "fn") {
          // A caller gets a pointer to the environment, and a JS host would get nothing it could call.
          const d: Desc = { k: "fn" };
          if (sh.nul !== undefined) d.nul = sh.nul;
          return d;
        }
        const id = n.id;
        if (heap[id] === undefined) {
          if (sh.s === "vec") {
            const es = n.elem ?? ({ s: "void" } as Shape);
            const entry: VecDesc = {
              k: "vec",
              slot: Math.max(1, sizeOf(es)),
              elem: { k: "void" },
              written: n.written,
              holes: es.s === "obj" || es.s === "vec" || es.s === "arr",
            };
            if (this.mem && n.long) entry.long = true;
            heap[id] = entry;
            entry.elem = this.descOf(es, heap);
          } else {
            const layout = layoutOf(n);
            const entry: ObjDesc = {
              k: "obj",
              size: layout.size,
              written: n.written,
              fields: [],
              variants: n.variants,
            };
            if (this.mem && n.long) entry.long = true;
            heap[id] = entry;
            if (n.tupleLen !== undefined) entry.tuple = n.tupleLen;
            const mapped = this.mapExportsOf(n, heap);
            if (mapped !== null) {
              entry.map = mapped;
              entry.internal = [];
            }
            for (const [name, f] of n.fields) {
              const isRef = f.s === "arr" || f.s === "vec" || f.s === "obj";
              (entry.internal ?? entry.fields).push({
                name,
                off: layout.offs.get(name)!,
                ty: this.descOf(f, heap),
                optional: f.s === "opt" || (isRef && f.nul !== undefined),
              });
            }
          }
        }
        const d: Desc = { k: "ref", id };
        if (sh.nul !== undefined) d.nul = sh.nul;
        return d;
      }
    }
  }

  /** Which classes can reach themselves, and the allocation sites that make them (SPEC 3.5). */
  cycleReport(): { classes: string[]; sites: string[] }[] {
    const siteOf = new Map<HeapNode, AllocSite[]>();
    for (const a of this.allocs) {
      if (a.node === undefined) continue;
      const n = findNode(a.node);
      siteOf.set(n, [...(siteOf.get(n) ?? []), a]);
    }
    return cycleClasses().map((comp) => {
      const sites = comp.flatMap((n) => siteOf.get(n) ?? []);
      const names = comp.map((n) => n.klass ?? siteOf.get(n)?.[0]?.what ?? n.kind).sort();
      return {
        classes: [...new Set(names)],
        sites: [...new Set(sites.map((s) => `${s.loc} (${s.what})`))].sort(),
      };
    });
  }

  // --- classes (SPEC 3.4, 4.5, D50): inheritance, class ids, dispatch and `instanceof`, in a memory mode

  classRecs = new Map<ts.ClassLikeDeclaration, ClassRec>();
  classIdsDirty = true;
  excOn = false; // something can catch: throws are exceptions, not the trap path (D49)
  dynNode!: HeapNode;

  /** The runtime class standing for a library error class (compiler/rt/exc.ts), or null. */
  errorRtName(name: string): string | null {
    return ERROR_RT[name] ?? null;
  }

  /** The class a heritage clause names: a class declaration, or the runtime's for `Error` and kin. */
  baseDeclOf(c: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | null {
    const h = c.heritageClauses?.find((x) => x.token === ts.SyntaxKind.ExtendsKeyword);
    if (h === undefined) return null;
    const ex = h.types[0]!.expression;
    if (!ts.isIdentifier(ex)) {
      this.block(
        "inheritance",
        ex,
        "extends of an expression, which a mixin or a call makes at run time",
      );
    }
    const sym = this.symbolOf(ex);
    if (sym === undefined) this.block("inheritance", ex, "an unresolved base class");
    if (this.isLibSymbol(sym)) {
      const rt = this.errorRtName(sym.name);
      if (rt === null) this.block("inheritance", ex, `extends the library's ${sym.name}`);
      return this.rtDecl(rt) as ts.ClassDeclaration;
    }
    const d = sym.declarations?.find(ts.isClassLike);
    if (d === undefined) this.block("inheritance", ex, `extends ${sym.name}, which isn't a class`);
    return d;
  }

  classRec(c: ts.ClassLikeDeclaration): ClassRec {
    const hit = this.classRecs.get(c);
    if (hit !== undefined) return hit;
    const baseDecl = this.baseDeclOf(c);
    const base = baseDecl !== null ? this.classRec(baseDecl) : null;
    const fromRt = c.getSourceFile().fileName.includes("/compiler/rt/");
    const own = c.name?.text ?? "";
    const rec: ClassRec = {
      decl: c,
      jsName: fromRt ? (RT_ERROR_JS[own] ?? own) : own,
      base,
      subs: [],
      id: 0,
      last: 0,
      key: `${repoRelative(c.getSourceFile().fileName)}:${c.pos}`,
    };
    this.classRecs.set(c, rec);
    if (base !== null) base.subs.push(rec);
    this.classIdsDirty = true;
    this.changed = true;
    return rec;
  }

  /** Ids in preorder over the forest of classes, so a class and its subclasses are one range (D50). 0 is no class. */
  classIds(): void {
    if (!this.classIdsDirty) return;
    this.classIdsDirty = false;
    const order = (a: ClassRec, b: ClassRec): number => cmpKey(a.key, b.key);
    let next = 1;
    const visit = (r: ClassRec): void => {
      r.id = next++;
      for (const s of [...r.subs].sort(order)) visit(s);
      r.last = next - 1;
    };
    for (const r of [...this.classRecs.values()].filter((x) => x.base === null).sort(order))
      visit(r);
  }

  idOf(r: ClassRec): number {
    this.classIds();
    return r.id;
  }

  isSubclass(r: ClassRec, of: ClassRec): boolean {
    for (let c: ClassRec | null = r; c !== null; c = c.base) if (c === of) return true;
    return false;
  }

  inHierarchy(r: ClassRec): boolean {
    return r.base !== null || r.subs.length > 0;
  }

  /** The class a type is an instance of, if it's a class. */
  classOfType(t0: ts.Type): ClassRec | null {
    const t = this.checker.getNonNullableType(this.subst(t0));
    const sym = t.getSymbol();
    if (sym === undefined) return null;
    if (this.isLibSymbol(sym)) {
      const rt = this.errorRtName(sym.name);
      return rt !== null ? this.classRec(this.rtDecl(rt) as ts.ClassDeclaration) : null;
    }
    const d = sym.declarations?.find(ts.isClassLike);
    return d !== undefined ? this.classRec(d) : null;
  }

  /** This flow class carries a class id in its first word. */
  markCls(n0: HeapNode): void {
    const n = findNode(n0);
    if (n.cls === true) return;
    if (!this.mem) this.block("inheritance", this.rootSf, "a class id needs a memory mode");
    n.cls = true;
    const loc = newLoc();
    joinLoc(loc, { float: false, lo: 0, hi: 1 << 20, negz: false });
    n.fields.set("$cls", { s: "num", loc });
    this.changed = true;
  }

  addClass(n0: HeapNode, r: ClassRec): void {
    const n = findNode(n0);
    n.classes ??= new Set();
    if (n.classes.has(r)) return;
    n.classes.add(r);
    this.changed = true;
  }

  classesOf(n0: HeapNode): ClassRec[] {
    const n = findNode(n0);
    return [...((n.classes ?? new Set()) as Set<ClassRec>)].sort((a, b) => cmpKey(a.key, b.key));
  }

  clsRead(obj: TE): TE {
    const o = obj.sh as Shape | undefined;
    // A class id is stored once, by `new`, before anything else has the object, and never again; in `leak` and `manual` no
    // object is ever freed, so no object's word 0 is anyone else's while it can be read. Its load is invariant (D73).
    // `rc` frees and reuses, and keeps its loads plain.
    const inv = this.memory === "leak" || this.memory === "manual" ? { inv: true as const } : {};
    return mk(
      T.i32,
      { k: "fload", base: obj, mem: [{ t: "i32", off: 0, ...inv }] },
      {
        range: [0, 1 << 20],
        ...(o !== undefined && o.s === "obj" ? { fld: { node: o.node, name: "$cls" } } : {}),
      },
    );
  }

  /** Whether a class id is in one of these ranges. */
  idIn(id: TE, ranges: [number, number][]): TE {
    let out: TE | null = null;
    for (const [lo, hi] of ranges) {
      const one =
        lo === hi
          ? this.cmpTE("eq", id, lit32(lo))
          : mk(T.bool, {
              k: "logic",
              op: "and",
              a: this.cmpTE("ge", id, lit32(lo)),
              b: this.cmpTE("le", id, lit32(hi)),
            });
      out = out === null ? one : mk(T.bool, { k: "logic", op: "or", a: out, b: one });
    }
    return out ?? litBool(false);
  }

  /** The member a class finds for a name, walking up: a method, or a getter. Abstract ones have no body. */
  resolveMember(r: ClassRec, name: string, kind: "method" | "get"): FnLike | null {
    for (let c: ClassRec | null = r; c !== null; c = c.base) {
      for (const m of c.decl.members) {
        if (m.name === undefined || m.name.getText() !== name) continue;
        if (kind === "method" && ts.isMethodDeclaration(m) && m.body !== undefined) return m;
        if (kind === "get" && ts.isGetAccessor(m) && m.body !== undefined) return m;
        if (ts.isPropertyDeclaration(m)) return null; // a field shadows a method: not lowered
      }
    }
    return null;
  }

  /**
   * A method or getter on a receiver: the one implementation the receiver's classes can reach, called directly, or a switch on
   * the class id with a direct call in each arm (D50). Each arm's callee keeps its own parameter representation.
   */
  dispatch(
    decl: FnLike,
    self: TE,
    sh: Extract<Shape, { s: "obj" }>,
    recvT: ts.Type,
    argsOf: () => TE[],
    node: ts.Node,
    kind: "method" | "get",
  ): TE {
    const direct = (impl: FnLike): TE => {
      const inst = this.methodInst(impl, sh, recvT);
      return this.callInst(inst, self, argsOf(), node);
    };
    const n = findNode(sh.node);
    const name = decl.name?.getText() ?? "";
    const declared = ts.isClassLike(decl.parent) ? decl.parent : null;
    if (!this.mem || declared === null || n.classes === undefined || n.classes.size === 0) {
      // No instance reaches here yet, or none ever does: an abstract method has nothing to call.
      if ((decl as ts.MethodDeclaration).body === undefined) {
        argsOf();
        return mk(NEVER_TY, { k: "trapnow", kind: "class", code: 10, loc: this.loc(node) });
      }
      return direct(decl);
    }
    const staticRec = this.classOfType(recvT);
    const cands = this.classesOf(n).filter(
      (r) => staticRec === null || this.isSubclass(r, staticRec),
    );
    const groups = new Map<FnLike, ClassRec[]>();
    for (const r of cands) {
      const impl = this.resolveMember(r, name, kind);
      if (impl === null) continue;
      const g = groups.get(impl) ?? [];
      g.push(r);
      groups.set(impl, g);
    }
    if (groups.size <= 1) {
      const impl = [...groups.keys()][0] ?? decl;
      if ((impl as ts.MethodDeclaration).body === undefined)
        return mk(NEVER_TY, { k: "trapnow", kind: "class", code: 10, loc: this.loc(node) });
      return direct(impl);
    }
    this.markCls(n);
    const out: Stmt[] = [];
    const recv = this.temp(self, out);
    const held = argsOf().map((a) => this.temp(a, out));
    const ct = this.typeAt(node);
    const rsh = hasFlag(ct, ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)
      ? ({ s: "void" } as Shape)
      : this.slot(`${this.slotKey(node)}#virt`, this.subst(ct), node);
    const rv = rsh.s === "void" ? null : this.newVar(tyOf(rsh), "$r");
    if (rv !== null) out.push({ k: "let", v: rv, init: null, constant: false });
    const clauses: { keys: TE[]; isDefault: boolean; body: Stmt[] }[] = [];
    const impls = [...groups.keys()];
    for (const [impl0, recs] of groups) {
      // A test build's wrong slot: each class gets its neighbour's implementation.
      const impl =
        this.classFault === "wrong-slot"
          ? impls[(impls.indexOf(impl0) + 1) % impls.length]!
          : impl0;
      const r = this.callInst(this.methodInst(impl, sh, recvT), recv, held, node);
      const body: Stmt[] = [];
      if (rv !== null && r.ty.k !== "never")
        body.push({
          k: "expr",
          e: mk(rv.ty, { k: "setvar", v: rv, val: this.flow(r, rsh, node) }),
        });
      else body.push({ k: "expr", e: r });
      body.push({ k: "break", label: null });
      clauses.push({ keys: recs.map((x) => lit32(this.idOf(x))), isDefault: false, body });
    }
    clauses.push({
      keys: [],
      isDefault: true,
      body: [
        {
          k: "expr",
          e: mk(NEVER_TY, { k: "trapnow", kind: "class", code: 10, loc: this.loc(node) }),
        },
      ],
    });
    out.push({ k: "switch", val: this.clsRead(recv), clauses });
    return mk(
      rv !== null ? rv.ty : T.void,
      { k: "blockexpr", body: out, result: rv !== null ? this.varTE(rv, rsh) : VOID },
      rv !== null ? this.carry(this.varTE(rv, rsh)) : undefined,
    );
  }

  /** `super.m(args)`: the base's implementation, called directly on `this`. */
  superMethodCall(e: ts.CallExpression, callee: ts.PropertyAccessExpression): TE {
    if (!this.mem || this.thisVar === null)
      this.block("inheritance", e, "super.method() outside a lowered method");
    const sym = this.checker.getSymbolAtLocation(callee.name);
    const decl = sym?.declarations?.find(
      (d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d) && d.body !== undefined,
    );
    const name = callee.name.text;
    if (decl === undefined) {
      if (name === "toString" && e.arguments.length === 0) {
        // Object.prototype.toString, or Error's, which is the runtime's.
        const sh = this.thisVar.sh as Extract<Shape, { s: "obj" }>;
        const errRec = this.classRec(this.rtDecl("TmkError") as ts.ClassDeclaration);
        const own = this.enclosingClass(e);
        const base = own !== null ? this.classRec(own).base : null;
        if (base !== null && this.isSubclass(base, errRec)) {
          const m = this.resolveMember(base, "toString", "method")!;
          return this.callInst(
            this.methodInst(m, sh, this.typeAt(callee.expression)),
            this.varTE(this.thisVar.v, sh),
            [],
            e,
          );
        }
        return this.strLit("[object Object]");
      }
      this.block("inheritance", e, `super.${name}, which isn't a method with a body`);
    }
    const sh = this.thisVar.sh as Extract<Shape, { s: "obj" }>;
    const inst = this.methodInst(decl, sh, this.typeAt(callee.expression));
    return this.callInst(
      inst,
      this.varTE(this.thisVar.v, sh),
      e.arguments.map((x) => this.expr(x)),
      e,
    );
  }

  enclosingClass(n: ts.Node): ts.ClassLikeDeclaration | null {
    for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent)
      if (ts.isClassLike(p)) return p;
    return null;
  }

  /** `super(args)` in a derived constructor: the base's constructor on `this`, then this class's fields (as JS orders them). */
  superCall(c: ts.ClassLikeDeclaration, args: TE[], at: ts.Node): TE {
    const rec = this.classRec(c);
    if (rec.base === null || this.thisVar === null)
      this.block("inheritance", at, "super() with no base class");
    const bd = rec.base.decl;
    if (c.typeParameters !== undefined || bd.typeParameters !== undefined)
      this.block("inheritance", at, "a generic class in a hierarchy");
    const bctor = bd.members.find(ts.isConstructorDeclaration);
    const owner: ts.Node = bctor ?? bd;
    if (this.fallback.has(owner)) {
      this.block(
        "callee",
        at,
        `${bd.name?.text ?? "the base"}'s constructor stayed JS`,
        this.fallbackRoot(owner),
      );
    }
    const thisTE = this.varTE(this.thisVar.v, this.thisVar.sh);
    const inst = this.instOf(bctor ?? bd, new Map(), new Map(), this.thisVar.sh, false, owner);
    const body: Stmt[] = [{ k: "expr", e: this.callInst(inst, thisTE, args, at) }];
    // A test build's wrong order: this class's fields before the base's constructor.
    if (this.classFault === "init-order") {
      const fields: Stmt[] = [];
      this.classCtorBody(c, fields, this.inst);
      body.unshift(...fields);
    } else this.classCtorBody(c, body, this.inst);
    return mk(T.void, { k: "blockexpr", body, result: VOID });
  }

  /** `new C(args)` for a class: the object, its class id where its flow class has one, then the constructor. */
  newOfClass(c: ts.ClassLikeDeclaration, t: ts.Type, argsOf: () => TE[], e: ts.Node): TE {
    const env = this.classEnv(t, c);
    const saved = this.env;
    this.env = env;
    const sh = this.objectShape(t as ts.ObjectType, e);
    this.env = saved;
    if (sh.s !== "obj") this.block("unsupported", e, "new of something that isn't an object");
    const ctor = c.members.find(ts.isConstructorDeclaration);
    const owner: ts.Node = ctor ?? c;
    if (this.fallback.has(owner)) {
      this.block(
        "callee",
        e,
        `${c.name?.text ?? "class"}'s constructor stayed JS, and objects don't cross a shim`,
        this.fallbackRoot(owner),
      );
    }
    if (c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true)
      this.block("inheritance", e, "new of an abstract class");
    if (this.mem) this.checkEarlyReads(c, e);
    const out: Stmt[] = [];
    const self = this.temp(this.allocObj(sh, e), out);
    if (this.mem) {
      const rec = this.classRec(c);
      this.addClass(sh.node, rec);
      if (this.inHierarchy(rec)) this.markCls(sh.node);
      if (findNode(sh.node).cls === true) {
        out.push({
          k: "expr",
          e: this.fieldStore(self, "$cls", sh.node, lit32(this.idOf(rec)), true),
        });
      }
    }
    const args = argsOf();
    const inst = this.instOf(ctor ?? c, env, new Map(), sh, false, owner);
    out.push({ k: "expr", e: this.callInst(inst, self, args, e) });
    return mk({ k: "ref" }, { k: "blockexpr", body: out, result: self }, { sh });
  }

  /** A runtime class made in place, such as a box or an error the compiler raises. */
  newRt(name: string, args: TE[], at: ts.Node): TE {
    const d = this.rtDecl(name) as ts.ClassDeclaration;
    return this.newOfClass(d, this.checker.getTypeAtLocation(d), () => args, at);
  }

  /**
   * A base constructor that reaches an override reading a field a subclass hasn't set yet: JS reads `undefined` there. A
   * field whose type allows it is zero, which is its `undefined`; one whose type doesn't can't say it, so this is a fallback
   * (D50), not a silent 0.
   */
  checkEarlyReads(c: ts.ClassLikeDeclaration, at: ts.Node): void {
    const rec = this.classRec(c);
    if (rec.base === null) return;
    const prior = this.earlyChecked.get(c);
    if (prior === null) return;
    if (prior !== undefined) this.block(prior.blocker, at, prior.detail);
    try {
      this.earlyReads(c, rec, at);
      this.earlyChecked.set(c, null);
    } catch (e) {
      if (e instanceof Blocked) this.earlyChecked.set(c, e);
      throw e;
    }
  }

  earlyReads(_c: ts.ClassLikeDeclaration, rec: ClassRec, at: ts.Node): void {
    for (let a: ClassRec | null = rec.base; a !== null; a = a.base) {
      const anc = a;
      const seen = new Set<ts.Node>();
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const name = n.name.text;
          const isCall = ts.isCallExpression(n.parent) && n.parent.expression === n;
          const impl = this.resolveMember(rec, name, isCall ? "method" : "get");
          if (impl !== null && impl.body !== undefined && !seen.has(impl)) {
            seen.add(impl);
            visit(impl.body);
          }
          // A plain `this.f = v` only writes: JS stores it, and the subclass's initialiser then overwrites it, as here.
          // `+=`, `++` and the like read first.
          const onlyWrites =
            ts.isBinaryExpression(n.parent) &&
            n.parent.left === n &&
            n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
          if (!isCall && impl === null && !onlyWrites) {
            const p = this.checker.getSymbolAtLocation(n.name);
            const d = p?.valueDeclaration;
            const owner = d !== undefined ? this.enclosingClass(d) : null;
            if (
              d !== undefined &&
              owner !== null &&
              (ts.isPropertyDeclaration(d) || ts.isParameter(d))
            ) {
              const orec = this.classRec(owner);
              const later =
                orec !== anc && this.isSubclass(orec, anc) && this.isSubclass(rec, orec);
              const t = this.checker.getTypeAtLocation(d);
              const undef = (t.isUnion() ? t.types : [t]).some((x) =>
                hasFlag(x, ts.TypeFlags.Undefined | ts.TypeFlags.Unknown | ts.TypeFlags.Any),
              );
              if (later && !undef) {
                this.block(
                  "field-before-init",
                  at,
                  `${anc.jsName}'s constructor reaches ${name}, which ${orec.jsName} hasn't set yet: JS reads undefined, and its type ${this.checker.typeToString(t)} can't hold it`,
                );
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      for (const m of anc.decl.members) {
        if (ts.isConstructorDeclaration(m) && m.body !== undefined) visit(m.body);
        if (ts.isPropertyDeclaration(m) && m.initializer !== undefined) visit(m.initializer);
      }
    }
  }

  earlyChecked = new Map<ts.Node, Blocked | null>();

  /**
   * A field's key in its flow class. A field the root of a hierarchy declares is its name; one a subclass adds is its name
   * and the class that first declares it, so siblings' fields of one name, which can differ in kind, don't share a slot (D50).
   */
  fieldKeyOfDecl(name: string, cls: ts.ClassLikeDeclaration | null): string {
    if (!this.mem || cls === null) return name;
    const declares = (c: ts.ClassLikeDeclaration): boolean =>
      c.members.some(
        (m) =>
          (ts.isPropertyDeclaration(m) && m.name.getText() === name) ||
          (ts.isConstructorDeclaration(m) &&
            m.parameters.some(
              (p) => ts.isParameterPropertyDeclaration(p, m) && p.name.getText() === name,
            )),
      );
    let top: ClassRec = this.classRec(cls);
    for (let c: ClassRec | null = top.base; c !== null; c = c.base) if (declares(c.decl)) top = c;
    if (top.base === null) return name;
    return `${name}@${top.jsName}:${top.decl.pos}`;
  }

  /** The key a read or write of `name` uses in this flow class: by the declaration the checker names, where siblings differ. */
  fkey(n0: HeapNode, name: string, at?: ts.Node): string {
    const n = findNode(n0);
    if (!this.mem || n.fields.has(name)) return name;
    const cands = [...n.fields.keys()].filter((k) => k.startsWith(`${name}@`));
    if (cands.length === 1) return cands[0]!;
    if (cands.length > 1 && at !== undefined) {
      const nm = ts.isPropertyAccessExpression(at) ? at.name : at;
      const d = this.checker.getSymbolAtLocation(nm)?.valueDeclaration;
      if (d !== undefined) return this.fieldKeyOfDecl(name, this.enclosingClass(d));
    }
    return name;
  }

  // --- static members (D50): a field is module state, set where the class is declared; a method is a plain function

  staticEntries = new Map<ts.Symbol, GlobalEntry>();

  /** The static member a property access names, if it's one: `C.x` or `C.m` on a class name. */
  staticMember(
    base: ts.Expression,
    name: string,
  ): {
    sym: ts.Symbol;
    decl: ts.ClassElement;
    cls: ts.ClassLikeDeclaration;
    via: ts.ClassLikeDeclaration;
  } | null {
    if (!this.mem || !ts.isIdentifier(base)) return null;
    const bs = this.symbolOf(base);
    if (bs === undefined || this.scope.get(bs) !== undefined) return null;
    const via = bs.declarations?.find(ts.isClassLike);
    if (via === undefined) return null;
    const t = this.checker.getTypeOfSymbolAtLocation(bs, base);
    const p = t.getProperty(name);
    const decl = p?.valueDeclaration;
    if (
      p === undefined ||
      decl === undefined ||
      !ts.isClassElement(decl) ||
      !ts.isClassLike(decl.parent)
    )
      return null;
    if (
      !(
        ts.canHaveModifiers(decl) &&
        ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true
      )
    )
      return null;
    return { sym: p, decl, cls: decl.parent, via };
  }

  staticEntry(sym: ts.Symbol, d: ts.PropertyDeclaration): GlobalEntry {
    const hit = this.staticEntries.get(sym);
    if (hit !== undefined) return hit;
    const cname = (d.parent as ts.ClassLikeDeclaration).name?.text ?? "class";
    const name = `g.${this.uniqueName(`${cname}.${sym.name}`)}`;
    const saved = { frame: this.frame, env: this.env };
    this.frame = { path: "init", retSh: null, retLabel: null, retVar: null, stack: [] };
    this.env = new Map();
    const sh = this.slot(`global:${name}`, this.checker.getTypeAtLocation(d.name), d);
    this.frame = saved.frame;
    this.env = saved.env;
    const entry: GlobalEntry = { name, sh, dynamicBlocked: false, isConst: false };
    this.staticEntries.set(sym, entry);
    this.globals.set(sym, entry);
    return entry;
  }

  /** A class's static fields, in order, where module init reaches its declaration. */
  initStatics(c: ts.ClassDeclaration): Stmt[] {
    if (!this.mem) return [];
    const out: Stmt[] = [];
    for (const m of c.members) {
      if (
        !(
          ts.canHaveModifiers(m) &&
          ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) === true
        )
      )
        continue;
      if (!ts.isPropertyDeclaration(m)) continue;
      const sym = this.symbolOf(m.name);
      if (sym === undefined) continue;
      const entry = this.staticEntry(sym, m);
      this.markGlobal(entry.sh);
      if (m.initializer === undefined) {
        if (entry.sh.s === "num")
          this.block(
            "unsupported",
            m,
            "a static field with no initialiser, which JS starts as undefined",
          );
        continue;
      }
      if (m.initializer.kind === ts.SyntaxKind.ThisKeyword || this.mentionsThis(m.initializer))
        this.block("unsupported", m, "a static initialiser that uses this");
      const te = this.flow(this.expr(m.initializer, entry.sh), entry.sh, m.initializer);
      out.push({ k: "expr", e: this.globalStore(entry.name, entry.sh, te) });
    }
    return out;
  }

  mentionsThis(n: ts.Node): boolean {
    return (
      n.kind === ts.SyntaxKind.ThisKeyword ||
      ts.forEachChild(n, (c) => this.mentionsThis(c)) === true
    );
  }

  staticRead(m: { sym: ts.Symbol; decl: ts.ClassElement }, whole: ts.Node): TE {
    if (!ts.isPropertyDeclaration(m.decl))
      this.block("unsupported", whole, "a static method or accessor used as a value");
    const entry = this.staticEntry(m.sym, m.decl);
    this.markGlobal(entry.sh);
    return this.memRead(
      mk({ k: "ref" }, { k: "gaddr", name: entry.name }),
      entry.sh,
      whole,
      entry.name,
    );
  }

  staticPlace(
    m: {
      sym: ts.Symbol;
      decl: ts.ClassElement;
      cls: ts.ClassLikeDeclaration;
      via: ts.ClassLikeDeclaration;
    },
    whole: ts.Node,
  ): LV {
    if (!ts.isPropertyDeclaration(m.decl))
      this.block("unsupported", whole, "an assignment to a static method");
    // Through a subclass, JS makes the subclass its own property and leaves the base's: two values, where this has one.
    if (m.via !== m.cls)
      this.block(
        "inheritance",
        whole,
        "a write to an inherited static through a subclass, which JS gives the subclass its own copy of",
      );
    const entry = this.staticEntry(m.sym, m.decl);
    return {
      sh: entry.sh,
      read: () => this.staticRead(m, whole),
      write: (val, at) => {
        const te = this.flow(val, entry.sh, at);
        this.markGlobal(entry.sh);
        return this.globalStore(entry.name, entry.sh, te);
      },
    };
  }

  staticCall(m: { decl: ts.ClassElement }, e: ts.CallExpression): TE {
    const d = m.decl;
    if (!ts.isMethodDeclaration(d) || d.body === undefined)
      this.block("unsupported", e, "a call to a static member that isn't a method");
    if (this.mentionsThis(d.body))
      this.block(
        "inheritance",
        d,
        "this in a static method, which is whichever class it was called through",
      );
    if (d.typeParameters !== undefined) this.block("unsupported", e, "a generic static method");
    return this.callFunction(d as unknown as FnLike, e);
  }

  // --- `unknown` (D49): a pointer to a class instance or a box, null for undefined

  isDyn(sh: unknown): boolean {
    const s = sh as Shape | undefined;
    return s !== undefined && s.s === "obj" && findNode(s.node).dyn === true;
  }

  dynShape(): Extract<Shape, { s: "obj" }> {
    return { s: "obj", node: this.dynNode };
  }

  noteDynTarget(n0: HeapNode): void {
    const n = findNode(n0);
    const d = findNode(this.dynNode);
    d.dynTargets ??= [];
    if (d.dynTargets.some((x) => findNode(x) === n)) return;
    d.dynTargets.push(n);
    this.changed = true;
  }

  boxNull(at: ts.Node): TE {
    return this.asDyn(this.newRt("TmkBoxNull", [], at), at);
  }

  /** A class instance's pointer as an `unknown`: the same pointer, with a class id. */
  asDyn(te: TE, _at: ts.Node): TE {
    const sh = te.sh as Extract<Shape, { s: "obj" }>;
    this.markCls(sh.node);
    this.markLong(sh);
    this.noteDynTarget(sh.node);
    return { ...te, sh: this.dynShape() } as TE;
  }

  /** Any value into an `unknown`. */
  toDyn(te: TE, at: ts.Node): TE {
    if (te.ty.k === "never") return te;
    if (this.isDyn(te.sh)) return te;
    if (te.ty.k === "nullish") {
      if (te.isNull === true)
        return mk(
          { k: "ref" },
          { k: "seq", items: [te], result: this.boxNull(at) },
          { sh: this.dynShape() },
        );
      return mk(
        { k: "ref" },
        { k: "seq", items: [te], result: nullPtr() },
        { sh: this.dynShape() },
      );
    }
    if (te.ty.k === "void")
      return mk(
        { k: "ref" },
        { k: "seq", items: [te], result: nullPtr() },
        { sh: this.dynShape() },
      );
    if (isNum(te)) return this.asDyn(this.newRt("TmkBoxNum", [te], at), at);
    if (te.ty.k === "bool") return this.asDyn(this.newRt("TmkBoxBool", [te], at), at);
    if (te.ty.k === "lits") {
      this.needStr(at, "a string as unknown");
    }
    const sh = te.sh as Shape | undefined;
    if (te.ty.k === "opt" && sh?.s === "opt") {
      return this.withTemp(te, (x) =>
        mk(
          { k: "ref" },
          {
            k: "cond",
            c: mk(T.bool, { k: "slice", val: x, from: 0, to: 1 }),
            a: this.toDyn(this.optPayload(x, sh), at),
            b: sh.nul === "null" ? this.boxNull(at) : nullPtr(),
          },
          { sh: this.dynShape() },
        ),
      );
    }
    if (sh === undefined || sh.s !== "obj") {
      this.block("any-type", at, `a ${sh?.s ?? te.ty.k} as unknown`);
    }
    const n = findNode(sh.node);
    if (n.kind === "fn") this.block("any-type", at, "a function as unknown");
    if (n.tupleLen !== undefined || this.mapKind(n) !== null)
      this.block("any-type", at, "a tuple, Map or Set as unknown");
    const present = (x: TE): TE =>
      this.isStr(sh)
        ? this.asDyn(
            this.newRt("TmkBoxStr", [{ ...x, sh: { ...sh, nul: undefined } } as TE], at),
            at,
          )
        : this.asDyn(x, at);
    if (sh.nul === undefined) return present(te);
    return this.withTemp(te, (x) =>
      mk(
        { k: "ref" },
        {
          k: "cond",
          c: this.cmpTE("ne", x, nullPtr()),
          a: present(x),
          b: sh.nul === "null" ? this.boxNull(at) : nullPtr(),
        },
        { sh: this.dynShape() },
      ),
    );
  }

  rtClassNode(name: string, at: ts.Node): Extract<Shape, { s: "obj" }> {
    return this.rtClassShape(name, [], at);
  }

  /**
   * An `unknown` read where the checker has narrowed it, by `typeof`, `instanceof` or a comparison. A type predicate can lie, and
   * a layout can't, so the class id is checked: a value that isn't what it was narrowed to traps 17 (3.10).
   */
  fromDyn(te: TE, want: Shape, at: ts.Node, asClass: ClassRec | null = null): TE {
    if (this.isDyn(want)) return te;
    const check = (x: TE, ranges: [number, number][]): Stmt =>
      this.castUnchecked ? { k: "block", body: [] } : this.dynCheck(x, ranges, at);
    const unbox = (box: string, inner: Shape): TE => {
      const bsh = this.rtClassNode(box, at);
      const rec = this.classRec(this.rtDecl(box) as ts.ClassDeclaration);
      const out: Stmt[] = [];
      const x = this.temp(te, out);
      out.push(check(x, [[this.idOf(rec), this.idOf(rec)]]));
      const v = this.fieldRead({ ...x, sh: bsh } as TE, "v", bsh.node, at);
      return this.withPrelude(out, this.flow(v, inner, at));
    };
    if (want.s === "num") return unbox("TmkBoxNum", want);
    if (want.s === "bool") return unbox("TmkBoxBool", want);
    if (want.s === "void") return mk({ k: "nullish" }, { k: "seq", items: [te], result: NULLISH });
    if (want.s === "obj" && this.isStr(want) && want.nul === undefined)
      return unbox("TmkBoxStr", want);
    if (want.s !== "obj" || want.nul !== undefined || findNode(want.node).kind === "fn")
      this.block(
        "any-type",
        at,
        `an unknown narrowed to a ${want.s} with no single representation (${this.checker.typeToString(this.typeAt(at))})`,
      );
    const target = findNode(want.node);
    // What it was narrowed to: the class the checker says, and everything under it.
    const recs = asClass !== null ? [asClass] : this.classesOf(target);
    // Every class under these that can be an `unknown` has to be read with this layout.
    for (const t of findNode(this.dynNode).dynTargets ?? []) {
      if (this.classesOf(t).some((r) => recs.some((q) => this.isSubclass(r, q))))
        this.unifyNodes(t, target, at);
    }
    this.markCls(target);
    this.classIds();
    const ranges = recs.map((r): [number, number] => [this.idOf(r), r.last]);
    const out: Stmt[] = [];
    const x = this.temp(te, out);
    out.push(check(x, ranges));
    return this.withPrelude(out, { ...x, sh: want } as TE);
  }

  castUnchecked = false;

  /** Traps 17 unless x is a non-null instance of a class in one of these id ranges. */
  dynCheck(x: TE, ranges: [number, number][], at: ts.Node): Stmt {
    return {
      k: "if",
      c: this.not(
        mk(T.bool, {
          k: "logic",
          op: "and",
          a: this.cmpTE("ne", x, nullPtr()),
          b: this.idIn(this.clsRead(x), ranges),
        }),
      ),
      a: [
        {
          k: "expr",
          e: mk(NEVER_TY, { k: "trapnow", kind: "narrow", code: 17, loc: this.loc(at) }),
        },
      ],
      b: null,
    };
  }

  /** A read of something whose binding is `unknown`, where the checker says it's narrower. */
  narrowDyn(te: TE, at: ts.Node): TE {
    if (!this.isDyn(te.sh)) return te;
    const t = this.typeAt(at);
    if (hasFlag(t, ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return te;
    // Narrowed only part of the way, such as to `{} | null` or `object`: still an `unknown` here.
    const parts = t.isUnion() ? t.types : [t];
    const one = parts.filter((p) => !hasFlag(p, ts.TypeFlags.Null | ts.TypeFlags.Undefined));
    if (one.length !== parts.length) return te;
    // `boolean` is the union `false | true`, and has one representation, the box's.
    const bool = one.length === 2 && one.every((p) => hasFlag(p, ts.TypeFlags.BooleanLiteral));
    if (one.length !== 1 && !bool) return te;
    const p = bool ? this.checker.getBooleanType() : one[0]!;
    const scalar = hasFlag(
      p,
      ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike,
    );
    const rec = scalar ? null : this.classOfType(p);
    if (!scalar && rec === null) return te;
    return this.fromDyn(te, this.slot(`${this.slotKey(at)}#narrow`, t, at), at, rec);
  }

  /** `x instanceof C`. */
  instanceOf(e: ts.BinaryExpression): TE {
    if (!this.mem) this.block("inheritance", e, "instanceof needs a memory mode in this phase");
    const right = strip(e.right);
    const sym = ts.isIdentifier(right) ? this.symbolOf(right) : undefined;
    if (sym === undefined)
      this.block("reflection", e, "instanceof of something that isn't a class name");
    let decl: ts.ClassLikeDeclaration | undefined;
    if (this.isLibSymbol(sym)) {
      const rt = this.errorRtName(sym.name);
      if (rt === null) this.block("reflection", e, `instanceof ${sym.name}`);
      decl = this.rtDecl(rt) as ts.ClassDeclaration;
    } else decl = sym.declarations?.find(ts.isClassLike);
    if (decl === undefined)
      this.block("reflection", e, "instanceof of something that isn't a class");
    if (decl.typeParameters !== undefined)
      this.block("inheritance", e, "instanceof a generic class");
    const rec = this.classRec(decl);
    const left = this.expr(e.left);
    const sh = left.sh as Shape | undefined;
    if (left.ty.k === "nullish")
      return mk(T.bool, { k: "seq", items: [left], result: litBool(false) });
    if (sh === undefined || sh.s !== "obj")
      return mk(T.bool, { k: "seq", items: [left], result: litBool(false) });
    if (!this.isDyn(sh)) {
      const n = findNode(sh.node);
      if (n.kind === "fn" || n === findNode(this.strNode))
        return mk(T.bool, { k: "seq", items: [left], result: litBool(false) });
      this.markCls(n);
      // The narrowed reads that follow use this flow class: it has to hold the narrower class's fields.
      const lt = this.classOfType(this.typeAt(e.left));
      if (lt !== null && this.isSubclass(rec, lt)) {
        const t = this.checker.getTypeAtLocation(decl);
        this.unify(sh, this.objectShape(t as ts.ObjectType, e), e);
      }
    }
    this.classIds();
    return this.withTemp(left, (x) =>
      mk(T.bool, {
        k: "logic",
        op: "and",
        a: this.cmpTE("ne", x, nullPtr()),
        b: this.idIn(this.clsRead(x), [
          [this.idOf(rec), this.classFault === "wrong-instanceof" ? this.idOf(rec) : rec.last],
        ]),
      }),
    );
  }

  /** `typeof x === "..."`: known from the shape, or from an `unknown`'s box. */
  typeofTest(x0: ts.Expression, what: string, at: ts.Node): TE {
    const x = this.expr(x0);
    const sh = x.sh as Shape | undefined;
    const known = (b: boolean): TE => mk(T.bool, { k: "seq", items: [x], result: litBool(b) });
    if (!this.isDyn(sh)) {
      if (x.ty.k === "nullish") return known(what === (x.isNull === true ? "object" : "undefined"));
      if (isNum(x)) return known(what === "number");
      if (x.ty.k === "bool") return known(what === "boolean");
      if (this.isStr(sh) && (sh as { nul?: Nul }).nul === undefined)
        return known(what === "string");
      if (
        sh?.s === "obj" &&
        findNode(sh.node).kind !== "fn" &&
        sh.nul === undefined &&
        !this.isStr(sh)
      )
        return known(what === "object");
      // An object that can be null is "object" either way; one that can be undefined is that when it's 0.
      if (sh?.s === "obj" && findNode(sh.node).kind !== "fn" && !this.isStr(sh)) {
        if (sh.nul === "null") return known(what === "object");
        if (sh.nul === "undefined" && (what === "object" || what === "undefined"))
          return this.cmpTE(what === "object" ? "ne" : "eq", x, nullPtr());
        if (sh.nul === "undefined") return known(false);
      }
      this.block("reflection", at, "typeof of a value whose type isn't one kind");
    }
    const boxId = (box: string): number =>
      this.idOf(this.classRec(this.rtDecl(box) as ts.ClassDeclaration));
    const is = (v: TE, box: string): TE => {
      this.rtClassNode(box, at);
      return mk(T.bool, {
        k: "logic",
        op: "and",
        a: this.cmpTE("ne", v, nullPtr()),
        b: this.cmpTE("eq", this.clsRead(v), lit32(boxId(box))),
      });
    };
    switch (what) {
      case "undefined":
        return this.cmpTE("eq", x, nullPtr());
      case "number":
        return this.withTemp(x, (v) => is(v, "TmkBoxNum"));
      case "string":
        return this.withTemp(x, (v) => is(v, "TmkBoxStr"));
      case "boolean":
        return this.withTemp(x, (v) => is(v, "TmkBoxBool"));
      case "object":
        // null, or an instance of a class that isn't a box.
        return this.withTemp(x, (v) =>
          mk(T.bool, {
            k: "logic",
            op: "and",
            a: this.cmpTE("ne", v, nullPtr()),
            b: this.not(
              this.idIn(
                this.clsRead(v),
                [boxId("TmkBoxNum"), boxId("TmkBoxStr"), boxId("TmkBoxBool")].map(
                  (i): [number, number] => [i, i],
                ),
              ),
            ),
          }),
        );
      default:
        return known(false);
    }
  }

  /** `typeof x` as a string: from the shape, or an `unknown`'s at run time. */
  typeofValue(x0: ts.Expression, at: ts.Node): TE {
    this.needStr(at, "typeof as a value");
    const x = this.expr(x0);
    if (this.isDyn(x.sh)) return this.rtCall("tmkTypeof", [x], at);
    const sh = x.sh as Shape | undefined;
    const kind =
      x.ty.k === "nullish"
        ? x.isNull === true
          ? "object"
          : "undefined"
        : isNum(x)
          ? "number"
          : x.ty.k === "bool"
            ? "boolean"
            : this.isStr(sh) && (sh as { nul?: Nul }).nul === undefined
              ? "string"
              : sh?.s === "obj" && sh.nul === undefined && findNode(sh.node).kind !== "fn"
                ? "object"
                : null;
    if (kind === null) this.block("reflection", at, "typeof of a value whose type isn't one kind");
    return mk(
      { k: "ref" },
      { k: "seq", items: [x], result: this.strLit(kind) },
      { sh: this.strShape() },
    );
  }

  /** `e === null` and kin on an `unknown`. */
  dynNullTest(x: TE, isNullLit: boolean, loose: boolean, at: ts.Node): TE {
    if (!isNullLit && !loose) return this.cmpTE("eq", x, nullPtr());
    const boxId = this.idOf(this.classRec(this.rtDecl("TmkBoxNull") as ts.ClassDeclaration));
    this.rtClassNode("TmkBoxNull", at);
    return this.withTemp(x, (v) => {
      const isBoxNull = mk(T.bool, {
        k: "logic",
        op: "and",
        a: this.cmpTE("ne", v, nullPtr()),
        b: this.cmpTE("eq", this.clsRead(v), lit32(boxId)),
      });
      return loose
        ? mk(T.bool, { k: "logic", op: "or", a: this.cmpTE("eq", v, nullPtr()), b: isBoxNull })
        : isBoxNull;
    });
  }

  /** __dyn_class_name(e): JS's `constructor.name`, by class id. */
  dynClassName(arg: TE): TE {
    this.classIds();
    const out: Stmt[] = [];
    const x = this.temp(arg, out);
    const rv = this.newVar({ k: "ref" }, "$name");
    out.push({ k: "let", v: rv, init: this.strLit("Object"), constant: false });
    const clauses = [...this.classRecs.values()].map((r) => ({
      keys: [lit32(this.idOf(r))],
      isDefault: false,
      body: [
        {
          k: "expr",
          e: mk(
            { k: "ref" },
            { k: "setvar", v: rv, val: this.strLit(r.jsName) },
            { sh: this.strShape() },
          ),
        } as Stmt,
        { k: "break", label: null } as Stmt,
      ],
    }));
    out.push({
      k: "if",
      c: this.cmpTE("ne", x, nullPtr()),
      a: [{ k: "switch", val: this.clsRead(x), clauses }],
      b: null,
    });
    return mk(
      { k: "ref" },
      { k: "blockexpr", body: out, result: this.varTE(rv, this.strShape()) },
      { sh: this.strShape() },
    );
  }

  // --- exceptions (D49): `throw` of any value, and `try`

  needExc(at: ts.Node): void {
    if (!this.mem)
      this.block(
        "try-catch",
        at,
        "exceptions need a memory mode: a thrown value outlives its frame",
      );
    if (!this.excOn) {
      this.excOn = true;
      this.changed = true;
    }
  }

  tryStmt(st: ts.TryStatement): Stmt[] {
    this.needExc(st);
    const body = this.blockOf(st.tryBlock);
    let cv: Var | null = null;
    let handler: Stmt[] | null = null;
    const cc = st.catchClause;
    if (cc !== undefined) {
      handler = this.inBlock(() => {
        const d = cc.variableDeclaration;
        if (d !== undefined) {
          if (!ts.isIdentifier(d.name))
            this.block("unsupported", d, "a pattern in a catch binding");
          const t = this.typeAt(d.name);
          if (hasFlag(t, ts.TypeFlags.Any)) this.block("any-type", d, "a catch binding typed any");
          cv = this.newVar({ k: "ref" }, d.name.text);
          const pre: Stmt[] = [];
          this.bindVar(this.symbolOf(d.name)!, cv, this.dynShape(), d, pre);
          return [
            ...pre,
            ...this.inBlock(() => {
              this.hoist(cc.block.statements);
              return this.stmts(cc.block.statements);
            }),
          ];
        }
        return this.blockOf(cc.block);
      });
    }
    const fin = st.finallyBlock !== undefined ? this.blockOf(st.finallyBlock) : null;
    return [{ k: "try", body, cv, cvSh: this.dynShape(), handler, fin }];
  }

  /** Throws a new error of a runtime class, with a fixed message: what V8 throws where lowered code would trap. */
  raiseNew(rt: string, msg: string, at: ts.Node): TE {
    return this.raiseTE(this.asDyn(this.newRt(rt, [this.strLit(msg)], at), at), at);
  }

  raiseTE(val: TE, at: ts.Node): TE {
    this.needExc(at);
    return mk(NEVER_TY, { k: "raise", val: this.toDyn(val, at), loc: this.loc(at) });
  }

  /** `throw new Error(...)` the trap path can say, in a module where nothing can catch it (4.5). */
  isStaticThrow(x0: ts.Expression): boolean {
    const x = strip(x0);
    if (!(ts.isNewExpression(x) || ts.isCallExpression(x)) || !ts.isIdentifier(x.expression))
      return false;
    const sym = this.symbolOf(x.expression);
    return (
      sym !== undefined &&
      this.isLibSymbol(sym) &&
      this.errorRtName(sym.name) !== null &&
      sym.name !== "SuppressedError" &&
      (x.arguments?.length ?? 0) <= 1
    );
  }

  /** `using x = e` and the rest of the block: a `try` whose cleanup disposes, with SuppressedError when both throw. */
  usingRest(list: ts.VariableDeclarationList, rest: readonly ts.Statement[]): Stmt[] {
    if ((list.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing)
      this.block("async", list, "await using");
    if (list.declarations.length !== 1)
      this.block("unsupported", list, "using with more than one binding");
    const d = list.declarations[0]!;
    this.needExc(d);
    const out: Stmt[] = [];
    this.varDecl(d, true, out);
    if (!ts.isIdentifier(d.name)) this.block("unsupported", d, "a pattern in a using declaration");
    const t = this.checker.getNonNullableType(this.typeAt(d.name));
    const disp = t.getProperties().find((p) => p.name.startsWith("__@dispose"));
    const md = disp?.declarations?.find(ts.isMethodDeclaration);
    if (md === undefined)
      this.block("unsupported", d, "a resource whose [Symbol.dispose] isn't a method");
    const read = (): TE => this.identifier(d.name as ts.Identifier);
    const disposeCall = (): TE => {
      const self = read();
      const sh = self.sh as Extract<Shape, { s: "obj" }>;
      const call = this.callInst(this.methodInst(md, { ...sh, nul: undefined }, t), self, [], d);
      return sh.nul !== undefined
        ? mk(T.void, {
            k: "blockexpr",
            body: [
              {
                k: "if",
                c: this.cmpTE("ne", read(), nullPtr()),
                a: [{ k: "expr", e: call }],
                b: null,
              },
            ],
            result: VOID,
          })
        : call;
    };
    const thrown = this.newVar(T.bool, "$thrown");
    out.push({ k: "let", v: thrown, init: litBool(false), constant: false });
    const body = this.stmts(rest);
    // The body threw: dispose, and if that throws too, both go into a SuppressedError.
    const ev = this.newVar({ k: "ref" }, "$e");
    const dv = this.newVar({ k: "ref" }, "$d");
    const dyn = this.dynShape();
    const sup = this.asDyn(
      this.newRt(
        "TmkSuppressedError",
        [
          this.varTE(dv, dyn),
          this.varTE(ev, dyn),
          this.strLit("An error was suppressed during disposal"),
        ],
        d,
      ),
      d,
    );
    const handler: Stmt[] = [
      { k: "expr", e: mk(T.bool, { k: "setvar", v: thrown, val: litBool(true) }) },
      {
        k: "try",
        body: [{ k: "expr", e: disposeCall() }],
        cv: dv,
        cvSh: dyn,
        handler: [{ k: "expr", e: mk(NEVER_TY, { k: "raise", val: sup, loc: this.loc(d) }) }],
        fin: null,
      },
      { k: "expr", e: mk(NEVER_TY, { k: "raise", val: this.varTE(ev, dyn), loc: this.loc(d) }) },
    ];
    const fin: Stmt[] = [
      {
        k: "if",
        c: this.not(this.varTE(thrown, { s: "bool" })),
        a: [{ k: "expr", e: disposeCall() }],
        b: null,
      },
    ];
    out.push({ k: "try", body, cv: ev, cvSh: dyn, handler, fin });
    return out;
  }

  finish(roots: FnLike[]): DownResult {
    const heap: DownMeta["heap"] = {};
    const meta: DownMeta = {
      exports: {},
      shims: {},
      heap,
      strings: Object.fromEntries(this.strings),
      traps: {},
      fallbackFile: null,
      fallbackNames: [],
      ...(this.memory !== "strict" ? { memory: this.memory } : {}),
    };
    const funcs: FuncInst[] = [];
    const live: Inst[] = [];
    const init = this.insts.get("<init>")!;
    funcs.push(init.fi);
    live.push(init);
    for (const inst of this.insts.values()) {
      if (inst.key === "<init>" || !this.visited.has(inst.key) || this.fallback.has(inst.owner))
        continue;
      funcs.push(inst.fi);
      live.push(inst);
    }
    for (const name of this.jsExports) {
      meta.exports[name] = { params: [], ret: { k: "void" }, fallback: true };
      meta.fallbackNames.push(name);
    }
    for (const r of roots) {
      const name = this.exportNames.get(r) ?? this.fnName(r);
      if (this.fallback.has(r)) {
        meta.exports[name] = { params: [], ret: { k: "void" }, fallback: true };
        meta.fallbackNames.push(name);
      }
    }
    for (const inst of live) {
      if (inst.exported && inst.key !== "<init>") {
        meta.exports[inst.fi.jsName] = {
          params: inst.paramSh.map((s) => this.descOf(s, heap)),
          ret: this.descOf(inst.retSh, heap),
        };
      }
    }
    for (const [name, x] of this.externs) {
      const shapes = this.shimShapes.get(name)!;
      meta.shims[name] = {
        js: x.meta.js,
        params: shapes.params.map((s) => this.descOf(s, heap)),
        ret: this.descOf(shapes.ret, heap),
      };
      if (!meta.fallbackNames.includes(x.meta.js)) meta.fallbackNames.push(x.meta.js);
    }
    // Exceptions, into ordinary control flow, before counts: `rc` releases on their jumps as on any other (D49).
    let exc: ExcStats | null = null;
    if (this.mem && usesExceptions(funcs)) {
      const cloOf = new Map<HeapNode, FuncInst[]>();
      const retSh = new Map<FuncInst, Shape>();
      for (const inst of live) {
        retSh.set(inst.fi, inst.retSh);
        if (inst.clo !== undefined) {
          const n = findNode(inst.clo.node);
          cloOf.set(n, [...(cloOf.get(n) ?? []), inst.fi]);
        }
      }
      const allClo = [...cloOf.values()].flat();
      // The tree as it was, for class printing, which desugars exceptions itself (D49, D68): the second implementation
      // the dual route compares with this one. down-exc.ts replaces bodies and doesn't change the nodes in them.
      const excSource: ExcSource = {
        funcs: funcs.map((f) => ({
          f,
          pre: { ...f, attrs: [...f.attrs] },
          post: null as unknown as FuncInst,
        })),
        dynSh: this.dynShape(),
        describe: this.excDescribe?.fi ?? null,
        overflow: this.excOverflow?.fi ?? null,
        uncaughtCode: THROW_CODE_BASE + this.nextThrow,
        wrappers: [],
      };
      const r = applyExc(funcs, {
        dynSh: this.dynShape(),
        closureThrows: (clo, can) => {
          const sh = clo.sh as Shape | undefined;
          const list =
            sh !== undefined && sh.s === "obj" ? (cloOf.get(findNode(sh.node)) ?? []) : allClo;
          return list.some((f) => can.has(f));
        },
        retShOf: (f) => retSh.get(f),
        describe: this.excDescribe?.fi ?? null,
        overflow: this.excOverflow?.fi ?? null,
        uncaughtCode: THROW_CODE_BASE + this.nextThrow,
        opts: this.excOptions,
      });
      const before = new Set(excSource.funcs.map((x) => x.f));
      for (const x of excSource.funcs) x.post = { ...x.f, attrs: [...x.f.attrs] };
      excSource.wrappers = r.funcs.filter((f) => !before.has(f));
      this.excSource = excSource;
      funcs.length = 0;
      funcs.push(...r.funcs);
      exc = r.stats;
      meta.exc = {
        describe: this.excDescribe?.fi.tirName ?? "",
        uncaught: THROW_CODE_BASE + this.nextThrow,
      };
    }
    // `rc`: counts, on the finished tree. Everything that's counted is known by now (SPEC 3.5, D39).
    // `uncounted`: the tree before counts, for the TSL route (R2), where tslc's expansion counts the printed classes (D74).
    const rc =
      this.memory === "rc" && this.rcOptions.uncounted !== true
        ? applyRc(funcs, this.rcOptions)
        : null;
    if (rc !== null) {
      for (const n of liveNodes()) {
        if (n.parent !== null || !n.long || n.kind === "fn") continue;
        const entry = heap[n.id];
        if (entry !== undefined) entry.rcDesc = rc.descOf(n);
      }
    }
    const extraGlobals: Global[] = [...rtGlobals(), ...(this.mem ? memoryRtGlobals() : [])];
    if (exc !== null) extraGlobals.push(...excRtGlobals());
    if (this.strRt) extraGlobals.push(...this.strGlobals());
    if (this.usesHashKey) extraGlobals.push(...this.hashGlobals());
    const rcBuild = { ...this.rcOptions, cycles: rc?.cycles === true };
    if (rc !== null) extraGlobals.push(...rcRtGlobals(rcBuild, rc.descs, rc.mapOn));
    for (const g of this.globals.values()) {
      if (g.konst === undefined && g.arrayDef === undefined) {
        extraGlobals.push({
          name: g.name,
          size: Math.max(8, sizeOf(g.sh)),
          align: 8,
          section: "data",
        });
      }
    }
    const typed: TypedModule = {
      file: repoRelative(this.rootSf.fileName),
      funcs,
      globals: [...this.globalDefs.values()],
      strings: this.strings,
      extraGlobals,
      extraFuncs: this.mem
        ? [
            ...rtFuncs(),
            ...memoryRtFuncs(),
            ...(rc !== null ? rcRtFuncs(rcBuild) : []),
            ...(this.strRt ? strRtFuncs(this.memory as "leak" | "manual" | "rc") : []),
            ...(this.usesHashKey ? hashRtFuncs() : []),
            ...(exc !== null ? excRtFuncs() : []),
          ]
        : rtFuncs(),
      extraTraps: rc !== null && this.rcOptions.check ? [...RT_TRAPS, ...RC_TRAPS] : RT_TRAPS,
      externs: [...this.externs.values()].map((x) => x.ext),
    };
    return {
      typed,
      meta,
      fallback: this.fallback,
      insts: live,
      allocs: this.allocs,
      warnings: this.warnings,
      rounds: this.round,
      sourceFiles: this.files,
      globalFiles: this.globalFiles,
      initFiles: this.initFiles,
      imports: this.importsOf,
      sharedTop: this.sharedTop,
      fnNameOf: (n) => this.fnName(n),
      usedMath: [...this.usedMath].sort(),
      ...(rc !== null
        ? { rc: rc.stats, cycles: this.cycleReport(), cycleCollector: rc.cycles }
        : {}),
      ...(exc !== null ? { exc } : {}),
      ...(this.excSource !== null ? { excSource: this.excSource } : {}),
    };
  }
}

// --- static data of strings and maps (D42), which the TSL route declares by these same functions (D62)

function strFlat(s: string, size: number): Uint8Array {
  const b = new Uint8Array(size);
  const d = new DataView(b.buffer);
  d.setUint32(8, STATIC_COUNT, true);
  d.setUint32(RC_HDR, s.length, true);
  d.setUint32(RC_HDR + 8, STR_FLAT_HDR, true);
  for (let i = 0; i < s.length; i++) {
    d.setUint16(RC_HDR + STR_FLAT_HDR + i * 2, s.charCodeAt(i), true);
  }
  return b;
}

/** A string literal: static, with a count that can't reach zero, flat UTF-16 after its header. */
export function strLiteralGlobal(name: string, s: string): Global {
  const size = RC_HDR + STR_FLAT_HDR + Math.max(1, s.length) * 2;
  return { name, size, align: 16, section: "data", bytes: strFlat(s, size) };
}

/** The text of a literal's global, read back from its bytes. */
export function strLiteralText(g: Global): string | null {
  if (g.bytes === undefined || g.bytes.length < RC_HDR + STR_FLAT_HDR) return null;
  const d = new DataView(g.bytes.buffer, g.bytes.byteOffset, g.bytes.byteLength);
  const n = d.getUint32(RC_HDR, true);
  if (RC_HDR + STR_FLAT_HDR + n * 2 > g.bytes.length) return null;
  let s = "";
  for (let i = 0; i < n; i++)
    s += String.fromCharCode(d.getUint16(RC_HDR + STR_FLAT_HDR + i * 2, true));
  return s;
}

/** The 256 one-unit strings below 256, which `__s_char` hands out. */
export function charTableGlobal(name: string): Global {
  const table = new Uint8Array(256 * STR_CHAR_SIZE);
  for (let u = 0; u < 256; u++)
    table.set(strFlat(String.fromCharCode(u), STR_CHAR_SIZE), u * STR_CHAR_SIZE);
  return { name, size: table.length, align: 16, section: "data", bytes: table };
}

/** The hash key's default, until a caller with entropy sets its own (4.5). */
export function hashKeyGlobal(name: string): Global {
  const key = new Uint8Array(8);
  new DataView(key.buffer).setUint32(0, HASH_KEY_DEFAULT[0]!, true);
  new DataView(key.buffer).setUint32(4, HASH_KEY_DEFAULT[1]!, true);
  return { name, size: 8, align: 8, section: "data", bytes: key };
}

/** A callee just fell back: this caller's walk is moot, and the next round sees the outcome. */
class RetryRound extends Error {}

/** The first run-time string in a module: its walk starts again, with every string in it a pointer (SPEC 4.5, D42). */
export class RestartStrRt extends Error {}

export interface Arg {
  te?: TE;
  targets?: Target[];
  tag?: Var | null;
}

interface Seq {
  te: TE;
  sh: Shape;
  elemSh: Shape;
  len(): TE;
  at(i: TE, node: ts.Node): TE;
  opt(i: TE, node: ts.Node): TE;
  trap(i: TE, node: ts.Node): TE;
}

interface LV {
  sh: Shape;
  read(): TE;
  write(val: TE, at: ts.Node): TE;
}

function leavesOf(sh: Shape): Extern["params"] {
  // A `bool` is a byte in memory and an i32 in a register (R6).
  return memOf(sh, 0).map((m) => (m.t === "i8" ? "i32" : m.t));
}

function isBitOp(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

function compoundBase(op: ts.SyntaxKind): ts.SyntaxKind {
  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      return ts.SyntaxKind.PlusToken;
    case ts.SyntaxKind.MinusEqualsToken:
      return ts.SyntaxKind.MinusToken;
    case ts.SyntaxKind.AsteriskEqualsToken:
      return ts.SyntaxKind.AsteriskToken;
    case ts.SyntaxKind.SlashEqualsToken:
      return ts.SyntaxKind.SlashToken;
    case ts.SyntaxKind.PercentEqualsToken:
      return ts.SyntaxKind.PercentToken;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return ts.SyntaxKind.AsteriskAsteriskToken;
    case ts.SyntaxKind.AmpersandEqualsToken:
      return ts.SyntaxKind.AmpersandToken;
    case ts.SyntaxKind.BarEqualsToken:
      return ts.SyntaxKind.BarToken;
    case ts.SyntaxKind.CaretEqualsToken:
      return ts.SyntaxKind.CaretToken;
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return ts.SyntaxKind.LessThanLessThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    default:
      return op;
  }
}

function foldBinary(op: ts.SyntaxKind, a: number, b: number): number | null {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return a + b;
    case ts.SyntaxKind.MinusToken:
      return a - b;
    case ts.SyntaxKind.AsteriskToken:
      return a * b;
    case ts.SyntaxKind.SlashToken:
      return a / b;
    case ts.SyntaxKind.PercentToken:
      return a % b;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return a ** b;
    case ts.SyntaxKind.AmpersandToken:
      return a & b;
    case ts.SyntaxKind.BarToken:
      return a | b;
    case ts.SyntaxKind.CaretToken:
      return a ^ b;
    case ts.SyntaxKind.LessThanLessThanToken:
      return a << b;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return a >> b;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return a >>> b;
    default:
      return null;
  }
}

function normElems(elem: ElemName, vals: number[]): number[] {
  const conv: Record<string, (x: number) => number> = {
    u8: (x) => x & 0xff,
    i8: (x) => (x << 24) >> 24,
    u16: (x) => x & 0xffff,
    i16: (x) => (x << 16) >> 16,
    u32: (x) => x >>> 0,
    i32: (x) => x | 0,
    f32: (x) => x,
    f64: (x) => x,
  };
  const f = conv[elem]!;
  return vals.map(f);
}

export { BLOCKERS, Blocked };
