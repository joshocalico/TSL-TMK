// `tmk lower --emit tsl` (SPEC 4.5, D62, design/pipeline.md): ordinary TS, lowered, printed as a TSL program that tslc
// compiles. The lowering's analyses are spelled in the TSL: a number's representation is its declared type, a range the
// lowering proved is a wrap context, a placement is which allocation it calls, and what TSL proper has no words for comes from
// @tsl/lowered. Each construct prints as the TSL that tslc elaborates back to the same node of the typed tree, so the TIR
// tslc reaches is the TIR the direct route reaches, and `tmk milestone pipe-a` checks that it does what it did.
//
// What isn't printable yet throws EmitUnsupported with what it was, and that program stays on the direct route.
import { dirname, relative } from "node:path";
import type { Global } from "../tir/ir.ts";
import type { Desc, DownMeta, DownResult } from "./down.ts";
import ts from "typescript";
import {
  findNode,
  liveNodes,
  locTy,
  r13Off,
  r14Off,
  r17Off,
  r18Off,
  r19Off,
  r6Off,
  r9Off,
  tyOf,
  type HeapNode,
  type Shape,
} from "./down-model.ts";
import { strLiteralText } from "./down.ts";
import { loweredRuntime, memText, stdMem } from "./elab-lowered.ts";
import { VEC_DATA, VEC_LEN } from "./down-rt.ts";
import { desugarExc, EXC_ABI, EXC_STATE, r23Off, STACK_LOW } from "./emit-exc.ts";
import { RC_STR_CORE, RC_STR_NAMES, r21UnitsOff, r22Off, rcStrRuntime } from "./emit-rcstr.ts";
import {
  ARRAY_BY_ELEM,
  elemSize,
  TRAP_NAMES,
  type FuncInst,
  type GlobalDef,
  type Stmt,
  type TE,
  type Ty,
  type Var,
} from "./types.ts";

export class EmitUnsupported extends Error {}

/** What starts the message where a map can't print as JsMap yet (D72), and the program prints as it did. */
const MAPS_NOT = "maps: ";

/** Exceptions and `unknown` printed with classes (D68); TMK_EMIT_EXC=0 prints as before, to find what that moves. */
const EMIT_EXC = process.env.TMK_EMIT_EXC !== "0";
/** TMK_DYN_SHARED=0: an `unknown`'s class with each class's fields side by side, as pipe-g printed it, for measuring. */
const DYN_UNSHARED = process.env.TMK_DYN_SHARED === "0";
/** TMK_EMIT_STRKEYS=0: a map with a string key or value prints as before strkeys (as the map runtime), to count what moved. */
const STRKEYS_OFF = process.env.TMK_EMIT_STRKEYS === "0";

/**
 * A field of a planned class. An optional scalar's (R7, D62's first ruling) is two: its flag, a `bool` declared just before
 * it, and its value, which names the flag (`flag`), so a read packs the two and a store writes both.
 */
type PlanField = {
  name: string;
  ty: string;
  init: string | null;
  flag?: PlanField;
  // R7: a typed-array field, held in place as a runtime class of its pointer and length: the array's TSL type
  arr?: string;
  // R23, `rc`: an `unknown`'s reference field nothing printed stores to: a getter giving null, its 8 bytes kept (`noneFields`)
  none?: boolean;
};

/** R7: an optional scalar prints as two fields, a `bool` flag and its value (`TMK_R7_OFF` lists what's off, r7-pins.ts). */
const R7_OFF = new Set((process.env.TMK_R7_OFF ?? "").split(",").map((x) => x.trim()));
const OPT_FIELDS = !R7_OFF.has("optfields");
/** R7: a typed-array field prints as a runtime class holding its pointer and length, held in place (D62's first ruling). */
const ARR_FIELDS = !R7_OFF.has("arrfields");
/** R7: a Map or Set crossing an export prints as JsMap or JsSet, with its surface exports (D36's map form). */
const MAPS_CROSS = !R7_OFF.has("mapscross");

/** An optional number or boolean, which R7 prints as a flag field and a value field. */
function isOptScalar(sh: Shape): sh is Extract<Shape, { s: "opt" }> {
  return OPT_FIELDS && sh.s === "opt" && (sh.of.s === "num" || sh.of.s === "bool");
}

export interface TslEmit {
  text: string; // the module: the root module, where there are several
  // One TSL module per source module (D65), by path relative to the package, the root module's first. Absent: one file.
  modules?: { path: string; text: string }[];
  tslJson: string; // its package's tsl.json
  stats: {
    funcs: number;
    lines: number;
    intrinsics: number; // calls into @tsl/lowered: what TSL proper can't say yet
    memoryOps: number; // of those, loads, stores and allocations: the part the next phases make into classes
    hoisted: number; // statement-expressions printed as statements before their statement
    jsStrings?: boolean; // strings printed as @tsl/jsrt's JsString (D67): the ABI's units are at the address at p + 8
    rcStrings?: boolean; // R10: in `rc`, strings printed as the program's own JsStr (emit-rcstr.ts), counted by the expansion
    rcStrAbi?: boolean; // R10: and one crosses an export, so a native caller counts strings by __rc_retain_str and __rc_release_str
    rcExc?: boolean; // R11: in `rc`, exceptions desugared here, a taken one given back by __exc_release
    classes?: boolean; // R14: class printing (phase 2), not phase 1's
    restructured: number; // loops and branches the printer reshaped to fit them, where -O0's TIR can differ
    reshapedWhy?: Record<string, number>; // R12: why, by kind
  };
  // R5: what crosses an export, as printed: by D36's heap id, each class's TSL name, D36's size and its fields' TSL names
  // at D36's offsets (which tslc checks), and each array's placing export. Absent where nothing does.
  boundary?: {
    classes: Record<
      string,
      {
        name: string;
        size: number;
        // R7: an optional scalar's entry is its flag, at D36's offset, and `value` its value field; a typed array's (`arr`)
        // is its runtime class held in place, the pointer and the length
        fields: Record<
          string,
          { name: string; off: number; value?: { name: string; off: number }; arr?: true }
        >;
      }
    >;
    vecs: Record<string, string>;
    // R7: each Map or Set crossing an export, by heap id: a JsMap, or a JsSet holding one in place
    maps?: Record<string, "map" | "set">;
    // and where JsMap keeps what a native caller reads it by (tslc fills it in, from the class as it laid it out)
    mapLayout?: JsMapLayout;
    // R8: in `rc`, each crossing class's and array's counting exports, by heap id
    rc?: Record<string, { place?: string; retain: string; release: string }>;
  };
}

/** R7: the fields of JsMap a reader of its memory needs, at their offsets, and JsSet's map's offset in it. */
export interface JsMapLayout {
  fields: Record<string, number>;
  setMap: number;
}

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await async of undefined NaN Infinity Math arguments eval"
  ).split(" "),
);

const CORE_TYPES = [
  "bool",
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "usize",
];

/** JS's own text for a double, exact both ways. */
function numText(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

function sanitize(s: string): string {
  let out = s.replace(/[^A-Za-z0-9_$]/g, "_");
  if (out === "" || /^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

interface Loop {
  label: string | null; // the label right around the loop, which a `continue L` names
  cont: string | null; // a block whose end is where a `continue` goes, where the loop isn't printed as itself
}

export interface EmitOptions {
  /**
   * Phase 2 (D62's rulings): objects print as TSL's own classes, in TSL's own layout, with `new` placed by tslc's escape
   * analysis and the class id a field, not as loads and stores at the lowering's offsets. Its TIR isn't the direct route's,
   * so it's the TSL route only when asked for, and the dual-route differential checks it. What it can't print yet is
   * EmitUnsupported, as for phase 1.
   */
  classes?: boolean;
  /**
   * With classes, vectors print as @tsl/jsrt's JsArray (D66); false leaves a program with one unprinted, as before. On
   * unless said otherwise; `auto` says, by whether the arrays met the speed rule.
   */
  vectors?: boolean;
  /**
   * With classes, strings print as @tsl/jsrt's JsString (D67), and the string runtime's core with them; false leaves a
   * program with a string unprinted, as before. On unless said otherwise; `auto` says, by whether they met the speed rule.
   */
  strings?: boolean;
  /**
   * With classes, `Map` and `Set` print as @tsl/jsrt's JsMap and JsSet (D72), and compiler/rt/map.ts isn't printed; where a
   * map can't print so yet (a key that's a boolean or nullable, an iterator as a value), the program prints as before. A
   * string key prints where strings do. On unless said otherwise; `auto` says, by whether they met the speed rule.
   */
  maps?: boolean;
  /**
   * With classes, a closure value prints as an environment class of the program's own, its call a method that picks the
   * closure by a kind field where there are several (R3); false leaves a program with one unprinted, as before. On unless
   * said otherwise; `auto` says, by mode, by whether they met the speed rule there.
   */
  closures?: boolean;
  /**
   * With classes, an exported function taking or giving an object or array prints (R5): each class that crosses laid out at
   * D36's listed offsets, which tslc checks, and each array placed by an export of its own; false leaves such a program
   * unprinted, as before. On unless said otherwise; `auto` says, by whether it met the speed rule (AUTO_BOUNDARY).
   */
  boundary?: boolean;
  /**
   * R9: typed arrays made in functions (layout classes and tails), module state that's a typed array, and arrays of
   * booleans and of nothing: on unless false, which `auto` says until they meet the speed rule (AUTO_R9 in tslc.ts).
   */
  r9?: boolean;
  /**
   * Class printing's reference sites to print with `!`: where tsc can't see the narrowing the TS had, because the printed
   * program reads through a temporary, and the lowering proved the value isn't null (it would have a nonNull otherwise).
   * Found by compileViaTsl from tsc's own errors on a printing with each site marked (`marks`).
   */
  bangs?: Set<number>;
  marks?: boolean;
  /**
   * One TSL module per source module (D65), with the source's imports and exports, in place of one file. Where something has
   * no source module of its own (a string literal's data, an object literal's class), it goes in a module every user of it
   * imports already; where there's none, or the modules would form a cycle (TSL bans them, TSL1010), it's EmitUnsupported.
   */
  modules?: boolean;
}

/** Where pass one found the things with no source module used: each one's key to the modules that used it. */
type Users = Map<string, Set<ts.SourceFile>>;

export function emitTsl(r: DownResult, memory: string, from: string, o: EmitOptions = {}): TslEmit {
  const make = (): Emitter => {
    const e = new Emitter(r, memory, from, o.classes === true);
    e.bangs = o.bangs ?? new Set();
    e.marks = o.marks === true;
    e.vectors = o.vectors !== false;
    // `rc` (R2): strings aren't counted through the TSL route yet, so a program with one stays on the direct route.
    // `rc` (R10): strings are the program's own JsStr there, counted by the expansion as its classes are (emit-rcstr.ts);
    // TMK_R10_OFF=strings leaves them unprinted, as before R10, for computing what R10 moved (tools/r10-pins.ts).
    e.strs = e.classes && o.strings !== false && (memory !== "rc" || !r10Off("strings"));
    e.maps = e.classes && (o as { mapsOn?: boolean }).mapsOn === true;
    e.closures = o.closures !== false;
    e.boundary = o.boundary !== false;
    e.r9 = o.r9 !== false;
    if (memory === "strict" && e.classes) {
      // R12: classes alone in `strict` (STRICT_CLASSES_ONLY). R13: and arrays, as @tsl/jsrt's arena array, whose buffers
      // are the call arena's (JsArenaArray), typed arrays made in functions as R9's layout classes and tails, closure
      // values as environment classes of the program's own (R3), and exports taking or giving objects in D36's listed
      // layout (R5), every one of them placed by tslc in the call arena the caller resets (region.ts); TMK_R13_OFF=arrays,
      // closures or boundary leaves each unprinted, as R12 did. Strings, maps and `Dyn` stay `@tsl/jsrt`'s and `@tsl/std`'s.
      e.vectors = o.vectors !== false && !r13Off("arrays");
      e.strs = false;
      e.maps = false;
      e.closures = o.closures !== false && !r13Off("closures");
      e.boundary = o.boundary !== false && !r13Off("boundary");
      e.r9 = o.r9 !== false && !r13Off("arrays");
    }
    return e;
  };
  // Maps as JsMap (D72) where every map in the program can be; where one can't, the program prints as it did.
  if (o.maps === true && o.classes === true) {
    try {
      return emitTsl(r, memory, from, { ...o, maps: false, mapsOn: true } as EmitOptions);
    } catch (e) {
      if (!(e instanceof EmitUnsupported) || !e.message.startsWith(MAPS_NOT)) throw e;
      return emitTsl(r, memory, from, { ...o, maps: false });
    }
  }
  if (o.modules !== true || r.sourceFiles.length < 2) return make().run();
  // Two passes: the first finds who uses what has no module of its own, the second puts each where all its users can reach it.
  const first = make();
  first.modules = true;
  first.run();
  const second = make();
  second.modules = true;
  second.homes = homesFor(r, first.users);
  second.importOwners = new Map([...first.importsOf].map(([m, by]) => [m, new Set(by.keys())]));
  return second.run();
}

/** Every module a module imports, directly or not. */
function reachOf(r: DownResult): Map<ts.SourceFile, Set<ts.SourceFile>> {
  const out = new Map<ts.SourceFile, Set<ts.SourceFile>>();
  const visit = (sf: ts.SourceFile, seen: Set<ts.SourceFile>): void => {
    for (const d of r.imports.get(sf) ?? [])
      if (!seen.has(d)) {
        seen.add(d);
        visit(d, seen);
      }
  };
  for (const sf of r.sourceFiles) {
    const seen = new Set<ts.SourceFile>();
    visit(sf, seen);
    out.set(sf, seen);
  }
  return out;
}

/** A home for each thing with no module of its own: one of its users that every other user imports, directly or not. */
function homesFor(r: DownResult, users: Users): Map<string, ts.SourceFile> {
  const reach = reachOf(r);
  const out = new Map<string, ts.SourceFile>();
  for (const [key, set] of users) {
    const home = r.sourceFiles.find(
      (m) => set.has(m) && [...set].every((u) => u === m || reach.get(u)!.has(m)),
    );
    if (home === undefined)
      throw new EmitUnsupported(
        `${key.replace(/^\w+:/, "")}, used by modules none of which the others import: it has no module to go in`,
      );
    out.set(key, home);
  }
  return out;
}

/** A module's file name with no directory and no `.ts`, capitalised: what a name is qualified with (`Square_inShapes`). */
function stemCap(sf: ts.SourceFile): string {
  const st = sf.fileName.replace(/.*\//, "").replace(/\.ts$/, "");
  const c = sanitize(st);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Where a declaration is: the function or class it's inside, else its module, for qualifying a name two things share. */
function whereOf(decl: ts.Node | undefined, sf: ts.SourceFile): string {
  for (let p = decl?.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (
      (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p)) &&
      p.name !== undefined
    ) {
      const n = sanitize(p.name.getText());
      return n.charAt(0).toUpperCase() + n.slice(1);
    }
  }
  return stemCap(sf);
}

/** The reference sites tsc says are used as non-null where it can't narrow: each marker ending where an error starts. */
export function bangSites(
  text: string,
  diags: { line: number; col: number; code: string }[],
): Set<number> {
  const lines = text.split("\n");
  const out = new Set<number>();
  const NULLISH = new Set(["TS18047", "TS18048", "TS2531", "TS2532", "TS2345", "TS2322", "TS2769"]);
  for (const d of diags) {
    if (!NULLISH.has(d.code)) continue;
    const line = lines[d.line - 1];
    if (line === undefined) continue;
    // tsc reports some errors at the expression inside a site's parentheses: skip them back to its marker.
    const before = line.slice(0, d.col - 1);
    // A location comment (`/*@ file:line:col */`) between them is trivia to tsc, which reports after it.
    const m = /\/\*<(\d+)\*\/\(*(?:\/\*@ [^*]*\*\/ )*$/.exec(before);
    if (m !== null) {
      out.add(Number(m[1]));
      continue;
    }
    // An assignment's error is at its target: the site is the value after its `=`.
    const after = line.slice(d.col - 1);
    const a = /^[^=;]*?[^=!<>]=\s*\(*\/\*<(\d+)\*\//.exec(after);
    if (a !== null) {
      out.add(Number(a[1]));
      continue;
    }
    // R9: a return's error is at its `return`: the site is the value it gives back (module state read, results_d36.ts)
    const r = /^return\s+\(*\/\*<(\d+)\*\//.exec(after);
    if (r !== null) out.add(Number(r[1]));
  }
  return out;
}

const STMT_KINDS = new Set([
  "let",
  "using",
  "expr",
  "if",
  "while",
  "do",
  "for",
  "forof",
  "switch",
  "block",
  "label",
  "break",
  "continue",
  "return",
  "try",
]);

/**
 * Class printing with strings (D67): a string intrinsic of compiler/rt prints as a call on JsString, with the operands
 * the lowering gave it, so its expansion into loads and stores at the lowering's offsets is never printed or walked.
 */
let strTagsOnly = false;

/** The operands a tagged string intrinsic prints with, where its expansion isn't walked. */
function strArgs(o: unknown): TE[] | null {
  if (!strTagsOnly) return null;
  const t = (o as { strop?: { args: TE[] } }).strop;
  return t === undefined ? null : t.args;
}

/** The lowering's node for run-time strings (D42): `string`'s flow class. */
function isStrNode(n: HeapNode): boolean {
  const m = findNode(n) as HeapNode & { chainOnly?: boolean };
  return m.klass === "string" && m.chainOnly === true;
}

/** R10: whether a part of R10 is turned off by TMK_R10_OFF, for computing what it moved (tools/r10-pins.ts). */
export function r10Off(part: string): boolean {
  return (process.env.TMK_R10_OFF ?? "").split(",").includes(part);
}

/** R11: whether a part of R11 is turned off by TMK_R11_OFF, for computing what it moved (tools/r11-pins.ts). */
export function r11Off(part: string): boolean {
  return (process.env.TMK_R11_OFF ?? "").split(",").includes(part);
}

/** R12: whether a part of R12 is turned off by TMK_R12_OFF, for computing what it moved (tools/r12-pins.ts). */
export function r12Off(part: string): boolean {
  return (process.env.TMK_R12_OFF ?? "").split(",").includes(part);
}

/** R16: whether a part of R16 is turned off by TMK_R16_OFF, for computing what it moved (tools/r16-pins.ts). */
export function r16Off(part: string): boolean {
  return (process.env.TMK_R16_OFF ?? "").split(",").includes(part);
}

/**
 * R12: class printing in `strict` (pile item 7) prints a program's objects as TSL classes and nothing else of phase 2: no
 * `JsArray`, `JsString`, `JsMap`, environment class, `Dyn` or layout class for a typed array, as each of those is
 * `@tsl/jsrt`'s or `@tsl/std`'s, a runtime `strict` code doesn't have (the kernel stays `strict` and `noStd`). Where a
 * program needs one, the printing refuses, and `auto` prints it as phase 1 did.
 */
export const STRICT_CLASSES_ONLY = "in strict, only objects print as classes (R12): not ";

/** R9: an array element that's a byte: a boolean (`bool` is 1 byte, 3.4), or nothing, of an array never given one. */
function byteElem(es: Shape): "bool" | "void" | null {
  if (es.s === "bool" && !r9Off("boolvecs")) return "bool";
  if (es.s === "void" && !r9Off("voidvecs")) return "void";
  return null;
}

/** R9: a number the tree has as a constant (a literal, or a conversion of one), or null. */
function constNum(te: TE): number | null {
  if (te.k === "lit" && (typeof te.value === "number" || typeof te.value === "bigint"))
    return Number(te.value);
  if (te.k === "conv") return constNum(te.val);
  return null;
}

/**
 * R9: a typed array's own pointer (`part<Ref>(a, 0, 1)`), or an element's address past it (`elemAddr`, as `subarray`,
 * `slice` and `set` make), which the lowering only reads and writes elements at, never keeps: an address, not a class's.
 */
function isArrPtr(te: TE): boolean {
  if (te.k === "slice") return te.from === 0 && te.val.ty.k === "arr";
  if (te.k === "elemaddr") return isArrPtr(te.base);
  return false;
}

function isArrSh(sh: unknown): boolean {
  return (sh as Shape | undefined)?.s === "arr";
}

function isStrSh(sh: unknown): boolean {
  const x = sh as Shape | undefined;
  return x !== undefined && x.s === "obj" && isStrNode(x.node);
}

/**
 * The string runtime's functions JsString does (D67), each a call on it: its core, which keeps D42's representation. The
 * rest of compiler/rt prints as TSL over the class's units, and `strConcat` as JS's length check before `concat`.
 */
/** A native caller's string functions (4.5), printed over JsString where strings are (D67). */
const STR_ABI = ["__str_place", "__str_units", "__str_length"];

// A static's text is what it's called by: the makers are JsFlat's, and equality, which takes nulls, a function (pipe-split).
const STR_CORE: Record<string, { name: string; static: boolean }> = {
  strSub: { name: "sub", static: false },
  strChar: { name: "JsFlat.ofUnit", static: true },
  strEq: { name: "jsEq", static: true },
  strCmp: { name: "compare", static: false },
  strCpLen: { name: "cpLen", static: false },
};

/** R10: JsString's surface as `rc` prints it, over the program's own JsStr (emit-rcstr.ts). */
const RC_STR_MAP: Record<string, string> = {
  JsString: "JsStr",
  "JsFlat.zeroed": "jsStrZeroed",
  "JsFlat.of": "jsStrOf",
  "JsFlat.ofUnits": "jsStrOfUnits",
  "JsFlat.ofUnit": "jsStrOfUnit",
  jsEq: "jsStrEq",
};

/** Every statement under a root, those inside statement-expressions included. */
function walkStmtsAll(root: unknown, f: (s: Stmt) => void): void {
  const seen = new Set<object>();
  const visit = (x: unknown): void => {
    if (x === null || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const y of x) visit(y);
      return;
    }
    const o = x as Record<string, unknown>;
    const sa = strArgs(o);
    if (sa !== null) {
      visit(sa);
      return;
    }
    if (typeof o.k === "string" && o.ty === undefined && STMT_KINDS.has(o.k))
      f(o as unknown as Stmt);
    for (const [k, v] of Object.entries(o)) if (isChild(k, v)) visit(v);
  };
  visit(root);
}

/** A flow class printed as a TSL class (phase 2): its name and each field's TSL name, type and initialiser. */
interface ClassPlan {
  name: string;
  base?: string; // the class's own name, before any qualifying
  note?: string; // why the name has a number, printed above it
  fields: Map<string, PlanField>;
  // An environment class (R3): made by its constructor, which takes every field, in this order, a kind's own captures
  // and, for a field another kind's capture has, its zero (`null` for a reference, which then can be null)
  env?: PlanField[];
}

/** R19: the most lines a closure kind's method body may have to be inlined where its environment's `call` calls it. */
const SMALL_KIND = 6;

// What isn't a child: shapes, instances, variables, globals, annotations and thunks. `c` is a condition (an `if`'s, a
// loop's, a `?:`'s) or a class: visited when it's an expression.
const SKIP_KEYS = new Set([
  "sh",
  "inst",
  "v",
  "g",
  "f",
  "fld",
  "glob",
  "deps",
  "range",
  "info",
  "stack",
  "long",
  "rcRefs",
  "rcOwn",
  "ty",
  "strop",
]);

function isChild(k: string, v: unknown): boolean {
  if (SKIP_KEYS.has(k)) return false;
  if (k === "c") return typeof v === "object" && v !== null && "k" in v && "ty" in v;
  return true;
}

/** Every typed-tree expression under a list of statements, lowered kinds and statement-expressions included. */
function eachTE(root: unknown, f: (te: TE) => void): void {
  const seen = new Set<object>();
  const visit = (x: unknown): void => {
    if (x === null || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const y of x) visit(y);
      return;
    }
    const o = x as Record<string, unknown>;
    const sa = strArgs(o);
    if (sa !== null) visit(sa);
    else for (const [k, v] of Object.entries(o)) if (isChild(k, v)) visit(v);
    if (typeof o.k === "string" && o.ty !== undefined) f(o as unknown as TE);
  };
  visit(root);
}

class Emitter {
  r: DownResult;
  memory: string;
  from: string;
  out: string[] = [];
  coreUsed = new Set<string>();
  loweredUsed = new Set<string>();
  topNames = new Set<string>();
  fnNames = new Map<FuncInst, string>();
  globalNames = new Map<GlobalDef, string>();
  dataNames = new Map<string, string>(); // a module-state global's TIR name to its TSL name
  runtimeGlobals = new Set<string>();
  intrinsics = 0;
  memoryOps = 0;
  hoisted = 0;
  restructured = 0;
  /** R12: why, each time: what tools/route-blockers.ts says of a reshaped program. */
  reshapedWhy = new Map<string, number>();
  reshape(why: string): void {
    this.restructured++;
    this.reshapedWhy.set(why, (this.reshapedWhy.get(why) ?? 0) + 1);
  }
  runtime: string[] = [];
  strings: Map<string, number>;
  // `tmk milestone pipe-a`'s injected bugs, each of which the dual-route differential has to catch. Never set otherwise.
  fault = process.env.TMK_TEST_EMIT ?? "";
  curInst: FuncInst | null = null;
  /**
   * The runtime's number text (compiler/rt/num.ts) makes typed arrays in a function, on its stack, which class printing
   * has no TSL class for yet (the number-text step, design/pipeline.md section 9): in the runtime's own functions they're
   * printed as phase 1 prints them, through @tsl/lowered, so that exceptions, whose description has numbers, print (D68).
   */
  rtScratch(f: FuncInst): boolean {
    return f.key.includes("/compiler/rt/");
  }
  excOwn = false; // exceptions desugared here (emit-exc.ts, D68), with their state and the native caller's ABI printed here

  // Per function.
  varNames = new Map<Var, string>();
  usedNames = new Set<string>();
  topDecls = new Map<string, string>(); // hoisted declarations: name to type
  effectOf: TE | null = null; // the expression `effect` is printing, whose value nothing uses
  topRefs = new Set<string>(); // of those, the ones holding a class's reference, which `rc` counts (R2)
  declared = new Set<Var>();
  hoistedVars = new Set<Var>(); // declared at the function's top: their lets are assignments
  assignedVars = new Set<Var>(); // `rc` (R2): what the function assigns after declaring it
  body: string[] = [];
  ind = 1;
  pre: string[] = []; // statements the current statement needs before it
  loops: Loop[] = [];
  pendingLabel: string | null = null;
  nextTemp = 1;
  nextCont = 1;

  // Phase 2's class printing (EmitOptions.classes).
  classes: boolean;
  bangs = new Set<number>();
  marks = false;
  nextSite = 0;
  plans = new Map<HeapNode, ClassPlan>();
  varCls = new Map<Var, { node: HeapNode; nul: boolean }>();
  retCls = new Map<FuncInst, { node: HeapNode; nul: boolean }>();
  globSh = new Map<string, Shape>(); // module state printed as a TSL global: its lowering name to its shape
  members = new Map<FuncInst, { node: HeapNode; name: string }>(); // methods printed in their class, called on it
  envKinds = new Map<HeapNode, FuncInst[]>(); // R3: an environment's flow class, and the closures it can be of
  cloSigs = new Map<FuncInst, { params: string[]; ret: string }>(); // R3: a closure method's printed parameters
  faultSwap = new Map<string, string>(); // the injected `class-field` bug: reads of these fields swapped
  vecs = new Map<HeapNode, Shape>(); // vectors printed as @tsl/jsrt's JsArray (D66): each one's element shape
  // R9: a typed array made in a function (the lowering's pointer and length, the pointer an allocation): the allocation,
  // which prints as an object whose storage the array is, a layout class's `array(…)` field or a class's tail (D69)
  arrAllocs = new Set<TE>();
  // R6: a vector read whose bounds check `get` makes, without the lowering's assert of it (the printing's own copy).
  foldedReads = new Map<TE, Extract<TE, { k: "blockexpr" }>>();
  lastNonNull: { e: TE; inner: string } | null = null; // R6: the last null check printed, and what it checks
  nonNulls = 0; // R6: nonNull's calls left in the text
  foldedRead = new Set<TE>(); // R6: the reads whose bounds check is `get`'s alone
  vecElem = new Set<TE>(); // `elemaddr(data of a vector, i)` under an element's load or store, and that data's load
  stdUsed = new Set<string>(); // what the printing takes from @tsl/std
  vectors = true; // EmitOptions.vectors
  descUsed = new Set<string>(); // @tsl/core's scalars named as values, as a JsArray's element descriptor
  arenaRefUsed = false; // R13: `ref` from @tsl/jsrt/arena, an arena array's descriptor of a reference, in `strict`
  memberText = new Map<HeapNode, string[]>();

  // Strings as @tsl/jsrt's JsString (D67, EmitOptions.strings): the lowering's string node, the functions printed (not the
  // string runtime's core, which JsString is), the literals made in `__init`, and what's called on the class instead.
  strs = false;
  strNode: HeapNode | null = null;
  funcs: FuncInst[] = [];
  strLitInit: string[] = [];
  strMapped = new Map<FuncInst, { name: string; static: boolean }>();
  strConcatFn: FuncInst | null = null;
  jsrtUsed = new Set<string>();
  // R10: in `rc`, strings are the program's own JsStr and JsStrBuf (emit-rcstr.ts), counted as its classes are; whether
  // the printing reached them, so their runtime is printed.
  rcStrUsed = false;
  // Maps as @tsl/jsrt's JsMap and JsSet (D72, EmitOptions.maps): compiler/rt/map.ts's flow classes and functions, which
  // aren't printed, and each map's key and value.
  maps = false;
  closures = true; // R3: closure values as environment classes
  boundary = true; // R5: exported functions taking or giving objects, in D36's listed layout
  r9 = true; // R9: typed arrays made in functions, module state that's one, arrays of booleans and of nothing
  mapPlans = new Map<HeapNode, { keys: Shape; vals: Shape }>();
  mapCursors = new Set<HeapNode>();
  mapRt = new Map<FuncInst, string>();

  // One module per source module (EmitOptions.modules, D65).
  modules = false;
  homes: Map<string, ts.SourceFile> | null = null; // pass two: where what has no module of its own goes
  users: Users = new Map(); // pass one: who uses it
  curMod: ts.SourceFile | null = null;
  fnMod = new Map<FuncInst, ts.SourceFile>();
  modTaken = new Map<ts.SourceFile, Set<string>>();
  importsOf = new Map<ts.SourceFile, Map<ts.SourceFile, Map<string, string>>>(); // module to owner to name to alias
  exportsOf = new Map<ts.SourceFile, Set<string>>();
  planMod = new Map<HeapNode, ts.SourceFile>();
  importOwners: Map<ts.SourceFile, Set<ts.SourceFile>> | null = null; // pass two: what each module imports from
  modDecls = new Map<ts.SourceFile, Set<string>>(); // what each module declares at its top level
  classText = new Map<HeapNode, string>();
  holders = new Map<string, { name: string; decl: string[]; newFn?: string }>();
  gcUsed = new Set<string>(); // R3: what the printing takes from @tsl/gc // rc's array and map holders (R2), by what they hold

  constructor(r: DownResult, memory: string, from: string, classes = false) {
    this.r = r;
    this.memory = memory;
    this.from = from;
    this.strings = r.typed.strings;
    this.classes = classes;
  }

  declIn(sf: ts.SourceFile): Set<string> {
    let d = this.modDecls.get(sf);
    if (d === undefined) {
      d = new Set();
      this.modDecls.set(sf, d);
    }
    return d;
  }

  /** The names taken at the top level of a module, starting with what the imports from @tsl/core and @tsl/lowered take. */
  takenIn(sf: ts.SourceFile): Set<string> {
    let t = this.modTaken.get(sf);
    if (t === undefined) {
      t = new Set([...LOWERED_NAMES, ...CORE_NAMES]);
      this.modTaken.set(sf, t);
    }
    return t;
  }

  get rootSf(): ts.SourceFile {
    return this.r.sourceFiles[this.r.sourceFiles.length - 1]!;
  }

  /** The module a piece of module state or static data is in: its declaration's, or for what has none, its home. */
  modOfData(name: string): ts.SourceFile | undefined {
    const g = this.r.globalFiles.get(name);
    if (g !== undefined) return g;
    return this.homes === null ? undefined : (this.homes.get(`data:${name}`) ?? this.rootSf);
  }

  modOfPlan(n: HeapNode): ts.SourceFile | undefined {
    const m = this.planMod.get(n);
    if (m !== undefined) return m;
    return this.homes === null ? undefined : (this.homes.get(`cls:${n.id}`) ?? this.rootSf);
  }

  /**
   * A top-level name as the module being printed refers to it: as it is in its own module, and imported (with an alias
   * where the name is taken here) from another. `owner` undefined: pass one, which only notes who uses it.
   */
  ref(owner: ts.SourceFile | undefined, key: string, name: string): string {
    if (!this.modules || this.curMod === null) return name;
    if (owner === undefined || this.homes === null) {
      const set = this.users.get(key) ?? new Set();
      set.add(this.curMod);
      this.users.set(key, set);
    }
    if (owner === undefined || owner === this.curMod) return name;
    const byOwner =
      this.importsOf.get(this.curMod) ?? new Map<ts.SourceFile, Map<string, string>>();
    this.importsOf.set(this.curMod, byOwner);
    const names = byOwner.get(owner) ?? new Map<string, string>();
    byOwner.set(owner, names);
    let alias = names.get(name);
    if (alias === undefined) {
      // Named for its module wherever the name is declared here, or in another module this one imports from too, so
      // which import comes first decides nothing (D65).
      const taken = this.takenIn(this.curMod);
      const others = [...(this.importOwners?.get(this.curMod) ?? [])].filter((o) => o !== owner);
      const clash =
        this.declIn(this.curMod).has(name) || others.some((o) => this.declIn(o).has(name));
      alias = clash ? `${name}_in${stemCap(owner)}` : name;
      if (taken.has(alias) && alias !== name) {
        // numbered: two imports are named for the same module, which only two modules with one file name can give.
        for (let i = 2; taken.has(`${alias}_${i}`); i++) alias = `${name}_in${stemCap(owner)}_${i}`;
      }
      taken.add(alias);
      names.set(name, alias);
    }
    const ex = this.exportsOf.get(owner) ?? new Set<string>();
    ex.add(name);
    this.exportsOf.set(owner, ex);
    return alias;
  }

  refFn(f: FuncInst): string | undefined {
    const n = this.fnNames.get(f);
    return n === undefined
      ? undefined
      : this.ref(this.fnMod.get(f) ?? this.rootSf, `fn:${f.tirName}`, n);
  }

  refGlobal(g: GlobalDef): string | undefined {
    const n = this.globalNames.get(g);
    return n === undefined ? undefined : this.ref(this.modOfData(g.name), `data:${g.name}`, n);
  }

  refData(name: string): string | undefined {
    const n = this.dataNames.get(name);
    return n === undefined ? undefined : this.ref(this.modOfData(name), `data:${name}`, n);
  }

  /** The flow class of an object shape, or null for any other. */
  objNode(sh: unknown): { node: HeapNode; nul: boolean } | null {
    const x = sh as Shape | undefined;
    if (x === undefined || (x.s !== "obj" && (x.s !== "vec" || !this.classes))) return null;
    const n = findNode(x.node);
    // An `unknown` is null for `undefined` (D49), so it can always be null.
    return { node: this.canon(n), nul: x.nul !== undefined || n.dyn === true };
  }

  /**
   * An `unknown` and every class it can hold are one TSL class (D68): its class id says which, as a hierarchy's does
   * (D50), so a value going into one or coming out after `instanceof` is the same reference.
   */
  dynOf = new Map<HeapNode, HeapNode>();
  dynNode: HeapNode | null = null;
  dynRecs = new Set<object>(); // the classes an `unknown` can hold
  dynMembers: HeapNode[] = []; // their flow classes, which print as the `unknown`'s one class
  canon(n0: HeapNode): HeapNode {
    const n = findNode(n0);
    const d = this.dynOf.get(n);
    if (d !== undefined) return d;
    // Another flow class of one of those classes, such as one narrowed out of the `unknown` by `instanceof` or `typeof`:
    // the same reference, so the same class.
    if (this.dynNode !== null && n.classes !== undefined)
      for (const r of n.classes)
        if (this.dynRecs.has(r)) {
          this.dynOf.set(n, this.dynNode);
          return this.dynNode;
        }
    return n;
  }

  /** The program's `unknown`, and the classes it can hold, by the one class they print as. */
  findDyn(): void {
    if (!EMIT_EXC) return;
    let dyn: HeapNode | null = null;
    const onTE = (te: TE): void => {
      const sh = te.sh as Shape | undefined;
      if (dyn === null && sh !== undefined && sh.s === "obj" && findNode(sh.node).dyn === true)
        dyn = findNode(sh.node);
    };
    const src = this.r.excSource;
    if (src !== undefined) onTE({ sh: src.dynSh } as TE);
    for (const f of this.funcs) if (dyn === null) eachTE(f.body, onTE);
    if (dyn === null) return;
    const d: HeapNode = dyn;
    for (const t of d.dynTargets ?? []) {
      const n = findNode(t);
      if (n.kind !== "obj" || n.variants.length > 0 || n.weakOf !== undefined)
        this.fail("an unknown that can hold something other than a class instance");
      if (this.dynOf.has(n)) continue; // two that flowed in, since joined
      this.dynOf.set(n, d);
      this.dynMembers.push(n);
      for (const r of n.classes ?? []) this.dynRecs.add(r);
    }
    this.dynNode = d;
    // What's read out of an `unknown` once it's narrowed (a box, by `typeof`) is the same reference, read through a
    // local the `unknown` went into: whatever such a local is read as is that class too.
    const seen = new Map<Var, Set<HeapNode>>();
    const add = (v: Var, sh: unknown): void => {
      const x = sh as Shape | undefined;
      if (x === undefined || x.s !== "obj") return;
      const set = seen.get(v) ?? new Set<HeapNode>();
      set.add(findNode(x.node));
      seen.set(v, set);
    };
    for (const f of this.funcs) {
      eachTE(f.body, (te) => {
        if (te.k === "var") add(te.v, te.sh);
        if (te.k === "setvar") add(te.v, te.val.sh);
      });
      walkStmtsAll(f.body, (st) => {
        if (st.k === "let" && st.init !== null) add(st.v, st.init.sh);
      });
    }
    for (const set of seen.values()) {
      if (![...set].some((n) => n === d)) continue;
      for (const n of set)
        if (n !== d && !this.dynOf.has(n)) {
          if (n.kind !== "obj" || n.variants.length > 0 || n.weakOf !== undefined)
            this.fail("an unknown narrowed to something other than a class instance");
          this.dynOf.set(n, d);
          this.dynMembers.push(n);
          for (const r of n.classes ?? []) this.dynRecs.add(r);
        }
    }
  }

  /** The vector whose data pointer `te`, an `elemaddr`, indexes, or null. */
  vecData(te: TE): TE | null {
    if (te.k !== "elemaddr" || te.base.k !== "fload") return null;
    const d = te.base;
    if (d.mem.length !== 1 || d.mem[0]!.off !== VEC_DATA || d.mem[0]!.t !== "ptr") return null;
    return (d.base.sh as Shape | undefined)?.s === "vec" ? d.base : null;
  }

  /** Whether `te` loads or stores a vector's length. */
  isVecLen(te: TE): boolean {
    if (te.k !== "fload" && te.k !== "fstore") return false;
    if (te.mem.length !== 1 || te.mem[0]!.off !== VEC_LEN || te.mem[0]!.t !== "ix") return false;
    return (te.base.sh as Shape | undefined)?.s === "vec";
  }

  /** A call to the vector runtime that JsArray does instead: `new` or `reserve`. */
  vecRt(te: Extract<TE, { k: "rtcall" }>): "new" | "reserve" | null {
    if (te.name.startsWith("__vec_new") && (te.sh as Shape | undefined)?.s === "vec") return "new";
    if (te.name.startsWith("__vec_reserve") && (te.args[0]?.sh as Shape | undefined)?.s === "vec")
      return "reserve";
    return null;
  }

  /** A vector's element type in the text: a number's TSL type, or a class or vector that a hole makes `| null`. */
  vecElemText(es: Shape): string {
    if (es.s === "num") return this.tyText(locTy(es.loc));
    // R9: an array of booleans is one of bytes, 0 and 1, a `bool`'s own layout (3.4); an array nothing is ever put in, of
    // bytes too (it's never read)
    if (this.byteElem(es) !== null)
      // the injected `bool-elem-size` bug (R9): an array of booleans laid out two bytes an element, not a `bool`'s one
      return this.tyText({
        k: "int",
        name: this.fault === "bool-elem-size" && this.byteElem(es) === "bool" ? "u16" : "u8",
      });
    if (es.s === "obj" || es.s === "vec") return `${this.clsName(findNode(es.node))} | null`;
    const ae = this.arrVecElem(es);
    if (ae !== null) return `${this.arrVecHelpers(ae).holder} | null`;
    return this.fail(`a vector of ${es.s}`);
  }

  /** `new JsArray(desc, len)`: the element's descriptor, @tsl/core's scalar or @tsl/std's `ref`. */
  vecNewText(n: HeapNode, len0: string): string {
    let len = len0;
    const es = this.vecs.get(findNode(n));
    if (es === undefined) return this.fail("a vector that wasn't planned");
    if (!this.rc) this.stdUsed.add("JsArray");
    let desc: string;
    if (es.s === "num" || this.byteElem(es) !== null) {
      desc = this.vecElemText(es);
      this.descUsed.add(desc);
    } else {
      this.useRef();
      desc = `ref<${this.vecElemText(es)}>()`;
    }
    // the injected `void-vec-room` bug (R9): an array of nothing made 2^28 long, room for elements it never has,
    // which only the memory it takes shows
    if (this.fault === "void-vec-room" && this.byteElem(es) === "void") len = "268435456";
    if (this.rc) return `${this.holderOf(es).newFn!}(${len})`;
    // R13: in `strict`, the arena array, whose buffers are the call arena's, which the caller resets (nothing to give back)
    // the injected `arena-short` bug (R13): an arena array made one element shorter than asked for
    if (this.memory === "strict") {
      const n =
        this.fault === "arena-short"
          ? `(${len} > 0 ? ${this.lowered("wrap")}<usize>(${len} - 1) : ${len})`
          : len;
      return `new JsArenaArray(${desc}, ${n})`;
    }
    // In `leak` an outgrown buffer is kept, as the direct route's leak vectors keep theirs (3.5).
    // R17: an array of numbers (or of bytes) has no holes, as JsRoomArray's says in `rc`: the lowering traps 15 before it
    // would make one, so the slots a shorter length drops needn't be zeroed (a longer one zeroes what it adds). For tools/r17-pins.ts, TMK_R17_OFF=holes says every array may have them, and =jsrt prints JsArray's
    // constructor as it was before R17 gave it the flag.
    const scalar = es.s === "num" || this.byteElem(es) !== null;
    const holes = r17Off("jsrt") ? "" : scalar && !r17Off("holes") ? ", false" : ", true";
    return `new JsArray(${desc}, ${len}, ${this.memory === "leak" ? "false" : "true"}${holes})`;
  }

  /**
   * Phase 2: which flow classes become TSL classes, and every reference's class. Everything a reference can be has to be
   * one of them, or the program isn't printable this way yet: a vector, a typed array kept as a reference, a closure's
   * environment, an `unknown`, a string, module state reached by address.
   */
  planClasses(): void {
    // R12: in `strict` too, where tslc places what escapes its function in the call arena the direct route uses (tslc.ts),
    // and refuses the printing where something would outlive the export call; TMK_R12_OFF=strict refuses it, as before.
    if (
      this.memory !== "leak" &&
      this.memory !== "manual" &&
      this.memory !== "rc" &&
      !(this.memory === "strict" && !r12Off("strict"))
    )
      this.fail(`classes in "${this.memory}", which TSL proper's escaping new doesn't have yet`);
    this.findDyn();
    if (this.memory === "strict" && this.dynNode !== null)
      this.fail(`${STRICT_CLASSES_ONLY}an unknown, which is a Dyn`);
    // Closures as values (R3): each lifted closure by the flow class of its environment, in the program's order.
    for (const f of this.funcs) {
      if (f.cloEnv === undefined) continue;
      if (!this.closures) this.fail("a closure value, which this build doesn't print (R3)");
      const n = this.canon(findNode(f.cloEnv.node as HeapNode));
      this.envKinds.set(n, [...(this.envKinds.get(n) ?? []), f]);
    }
    const want = (n0: HeapNode): void => {
      const n = this.canon(n0);
      if (this.plans.has(n) || this.vecs.has(n)) return;
      if (this.maps && this.planMap(n, want)) return;
      if (n.dyn === true && !EMIT_EXC) this.fail("an object that's an unknown");
      if (n.dyn === true) {
        // An `unknown` (D68): one class with the fields of everything it can hold.
        this.plans.set(n, { name: "", fields: new Map() });
        for (const t of this.dynMembers)
          for (const [, fsh] of t.fields) {
            if (fsh.s === "obj" || fsh.s === "vec") want(findNode(fsh.node));
            else if (fsh.s !== "num" && fsh.s !== "bool" && !(fsh.s === "str" && this.strs))
              this.fail(`a field of shape ${fsh.s}`);
          }
        return;
      }
      if (this.strs && isStrNode(n)) {
        // A string is @tsl/jsrt's JsString (D67): a class of its own, with nothing of it planned here.
        this.strNode = n;
        return;
      }
      if (n.kind === "vec" && this.vectors) {
        // A vector is @tsl/jsrt's JsArray of its element (D66), whose holes are zero: null for a reference.
        const es = n.elem ?? { s: "void" };
        if (
          es.s !== "num" &&
          es.s !== "obj" &&
          es.s !== "vec" &&
          this.byteElem(es) === null &&
          this.arrVecElem(es) === null
        )
          this.fail(`a vector of ${es.s === "bool" ? "booleans" : es.s}`);
        this.vecs.set(n, es);
        if (es.s === "obj" || es.s === "vec") want(findNode(es.node));
        return;
      }
      if (n.kind === "fn") {
        // A closure value (R3): its environment is a class of the program's own, holding what each closure that can be
        // here captures, with a kind field where there are several, and its call a method (design/pipeline.md, 2).
        const kinds = this.envKinds.get(n) ?? [];
        if (kinds.length === 0) this.fail("a closure value no closure reaches");
        this.plans.set(n, { name: "", fields: new Map() });
        for (const f of kinds)
          for (const c of f.cloEnv!.caps) {
            const sh = c.sh as Shape;
            if (sh.s === "obj" || sh.s === "vec") want(findNode(sh.node));
            else if (sh.s !== "num" && sh.s !== "bool" && !(sh.s === "str" && this.strs))
              this.fail(`a closure capturing a value of shape ${sh.s}`);
          }
        return;
      }
      if (n.kind !== "obj") this.fail(`a reference to a ${n.kind}, not an object`);
      if (n.weakOf !== undefined || n.variants.length > 0)
        this.fail("an object that's a WeakRef or a union");
      this.plans.set(n, { name: "", fields: new Map() });
      for (const [, fsh] of n.fields) {
        if (fsh.s === "obj" || fsh.s === "vec") want(findNode(fsh.node));
        else if (
          fsh.s !== "num" &&
          fsh.s !== "bool" &&
          !(fsh.s === "str" && this.strs) &&
          !isOptScalar(fsh) &&
          !this.arrField(fsh)
        )
          this.fail(`a field of shape ${fsh.s}`);
      }
    };
    const note = (
      m: Map<unknown, { node: HeapNode; nul: boolean }>,
      k: unknown,
      sh: unknown,
    ): void => {
      const o = this.objNode(sh);
      if (o === null) return;
      want(o.node);
      const had = m.get(k);
      if (had !== undefined && had.node !== o.node) this.fail("a variable holding two classes");
      m.set(k, { node: o.node, nul: o.nul || (had?.nul ?? false) });
    };
    const varMap = this.varCls as Map<unknown, { node: HeapNode; nul: boolean }>;
    // A lifted closure's first parameter is its environment (R3), which it's a method of.
    for (const [n, kinds] of this.envKinds) {
      want(n);
      for (const f of kinds) varMap.set(f.params[0]!, { node: n, nul: false });
    }
    // Nullability by what's assigned (a read's shape is the binding's, joined with everything that flowed in), so a
    // `const p = new P()` is a P. `this` never is null. What tsc can't then see is found from its errors (bangs).
    const nul = new Set<unknown>();
    const mayBeNull = (te: TE | null): boolean => {
      if (te === null) return false;
      if (te.k === "lit") return te.ty.k === "ref";
      if (te.k === "alloc" || te.k === "nonnull") return false;
      if (te.k === "blockexpr" || te.k === "seq") return mayBeNull(te.result);
      if (te.k === "var") return nul.has(te.v);
      if (te.k === "setvar") return mayBeNull(te.val);
      if (te.k === "cond") return mayBeNull(te.a) || mayBeNull(te.b);
      // A map's `get` of a reference is JsMap's `getOr(k, null)`: null for JS's undefined, where the key isn't there.
      if (te.k === "call") return nul.has(te.inst) || this.mapRt.get(te.inst) === "get";
      const o = this.objNode(te.sh);
      return o === null || o.nul;
    };
    const retMap = this.retCls as Map<unknown, { node: HeapNode; nul: boolean }>;
    // Module state, read and written whole by name: a TSL global. Its address taken any other way isn't printable yet.
    const okBase = new Set<TE>();
    for (const f of this.funcs)
      eachTE(f.body, (te) => {
        if (
          (te.k === "fload" || te.k === "fstore") &&
          te.glob !== undefined &&
          te.base.k === "gaddr"
        ) {
          okBase.add(te.base);
          const sh = te.glob.sh as Shape;
          if (
            sh.s !== "num" &&
            sh.s !== "bool" &&
            sh.s !== "obj" &&
            sh.s !== "vec" &&
            !(sh.s === "arr" && this.globArr(sh))
          )
            this.fail(`module state of shape ${sh.s}`);
          if (sh.s === "obj" || sh.s === "vec") want(findNode(sh.node));
          this.globSh.set(te.glob.name, sh);
        }
      });
    // Exceptions desugared here: the thrown value's class, which the native caller's __exc_take gives, whatever is thrown.
    if (this.excOwn) want(findNode((this.r.excSource!.dynSh as Extract<Shape, { s: "obj" }>).node));
    // A vector's element: a load or store at `elemaddr(load of its data pointer, i)`, which prints as `v.get(i)` and
    // `v.set(i, x)`. Its data pointer is never reached any other way.
    for (const f of this.funcs)
      eachTE(f.body, (te) => {
        if ((te.k === "fload" || te.k === "fstore") && this.vecData(te.base) !== null) {
          this.vecElem.add(te.base);
          this.vecElem.add((te.base as Extract<TE, { k: "elemaddr" }>).base);
        }
      });
    // R6: a vector read the lowering checks for bounds (`assert(i < v.length, Trap.Bounds)`, then the element) where JsArray's
    // own `get` makes the same check, trapping 2 below the length as the assert does, prints as `v.get(i)` alone, as a
    // person writes it: one check where -O1 made two (M5's R5 record). Only the code is observable, never the site.
    if (this.classes && !r6Off("checks"))
      for (const f of this.funcs)
        eachTE(f.body, (te) => {
          if (te.k !== "blockexpr" || te.body.length === 0) return;
          const last = te.body[te.body.length - 1]!;
          if (last.k !== "expr" || last.e.k !== "builtin" || last.e.name !== "assert") return;
          const [c, code] = last.e.args;
          if (code?.k !== "lit" || Number(code.value) !== 2 || c?.k !== "cmp" || c.op !== "lt")
            return;
          const r = te.result;
          if (r.k !== "fload" || !this.vecElem.has(r.base)) return;
          const el = r.base as Extract<TE, { k: "elemaddr" }>;
          const v = this.vecData(el);
          if (v === null || !this.isVecLen(c.b)) return;
          const len = c.b as Extract<TE, { k: "fload" }>;
          // The same index variable, and the same vector, read through one variable or one expression object. R13: in
          // `strict`, or the same constant index (`planes[0]!`, the JPEG decoder's per-pixel reads), where -O1 kept both checks.
          const sameConst =
            this.memory === "strict" &&
            !r13Off("arrays") &&
            constNum(c.a) !== null &&
            constNum(c.a) === constNum(el.idx);
          if (!sameConst && (c.a.k !== "var" || el.idx.k !== "var" || c.a.v !== el.idx.v)) return;
          const same =
            len.base === v || (len.base.k === "var" && v.k === "var" && len.base.v === v.v);
          if (!same) return;
          this.foldedReads.set(te, { ...te, body: te.body.slice(0, -1) });
          this.foldedRead.add(r);
        });
    // R9: each typed array made in a function, a pointer and a length whose pointer is an allocation of its bytes.
    if (!r9Off("arrays") && this.r9)
      for (const f of this.funcs)
        eachTE(f.body, (te) => {
          if (
            te.k === "tuple" &&
            te.ty.k === "arr" &&
            te.items.length === 2 &&
            te.items[0]!.k === "alloc" &&
            ARRAY_BY_ELEM[te.ty.elem] !== undefined
          )
            this.arrAllocs.add(te.items[0]!);
        });
    let crossing = false;
    for (const f of this.funcs) {
      // What crosses an export (D36, R5): each class prints in D36's listed layout, and each array has a placing export.
      // Planned at the first export that takes or gives an object, where this printing used to stop at it.
      if (
        !crossing &&
        f.exported &&
        (f.ret.k === "ref" || f.params.some((p) => p.ty.k === "ref")) &&
        !this.strExport(f)
      ) {
        crossing = true;
        this.planBoundary(want);
      }
      const rt = this.rtScratch(f);
      eachTE(f.body, (te) => {
        if (
          te.ty.k === "ref" &&
          te.k !== "lit" &&
          te.k !== "alloc" &&
          !((rt || ARR_FIELDS) && te.k === "slice" && isArrSh(te.val.sh)) &&
          !(!r9Off("arrays") && this.r9 && isArrPtr(te)) &&
          !(te.k === "gaddr" && okBase.has(te)) &&
          this.objNode(te.sh) === null &&
          te.fld === undefined &&
          te.k !== "var" &&
          te.k !== "setvar" &&
          !this.vecElem.has(te) &&
          !(te.k === "fstore" && this.vecElem.has(te.base))
        )
          this.fail(
            `a reference from ${te.k}${te.k === "gaddr" ? ` ${te.name}` : ""} that isn't a class instance`,
          );
        if (te.k === "var") note(varMap, te.v, te.sh);
        if (te.k === "setvar") note(varMap, te.v, te.val.sh);
        if (te.k === "call" && te.inst.ret.k === "ref") note(retMap, te.inst, te.sh);
        // The runtime's scratch typed arrays: an allocation of no shape on the stack, packed with its length.
        if (
          te.k === "alloc" &&
          !this.arrAllocs.has(te) &&
          !(rt && te.sh === undefined && te.stack() !== null)
        ) {
          if (this.objNode(te.sh) === null)
            this.fail(
              `an allocation that isn't an object (${f.tirName} ${(te as { loc?: string }).loc ?? ""})`,
            );
          want(this.objNode(te.sh)!.node);
        }
        if (te.fld !== undefined) want(this.canon(te.fld.node as HeapNode));
        // A load or store that isn't a field or module state would be at the lowering's offset, not TSL's layout.
        if (
          (te.k === "fload" || te.k === "fstore") &&
          te.fld === undefined &&
          te.glob === undefined &&
          !this.vecElem.has(te.base) &&
          !this.isVecLen(te) &&
          !this.isStrLen(te) &&
          // A tagged string intrinsic prints as its call on JsString (strHash's hash word, pipe-h).
          strArgs(te) === null &&
          !(te.k === "fload" && this.vecElem.has(te))
        )
          this.fail(
            `a ${te.k} that isn't a field of a class or module state (${f.tirName}, offset ${(te as { mem?: { off: number }[] }).mem?.[0]?.off ?? "?"})`,
          );
        // An uncaught exception's description is read by the native caller's side, by the string ABI the build says.
        if (
          this.strs &&
          te.k === "throwjs" &&
          te.args.some((a) => isStrSh(a.sh)) &&
          !(this.excOwn && te.loc === "uncaught")
        )
          this.fail(
            "a thrown message with a string part, which the runtime reads at the lowering's offsets",
          );
        if (te.k === "gaddr" && !okBase.has(te) && !(this.strs && /^__strlit_\d+$/.test(te.name)))
          this.fail(`module state ${te.name} reached by address`);
        if (
          te.k === "rtcall" &&
          (te.ty.k === "ref" || te.args.some((a) => a.ty.k === "ref")) &&
          this.vecRt(te) === null &&
          !(this.strs && te.name === "$concat")
        )
          this.fail(`the runtime's ${te.name}, on references`);
      });
      walkStmtsAll(f.body, (st) => {
        if (st.k === "let" && st.init !== null) note(varMap, st.v, st.init.sh);
        if (st.k === "return" && st.val !== null && f.ret.k === "ref" && st !== this.deadTail(f))
          note(retMap, f, st.val.sh);
      });
    }
    // More evidence of a variable's class, to a fixed point: the base of a field's load or store is that field's class;
    // an argument and its parameter, a variable and what's assigned to it, a result and what's returned, are one class.
    const clsOfTE = (te: TE): { node: HeapNode; nul: boolean } | undefined => {
      const o = this.objNode(te.sh);
      if (o !== null) return o;
      if (te.k === "var" || te.k === "setvar") return this.varCls.get(te.v);
      if (te.k === "call") return this.retCls.get(te.inst);
      if (te.k === "blockexpr" || te.k === "seq") return clsOfTE(te.result);
      if (te.k === "alloc") return undefined;
      return undefined;
    };
    const link = (
      m: Map<unknown, { node: HeapNode; nul: boolean }>,
      k: unknown,
      c: { node: HeapNode; nul: boolean } | undefined,
    ): boolean => {
      if (c === undefined || m.has(k)) return false;
      m.set(k, { node: c.node, nul: false });
      return true;
    };
    for (let round = 0, changed = true; changed && round < 64; round++) {
      changed = false;
      for (const f of this.funcs) {
        eachTE(f.body, (te) => {
          if (
            (te.k === "fload" || te.k === "fstore") &&
            te.fld !== undefined &&
            te.base.k === "var"
          )
            changed =
              link(varMap, te.base.v, { node: this.canon(te.fld.node as HeapNode), nul: false }) ||
              changed;
          if (te.k === "setvar" && te.ty.k === "ref")
            changed = link(varMap, te.v, clsOfTE(te.val)) || changed;
          if (te.k === "call")
            te.args.forEach((a, i) => {
              const p = te.inst.params[i];
              if (p === undefined || p.ty.k !== "ref") return;
              changed = link(varMap, p, clsOfTE(a)) || changed;
              if (a.k === "var") changed = link(varMap, a.v, this.varCls.get(p)) || changed;
            });
          // A closure value's call (R3): each argument, and the parameter after the environment of each kind.
          if (te.k === "callclo") {
            const o = this.objNode(te.clo.sh);
            for (const k of o !== null ? (this.envKinds.get(o.node) ?? []) : [])
              te.args.forEach((a, i) => {
                const p = k.params[i + 1];
                if (p === undefined || p.ty.k !== "ref") return;
                changed = link(varMap, p, clsOfTE(a)) || changed;
                if (a.k === "var") changed = link(varMap, a.v, this.varCls.get(p)) || changed;
              });
          }
        });
        walkStmtsAll(f.body, (st) => {
          if (st.k === "let" && st.init !== null && st.v.ty.k === "ref")
            changed = link(varMap, st.v, clsOfTE(st.init)) || changed;
          if (st.k === "return" && st.val !== null && f.ret.k === "ref" && st !== this.deadTail(f))
            changed = link(retMap, f, clsOfTE(st.val)) || changed;
        });
      }
    }
    // Parameters: nullable as the TS declared them, which is the shape their reads have, or where a caller passes null
    // (a default's `undefined`); `this` never. A nullable argument to one that isn't was narrowed in the TS: a `!`.
    for (const f of this.funcs)
      for (const p of f.params) {
        const c = this.varCls.get(p);
        if (c !== undefined && c.nul && p.name !== "this") nul.add(p);
      }
    for (const f of this.funcs)
      eachTE(f.body, (te) => {
        if (te.k === "callclo") {
          // A closure kind's parameter given null (R3) can be null.
          const o = this.objNode(te.clo.sh);
          for (const k of o !== null ? (this.envKinds.get(o.node) ?? []) : [])
            te.args.forEach((a, i) => {
              const p = k.params[i + 1];
              if (p !== undefined && p.ty.k === "ref" && a.k === "lit") nul.add(p);
            });
          return;
        }
        if (te.k !== "call") return;
        te.args.forEach((a, i) => {
          const p = te.inst.params[i];
          if (p !== undefined && p.ty.k === "ref" && a.k === "lit" && p.name !== "this") nul.add(p);
        });
      });
    // To a fixed point: a variable is nullable if anything assigned to it can be, and so is a function's result.
    for (let round = 0, changed = true; changed && round < 64; round++) {
      changed = false;
      const mark = (k: unknown, te: TE | null): void => {
        if (!nul.has(k) && mayBeNull(te)) {
          nul.add(k);
          changed = true;
        }
      };
      for (const f of this.funcs) {
        eachTE(f.body, (te) => {
          if (te.k === "setvar" && te.ty.k === "ref") mark(te.v, te.val);
        });
        walkStmtsAll(f.body, (st) => {
          if (st.k === "let" && st.v.ty.k === "ref") {
            if (st.init === null) {
              if (!nul.has(st.v)) {
                nul.add(st.v);
                changed = true;
              }
            } else mark(st.v, st.init);
          }
          if (st.k === "return" && st.val !== null && f.ret.k === "ref" && st !== this.deadTail(f))
            mark(f, st.val);
        });
      }
    }
    for (const [k, c] of this.varCls) c.nul = nul.has(k);
    for (const [k, c] of this.retCls) c.nul = nul.has(k);
    // Names: the class it was made from, else `Obj`. A hierarchy is one class, named for its root: the class in it whose
    // base isn't. Two classes of one name in one module (two modules', printed as one file, or two functions' own) are
    // each named for where they're declared, `Square_inParseShapes`; a number only where that still leaves two (D65).
    const rootRec = (
      n: HeapNode,
    ): { jsName: string; decl?: ts.ClassLikeDeclaration } | undefined => {
      const recs = [
        ...((n.classes ?? new Set()) as Set<{
          jsName: string;
          base: unknown;
          decl?: ts.ClassLikeDeclaration;
        }>),
      ];
      return recs.find((r) => r.base === null || !recs.includes(r.base as never));
    };
    const klassName = (n: HeapNode): string =>
      n.dyn === true
        ? "Dyn"
        : n.kind === "fn"
          ? this.envBase(n)
          : sanitize(rootRec(n)?.jsName ?? n.klass ?? "Obj");
    const spaceOf = (n: HeapNode): ts.SourceFile => {
      const d = rootRec(n)?.decl;
      if (d !== undefined) this.planMod.set(n, d.getSourceFile());
      return this.modules ? (this.modOfPlan(n) ?? this.rootSf) : this.rootSf;
    };
    const baseCount = new Map<string, number>();
    const keyOf = (n: HeapNode): string => `${spaceOf(n).fileName}\0${klassName(n)}`;
    for (const [n] of this.plans) baseCount.set(keyOf(n), (baseCount.get(keyOf(n)) ?? 0) + 1);
    const plansSorted = [...this.plans].sort(([a], [b]) => {
      const pa = rootRec(a)?.decl?.pos ?? -1;
      const pb = rootRec(b)?.decl?.pos ?? -1;
      const fa = rootRec(a)?.decl?.getSourceFile().fileName ?? "";
      const fb = rootRec(b)?.decl?.getSourceFile().fileName ?? "";
      return fa < fb ? -1 : fa > fb ? 1 : pa - pb || a.id - b.id;
    });
    for (const [n, plan] of plansSorted) {
      const space = spaceOf(n);
      const taken = this.modules ? this.takenIn(space) : this.topNames;
      let base = klassName(n);
      if (baseCount.get(keyOf(n))! > 1) {
        const d = rootRec(n)?.decl;
        base = `${base}_in${whereOf(d, d?.getSourceFile() ?? space)}`;
      }
      if (RESERVED.has(base) || CORE_TYPES.includes(base)) base = `${base}_`;
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
      if (name !== base)
        plan.note = `numbered: another class here is also named ${base} once qualified by where it's declared`;
      taken.add(name);
      if (!this.modules) this.topNames.add(name);
      else this.declIn(space).add(name);
      plan.base = klassName(n);
      plan.name = name;
      const used = new Set<string>();
      if (n.kind === "fn") {
        this.planEnv(n, plan, used);
        continue;
      }
      // The class id first, as D50 lays it out; then the fields in the order the lowering met them. A field two sibling
      // classes both declare is two fields, the second named for its class.
      const order = this.fieldOrder(n);
      // An `unknown`'s class (D68, pipe-h): each object is of one of the classes it can hold, so fields of two of them are
      // never both live, and one field of a type holds each class's field of that type (`slots`, below).
      const dynFields: { key: string; member: string; own: string; f: PlanField }[] = [];
      for (const [key, fsh] of order) {
        // In an `unknown`'s class (D68) a field is keyed by the class it's from, `12|message`.
        const from = /^(\d+)\|/.exec(key);
        const own = from !== null ? key.slice(from[0].length) : key;
        let fname = own === "$cls" ? "cid" : sanitize(own.replace(/@.*$/, ""));
        if (RESERVED.has(fname)) fname = `${fname}_`;
        if (used.has(fname) && /@/.test(own))
          fname = `${fname}_${sanitize(own.replace(/^[^@]*@/, "").replace(/:.*$/, ""))}`;
        if (used.has(fname) && from !== null) {
          const t = this.dynMembers.find((x) => x.id === Number(from[1]));
          if (t !== undefined) fname = `${fname}_${klassName(t)}`;
        }
        let u = fname;
        for (let i = 2; used.has(u); i++) u = `${fname}_${i}`;
        used.add(u);
        let ty: string;
        let init: string | null;
        if (fsh.s === "num" && own === "$cls" && n.dyn === true && !DYN_UNSHARED) {
          // An `unknown`'s class id in two bytes (pipe-h), so a byte-sized field and a 4-byte one pack into its word.
          ty = "u16";
          init = "0";
          this.coreUsed.add("u16");
        } else if (fsh.s === "num") {
          ty = this.tyText(locTy(fsh.loc));
          init = "0";
        } else if (fsh.s === "bool") {
          ty = this.tyText({ k: "bool" });
          init = "false";
        } else if (fsh.s === "str" && this.strs) {
          // A literal union's small integer (4.5): the lowering's `str` shape, which a program with run-time strings never
          // has (its literals are strings there), so never a JsString, as this printed it until R5 found it
          ty = "i32";
          init = "0";
          this.coreUsed.add("i32");
        } else if (fsh.s === "obj" || fsh.s === "vec") {
          const target = this.canon(fsh.node);
          ty = target === n ? "@SELF@" : `@CLS${target.id}@`;
          // An `unknown` field is null for `undefined` (D49).
          const nullable = fsh.nul !== undefined || findNode(fsh.node).dyn === true;
          init = nullable ? "null" : null;
          if (nullable) ty = `${ty} | null`;
        } else if (this.arrField(fsh) && n.dyn !== true) {
          // R7: a typed array, its pointer and length in a runtime class of the program's own held in place (D37), which
          // TSL lays out where D36 lists the array: the pointer at its offset, the length 8 past it
          const ctor = ARRAY_BY_ELEM[fsh.elem]!;
          const holder = this.arrFieldClass(ctor);
          plan.fields.set(key, { name: u, ty: holder, init: `new ${holder}()`, arr: ctor });
          continue;
        } else if (isOptScalar(fsh) && n.dyn !== true) {
          // R7: an optional scalar is two fields, its flag a `bool` just before its value (D62's first ruling), which TSL
          // lays out where D36 lists the optional: the flag at its offset, the value at the next its alignment allows.
          let fl = `${u}_has`;
          for (let i = 2; used.has(fl); i++) fl = `${u}_has${i}`;
          used.add(fl);
          const flag: PlanField = { name: fl, ty: this.tyText({ k: "bool" }), init: "false" };
          plan.fields.set(`${key}$has`, flag);
          const vt = tyOf(fsh.of);
          plan.fields.set(key, {
            name: u,
            ty: this.tyText(vt),
            init: vt.k === "bool" ? "false" : "0",
            flag,
          });
          continue;
        } else this.fail(`a field of shape ${fsh.s}`);
        if (n.dyn === true && from !== null && !DYN_UNSHARED)
          dynFields.push({ key, member: from[1]!, own: fname, f: { name: u, ty, init } });
        else plan.fields.set(key, { name: u, ty, init });
      }
      if (dynFields.length > 0) this.dynSlots(plan, dynFields);
    }
    // R5: what crosses an export, in D36's listed layout.
    this.layBoundary();
    // `pipe-b`'s injected bug: two fields of one type in a class swapped, as a printer that named the wrong field would.
    if (this.fault === "class-field")
      for (const plan of this.plans.values()) {
        const fs = [...new Set(plan.fields.values())].filter((f) => f.name !== "cid");
        const a = fs.find((f) => fs.some((g) => g !== f && g.ty === f.ty));
        const b = a !== undefined ? fs.find((g) => g !== a && g.ty === a.ty) : undefined;
        if (a !== undefined && b !== undefined) {
          this.faultSwap.set(a.name, b.name).set(b.name, a.name);
          break;
        }
      }
  }

  /**
   * An `unknown`'s fields sharing storage (D68, pipe-h): a field of one class it can hold takes the first field of the
   * same type and initial value that no field of its own class has taken, so the class is as big as the biggest of them
   * per type, not all of them side by side. A shared field is named for what it holds (`v_or_message`). Then the small
   * fields go after the class id, smallest first, so they pack into its word, and the 8-byte fields after them.
   */
  dynSlots(
    plan: { fields: Map<string, PlanField> },
    fields: { key: string; member: string; own: string; f: PlanField }[],
  ): void {
    const slots: { f: PlanField; owns: string[]; members: Set<string>; keys: string[] }[] = [];
    for (const x of fields) {
      const s = slots.find(
        (y) =>
          y.f.ty === x.f.ty &&
          y.f.init === x.f.init &&
          (!y.members.has(x.member) || this.fault === "dyn-slot-own"),
      );
      if (s === undefined) {
        slots.push({ f: x.f, owns: [x.own], members: new Set([x.member]), keys: [x.key] });
        continue;
      }
      s.members.add(x.member);
      if (!s.owns.includes(x.own)) s.owns.push(x.own);
      s.keys.push(x.key);
    }
    const taken = new Set([...plan.fields.values()].map((f) => f.name));
    for (const s of slots) {
      if (s.owns.length > 1) {
        const want = s.owns.length <= 3 ? s.owns.join("_or_") : `${s.owns[0]!}_shared`;
        let u = want;
        for (let i = 2; taken.has(u); i++) u = `${want}_${i}`;
        s.f.name = u;
      }
      taken.add(s.f.name);
    }
    const size = (ty: string): number =>
      /^(bool|i8|u8)$/.test(ty)
        ? 1
        : /^(i16|u16)$/.test(ty)
          ? 2
          : /^(i32|u32|f32)$/.test(ty)
            ? 4
            : 8;
    const rank = (z: number): number => (z < 8 ? z : 100);
    const order = slots
      .map((s, i) => ({ s, i, r: rank(size(s.f.ty)) }))
      .sort((a, b) => a.r - b.r || a.i - b.i);
    for (const { s } of order) for (const k of s.keys) plan.fields.set(k, s.f);
  }

  /**
   * R23, `rc`: an `unknown`'s reference fields that nothing printed ever stores to (`SuppressedError`'s `error` and
   * `suppressed` in a program that never makes one) are always null, so each prints as a getter giving null, not a field,
   * and the class's release function visits only the slots that can hold something. Each keeps its 8 bytes as a field
   * that holds no reference (`<name>_none: u64`), so the object is as big as it was and stays in its size class: R22
   * found that a smaller `Dyn` moved to the 64-byte class and corpus/lower/exc/exc_exhaust.ts then ran out of pages, as
   * the collector's chunks stay their size class's. A read is the same null it always was; there is no store to keep.
   */
  noneFields(): void {
    if (!this.rc || this.dynNode === null || r23Off("none")) return;
    const plan = this.plans.get(this.canon(this.dynNode));
    if (plan === undefined) return;
    const stored = new Set<PlanField>();
    for (const f of this.funcs)
      eachTE(f.body, (te) => {
        if (te.k !== "fstore" || te.fld === undefined) return;
        const n = this.canon(findNode(te.fld.node as HeapNode));
        if (this.plans.get(n) !== plan) return;
        stored.add(this.planField(te.fld));
      });
    for (const f of new Set(plan.fields.values()))
      if (f.init === "null" && /^@CLS\d+@ \| null$|^@SELF@ \| null$/.test(f.ty) && !stored.has(f))
        f.none = true;
  }

  /**
   * Locals the lowering set to `this` and to nothing else (pipe-h): a field read or write through one prints on `this`
   * itself, which tslc knows isn't null, where the local would need a `!` and its check.
   */
  thisCopies = new Map<Var, Var>();
  findThisCopies(): void {
    for (const f of this.funcs) {
      const self = f.params[0];
      if (self === undefined || self.name !== "this" || !this.varCls.has(self)) continue;
      // A temporary the lowering declares with no value is set before it's read; what it's set to is what counts.
      const from = new Map<Var, TE[]>();
      const set = (v: Var, val: TE): void => void from.set(v, [...(from.get(v) ?? []), val]);
      walkStmtsAll(f.body, (st) => {
        if (st.k === "let" && st.init !== null) set(st.v, st.init);
      });
      eachTE(f.body, (te) => {
        if (te.k === "setvar") set(te.v, te.val);
      });
      for (const [v, vals] of from)
        if (
          !f.params.includes(v) &&
          // The injected `this-copy-any` bug takes a local set to `this` once as `this` wherever it's read.
          (this.fault === "this-copy-any" ? vals.some : vals.every).call(
            vals,
            (x: TE) => x.k === "var" && x.v === self,
          )
        )
          this.thisCopies.set(v, self);
    }
  }

  /** `this`, where `te` is a local only ever set to it and the function prints as a method; else null. */
  thisBase(te: TE): string | null {
    if (te.k !== "var") return null;
    const self = this.thisCopies.get(te.v);
    return self !== undefined && this.varName(self) === "this" ? "this" : null;
  }

  /**
   * Which functions print as methods of their class: one whose first parameter is the lowering's `this`, of a planned
   * class, and never assigned. A constructor is `init`, as TSL's `new` takes no arguments here: `new C()` zeroes it, and
   * the TS constructor runs as `c.init(…)`. In a hierarchy a member another class of it declares is named for that class.
   */
  planMembers(): void {
    const used = new Map<HeapNode, Set<string>>();
    for (const [n, plan] of this.plans)
      used.set(n, new Set([...plan.fields.values()].map((f) => f.name)));
    for (const f of this.funcs) {
      if (f.exported || f.params.length === 0) continue;
      if (f.cloEnv !== undefined) {
        // A lifted closure (R3) is a method of its environment's class: `call`, or with several kinds `call_k`, which
        // the class's own `call` picks by its kind field.
        const n = this.varCls.get(f.params[0]!)!.node;
        const kinds = this.envKinds.get(n)!;
        const base = kinds.length > 1 ? `call_${kinds.indexOf(f) + 1}` : "call";
        const taken = used.get(n)!;
        let name = base;
        for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
        taken.add(name);
        this.members.set(f, { node: n, name });
        continue;
      }
      const self = f.params[0]!;
      if (self.name !== "this" || self.ty.k !== "ref") continue;
      const c = this.varCls.get(self);
      if (c === undefined) continue;
      let assigned = false;
      eachTE(f.body, (te) => {
        if (te.k === "setvar" && te.v === self) assigned = true;
      });
      if (assigned) continue;
      const plan = this.plans.get(c.node)!;
      const dot = f.tirName.lastIndexOf(".");
      // A class two modules both declare has the lowering's names qualified by its module, `shapes.Square.area` (D65).
      const owner = (dot > 0 ? f.tirName.slice(0, dot).replace(/\$\d+$/, "") : "").replace(
        /^.*\./,
        "",
      );
      // The lowering numbers a second instance of one member `m$2`: a member name says what it is, and a clash is `_2`.
      let base = (dot > 0 ? f.tirName.slice(dot + 1) : f.tirName).replace(/\$\d+$/, "");
      if (base === "constructor") base = "init";
      base = sanitize(base);
      if (owner !== "" && sanitize(owner) !== (plan.base ?? plan.name))
        base = `${base}_${sanitize(owner)}`;
      if (RESERVED.has(base)) base = `${base}_`;
      const taken = used.get(c.node)!;
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
      taken.add(name);
      this.members.set(f, { node: c.node, name });
    }
  }

  /** The class id, then each class's own fields, base first (preorder), then anything else in the lowering's order. */
  fieldOrder(n: HeapNode): [string, Shape][] {
    if (n.dyn === true) {
      // The class id, then each class it can hold, in the order of their ids, with that class's fields in its order.
      const targets = [...this.dynMembers].sort((a, b) => a.id - b.id);
      const cls = targets.map((t) => t.fields.get("$cls")).find((x) => x !== undefined);
      const out: [string, Shape][] = cls !== undefined ? [["$cls", cls]] : [];
      for (const t of targets)
        for (const [k, sh] of this.fieldOrder(t)) if (k !== "$cls") out.push([`${t.id}|${k}`, sh]);
      return out;
    }
    const all = [...n.fields];
    const out: [string, Shape][] = all.filter(([k]) => k === "$cls");
    const recs = [
      ...((n.classes ?? new Set()) as Set<{
        id: number;
        jsName: string;
        decl: ts.ClassLikeDeclaration;
      }>),
    ].sort((a, b) => a.id - b.id);
    for (const r of recs) {
      const own: string[] = [];
      for (const m of r.decl.members) {
        if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) own.push(m.name.text);
        if (ts.isConstructorDeclaration(m))
          for (const p of m.parameters)
            if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name))
              own.push(p.name.text);
      }
      for (const name of own)
        for (const e of all)
          if (
            !out.includes(e) &&
            (e[0] === name || (e[0].startsWith(`${name}@`) && e[0].includes(r.jsName)))
          )
            out.push(e);
    }
    for (const e of all) if (!out.includes(e)) out.push(e);
    return out;
  }

  /** Whether `te` loads a string's length: the lowering's load at offset 0 of one (D42), printed as `s.length` (D67). */
  isStrLen(te: TE): boolean {
    if (!this.strs || te.k !== "fload" || te.fld !== undefined || te.glob !== undefined)
      return false;
    if (te.mem.length !== 1 || te.mem[0]!.off !== 0 || te.mem[0]!.t !== "i32") return false;
    return isStrSh(te.base.sh);
  }

  // What crosses an export (D36's boundary, R5): heap id to the flow class, for each class and array a native caller can
  // be handed or hand in, by the meta the direct route publishes.
  boundaryObjs = new Map<string, HeapNode>();
  boundaryVecs = new Map<string, HeapNode>();
  boundaryMaps = new Map<string, HeapNode>(); // R7: a Map or Set crossing an export, by heap id
  // A boundary class as printed: its D36 fields' names in TSL and where both put them, and D36's size.
  boundaryLaid = new Map<
    HeapNode,
    {
      id: string;
      size: number;
      fields: {
        d36: string;
        tsl: string;
        off: number;
        value?: { name: string; off: number };
        arr?: true;
      }[];
    }
  >();

  /**
   * R5: the flow classes an export's parameters and result reach, by D36's descriptions of them (meta.heap), which are the
   * layout a native caller reads and writes. Each object is planned as a class that `layBoundary` lays out at D36's
   * offsets, and each array gets an export that places one (`__vec_place_<id>`). What has no listed form yet stops here:
   * `rc`'s counted handles, a `Map` or `Set` (whose surface functions are the map runtime's), a closure, a union, a tuple
   * of mixed parts kept as a JS array, an optional scalar or a typed array as a field.
   */
  planBoundary(want: (n: HeapNode) => void): void {
    const meta = this.r.meta;
    const what = "an exported function taking or giving an object";
    if (!this.boundary) this.fail(`${what}, whose layout the native caller reads (D36)`);
    // R8: in `rc`, a counted object crosses at its address (its references untagged, untaggedCounted) and the printing
    // gives a native caller its counts (rcBoundaryText). `TMK_R8_OFF=boundary` stops here, as before R8.
    if (this.rc && (process.env.TMK_R8_OFF ?? "").split(",").includes("boundary"))
      this.fail(`rc: ${what}: a counted object's handle at the boundary isn't built (D36, R5)`);
    if (this.modules) this.fail(`${what}, in a program of several modules (R5)`);
    const byId = new Map<number, HeapNode>();
    for (const n of liveNodes()) byId.set(findNode(n).id, findNode(n));
    const seen = new Set<string>();
    const visit = (d: Desc | undefined): void => {
      if (d === undefined) return;
      if (d.k === "opt") return visit(d.of);
      if (d.k === "fn") this.fail(`${what}: a closure value crossing it (R5)`);
      if (d.k === "string" && !this.strs)
        this.fail(`${what}: a string crossing it, with strings not printed as JsString`);
      if (d.k !== "ref") return;
      const id = String(d.id);
      if (seen.has(id)) return;
      seen.add(id);
      const h = meta.heap[id];
      const n = byId.get(d.id);
      if (h === undefined || n === undefined) return this.fail(`${what}: heap entry ${id} unknown`);
      if (this.canon(n) !== n) this.fail(`${what}: a flow class printed as another's (R5)`);
      if (h.k === "vec") {
        this.boundaryVecs.set(id, n);
        want(n);
        visit(h.elem);
        return;
      }
      if (h.map !== undefined) {
        // R7: a Map or Set crosses as JsMap or JsSet (D72), which a native caller builds and reads through the exports D36
        // names for it (`h.map`'s make, put, size, has, iter, step, key, val), printed from compiler/rt/map.ts's surface
        if (!this.maps || !MAPS_CROSS) this.fail(`${what}: a Map or Set crossing it (R5)`);
        if (this.rc)
          this.fail(`rc: ${what}: a Map or Set crossing it, whose counts aren't printed (R8)`);
        this.boundaryMaps.set(id, n);
        want(n);
        visit(h.map.keyDesc);
        visit(h.map.valDesc);
        return;
      }
      if (h.tuple !== undefined) this.fail(`${what}: a tuple crossing it (R5)`);
      if (h.variants.length > 0) this.fail(`${what}: a union crossing it (R5)`);
      if (n.dyn === true) this.fail(`${what}: an unknown crossing it (R5)`);
      for (const f of h.fields) {
        if (f.ty.k === "opt" && !(OPT_FIELDS && (f.ty.of.k === "num" || f.ty.of.k === "bool")))
          this.fail(`${what}: an optional scalar field crossing it (R5)`);
        if (f.ty.k === "arr" && !(ARR_FIELDS && ARRAY_BY_ELEM[f.ty.elem as never] !== undefined))
          this.fail(`${what}: a typed array field crossing it (R5)`);
        if (f.ty.k === "str" || f.ty.k === "void")
          this.fail(`${what}: a field of ${f.ty.k} crossing it (R5)`);
      }
      this.boundaryObjs.set(id, n);
      want(n);
      for (const f of h.fields) visit(f.ty);
    };
    // A map's own surface (R7): what a caller builds and reads a crossing map with, whose cursor is no object of its own.
    const surface = this.mapSurfaceNames();
    for (const [name, e] of Object.entries(meta.exports)) {
      if (this.r.typed.funcs.every((f) => !f.exported || f.jsName !== name)) continue;
      if (surface.has(name)) continue;
      e.params.forEach(visit);
      visit(e.ret);
    }
  }

  /** Every map type's surface exports' names (D36's map form, DownMeta's `heap[id].map`). */
  mapSurfaceNames(): Set<string> {
    const out = new Set<string>();
    for (const h of Object.values(this.r.meta.heap)) {
      const m = (h as { map?: Record<string, unknown> }).map;
      if (m === undefined) continue;
      for (const k of ["make", "put", "size", "has", "iter", "step", "key", "val"])
        if (typeof m[k] === "string" && m[k] !== "") out.add(m[k] as string);
    }
    return out;
  }

  /**
   * R5, R6: a boundary class laid out as D36 lists it (4.5's ABI), which since R6 is TSL's own rule (3.4: declaration order,
   * natural alignment, a `bool` 1 byte), so the class is printed with its fields in D36's order and nothing added: TSL puts
   * each where D36 lists it, and its size is D36's. A field D36 lays out at another offset, or of another width, stops it,
   * and tslc checks the result (tslc.ts's `checkBoundary`), so a layout that moved is a build that falls back, never one
   * that runs.
   */
  layBoundary(): void {
    const meta = this.r.meta;
    const size = (ty: string): number =>
      /^(f64|u64|i64|usize)$/.test(ty)
        ? 8
        : /^(i32|u32|f32)$/.test(ty)
          ? 4
          : /^(u16|i16)$/.test(ty)
            ? 2
            : /^(bool|u8|i8)$/.test(ty)
              ? 1
              : 8; // a reference
    for (const [id, n] of this.boundaryObjs) {
      const h = meta.heap[id] as Extract<DownMeta["heap"][string], { k: "obj" }>;
      const plan = this.plans.get(n);
      if (plan === undefined) return this.fail(`a boundary class ${id} that wasn't planned`);
      const fields = new Map<string, PlanField>();
      const laid: {
        d36: string;
        tsl: string;
        off: number;
        value?: { name: string; off: number };
        arr?: true;
      }[] = [];
      let at = 0;
      const sorted = [...h.fields].sort((a, b) => a.off - b.off);
      // R7: an optional scalar is two fields of the printing's, its flag and its value
      const opts = sorted.filter((f) => f.ty.k === "opt").length;
      if (sorted.length + opts !== new Set(plan.fields.values()).size)
        this.fail(`a boundary class whose fields D36 and the printing count differently (R5)`);
      // the injected `boundary-reorder` bug (and `boundary-unchecked`, which tslc doesn't check): the class's first two
      // fields printed the other way round, so TSL lays each out where the other's offset is listed
      const swap =
        (this.fault === "boundary-reorder" || this.fault === "boundary-unchecked") &&
        sorted.length >= 2;
      const order = swap ? [sorted[1]!, sorted[0]!, ...sorted.slice(2)] : sorted;
      for (const f of order) {
        const pf = plan.fields.get(f.name);
        if (pf === undefined) return this.fail(`a boundary field ${f.name} the class doesn't have`);
        if (pf.arr !== undefined) {
          // R7: a typed array's runtime class held in place, its pointer at D36's offset and its length 8 past it
          if (f.ty.k !== "arr")
            this.fail(`a boundary field ${f.name} printed as a typed array (R7)`);
          const off = Math.ceil(at / 8) * 8;
          if (off !== f.off && !swap)
            this.fail(
              `a boundary field ${f.name} TSL lays out at ${off}, where D36 lists ${f.off} (R7)`,
            );
          fields.set(f.name, pf);
          laid.push({ d36: f.name, tsl: pf.name, off: f.off, arr: true });
          at = off + 16;
          continue;
        }
        if (pf.flag !== undefined) {
          // R7: the flag, a byte at D36's offset, then the value at the next offset its size allows, which is where D36's
          // optional has it (its value past a bool flag, at the value's own alignment)
          const d = f.ty;
          if (d.k !== "opt")
            return this.fail(`a boundary field ${f.name} printed as an optional (R7)`);
          const vs = size(pf.ty);
          const vok = d.of.k === "num" ? pf.ty === d.of.rep : d.of.k === "bool" && pf.ty === "bool";
          if (!vok) this.fail(`a boundary field ${f.name} of ${pf.ty} where D36 has ${d.k} (R7)`);
          if (at !== f.off && !swap)
            this.fail(
              `a boundary field ${f.name}'s flag TSL lays out at ${at}, where D36 lists ${f.off} (R7)`,
            );
          const voff = Math.ceil((f.off + 1) / vs) * vs;
          if (voff !== f.off + d.off && !swap)
            this.fail(
              `a boundary field ${f.name}'s value TSL lays out at ${voff}, where D36 lists ${f.off + d.off} (R7)`,
            );
          fields.set(`${f.name}$has`, pf.flag);
          fields.set(f.name, pf);
          laid.push({
            d36: f.name,
            tsl: pf.flag.name,
            off: f.off,
            value: { name: pf.name, off: voff },
          });
          at = voff + vs;
          continue;
        }
        const s = size(pf.ty);
        const d = f.ty;
        const ok =
          d.k === "num"
            ? pf.ty === d.rep
            : d.k === "bool"
              ? pf.ty === "bool"
              : d.k === "ref" || d.k === "string"
                ? s === 8 && !/^(f64|u64|i64|usize)$/.test(pf.ty)
                : false;
        if (!ok) this.fail(`a boundary field ${f.name} of ${pf.ty} where D36 has ${d.k} (R5)`);
        const off = Math.ceil(at / s) * s;
        if (off !== f.off && !swap)
          this.fail(
            `a boundary field ${f.name} TSL lays out at ${off}, where D36 lists ${f.off} (R6)`,
          );
        fields.set(f.name, pf);
        laid.push({ d36: f.name, tsl: pf.name, off: f.off });
        at = off + s;
      }
      plan.fields = fields;
      this.boundaryLaid.set(n, { id, size: h.size, fields: laid });
    }
  }

  /** R5: each boundary array's placing export, `__vec_place_<id>(length)`: JsArray's own, of `length` holes. */
  boundaryPlaceText(): string[] {
    const out: string[] = [];
    for (const [id, n] of this.boundaryVecs) {
      this.coreUsed.add("usize");
      out.push(
        `export function __vec_place_${id}(length: usize): ${this.clsName(n)} {`,
        // the injected `vec-place-long` bug: an array placed one hole longer than the caller asked for
        `  return ${this.vecNewText(n, this.fault === "vec-place-long" ? "length + 1" : "length")};`,
        "}",
        "",
      );
    }
    if (out.length > 0)
      out.unshift(
        "// A native caller's arrays (4.5's ABI, D36, R5): one placed with `length` holes, its buffer's address at p + 0 and",
        "// its length at p + 8, as D36's array header has them.",
      );
    if (this.rc) out.push(...this.rcBoundaryText());
    return out;
  }

  /**
   * R8: in `rc`, a native caller's counts (4.5's ABI in `rc`, D36, D39), printed as the plain TSL tslc's expansion counts.
   * For each class and array that crosses: a placing export, whose result is a new object with one count, the caller's (D39:
   * a result is owned); `__rc_retain_<id>`, which gives back what it's given, so the expansion shares it and the caller
   * holds one more count (it ignores the result, the same object); and `__rc_release_<id>`, which takes its argument over
   * (`@tsl.moves`), so the expansion drops the count the caller gave up. Arguments to every other export are borrowed and
   * results owned, as through the direct route. And `__rc_collect`, `__rc_live` and `__rc_steps`, @tsl/gc's `rcCollect`,
   * `rcLive` and `rcSteps`, the direct route's `__rc_collect` and its live-object and freeing-step counts.
   */
  rcBoundaryText(): string[] {
    const out: string[] = [];
    const each = [...this.boundaryObjs, ...this.boundaryVecs].sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    );
    if (each.length === 0 && !this.rcStrAbi) return out;
    out.push(
      "// A native caller's counts (4.5's ABI in `rc`, D39, R8): a placed object is the caller's, at a count of one; retain",
      "// gives back what it's given, so the caller holds one more count; release takes the caller's count over and drops it.",
    );
    for (const [id, n] of each) {
      const c = this.clsName(n);
      if (this.boundaryObjs.has(id)) {
        this.rcPlaced.set(id, `__rc_place_${id}`);
        out.push(`export function __rc_place_${id}(): ${c} {`, `  return new ${c}();`, "}", "");
      }
      out.push(`export function __rc_retain_${id}(p: ${c}): ${c} {`, "  return p;", "}", "");
      out.push(`/** @tsl.moves p */`, `export function __rc_release_${id}(p: ${c}): void {}`, "");
    }
    // R10: a string a native caller places or gets back is counted the same way, by the string's own pair
    if (this.rcStrAbi) {
      const c = this.strName("JsString");
      out.push(`export function __rc_retain_str(p: ${c}): ${c} {`, "  return p;", "}", "");
      out.push(`/** @tsl.moves p */`, `export function __rc_release_str(p: ${c}): void {}`, "");
    }
    this.gcUsed.add("rcCollect").add("rcLive").add("rcSteps");
    this.coreUsed.add("usize");
    out.push(
      "export function __rc_collect(): void {\n  rcCollect();\n}",
      "",
      "export function __rc_live(): usize {\n  return rcLive();\n}",
      "",
      "export function __rc_steps(): usize {\n  return rcSteps();\n}",
      "",
    );
    return out;
  }

  /** R8: each crossing class's placing export in `rc`, by heap id. */
  rcPlaced = new Map<string, string>();
  /** R10: in `rc`, a string crosses an export, so a native caller's retain and release for strings are printed. */
  rcStrAbi = false;
  /** R10: in `rc`, a statement-expression's temporary printed as the local it's given to, which keeps that name. */
  rcNamed = new Set<Var>();

  /** What the build publishes for a native caller (R5): each boundary class's TSL name and fields, each array's placer. */
  boundaryInfo(): TslEmit["boundary"] {
    if (
      this.boundaryLaid.size === 0 &&
      this.boundaryVecs.size === 0 &&
      this.boundaryMaps.size === 0
    )
      return undefined;
    const classes: NonNullable<TslEmit["boundary"]>["classes"] = {};
    for (const [n, b] of this.boundaryLaid)
      classes[b.id] = {
        name: this.plans.get(n)!.name,
        size: b.size,
        fields: Object.fromEntries(
          b.fields.map((f) => [
            f.d36,
            {
              name: f.tsl,
              off: f.off,
              ...(f.value !== undefined ? { value: f.value } : {}),
              ...(f.arr === true ? { arr: true as const } : {}),
            },
          ]),
        ),
      };
    const vecs: Record<string, string> = {};
    for (const [id] of this.boundaryVecs) vecs[id] = `__vec_place_${id}`;
    const rc: NonNullable<NonNullable<TslEmit["boundary"]>["rc"]> = {};
    if (this.rc)
      for (const id of [...this.boundaryObjs.keys(), ...this.boundaryVecs.keys()])
        rc[id] = {
          ...(this.boundaryObjs.has(id) ? { place: `__rc_place_${id}` } : {}),
          retain: `__rc_retain_${id}`,
          release: `__rc_release_${id}`,
        };
    if (this.boundaryMaps.size === 0) return { classes, vecs, ...(this.rc ? { rc } : {}) };
    const maps: Record<string, "map" | "set"> = {};
    for (const [id, n] of this.boundaryMaps)
      maps[id] = this.mapPlans.get(this.canon(n))?.vals.s === "void" ? "set" : "map";
    return { classes, vecs, maps };
  }

  /**
   * R5: the lowering's dead return at the end of `f` (`deadTail`), which class printing leaves out of an exported function
   * whose result crosses the boundary, so its result isn't `| null` where the TS's isn't (a caller's null check the direct
   * route doesn't make). Only there: elsewhere what a function returns can be read as nullable for reasons tsc can't see
   * past (a string literal's module state), and the printing stays as it was. Not where the printer desugars exceptions
   * (D68): its flag checks return a zero the function's result type has to hold.
   */
  deadTail(f: FuncInst): Stmt | null {
    if (this.excOwn || !this.boundary || this.rc || !f.exported || f.ret.k !== "ref") return null;
    if (this.strExport(f)) return null;
    return deadTail(f);
  }

  /** An exported function whose references are all strings, which cross as JsString (D67, the ABI in 4.5). */
  strExport(f: FuncInst): boolean {
    if (!this.strs) return false;
    const d = this.r.meta.exports[f.jsName];
    if (d === undefined) return false;
    const refs = [...f.params.map((p, i) => [p.ty, d.params[i]] as const), [f.ret, d.ret] as const];
    return refs.every(
      ([ty, desc]) => ty.k !== "ref" || (desc as { k?: string } | undefined)?.k === "string",
    );
  }

  /**
   * With strings (D67): the functions printed. The string runtime's core is JsString's, so none of it is printed, and
   * `strConcat` is JS's length check and then `concat`, so what only it calls isn't either. Everything else is.
   */
  printedFuncs(funcs: FuncInst[]): FuncInst[] {
    const name = new Map<FuncInst, string>();
    for (const i of this.r.insts) {
      const d = i.decl as ts.Node;
      if (!d.getSourceFile().fileName.endsWith("/compiler/rt/str.ts")) continue;
      if (ts.isFunctionDeclaration(d) && d.name !== undefined) name.set(i.fi, d.name.text);
    }
    for (const f of funcs) {
      const n = name.get(f);
      if (n === undefined) continue;
      const m = STR_CORE[n];
      if (m !== undefined) this.strMapped.set(f, m);
      if (n === "strConcat") this.strConcatFn = f;
    }
    const keep = new Set<FuncInst>();
    const visit = (f: FuncInst): void => {
      if (keep.has(f) || this.strMapped.has(f)) return;
      keep.add(f);
      if (f === this.strConcatFn) return;
      eachTE(f.body, (te) => {
        if (te.k === "call") visit(te.inst);
        if (te.k === "fnref") visit(te.inst);
      });
    };
    for (const f of funcs) if (!name.has(f) || f.exported) visit(f);
    return funcs.filter((f) => keep.has(f));
  }

  /**
   * `strConcat`'s body as far as JS's length check (which throws RangeError, as the lowering spells it), and then
   * `return a.concat(b)`: JsString's concatenation is the rest of it.
   */
  concatBody(f: FuncInst): Stmt[] {
    const at = f.body.findIndex((st) => {
      let hit = false;
      eachTE(st, (te) => {
        if (te.k === "lit" && te.value === 536870888) hit = true;
      });
      return hit;
    });
    let sh: unknown;
    eachTE(f.body, (te) => {
      if (sh === undefined && isStrSh(te.sh)) sh = te.sh;
    });
    const [a, b] = f.params;
    if (at < 0 || sh === undefined || a === undefined || b === undefined || f.params.length !== 2)
      this.fail("strConcat's length check");
    const v = (x: Var): TE => ({ k: "var", v: x, ty: x.ty, sh }) as TE;
    const call = { k: "rtcall", name: "$concat", args: [v(a!), v(b!)], ty: f.ret, sh } as TE;
    // Its own lets and the check: `concat` returns the other side of an empty one itself.
    const kept = f.body.slice(0, at).filter((st) => st.k === "let");
    return [...kept, f.body[at]!, { k: "return", val: call } as Stmt];
  }

  /** A string intrinsic of compiler/rt, as the call on JsString it is (D67). */
  strOp(e: TE): string {
    const t = e.strop!;
    // Its operands have to be the expansion's still: a pass that rebuilt the expansion would leave them stale here.
    const inside = new Set<TE>();
    strTagsOnly = false;
    try {
      eachTE({ ...e, strop: undefined }, (x) => inside.add(x));
    } finally {
      strTagsOnly = true;
    }
    if (!t.args.every((a) => inside.has(a))) this.fail(`${t.op}, whose expansion was rebuilt`);
    const need = (te: TE, k: string): void => {
      if (te.ty.k !== "int" || te.ty.name !== k)
        this.fail(`${t.op} given ${te.ty.k} where JsString takes ${k}`);
    };
    switch (t.op) {
      case "__s_unit": {
        need(t.args[1]!, "usize");
        if (e.ty.k !== "int" || e.ty.name !== "i32") this.fail(`a unit read as ${e.ty.k}`);
        const [s, i] = this.operands(t.args);
        return `${paren(s!)}.unit(${i})`;
      }
      case "__s_flat": {
        need(t.args[0]!, "i32");
        return `${this.strName("JsFlat.zeroed")}(${this.operands(t.args)[0]})`;
      }
      case "__s_put": {
        need(t.args[1]!, "usize");
        need(t.args[2]!, "i32");
        const [s, i, u] = this.operands(t.args);
        return `${paren(s!)}.put(${i}, ${u})`;
      }
      case "__s_copy": {
        for (const k of [1, 3, 4]) need(t.args[k]!, "usize");
        const [d, di, src, si, n] = this.operands(t.args);
        return `${paren(d!)}.copyFrom(${di}, ${src}, ${si}, ${n})`;
      }
      case "__hash_k0":
      case "__hash_k1":
        if (this.hashNames.length !== 2) this.fail("the hash key, outside its module state");
        return this.hashNames[t.op === "__hash_k0" ? 0 : 1]!;
      case "__s_hash_get": {
        // D42's hash word, strHash's cache (pipe-h): JsString keeps it as the flags it already had.
        if (e.ty.k !== "int" || e.ty.name !== "i32") this.fail(`a hash word read as ${e.ty.k}`);
        return `${paren(this.operands(t.args)[0]!)}.hashWord()`;
      }
      case "__s_hash_set": {
        need(t.args[1]!, "i32");
        const [s, w] = this.operands(t.args);
        return `${paren(s!)}.setHashWord(${w})`;
      }
      default:
        return this.fail(`the string runtime's ${t.op}, which JsString keeps to itself`);
    }
  }

  /**
   * R10: a name of JsString's surface as the printing calls it: @tsl/jsrt's (D67), or in `rc` the program's own JsStr and
   * its functions (emit-rcstr.ts), counted by the expansion as the program's classes are.
   */
  strName(n: string): string {
    if (!this.rc) {
      this.jsrtUsed.add(n.split(".")[0]!);
      return n;
    }
    this.rcStrUsed = true;
    const m = RC_STR_MAP[n];
    if (m === undefined) return this.fail(`rc: JsString's ${n}, which JsStr has no counterpart of`);
    return m;
  }

  /** A call to the string runtime's core, as the call on JsString that does it (D67). */
  strCall(e: Extract<TE, { k: "call" }>, m: { name: string; static: boolean }): string {
    const ops = this.operands(e.args);
    const call = m.static
      ? `${this.strName(m.name)}(${ops.join(", ")})`
      : `${paren(ops[0]!)}.${m.name}(${ops.slice(1).join(", ")})`;
    return sameRep(e.ty, e.inst.ret) ? call : this.retyped(call, e.ty, e.inst.ret);
  }

  /** A string literal (D42's static data), made once in `__init` from its text, readable: `JsString.of(lit("…"))`. */
  strLitDecl(name: string, g: Global): string {
    const text = strLiteralText(g);
    if (text === null) return this.fail(`the string literal ${g.name}`);
    const ty = this.strName("JsString");
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
      text,
    );
    if (!lone) {
      this.coreUsed.add("lit");
      this.strLitInit.push(`${name} = ${this.strName("JsFlat.of")}(lit(${JSON.stringify(text)}));`);
      return `let ${name}: ${ty} | null = null;`;
    }
    // A lone surrogate, which UTF-8 can't say: its units, with the text as JS would print it.
    const units = [...Array(text.length).keys()].map((i) => `0x${text.charCodeAt(i).toString(16)}`);
    this.strLitInit.push(`${name} = ${this.strName("JsFlat.ofUnits")}(${name}_units);`);
    return `// ${JSON.stringify(text)}\nconst ${name}_units = new Uint16Array([${units.join(", ")}]);\nlet ${name}: ${ty} | null = null;`;
  }

  /** A class's name in the text: what a `@CLSn@` placeholder stands for. */
  /** compiler/rt/map.ts's functions (D72): none is printed, as JsMap and JsSet are what they were. */
  mapFuncs(funcs: FuncInst[]): FuncInst[] {
    for (const i of this.r.insts) {
      const d = i.decl as ts.Node;
      if (!d.getSourceFile().fileName.endsWith("/compiler/rt/map.ts")) continue;
      const n =
        (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.name !== undefined
          ? d.name.getText()
          : ts.isConstructorDeclaration(d) || ts.isClassDeclaration(d)
            ? "new"
            : "?";
      this.mapRt.set(i.fi, n);
    }
    // R7: a crossing map's surface (D36's map form) is printed, its body the JsMap calls it makes; the rest isn't.
    const surface = this.boundary && MAPS_CROSS ? this.mapSurfaceNames() : new Set<string>();
    return funcs.filter((f) => !this.mapRt.has(f) || surface.has(f.tirName));
  }

  /** A flow class of compiler/rt/map.ts's, printed as JsMap, JsSet or JsMapCursor: whether n is one. */
  planMap(n: HeapNode, want: (n: HeapNode) => void): boolean {
    if (n.klass === "TmkCursor") {
      this.mapCursors.add(n);
      return true;
    }
    if (
      n.klass === "TmkGen" ||
      n.klass === "TmkOld" ||
      n.klass === "TmkIter" ||
      n.klass === "TmkResult"
    )
      this.fail(`${MAPS_NOT}the map runtime's ${n.klass} as a value`);
    if (n.klass !== "TmkMap") return false;
    const elem = (f: string): Shape => {
      const sh = n.fields.get(f);
      if (sh === undefined || sh.s !== "vec") return this.fail(`${MAPS_NOT}a map with no ${f}`);
      return findNode(sh.node).elem ?? { s: "void" };
    };
    const keys = elem("keys");
    const vals = elem("vals");
    const ok = (sh: Shape, isKey: boolean): boolean =>
      sh.s === "num" || sh.s === "obj" || sh.s === "vec" || (!isKey && sh.s === "void");
    if (!ok(keys, true)) this.fail(`${MAPS_NOT}a key of shape ${keys.s}`);
    if (!ok(vals, false)) this.fail(`${MAPS_NOT}a value of shape ${vals.s}`);
    for (const sh of [keys, vals]) {
      if (sh.s !== "obj" && sh.s !== "vec") continue;
      // A string key is a JsString, which keyHash and keySame reach through its class id (D70, D72): its hashKey is D42's
      // HalfSipHash and its sameKey compares units, as the direct route's strHash and strEq.
      const e = findNode(sh.node);
      if (STRKEYS_OFF && this.strs && isStrNode(this.canon(e)))
        this.fail(`${MAPS_NOT}a string as a key or value`);
      want(e);
    }
    this.mapPlans.set(n, { keys, vals });
    return true;
  }

  /** A field of a map's flow class (D72). */
  mapField(fld: { node: unknown }): boolean {
    return this.maps && this.mapPlans.has(this.canon(findNode(fld.node as HeapNode)));
  }

  /** A map's key or value: its TSL type, and its descriptor as JsMap's constructor takes it. A number key is its bits. */
  mapPart(sh: Shape, isKey: boolean): { ty: string; desc: string } {
    if (sh.s === "num") {
      const t = locTy(sh.loc);
      const ty = isKey && t.k === "float" ? "u64" : this.tyText(t);
      this.descUsed.add(ty);
      return { ty, desc: ty };
    }
    if (sh.s === "obj" || sh.s === "vec") {
      this.stdUsed.add("ref");
      const ty = `${this.clsName(findNode(sh.node))} | null`;
      return { ty, desc: `ref<${ty}>()` };
    }
    return this.fail(`${MAPS_NOT}a map's ${sh.s}`);
  }

  mapTyText(p: { keys: Shape; vals: Shape }): string {
    if (this.rc) return this.mapHolderOf(p).name;
    const k = this.mapPart(p.keys, true).ty;
    if (p.vals.s === "void") {
      this.jsrtUsed.add("JsSet");
      return `JsSet<${k}>`;
    }
    this.jsrtUsed.add("JsMap");
    return `JsMap<${k}, ${this.mapPart(p.vals, false).ty}>`;
  }

  /** Whether a map's keys are numbers held as their bits (`jsNumKey`). */
  mapNumKeys(p: { keys: Shape }): boolean {
    return p.keys.s === "num" && locTy(p.keys.loc).k === "float";
  }

  /** `new Map()` as the lowering made it, `new TmkMap()` and its constructor, as `new JsMap(…)` (D72). */
  mapNew(e: Extract<TE, { k: "blockexpr" }>): string | null {
    const [a, b] = e.body;
    if (e.body.length !== 2 || a === undefined || b === undefined) return null;
    if (a.k !== "let" || a.init === null || a.init.k !== "alloc") return null;
    const o = this.objNode(a.init.sh);
    const p = o === null ? undefined : this.mapPlans.get(o.node);
    if (p === undefined) return null;
    if (b.k !== "expr" || b.e.k !== "call" || this.mapRt.get(b.e.inst) !== "new")
      return this.fail(`${MAPS_NOT}a map made other than by new Map()`);
    if (e.result.k !== "var" || e.result.v !== a.v)
      return this.fail(`${MAPS_NOT}a map made other than by new Map()`);
    if (this.rc) return `new ${this.mapHolderOf(p).name}()`;
    const giveBack = this.memory === "leak" ? "false" : "true";
    const k = this.mapPart(p.keys, true);
    if (p.vals.s === "void") {
      this.jsrtUsed.add("JsSet");
      return `new JsSet(${k.desc}, ${giveBack})`;
    }
    const v = this.mapPart(p.vals, false);
    this.jsrtUsed.add("JsMap");
    return `new JsMap(${k.desc}, ${v.desc}, true, ${giveBack})`;
  }

  /** A call into compiler/rt/map.ts, as the call on JsMap or JsSet that does it (D72). */
  mapCall(e: Extract<TE, { k: "call" }>, name: string): string {
    const o = this.objNode(e.args[0]?.sh);
    const p = o === null ? undefined : this.mapPlans.get(o.node);
    if (p === undefined) return this.fail(`${MAPS_NOT}the map runtime's ${name} on something else`);
    const ops = this.operands(e.args);
    const m = `${paren(ops[0]!)}${this.mapIn}`;
    const num = this.mapNumKeys(p);
    // A number key or value the lowering held as an integer at this call, where the map's are doubles: the same number.
    const asF64 = (te: TE | undefined, x: string): string =>
      te !== undefined && te.ty.k === "int" ? `${this.core("toF64")}(${x})` : x;
    const key = (x: string): string => {
      if (!num) return x;
      this.jsrtUsed.add("jsNumKey");
      return `jsNumKey(${asF64(e.args[1], x)})`;
    };
    let call: string;
    switch (name) {
      case "get": {
        if (p.vals.s === "obj" || p.vals.s === "vec") {
          call = `${m}.getOr(${key(ops[1]!)}, null)`;
          break;
        }
        // A scalar's `undefined` is a flag and a value (3.3, rule 12), which the lowering holds as an Opt.
        this.loweredUsed.add("Opt");
        const v = this.mapPart(p.vals, false).ty;
        return `${this.lowered("cast")}<Opt<${v}>>(${m}.get(${key(ops[1]!)}), "opt")`;
      }
      case "set": {
        const v = this.mapPart(p.vals, false).ty === "f64" ? asF64(e.args[2], ops[2]!) : ops[2]!;
        call = `${m}.set(${key(ops[1]!)}, ${v})`;
        break;
      }
      case "has":
      case "delete":
      case "add":
        call = `${m}.${name}(${key(ops[1]!)})`;
        break;
      case "clear":
        call = `${m}.clear()`;
        break;
      case "mapCursor":
        call = `${m}.cursor()`;
        break;
      case "mapAdvance":
        call = `${m}.advance(${ops[1]})`;
        break;
      case "curKey":
        call = `${m}.keyAt(${ops[1]})`;
        if (num) {
          this.jsrtUsed.add("jsKeyNum");
          call = `jsKeyNum(${call})`;
        }
        break;
      case "curVal":
        call = `${m}.valAt(${ops[1]})`;
        break;
      default:
        return this.fail(`${MAPS_NOT}the map runtime's ${name}`);
    }
    return sameRep(e.ty, e.inst.ret) ? call : this.retyped(call, e.ty, e.inst.ret);
  }

  clsName(n: HeapNode): string {
    const m = this.canon(n);
    const mp = this.mapPlans.get(m);
    if (mp !== undefined) return this.mapTyText(mp);
    if (this.mapCursors.has(m)) {
      this.jsrtUsed.add("JsMapCursor");
      return "JsMapCursor";
    }
    if (this.strs && isStrNode(m)) return this.strName("JsString");
    const es = this.vecs.get(m);
    if (es !== undefined) {
      if (this.rc) return this.holderOf(es).name;
      this.stdUsed.add("JsArray");
      return `${this.arrCls}<${this.vecElemText(es)}>`;
    }
    const p = this.plans.get(m);
    if (p === undefined) this.fail("a reference to a class that wasn't planned");
    return this.ref(this.modOfPlan(m), `cls:${m.id}`, p!.name);
  }

  /**
   * In `rc` (R2), an array is held in place by a class of the program's own, one per element type, so the expansion counts
   * it as it counts any class (D74): its elements are counted references where they're objects, freed one a step when
   * it's freed, and its buffer goes back as the last step. The holder is the array, so `xs.v.get(i)` reads an element.
   */
  holderOf(es: Shape): { name: string; newFn?: string } {
    const elem = this.vecElemText(es);
    let h = this.holders.get(`arr:${elem}`);
    if (h === undefined) {
      if (this.modules) this.fail("rc: an array in a program of several modules");
      let desc: string;
      const scalar = es.s === "num" || this.byteElem(es) !== null;
      if (scalar) {
        desc = elem;
        this.descUsed.add(desc);
      } else {
        this.stdUsed.add("ref");
        desc = `ref<${elem}>()`;
      }
      this.coreUsed.add("usize");
      const name = `JsArr_${sanitize(elem.replace(/ \| null$/, ""))}`;
      // R3: the array's first room is the holder's own tail (D69), a reference's element a word, so a holder and the
      // elements that fit are one counted allocation; @tsl/gc's JsRoomArray takes rooms of the counted heap past it.
      const room = scalar ? desc : "u64";
      this.descUsed.add(room);
      this.coreUsed.add("tail");
      this.coreUsed.add("withTail");
      this.gcUsed.add("JsRoomArray");
      h = {
        name,
        newFn: `new${name}`,
        decl: [
          `/** An array of ${elem}, counted as the classes are (R2), its first room its own tail (R3). */`,
          `class ${name} {`,
          `  v: JsRoomArray<${elem}>;`,
          `  room = tail(${room});`,
          "",
          "  constructor(length: usize) {",
          `    this.v = new JsRoomArray(${desc}, length, ${scalar ? "false" : "true"});`,
          "  }",
          "}",
          "",
          `/** A ${name} of \`length\` holes, in one allocation with room for at least 4 (R3). */`,
          `function new${name}(length: usize): ${name} {`,
          "  const n: usize = length < 4 ? 4 : length;",
          `  const a: ${name} = withTail(n, new ${name}(length));`,
          // the injected `room-past-tail` bug: a first room twice as long as the tail
          `  a.v.attach(a, ${this.fault === "room-past-tail" ? "n + n" : "n"});`,
          "  return a;",
          "}",
        ],
      };
      this.holders.set(`arr:${elem}`, h);
    }
    return h;
  }

  /**
   * In `rc` (R2), a map or set is held in place by a class of the program's own, one per key and value type, as an array
   * is (`holderOf`): the expansion counts what it holds through JsMap's `put`, `cut` and `entryAt`, which hand back what
   * the map stops holding, and frees one position a step when the holder goes.
   */
  mapHolderOf(p: { keys: Shape; vals: Shape }): { name: string } {
    const k = this.mapPart(p.keys, true);
    const v = p.vals.s === "void" ? null : this.mapPart(p.vals, false);
    const key = `map:${k.ty}:${v?.ty ?? ""}`;
    let h = this.holders.get(key);
    if (h === undefined) {
      if (this.modules) this.fail(`${MAPS_NOT}rc: a map in a program of several modules`);
      const bare = (t: string): string => sanitize(t.replace(/ \| null$/, ""));
      const name = v === null ? `JsSet_${bare(k.ty)}` : `JsMap_${bare(k.ty)}_${bare(v.ty)}`;
      const ty = v === null ? `JsSet<${k.ty}>` : `JsMap<${k.ty}, ${v.ty}>`;
      const made =
        v === null ? `new JsSet(${k.desc}, true)` : `new JsMap(${k.desc}, ${v.desc}, true, true)`;
      this.jsrtUsed.add(v === null ? "JsSet" : "JsMap");
      // R11: making each of its tables takes the counted heap's freeing steps, and where @tsl/std has nothing left, what the
      // counted heap has waiting is freed first (`tablesIn`, D39), as the direct route's map's vectors are the counted
      // heap's; the injected `r11-tables-unpaced` bug leaves both out, as before R11
      const uncounted = this.fault === "r11-tables-unpaced" || r11Off("tables");
      if (!uncounted) this.gcUsed.add("rcAllocSteps").add("rcCollect");
      h = {
        name,
        decl: [
          `/** A ${v === null ? "set" : "map"} of ${ty.slice(6, -1)}, counted as the classes are (R2), its tables paced as theirs (R11). */`,
          `class ${name} {`,
          `  m: ${ty};`,
          "",
          "  constructor() {",
          `    this.m = ${made};`,
          uncounted ? "    this.m.freesTables();" : "    this.m.tablesIn(rcAllocSteps, rcCollect);",
          "  }",
          "}",
        ],
      };
      this.holders.set(key, h);
    }
    return h;
  }

  /** R7: whether a field of this shape prints as a typed array's runtime class. */
  arrField(sh: Shape): sh is Extract<Shape, { s: "arr" }> {
    return ARR_FIELDS && !this.rc && sh.s === "arr" && ARRAY_BY_ELEM[sh.elem] !== undefined;
  }

  /**
   * R7: the runtime class a typed-array field of this kind is held in, one per kind in the program: the array's pointer
   * and its length, D36's two words, which `pack` makes the array from and `part` takes it apart into (@tsl/lowered).
   */
  arrFieldClass(ctor: string): string {
    const key = `arrfield:${ctor}`;
    let h = this.holders.get(key);
    if (h === undefined) {
      const name = `${ctor}Field`;

      this.coreUsed.add("usize");
      h = {
        name,
        decl: [
          `/** A ${ctor} held in a field: its pointer and its length (R7, D62's first ruling). */`,
          `class ${name} {`,
          "  ptr: usize = 0;",
          "  len: usize = 0;",
          "}",
        ],
      };
      this.holders.set(key, h);
    }
    return h.name;
  }

  /**
   * R13: an array's element that's a typed array (the JPEG decoder's `Uint16Array[]`), in `strict`: its kind's constructor,
   * or null where it isn't one. TMK_R13_OFF=arrays leaves it unprinted.
   */
  arrVecElem(es: Shape): string | null {
    if (this.memory !== "strict" || es.s !== "arr" || r13Off("arrays")) return null;
    return ARRAY_BY_ELEM[es.elem] ?? null;
  }

  /**
   * R13: an array of typed arrays holds each in R7's holder of its kind, its pointer and length (`Uint16ArrayField`), made
   * when it's stored; a hole is null, and reads as a typed array of no storage, as the lowering's hole of one does (its
   * pointer null, its length 0). Two functions of the program's own do it: `<holder>_of(a)`, a holder made for a, and
   * `<holder>_get(h)`, the typed array h holds.
   */
  arrVecHelpers(ctor: string): { holder: string; of: string; get: string } {
    if (this.modules) this.fail("an array of typed arrays, in a program of several modules (R13)");
    const holder = this.arrFieldClass(ctor);
    const key = `arrvec:${ctor}`;
    const of = `${holder}_of`;
    const get = `${holder}_get`;
    if (!this.holders.has(key)) {
      for (const n of ["cast", "part", "pack", "nullRef", "Ref"]) this.loweredUsed.add(n);
      this.coreUsed.add("usize");
      // the injected `arr-elem-len` bug (R13): a typed array an array holds kept one element shorter than it is
      if (this.fault === "arr-elem-len") this.loweredUsed.add("wrap");
      const len =
        this.fault === "arr-elem-len"
          ? "(part<usize>(a, 1, 2) > 0 ? wrap<usize>(part<usize>(a, 1, 2) - 1) : 0)"
          : "part<usize>(a, 1, 2)";
      this.holders.set(key, {
        name: of,
        decl: [
          `/** A ${ctor} an array holds (R13): a holder of its pointer and length, made for it. */`,
          `function ${of}(a: ${ctor}): ${holder} {`,
          `  const h = new ${holder}();`,
          "  h.ptr = cast<usize>(part<Ref>(a, 0, 1));",
          `  h.len = ${len};`,
          "  return h;",
          "}",
          "",
          `/** The ${ctor} a holder holds; a hole's is one of no storage, as the lowering reads a hole of a typed array. */`,
          `function ${get}(h: ${holder} | null): ${ctor} {`,
          `  return h !== null ? pack<${ctor}>(cast<Ref>(h.ptr), h.len) : pack<${ctor}>(nullRef(), cast<usize>(0));`,
          "}",
        ],
      });
    }
    return { holder, of, get };
  }

  /** R13: the element of the array `v` is a typed array's kind, or null. */
  vecArrElem(v: TE): string | null {
    const sh = v.sh as Shape | undefined;
    if (sh?.s !== "vec") return null;
    const es = this.vecs.get(this.canon(findNode(sh.node)));
    return es === undefined ? null : this.arrVecElem(es);
  }

  /**
   * R9: a typed array made in a function, as TSL makes one. TSL has no `new Int32Array(n)` in a function (TSL1001): a typed
   * array there is a view of an object's storage. Of a constant length up to 64 KiB it's a layout class's `array(…)` field,
   * `new Int32Array_8().items`, which tslc's escape analysis puts on the stack where the view doesn't outlive the function
   * (as the direct route's stack typed arrays are) and on the heap where it does; otherwise a class whose tail is the
   * elements (D69), `withTail(n, new Float64Array_n()).items`, on the heap. Where nothing reaches it after the export
   * call, tslc puts either in the per-call region (region.ts), as the direct route puts it in the call arena. Zeroed.
   */
  newTypedArray(e: Extract<TE, { k: "tuple" }>): string {
    if (this.modules)
      this.fail("a typed array made in a function, in a program of several modules (R9)");
    const elem = (e.ty as Extract<Ty, { k: "arr" }>).elem;
    const ctor = this.tyText(e.ty);
    const n = constNum(e.items[1]!);
    const es = elemSize(elem);
    // R10: in `rc`, only a constant length's layout class, which the expansion doesn't count (it holds no reference and
    // has no tail): tslc puts it on the stack, or, where its view would outlive the function, refuses the printing, as a
    // stack object's escape is in a `strict` package, and the direct route builds it. A run-time length's tail would be a
    // counted object a view outlives, which isn't built (R9). The number text's scratch digits are the first kind.
    if (this.rc && (r10Off("typed") || n === null || n <= 0 || n * es > 65536))
      this.fail("a typed array made in a function, in rc (R9)");
    // the injected `typed-array-short` bug (R9): an array made one element short
    const short = this.fault === "typed-array-short" ? 1 : 0;
    this.descUsed.add(elem);
    if (n !== null && n > 0 && n * es <= 65536) {
      const name = this.typedArrayClass(ctor, elem, n - short);
      return `${this.loc(e.items[0]! as { loc?: string })}new ${name}().items`;
    }
    const name = this.typedArrayClass(ctor, elem, null);
    const len = this.typedArg(e.items[1]!);
    const n1 = short === 0 ? len : `${paren(len)} - 1`;
    return `${this.loc(e.items[0]! as { loc?: string })}${this.core("withTail")}(${n1}, new ${name}()).items`;
  }

  /** R9: the class whose storage a typed array made in a function is: of `n` elements in place, or a tail (`n` null). */
  typedArrayClass(ctor: string, elem: string, n: number | null): string {
    const key = `typedarr:${ctor}:${n ?? "n"}`;
    let h = this.holders.get(key);
    if (h === undefined) {
      const name = `${ctor}_${n ?? "n"}`;
      h = {
        name,
        decl:
          n !== null
            ? [
                `/** The storage of ${/^[AEIOU]/.test(ctor) ? "an" : "a"} ${ctor} of ${n} made in a function (R9): \`items\`, a layout class's array. */`,
                `class ${name} {`,
                `  items = ${this.core("array")}(${elem}, ${n});`,
                "}",
              ]
            : [
                `/** The storage of ${/^[AEIOU]/.test(ctor) ? "an" : "a"} ${ctor} made in a function (R9): \`items\`, its tail (D69). */`,
                `class ${name} {`,
                `  items = ${this.core("tail")}(${elem});`,
                "}",
              ],
      };
      this.holders.set(key, h);
    }
    return h.name;
  }

  /** The holders' declarations (R2): each an array or a map in place. */
  holderDecls(): string[] {
    return [...this.holders.values()].flatMap((h) => [...h.decl, ""]);
  }

  /** In `rc`, where a map's own operations are, past its holder (R2). */
  get mapIn(): string {
    return this.rc ? ".m" : "";
  }

  /** In `rc`, where an array's own operations are, past its holder (R2). */
  get arr(): string {
    return this.rc ? ".v" : "";
  }

  /** R13: the array class: @tsl/jsrt's JsArray, or in `strict`, which has no heap, its arena array. */
  get arrCls(): string {
    return this.memory === "strict" ? "JsArenaArray" : "JsArray";
  }

  /** `ref<C>()`, an array's element descriptor for a reference: @tsl/std's, or in `strict` (R13) the arena array's module's. */
  useRef(): void {
    if (this.memory === "strict") this.arenaRefUsed = true;
    else this.stdUsed.add("ref");
  }

  classDecls(): string[] {
    const out: string[] = [];
    for (const [n, plan] of this.plans) {
      const getters: string[] = [];
      const lines = [...new Set(plan.fields.values())]
        .map((f): string | null => {
          this.curMod = this.modOfPlan(n) ?? this.rootSf;
          const ty = f.ty
            .replace("@STR@", () => this.strName("JsString"))
            .replace("@SELF@", plan.name)
            .replace(/@CLS(\d+)@/, (_m, id: string) => {
              for (const [m] of this.plans) if (m.id === Number(id)) return this.clsName(m);
              for (const [m] of this.vecs) if (m.id === Number(id)) return this.clsName(m);
              // A map in a field (D72): JsMap or JsSet, and a cursor JsMapCursor.
              for (const [m] of this.mapPlans) if (m.id === Number(id)) return this.clsName(m);
              for (const m of this.mapCursors) if (m.id === Number(id)) return this.clsName(m);
              if (this.strNode !== null && this.strNode.id === Number(id))
                return this.clsName(this.strNode);
              return this.fail("a field's class");
            });
          if (plan.env !== undefined) return `  ${f.name}: ${ty};`;
          if (f.none === true) {
            // R23 (`noneFields`): its 8 bytes, holding no reference, and a getter giving null; the injected `r23-none-pad`
            // bug leaves the 8 bytes out, so the object is smaller and in another size class
            this.coreUsed.add("u64");
            getters.push(`  get ${f.name}(): ${ty} {\n    return null;\n  }`);
            return this.fault === "r23-none-pad" ? null : `  ${f.name}_none: u64 = 0n;`;
          }
          return f.init === null ? `  ${f.name}!: ${ty};` : `  ${f.name}: ${ty} = ${f.init};`;
        })
        .filter((l): l is string => l !== null);
      if (plan.env !== undefined && plan.env.length > 0) {
        // An environment's constructor (R3): every field from its parameter of the same name and type.
        const tys = lines.map((l) => l.slice(l.indexOf(":") + 2, -1));
        lines.push(
          "",
          `  constructor(${plan.env.map((f, i) => `${f.name}: ${tys[i]}`).join(", ")}) {`,
          ...plan.env.map((f) => `    this.${f.name} = ${f.name};`),
          "  }",
        );
      }
      const methods = (this.memberText.get(n) ?? []).map((m) =>
        m
          .split("\n")
          .map((l) => (l === "" ? l : `  ${l}`))
          .join("\n"),
      );
      const body = [...lines, ...[...getters, ...methods].flatMap((m) => ["", m])];
      const note = plan.note !== undefined ? `// ${plan.note}\n` : "";
      // R5: a class that crosses an export is laid out as D36 lists it, exported so a host caller can make one (D71).
      const laid = this.boundaryLaid.get(n);
      const doc =
        laid === undefined
          ? ""
          : `/**\n * Crosses an export: D36's layout (4.5's ABI, R5), ${laid.fields.map((f) => `${f.tsl} at ${f.off}`).join(", ")}.\n * @tsl.size ${laid.size}\n */\nexport `;
      // R18: kept on the stack in `rc` (planStack), as the direct route keeps it
      const stack = this.stackPlans.has(n)
        ? "/** On the stack, as the lowering keeps every object of it (R18). @tsl.stack */\n"
        : "";
      const text = `${note}${stack}${doc}class ${plan.name} {\n${body.join("\n")}\n}`;
      this.classText.set(n, text);
      out.push(text, "");
    }
    return out;
  }

  /**
   * R18: in `rc`, the classes the lowering keeps on the stack, every object of them, as the direct route does (D39: what
   * isn't on the stack is counted). A class is one if each `new` of it is an allocation the lowering placed on its
   * function's stack (`stack()`: it doesn't escape, isn't reachable from module state and isn't made in a loop), its flow
   * class isn't long, and what it holds is numbers, booleans and objects of other such classes; and nothing else holds it:
   * no counted class's field, environment's capture, array's element or map's key or value. An environment class (a
   * closure value, R3) is one on the same terms, its captures as its fields. Such a class prints tagged `@tsl.stack`, and
   * tslc's expansion leaves it uncounted, its `new` a plain `new`, which tslc's escape checking puts on the stack and
   * refuses wherever one could outlive its frame (expand-rc.ts, SPEC 3.5's R18). The tag is the lowering's facts handed on;
   * tslc checks what it relies on, so a wrong tag is a build tslc refuses, not a wrong run.
   */
  stackPlans = new Set<HeapNode>();
  planStack(): void {
    if (this.memory !== "rc" || r18Off("stack")) return;
    // the injected bugs (TMK_TEST_EMIT): `r18-stack-any`, every class that holds what one can tagged, wherever its objects
    // go; `r18-stack-held`, a class a counted object's field holds tagged too
    const any = this.fault === "r18-stack-any";
    const anyHeld = this.fault === "r18-stack-held";
    const made = new Set<HeapNode>();
    const counted = new Set<HeapNode>();
    for (const f of this.funcs)
      eachTE(f.body, (te) => {
        if (te.k !== "alloc") return;
        const o = this.objNode(te.sh);
        if (o === null) return;
        made.add(o.node);
        const own = findNode((te.sh as Extract<Shape, { s: "obj" }>).node);
        if (te.stack() === null || own.long || findNode(o.node).long) counted.add(o.node);
      });
    // What each class holds: an object's fields, an environment's captures, of every closure it can be.
    const holds = (n: HeapNode): Shape[] => {
      const m = findNode(n);
      if (m.kind === "fn")
        return (this.envKinds.get(n) ?? []).flatMap((f) =>
          (f.cloEnv?.caps ?? []).map((c) => c.sh as Shape),
        );
      return [...m.fields.values()];
    };
    const target = (sh: Shape): HeapNode | null =>
      sh.s === "obj" || sh.s === "vec" ? this.canon(findNode(sh.node)) : null;
    const byField = new Set<HeapNode>();
    if (anyHeld)
      for (const [h] of this.plans)
        for (const sh of holds(h)) {
          const t = target(sh);
          if (t !== null && t !== h) byField.add(t);
        }
    const cand = new Set<HeapNode>();
    for (const [n, plan] of this.plans) {
      const m = findNode(n);
      if (!made.has(n) || (!any && !byField.has(n) && counted.has(n))) continue;
      if (m.dyn === true || m.weakOf !== undefined || m.variants.length > 0) continue;
      if (m.kind !== "obj" && !(m.kind === "fn" && plan.env !== undefined)) continue;
      if (this.boundaryLaid.has(n) || this.dynNode === n) continue;
      const ok = holds(n).every(
        (sh) =>
          sh.s === "num" ||
          sh.s === "bool" ||
          isOptScalar(sh) ||
          (sh.s === "obj" && this.plans.has(target(sh)!)),
      );
      if (ok) cand.add(n);
    }
    // Down to a fixed point: a class whose field's class isn't one, or which something not one holds, isn't one.
    const holders = [...this.plans.keys()];
    for (let changed = true; changed;) {
      changed = false;
      const heldByOther = new Set<HeapNode>();
      for (const h of holders) {
        if (cand.has(h)) continue;
        for (const sh of holds(h)) {
          const t = target(sh);
          if (t !== null) heldByOther.add(t);
        }
      }
      for (const [, es] of this.vecs) {
        const t = target(es);
        if (t !== null) heldByOther.add(t);
      }
      for (const [, mp] of this.mapPlans)
        for (const sh of [mp.keys, mp.vals]) {
          const t = target(sh);
          if (t !== null) heldByOther.add(t);
        }
      for (const n of cand) {
        const bad =
          (!any && !byField.has(n) && heldByOther.has(n)) ||
          holds(n).some((sh) => {
            const t = target(sh);
            return t !== null && !cand.has(t);
          });
        if (bad) {
          cand.delete(n);
          changed = true;
        }
      }
    }
    for (const n of cand) this.stackPlans.add(n);
  }

  /** A reference's type in the text: its class, `| null` where the lowering says it can be. */
  refText(c: { node: HeapNode; nul: boolean } | undefined, what: string): string {
    if (c === undefined) return this.fail(`the class of ${what}`);
    return c.nul ? `${this.clsName(c.node)} | null` : this.clsName(c.node);
  }

  /** A variable's declared type. */
  varTy(v: Var): string {
    if (this.classes && v.ty.k === "ref")
      return this.refText(this.varCls.get(v), `the variable ${v.name} in ${this.curFn}`);
    return this.tyText(v.ty);
  }

  /** An expression's type, for a temporary that holds it. */
  teTy(te: TE): string {
    if (this.classes && te.ty.k === "ref") {
      const o = this.objNode(te.sh);
      if (o !== null) return this.refText(o, te.k);
      if (te.k === "var") return this.varTy(te.v);
      // R9: a typed array's pointer, or an element's address past it: an address
      if (!r9Off("arrays") && this.r9 && isArrPtr(te)) return this.lowered("Ref");
      return this.fail(`the class of a temporary holding ${te.k}`);
    }
    return this.tyText(te.ty);
  }

  path: string[] = []; // the expressions being printed, for a message
  hashNames: string[] = []; // the hash key's two words, as module state (pipe-h)

  fail(what: string): never {
    throw new EmitUnsupported(
      this.path.length > 0 ? `${what} (in ${this.path.slice(-4).join(" > ")})` : what,
    );
  }

  run(): TslEmit {
    // Exceptions (D68): class printing desugars them itself, from the tree as it was before down-exc.ts, so the dual route
    // compares two implementations. The functions are the direct route's too, so what's swapped in is put back.
    // TMK_EMIT_EXC=0: as before D68, for finding what it moves (exceptions and `unknown` not printed with classes).
    const src = this.classes && EMIT_EXC ? this.r.excSource : undefined;
    if (src === undefined) return this.run1(this.r.typed.funcs);
    // R10: exceptions in `rc` aren't built through the TSL route. Until strings printed in `rc`, every program with them
    // stopped at its messages' strings first; their counts on each way out of a `try` and a native caller's `__exc_take` are
    // a design of their own, so they're refused by name here, and the direct route builds them.
    // R11: built since; TMK_R11_OFF=exc refuses them by name as before, for computing what R11 moved
    if (this.rc && r11Off("exc"))
      this.fail("exceptions in rc, desugared by the printer (D68), which aren't built in rc (R10)");
    const d = desugarExc(src, this.fault, { rc: this.rc });
    this.excOwn = true;
    try {
      return this.run1(d.funcs);
    } finally {
      d.restore();
    }
  }

  run1(all: FuncInst[]): TslEmit {
    // R10: in `rc`, a map that can't be JsMap (an iterator as a value, a key JsMap doesn't take) would print as compiler/rt's
    // own map runtime, whose hash key only printed module state reaches, which came with strings: never built in `rc`
    // before, and not built now (its generations and cursors, counted, aren't checked against the direct route's), so the
    // direct route builds it, as it did. TMK_R10_OFF=strings, as before R10, stops at the hash key itself.
    if (this.rc && !this.maps && this.strs)
      for (const i of this.r.insts) {
        const d = i.decl as ts.Node;
        if (d.getSourceFile().fileName.endsWith("/compiler/rt/map.ts") && all.includes(i.fi))
          this.fail(
            "rc: a map printed as compiler/rt's own runtime, not as JsMap, which isn't built in rc (R10)",
          );
      }
    this.funcs = this.maps ? this.mapFuncs(all) : all;
    if (this.maps && this.modules) this.fail(`${MAPS_NOT}in a program of several modules`);
    if (!this.strs) return this.run0();
    // Strings as JsString (D67): the string runtime's core isn't printed, and strConcat is its length check and concat.
    strTagsOnly = true;
    let concat: { f: FuncInst; body: Stmt[] } | null = null;
    try {
      for (const n of ["JsString", "JsFlat", "jsEq"]) this.topNames.add(n);
      // R10: in `rc`, the program's own string runtime's names, and what it takes from @tsl/core
      if (this.rc) for (const n of [...RC_STR_NAMES, ...RC_STR_CORE]) this.topNames.add(n);
      this.funcs = this.printedFuncs(this.funcs);
      const f = this.strConcatFn;
      if (f !== null && this.funcs.includes(f)) {
        concat = { f, body: f.body };
        f.body = this.concatBody(f);
      }
      const out = this.run0();
      if ((this.jsrtUsed.size > 0 || this.rcStrUsed) && this.modules)
        this.fail("strings in a program of several modules");
      return out;
    } finally {
      strTagsOnly = false;
      if (concat !== null) concat.f.body = concat.body;
    }
  }

  run0(): TslEmit {
    const t = this.r.typed;
    if (this.r.fallback.size > 0) this.fail(`${this.r.fallback.size} function(s) stay JS`);
    if ((t.externs ?? []).length > 0) this.fail("calls into JS");
    // The runtime the lowering linked, by its parts: its base and its mode's, then strings, the hash key, exceptions.
    const linked = new Set((t.extraFuncs ?? []).map((f) => f.name));
    // With strings as JsString (D67), a native caller's three string functions are the printing's own, over the class.
    const strAbi = this.strs && linked.has("__str_place");
    if (strAbi) for (const n of STR_ABI) linked.delete(n);
    // Exceptions desugared here (D68): their state and the native caller's four functions are printed here too.
    if (this.excOwn) {
      for (const n of EXC_ABI) linked.delete(n);
      if (this.modules) this.fail("exceptions in a program of several modules");
    }
    // The hash key (D42) with strings as JsString (pipe-h): two words of module state, and a native caller's
    // `__hash_key_use` printed over them, in place of the runtime's 8 bytes of data and its stores.
    // With maps as JsMap (D72) the key is JsMap's too, which `__hash_key_use` gives it, where nothing printed reads the data.
    const keyRead =
      !this.strs &&
      this.funcs.some((f) => {
        let hit = false;
        eachTE(f.body, (te) => {
          if (te.k === "gaddr" && te.name === "__hash_key") hit = true;
        });
        return hit;
      });
    const hashOwn =
      (this.strs || (this.maps && !keyRead)) && !this.modules && linked.has("__hash_key_use");
    if (hashOwn) linked.delete("__hash_key_use");
    let hashKey: Global | null = null;
    this.runtime = [
      ...(linked.has("__str_place") ? ["str"] : []),
      ...(linked.has("__hash_key_use") ? ["hash"] : []),
      ...(linked.has("__exc_take") ? ["exc"] : []),
    ];
    const setting = { memory: this.memory as "strict", runtime: this.runtime, from: this.from };
    const rt = loweredRuntime(setting);
    for (const g of rt.globals) this.runtimeGlobals.add(g.name);
    const rtFuncNames = new Set(rt.funcs.map((f) => f.name));
    for (const f of t.extraFuncs ?? [])
      if (
        !rtFuncNames.has(f.name) &&
        !(strAbi && STR_ABI.includes(f.name)) &&
        !(hashOwn && f.name === "__hash_key_use") &&
        !(this.excOwn && EXC_ABI.includes(f.name))
      )
        this.fail(`the runtime function ${f.name}, which a lowered package's runtime doesn't have`);
    for (const n of rtFuncNames)
      if (!linked.has(n)) this.fail(`the runtime function ${n}, which the lowering didn't link`);
    // Module state: the lowering's globals beyond its runtime's.
    const state: Global[] = [];
    const statics: { g: Global; init: string }[] = [];
    for (const g of t.extraGlobals ?? []) {
      if (this.runtimeGlobals.has(g.name)) continue;
      if (this.excOwn && EXC_STATE.includes(g.name)) continue;
      if (g.bytes !== undefined) {
        // Static data the lowering laid out, declared by what it is, so tslc lays it out the same way.
        if (/^__strlit_\d+$/.test(g.name) && this.strs) {
          statics.push({ g, init: "" });
        } else if (/^__strlit_\d+$/.test(g.name)) {
          const text = strLiteralText(g);
          if (text === null) this.fail(`the string literal ${g.name}`);
          statics.push({ g, init: `text(${JSON.stringify(text)}` });
        } else if (g.name === "__s_chars") {
          // With strings as JsString, its one-unit strings are the class's own (`JsString.ofUnit`).
          if (!this.strs) statics.push({ g, init: "charTable(" });
        } else if (g.name === "__hash_key" && hashOwn) hashKey = g;
        else if (g.name === "__hash_key") statics.push({ g, init: "hashKey(" });
        else this.fail(`the global ${g.name} has contents`);
        continue;
      }
      state.push(g);
    }
    // Names: functions first, then globals, then module state, every one unique at the top level.
    const claim = (want: string): string => {
      let n = sanitize(want);
      if (RESERVED.has(n) || CORE_TYPES.includes(n)) n = `${n}_`;
      for (let i = 2; this.topNames.has(n); i++) n = `${sanitize(want)}_${i}`;
      this.topNames.add(n);
      return n;
    };
    for (const n of LOWERED_NAMES) this.topNames.add(n);
    for (const n of CORE_NAMES) this.topNames.add(n);
    // One module per source module (D65): each name is its module's, and a function, a global or a piece of state is in
    // the module its declaration is in. The lowering names a top-level name two modules both declare for its module
    // (`shapes.area`), so that no name depends on the order of the imports: in its own module that's `area`, and printed
    // as one file, `area_inShapes`.
    for (const i of this.r.insts) this.fnMod.set(i.fi, i.decl.getSourceFile());
    const unq = (low: string, sf: ts.SourceFile | undefined): string => {
      if (sf === undefined) return low;
      const stem = sf.fileName.replace(/.*\//, "").replace(/\.ts$/, "");
      for (const pre of [`${stem}.`, `g.${stem}.`]) {
        if (!low.startsWith(pre)) continue;
        const rest = low.slice(pre.length);
        if (!this.r.sharedTop.has(rest.split(".")[0]!.replace(/\$\d+$/, ""))) continue;
        const g = pre.startsWith("g.") ? "g." : "";
        return this.modules ? `${g}${rest}` : `${g}${rest}_in${stemCap(sf)}`;
      }
      return low;
    };
    const claimIn = (want: string, sf: ts.SourceFile): string => {
      if (!this.modules) return claim(want);
      const taken = this.takenIn(sf);
      let n = sanitize(want);
      if (RESERVED.has(n) || CORE_TYPES.includes(n)) n = `${n}_`;
      for (let i = 2; taken.has(n); i++) n = `${sanitize(want)}_${i}`;
      taken.add(n);
      this.declIn(sf).add(n);
      return n;
    };
    const fnSf = (f: FuncInst): ts.SourceFile => this.fnMod.get(f) ?? this.rootSf;
    for (const f of this.funcs)
      this.fnNames.set(
        f,
        claimIn(f.exported ? f.jsName : unq(f.tirName, this.fnMod.get(f)), fnSf(f)),
      );
    for (const g of t.globals)
      this.globalNames.set(
        g,
        claimIn(
          unq(g.jsName || g.name, this.modOfData(g.name)),
          this.modOfData(g.name) ?? this.rootSf,
        ),
      );
    for (const g of state)
      this.dataNames.set(
        g.name,
        claimIn(unq(g.name, this.modOfData(g.name)), this.modOfData(g.name) ?? this.rootSf),
      );
    if (this.excOwn) for (const n of EXC_STATE) this.dataNames.set(n, claim(n));
    if (hashKey !== null) this.hashNames = [claim("hash_k0"), claim("hash_k1")];
    for (const x of statics)
      this.dataNames.set(
        x.g.name,
        claimIn(x.g.name.replace(/^__/, ""), this.modOfData(x.g.name) ?? this.rootSf),
      );

    if (this.classes) {
      this.planClasses();
      this.noneFields();
      this.planMembers();
      this.findThisCopies();
      this.planStack();
    }
    const parts: string[] = [];
    // Modules (D65): each part also goes to its own module's list, printed with that module as the one referring.
    const modParts = new Map<ts.SourceFile, string[]>();
    const put = (sf: ts.SourceFile | undefined, ...texts: string[]): void => {
      parts.push(...texts);
      if (!this.modules) return;
      const at = sf ?? this.rootSf;
      modParts.set(at, [...(modParts.get(at) ?? []), ...texts]);
    };
    const inMod = <X>(sf: ts.SourceFile | undefined, f: () => X): X => {
      this.curMod = this.modules ? (sf ?? this.rootSf) : null;
      try {
        return f();
      } finally {
        this.curMod = null;
      }
    };
    for (const g of t.globals) {
      const sf = this.modOfData(g.name);
      put(
        sf,
        inMod(sf, () => this.globalDecl(g)),
      );
    }
    for (const x of statics) {
      const n = this.dataNames.get(x.g.name)!;
      if (x.init === "") {
        put(this.modOfData(x.g.name), this.strLitDecl(n, x.g));
        continue;
      }
      const fn = x.init.slice(0, x.init.indexOf("("));
      this.loweredUsed.add(fn);
      const sep = x.init.endsWith("(") ? "" : ", ";
      put(this.modOfData(x.g.name), `const ${n} = ${x.init}${sep}${JSON.stringify(x.g.name)});`);
    }
    for (const g of state) {
      const n = this.dataNames.get(g.name)!;
      const sf = this.modOfData(g.name);
      const away = this.modules && (sf ?? this.rootSf) !== this.rootSf;
      const gsh = this.classes ? this.globSh.get(g.name) : undefined;
      if (this.classes) {
        // Module state as TSL module state: a global, zero to start with, as the lowering's block was.
        if (gsh === undefined)
          this.fail(`module state ${g.name} that nothing reads or writes whole`);
        const tag0 = n === g.name && !away ? "" : `/** @tsl.symbol ${g.name} */\n`;
        if (gsh.s === "arr") {
          // R9: a typed array, its pointer and length in a static object of R7's runtime class (D37's field form), which
          // starts at none, the lowering's zeroed block
          const holder = inMod(sf, () => this.arrFieldClass(ARRAY_BY_ELEM[gsh.elem]!));
          put(sf, `${tag0}const ${n} = new ${holder}();`);
          continue;
        }
        const ty = inMod(sf, () =>
          gsh!.s === "obj" || gsh!.s === "vec"
            ? `${this.clsName(findNode(gsh!.node))} | null`
            : gsh!.s === "bool"
              ? this.tyText({ k: "bool" })
              : this.tyText(locTy((gsh as Extract<Shape, { s: "num" }>).loc)),
        );
        const zero =
          gsh!.s === "obj" || gsh!.s === "vec" ? "null" : gsh!.s === "bool" ? "false" : "0";
        // The lowering's symbol, as phase 1's globals keep theirs: a native caller or a test driver can name it. Outside
        // the root module tslc would name it for its module, so it's always given there.
        const tag = n === g.name && !away ? "" : `/** @tsl.symbol ${g.name} */\n`;
        put(sf, `${tag}let ${n}: ${ty} = ${zero};`);
        continue;
      }
      this.loweredUsed.add("data");
      put(
        sf,
        `const ${n} = data(${g.size}${n === g.name && !away ? "" : `, ${JSON.stringify(g.name)}`});`,
      );
    }
    if (parts.length > 0) parts.push("");
    // Module init, in modules with classes: a module's state can only be assigned in its own module (an import is
    // read-only), so each module's part of the lowering's init is a function of its own, which the root's calls in the
    // order JS runs them. The TIR then differs from one file's, so it counts as reshaped.
    let funcs = this.funcs;
    if (this.modules) funcs = this.canonInit(funcs);
    if (this.modules && this.classes) funcs = this.splitInit(funcs, claimIn);
    for (const f of funcs) {
      const m = this.members.get(f);
      const sf = this.fnMod.get(f);
      if (m === undefined)
        put(
          sf,
          inMod(sf, () => this.func(f)),
          "",
        );
      else {
        const list = this.memberText.get(m.node) ?? [];
        const text = inMod(this.modOfPlan(m.node), () => this.func(f));
        list.push(this.smallKind(m.node, f, text) ? `/** @tsl.inline */\n${text}` : text);
        this.memberText.set(m.node, list);
      }
    }
    // An environment class with several kinds (R3): its `call` picks the kind's method by the kind field, a compare and a
    // direct call each, as closed-world dispatch does (D70), the last kind needing no compare.
    for (const [n, kinds] of this.envKinds) {
      if (kinds.length < 2 || !this.plans.has(n)) continue;
      const sig = this.cloSigs.get(kinds[0]!);
      if (sig === undefined) this.fail("a closure kind that wasn't printed");
      const names = sig!.params.map((p) => p.slice(0, p.indexOf(":"))).join(", ");
      // the injected `r19-kind-arm` bug (R19): in `rc`'s inlined switch, the first two kinds' calls swapped
      const swap = this.rc && !r19Off("inline") && this.fault === "r19-kind-arm";
      const call = (k: number): string =>
        `this.${this.members.get(kinds[swap && k < 2 ? 1 - k : k]!)!.name}(${names})`;
      // R19: in `rc`, inlined where it's called, so a call in a loop is the compare chain and the kind's method there, which
      // tslc's expansion and markInvariantFields let the optimiser take out of the loop: the kind and the captures are
      // stored by the environment's constructor alone (D73), and an unswitched loop calls the kind's method directly
      const lines = [
        ...(this.rc && !r19Off("inline") ? ["/** @tsl.inline */"] : []),
        `call(${sig!.params.join(", ")}): ${sig!.ret} {`,
      ];
      const last = kinds.length - 1;
      const kindAt =
        this.fault === "env-wrong-kind"
          ? (k: number): number => k + 2
          : (k: number): number => k + 1;
      for (let k = 0; k < last; k++)
        lines.push(
          sig!.ret === "void"
            ? `  if (this.kind === ${kindAt(k)}) {\n    ${call(k)};\n    return;\n  }`
            : `  if (this.kind === ${kindAt(k)}) return ${call(k)};`,
        );
      lines.push(sig!.ret === "void" ? `  ${call(last)};` : `  return ${call(last)};`, "}");
      const list = this.memberText.get(n) ?? [];
      list.push(lines.join("\n"));
      this.memberText.set(n, list);
    }
    if (this.strLitInit.length > 0 && !this.funcs.some((f) => f.tirName === "__init"))
      this.fail("string literals in a program with no module init to make them in");
    if (strAbi) {
      for (const n of ["i32", "u64", "usize"]) this.coreUsed.add(n);
      const str = this.strName("JsString");
      // the injected `rcstr-abi-len` bug (R10): a placed string one unit short of what the caller asked for
      const n = this.rc && this.fault === "rcstr-abi-len" ? "cast<i32>(n) - 1" : "cast<i32>(n)";
      put(
        this.rootSf,
        "// A native caller's strings (4.5's ABI, D67): one placed by length, its units' address, and its length.",
        `export function __str_place(n: usize): ${str} {\n  return ${this.strName("JsFlat.zeroed")}(${n});\n}`,
        "",
        `export function __str_units(s: ${str}): u64 {\n  return s.unitsAddr();\n}`,
        "",
        `export function __str_length(s: ${str}): i32 {\n  return s.len();\n}`,
        "",
      );
      this.loweredUsed.add("cast");
      // R10: in `rc` a native caller counts strings as it counts objects (R8): rcBoundaryText prints retain and release
      if (this.rc) this.rcStrAbi = true;
    }
    const places = this.classes ? this.boundaryPlaceText() : [];
    if (places.length > 0) put(this.rootSf, ...places);
    if (hashKey !== null) {
      const key = new DataView(hashKey.bytes!.buffer, hashKey.bytes!.byteOffset, 8);
      const [k0, k1] = this.hashNames;
      this.coreUsed.add("i32");
      if (this.mapPlans.size > 0) this.jsrtUsed.add("jsMapKey");
      put(
        this.rootSf,
        "// The hash key (D42): two words, which a native caller with entropy sets.",
        `let ${k0}: i32 = ${key.getInt32(0, true)};`,
        `let ${k1}: i32 = ${key.getInt32(4, true)};`,
        "",
        `export function __hash_key_use(a: i32, b: i32): void {\n  ${k0} = a;\n  ${k1} = b;${this.mapPlans.size > 0 ? "\n  jsMapKey(a, b);" : ""}\n}`,
        "",
      );
    }
    if (this.excOwn) {
      const src = this.r.excSource!;
      const dyn = this.clsName((src.dynSh as Extract<Shape, { s: "obj" }>).node);
      for (const n of ["i32", "bool"]) this.coreUsed.add(n);
      for (const n of ["data", "load", "store", "addr", "Ref"]) this.loweredUsed.add(n);
      const [on, val, mode, limit] = EXC_STATE.map((n) => this.dataNames.get(n)!);
      put(
        this.rootSf,
        "// Exceptions (D49, D68): whether one is in flight, and what it is; whether the native caller takes one that",
        "// reaches it (__exc_catch_use(1)) or gets the trap path; and the stack's end, where recursion throws RangeError.",
        `let ${on}: bool = false;`,
        `let ${val}: ${dyn} | null = null;`,
        `let ${mode}: i32 = 0;`,
        `const ${limit} = data(8, "__exc_stack_limit");`,
        "",
        "// The native caller's side (4.5's ABI, D36).",
        `export function __exc_catch_use(on: i32): void {
  ${mode} = on;
}`,
        "",
        `export function __exc_stack_use(limit: Ref): void {
  store<Ref>(addr(${limit}), 0, limit);
}`,
        "",
        `export function __exc_pending(): i32 {
  return ${on} ? 1 : 0;
}`,
        "",
        `export function __exc_take(): ${dyn} | null {
  const v = ${val};
  ${val} = null;
  ${on} = false;
  return v;
}`,
        "",
      );
      // R11: in `rc` a taken exception's count is the caller's (4.5), given back by the module's own release, as R8's
      // `__rc_release_<id>` takes a caller's count over (DownMeta.exc.release)
      if (this.rc)
        put(
          this.rootSf,
          "// The caller gives back a thrown value it took (4.5's ABI in `rc`, R8's pattern).",
          "/** @tsl.moves p */",
          `export function __exc_release(p: ${dyn}): void {}`,
          "",
        );
    }
    // Classes first: their declarations, with their methods, now that the methods are printed.
    if (this.classes) {
      const decls = [...this.classDecls(), ...this.holderDecls()];
      if (this.rcStrUsed) {
        // R10: the string runtime, the program's own in `rc` (emit-rcstr.ts), printed after the classes that use it
        for (const n of RC_STR_CORE) this.coreUsed.add(n);
        this.descUsed.add("u16"); // a value: the tails' element
        for (const n of ["cast", "part", "Ref"]) this.loweredUsed.add(n);
        // R21: the one-unit table, an array holder of the runtime's own
        if (!r21UnitsOff()) {
          this.gcUsed.add("JsRoomArray");
          this.stdUsed.add("ref");
          this.descUsed.add("u64");
        }
        decls.push(
          ...rcStrRuntime(
            this.hashNames.length === 2 ? [this.hashNames[0]!, this.hashNames[1]!] : null,
            this.join3Name !== null,
          ),
          "",
          ...this.join3Text(),
        );
      }
      parts.unshift(...decls);
      if (this.modules)
        for (const [n, text] of [...this.classText].reverse()) {
          const sf = this.modOfPlan(n) ?? this.rootSf;
          modParts.set(sf, [text, "", ...(modParts.get(sf) ?? [])]);
        }
    }
    if (this.modules) return this.assemble(modParts);

    const header: string[] = [
      `// Lowered from ${this.from} by tmk lower --emit tsl, in "${this.memory}" (SPEC 4.5, D62). Generated: edit the source.`,
    ];
    for (const d of this.descUsed) this.coreUsed.add(d);
    const coreTypes = [...this.coreUsed]
      .filter((n) => CORE_TYPES.includes(n) && !this.descUsed.has(n))
      .sort();
    const coreVals = [...this.coreUsed]
      .filter((n) => !CORE_TYPES.includes(n) || this.descUsed.has(n))
      .sort();
    if (this.coreUsed.size > 0)
      header.push(
        `import { ${[...coreVals, ...coreTypes.map((n) => `type ${n}`)].join(", ")} } from "@tsl/core";`,
      );
    const stdNames = [...this.stdUsed].filter((n) => n !== "JsArray").sort();
    if (stdNames.length > 0) header.push(`import { ${stdNames.join(", ")} } from "@tsl/std";`);
    // JsArray is @tsl/jsrt's, beside JsString; JsString is an interface (D70), so a type import: Node's and Bun's type
    // stripping drop it whole (pipe-split).
    const strictArr = this.memory === "strict";
    const jsrtNames = [
      ...this.jsrtUsed,
      ...(this.stdUsed.has("JsArray") && !strictArr ? ["JsArray"] : []),
    ];
    // R13: `strict`'s arena array is @tsl/jsrt/arena's, which links no heap (no @tsl/std)
    if (strictArr && (this.stdUsed.has("JsArray") || this.arenaRefUsed))
      header.push(
        `import { ${[...(this.stdUsed.has("JsArray") ? ["JsArenaArray"] : []), ...(this.arenaRefUsed ? ["ref"] : [])].join(", ")} } from "@tsl/jsrt/arena";`,
      );
    if (jsrtNames.length > 0)
      header.push(
        `import { ${[...jsrtNames.filter((n) => n !== "JsString").sort(), ...(this.jsrtUsed.has("JsString") ? ["type JsString"] : [])].join(", ")} } from "@tsl/jsrt";`,
      );
    if (this.gcUsed.size > 0)
      header.push(`import { ${[...this.gcUsed].sort().join(", ")} } from "@tsl/gc";`);
    if (this.nonNulls === 0) this.loweredUsed.delete("nonNull");
    const lowTypes = [...this.loweredUsed].filter((n) => n === "Ref" || n === "Opt").sort();
    const lowVals = [...this.loweredUsed].filter((n) => n !== "Ref" && n !== "Opt").sort();
    if (this.loweredUsed.size > 0)
      header.push(
        `import { ${[...lowVals, ...lowTypes.map((n) => `type ${n}`)].join(", ")} } from "@tsl/lowered";`,
      );
    const text = `${[...header, "", ...parts].join("\n").replace(/\n+$/, "")}\n`;
    const tslJson = `${JSON.stringify(
      {
        lowered: {
          memory: this.memory,
          ...(this.runtime.length > 0 ? { runtime: this.runtime } : {}),
          from: this.from,
        },
      },
      null,
      2,
    )}\n`;
    return {
      text,
      tslJson,
      stats: {
        funcs: t.funcs.length,
        lines: text.split("\n").length,
        intrinsics: this.intrinsics,
        memoryOps: this.memoryOps,
        hoisted: this.hoisted,
        restructured: this.restructured,
        reshapedWhy: Object.fromEntries(this.reshapedWhy),
        ...(this.jsrtUsed.size > 0 && !this.rcStrUsed ? { jsStrings: true } : {}),
        ...(this.rcStrUsed ? { rcStrings: true } : {}),
        ...(this.rcStrAbi ? { rcStrAbi: true } : {}),
        ...(this.rc && this.excOwn ? { rcExc: true } : {}),
        ...(this.classes ? { classes: true } : {}),
      },
      ...(this.boundaryInfo() !== undefined ? { boundary: this.boundaryInfo()! } : {}),
    };
  }

  // --- module level

  globalDecl(g: GlobalDef): string {
    const name = this.globalNames.get(g)!;
    const away = this.modules && (this.modOfData(g.name) ?? this.rootSf) !== this.rootSf;
    return name === g.name && !away
      ? this.globalDecl0(g, name)
      : `/** @tsl.symbol ${g.name} */\n${this.globalDecl0(g, name)}`;
  }

  globalDecl0(g: GlobalDef, name: string): string {
    if (g.array !== undefined) {
      const ctor = ARRAY_BY_ELEM[g.array.elem];
      if (ctor === undefined) this.fail(`a static array of ${g.array.elem}`);
      if (g.array.text !== undefined) this.fail("a static array from text");
      let vals: (number | bigint)[] | null = g.array.values ?? null;
      if (vals === null && g.array.bytes !== undefined) {
        if (g.array.elem !== "u8") this.fail("a static array given as bytes");
        vals = [...g.array.bytes];
      }
      if (vals === null) return `const ${name} = new ${ctor}(${g.array.length});`;
      if (vals.length !== g.array.length) this.fail("a static array shorter than its length");
      const body = vals.map((v) => (typeof v === "bigint" ? `${v}n` : numText(v))).join(", ");
      return `const ${name} = new ${ctor}([${body}]);`;
    }
    if (g.object !== undefined || g.table !== undefined) this.fail(`the global ${g.name}`);
    if (g.value !== undefined) {
      const kw = g.mutable ? "let" : "const";
      return `${kw} ${name}: ${this.tyText(g.ty)} = ${this.constText(g.value, g.ty)};`;
    }
    return this.fail(`the global ${g.name}`);
  }

  constText(v: number | bigint | boolean | string, ty: Ty): string {
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return String(this.strNum(v));
    if (ty.k === "int" && !Number.isInteger(v)) this.fail("a fractional integer");
    return numText(v);
  }

  strNum(s: string): number {
    const n = this.strings.get(s);
    if (n === undefined) this.fail(`the literal "${s}", which has no number`);
    return n;
  }

  tyText(t: Ty): string {
    switch (t.k) {
      case "int":
      case "big":
      case "float":
        this.coreUsed.add(t.name);
        return t.name;
      case "bool":
        this.coreUsed.add("bool");
        return "bool";
      case "lits":
      case "enum":
        // A literal union is a small integer (3.5): its text was numbered when the lowering interned it.
        this.coreUsed.add("i32");
        return "i32";
      case "ref":
        this.loweredUsed.add("Ref");
        return "Ref";
      case "arr": {
        const c = ARRAY_BY_ELEM[t.elem];
        if (c === undefined) this.fail(`a typed array of ${t.elem}`);
        return c;
      }
      case "opt":
        this.loweredUsed.add("Opt");
        return `Opt<${this.tyText(t.of)}>`;
      case "void":
        return "void";
      case "never":
        return "never";
      default:
        return this.fail(`the type ${t.k}`);
    }
  }

  // --- functions

  curFn = "";

  /**
   * The lowering's module init in the order of the imports, as JS runs it, except where that order can't matter: where
   * each module's part only stores constants into its own state, the parts go in the order of their paths, so the
   * printing doesn't depend on which import comes first (D65). A changed order is a reshaping: its TIR isn't the direct
   * route's.
   */
  canonInit(funcs: FuncInst[]): FuncInst[] {
    const init = funcs.find((f) => f.tirName === "__init");
    if (init === undefined) return funcs;
    const root = this.rootSf;
    const blocks = new Map<ts.SourceFile, Stmt[]>();
    let firstAt = -1;
    let lastAt = -1;
    init.body.forEach((st, i) => {
      const sf = this.r.initFiles.get(st);
      if (sf === undefined || sf === root) return;
      if (firstAt < 0) firstAt = i;
      lastAt = i;
      blocks.set(sf, [...(blocks.get(sf) ?? []), st]);
    });
    if (blocks.size < 2) return funcs;
    const span = init.body.slice(firstAt, lastAt + 1);
    if (span.some((st) => !blocks.has(this.r.initFiles.get(st) as ts.SourceFile))) return funcs;
    const own = (st: Stmt, sf: ts.SourceFile): boolean =>
      st.k === "expr" &&
      st.e.k === "fstore" &&
      st.e.base.k === "gaddr" &&
      st.e.val.k === "lit" &&
      this.r.globalFiles.get(st.e.base.name) === sf;
    for (const [sf, list] of blocks) if (!list.every((st) => own(st, sf))) return funcs;
    const sorted = [...blocks]
      .sort(([a], [b]) => (a.fileName < b.fileName ? -1 : 1))
      .flatMap(([, l]) => l);
    if (sorted.every((st, i) => st === span[i])) return funcs;
    this.reshape("module init order");
    const body = [...init.body.slice(0, firstAt), ...sorted, ...init.body.slice(lastAt + 1)];
    const top: FuncInst = { ...init, body };
    this.fnNames.set(top, this.fnNames.get(init)!);
    if (this.fnMod.has(init)) this.fnMod.set(top, this.fnMod.get(init)!);
    return funcs.map((f) => (f === init ? top : f));
  }

  /** The lowering's module init, one function per module that has a part of it, the root's calling the rest in order. */
  splitInit(funcs: FuncInst[], claimIn: (want: string, sf: ts.SourceFile) => string): FuncInst[] {
    const init = funcs.find((f) => f.tirName === "__init");
    if (init === undefined) return funcs;
    const root = this.rootSf;
    const groups = new Map<ts.SourceFile, Stmt[]>();
    const rootBody: Stmt[] = [];
    let prev: ts.SourceFile = root;
    let calls = 0;
    for (const st of init.body) {
      const own = this.r.initFiles.get(st);
      // A statement the lowering's later passes rebuilt has no note: it's from the module of the one before it.
      const sf = own ?? (st.k === "expr" && st.e.k === "rtcall" ? root : prev);
      prev = sf;
      if (sf === root) {
        rootBody.push(st);
        continue;
      }
      if (!groups.has(sf)) {
        groups.set(sf, []);
        calls++;
      }
      groups.get(sf)!.push(st);
    }
    if (calls === 0) return funcs;
    this.reshape("module init calls");
    const made: FuncInst[] = [];
    const callStmts: Stmt[] = [];
    // In the order the (canonical) init has them, which is JS's, or the paths' where that can't matter.
    for (const [sf, body] of groups) {
      const name = `__init_${sanitize(sf.fileName.replace(/.*\//, "").replace(/\.ts$/, ""))}`;
      const fi: FuncInst = {
        ...init,
        key: name,
        tirName: name,
        jsName: name,
        exported: false,
        attrs: [],
        body,
      };
      this.fnMod.set(fi, sf);
      this.fnNames.set(fi, claimIn(name, sf));
      made.push(fi);
      callStmts.push({ k: "expr", e: { ty: { k: "void" }, k: "call", inst: fi, args: [] } as TE });
    }
    // The arena's start first and its commit last, as the lowering put them; between them, JS's order: imports first.
    const first = rootBody[0];
    const head = first?.k === "expr" && first.e.k === "rtcall" ? [first] : [];
    const top: FuncInst = {
      ...init,
      body: [...head, ...callStmts, ...rootBody.slice(head.length)],
    };
    this.fnMod.set(top, root);
    this.fnNames.set(top, this.fnNames.get(init)!);
    return [...funcs.filter((f) => f !== init), top, ...made];
  }

  /** Each module's text: its imports, from @tsl/core, @tsl/lowered and the package's other modules, then its parts. */
  assemble(modParts: Map<ts.SourceFile, string[]>): TslEmit {
    const files = this.r.sourceFiles.filter((sf) => modParts.has(sf) || sf === this.rootSf);
    // A module cycle is TSL1010: the source may have one, the printing can't.
    const edges = new Map<ts.SourceFile, ts.SourceFile[]>();
    for (const [sf, by] of this.importsOf) edges.set(sf, [...by.keys()]);
    const state = new Map<ts.SourceFile, number>();
    const cyc = (sf: ts.SourceFile): boolean => {
      if (state.get(sf) === 1) return true;
      if (state.get(sf) === 2) return false;
      state.set(sf, 1);
      for (const d of edges.get(sf) ?? []) if (cyc(d)) return true;
      state.set(sf, 2);
      return false;
    };
    for (const sf of files)
      if (cyc(sf)) this.fail("modules that import each other, which TSL bans (TSL1010)");
    let common = dirname(files[0]!.fileName);
    for (const sf of files)
      while (!`${sf.fileName}`.startsWith(`${common}/`)) common = dirname(common);
    const pathOf = (sf: ts.SourceFile): string => relative(common, sf.fileName);
    const out: { path: string; text: string }[] = [];
    let lines = 0;
    for (const sf of files) {
      const ex = this.exportsOf.get(sf) ?? new Set<string>();
      const body = (modParts.get(sf) ?? []).map((part) =>
        part.replace(
          /^((?:\/\*\*.*?\*\/\n)?(?:\/\/[^\n]*\n)?)(function|class|let|const) ([A-Za-z_$][\w$]*)/,
          (m, pre: string, kw: string, name: string) =>
            ex.has(name) ? `${pre}export ${kw} ${name}` : m,
        ),
      );
      const text0 = body.join("\n");
      const used = (n: string): boolean =>
        new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, "\\$")}([^\\w$]|$)`, "m").test(text0);
      const header: string[] = [
        `// Lowered from ${pathOf(sf)} (of ${this.from}) by tmk lower --emit tsl, in "${this.memory}" (SPEC 4.5, D62, D65). Generated: edit the source.`,
      ];
      // A scalar named as a JsArray's descriptor is imported as a value, which names the type too.
      const asVal = (n: string): boolean =>
        this.descUsed.has(n) && new RegExp(`new ${this.arrCls}\\(${n},`).test(text0);
      const coreTypes = [...this.coreUsed, ...this.descUsed]
        .filter((n, i, a) => a.indexOf(n) === i && CORE_TYPES.includes(n) && used(n) && !asVal(n))
        .sort();
      const coreVals = [...this.coreUsed, ...this.descUsed]
        .filter((n, i, a) => a.indexOf(n) === i && (!CORE_TYPES.includes(n) || asVal(n)) && used(n))
        .sort();
      if (coreTypes.length + coreVals.length > 0)
        header.push(
          `import { ${[...coreVals, ...coreTypes.map((n) => `type ${n}`)].join(", ")} } from "@tsl/core";`,
        );
      const stdHere = [...this.stdUsed].filter((n) => n !== "JsArray" && used(n)).sort();
      if (stdHere.length > 0) header.push(`import { ${stdHere.join(", ")} } from "@tsl/std";`);
      // JsArray is @tsl/jsrt's (D66); strings aren't printed in a program of several modules.
      if (this.memory === "strict") {
        // R13: `strict`'s arena array, @tsl/jsrt/arena's
        const names = ["JsArenaArray", "ref"].filter(
          (n) => (n === "ref" ? this.arenaRefUsed : this.stdUsed.has("JsArray")) && used(n),
        );
        if (names.length > 0) header.push(`import { ${names.join(", ")} } from "@tsl/jsrt/arena";`);
      } else if (this.stdUsed.has("JsArray") && used("JsArray"))
        header.push(`import { JsArray } from "@tsl/jsrt";`);
      const lowUsed = [...this.loweredUsed].filter(used);
      const lowTypes = lowUsed.filter((n) => n === "Ref" || n === "Opt").sort();
      const lowVals = lowUsed.filter((n) => n !== "Ref" && n !== "Opt").sort();
      if (lowUsed.length > 0)
        header.push(
          `import { ${[...lowVals, ...lowTypes.map((n) => `type ${n}`)].join(", ")} } from "@tsl/lowered";`,
        );
      const imps = [...(this.importsOf.get(sf) ?? new Map<ts.SourceFile, Map<string, string>>())]
        .map(([owner, names]) => {
          let spec = relative(dirname(sf.fileName), owner.fileName);
          if (!spec.startsWith(".")) spec = `./${spec}`;
          const list = [...names]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([n, alias]) => (n === alias ? n : `${n} as ${alias}`));
          return { spec, line: `import { ${list.join(", ")} } from ${JSON.stringify(spec)};` };
        })
        .sort((a, b) => (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0))
        .map((x) => x.line);
      header.push(...imps);
      const text = `${[...header, "", ...body].join("\n").replace(/\n+$/, "")}\n`;
      lines += text.split("\n").length;
      out.push({ path: pathOf(sf), text });
    }
    out.sort((a, b) =>
      a.path === pathOf(this.rootSf)
        ? -1
        : b.path === pathOf(this.rootSf)
          ? 1
          : a.path < b.path
            ? -1
            : 1,
    );
    const tslJson = `${JSON.stringify(
      {
        lowered: {
          memory: this.memory,
          ...(this.runtime.length > 0 ? { runtime: this.runtime } : {}),
          from: this.from,
        },
      },
      null,
      2,
    )}\n`;
    return {
      text: out[0]!.text,
      modules: out,
      tslJson,
      stats: {
        funcs: this.r.typed.funcs.length,
        lines,
        intrinsics: this.intrinsics,
        memoryOps: this.memoryOps,
        hoisted: this.hoisted,
        restructured: this.restructured,
        reshapedWhy: Object.fromEntries(this.reshapedWhy),
      },
    };
  }

  func(f: FuncInst): string {
    this.curFn = f.tirName;
    this.curInst = f;
    this.varNames = new Map();
    this.usedNames = new Set();
    this.topDecls = new Map();
    this.topRefs = new Set();
    this.declared = new Set();
    this.body = [];
    this.ind = 1;
    this.loops = [];
    this.nextTemp = 1;
    this.nextCont = 1;
    if (f.isClosure === true || (f.captures ?? []).length > 0) this.fail("a closure");
    const member = this.members.get(f);
    if (member !== undefined) {
      // A method: its receiver is `this`.
      this.varNames.set(f.params[0]!, "this");
      this.usedNames.add("this");
      this.declared.add(f.params[0]!);
    }
    this.hoistedVars = hoistScan(f, this.rc);
    this.assignedVars = new Set();
    if (this.rc)
      eachTE(f.body, (x) => {
        if (x.k === "setvar") this.assignedVars.add(x.v);
      });
    // In `rc` (R2) a parameter is borrowed, so one holding a reference that the function assigns is a local given the
    // argument first: the expansion counts the local.
    const assignedParams = new Set<Var>();
    if (this.rc)
      eachTE(f.body, (x) => {
        if (x.k === "setvar" && x.v.ty.k === "ref" && f.params.includes(x.v))
          assignedParams.add(x.v);
      });
    const paramLocals: string[] = [];
    // A parameter with no leaves, `undefined` as a Set's value, isn't one in TIR either: it's left out of both sides.
    const params = f.params
      .filter((p, i) => !noLeaves(p.ty) && !(member !== undefined && i === 0))
      .map((p) => {
        this.declared.add(p);
        if (assignedParams.has(p)) {
          const local = this.varName(p);
          const given = this.rcLocal();
          paramLocals.push(`  let ${local}: ${this.varTy(p)} = ${given};`);
          return `${given}: ${this.varTy(p)}`;
        }
        return `${this.varName(p)}: ${this.varTy(p)}`;
      });
    let ret =
      this.classes && f.ret.k === "ref"
        ? this.refText(this.retCls.get(f), `${f.tirName}'s result`)
        : this.tyText(f.ret);
    // R7: a crossing map's `key` and `val` (D36's surface) give what JsMap's keyAt and valAt give, a reference's `| null`:
    // the same word, and the caller reads it as it reads any reference
    if (
      this.classes &&
      f.ret.k === "ref" &&
      this.mapRt.has(f) &&
      !ret.endsWith("| null") &&
      (this.mapRt.get(f) === "mapKey" || this.mapRt.get(f) === "mapVal")
    )
      ret = `${ret} | null`;
    if (f.cloEnv !== undefined) this.cloSigs.set(f, { params, ret });
    for (const v of this.hoistedVars) {
      this.declared.add(v);
      this.topDecls.set(this.varName(v), this.varTy(v));
      if (this.classes && v.ty.k === "ref") this.topRefs.add(this.varName(v));
    }
    this.body.push(...paramLocals);
    // R5: with classes, the lowering's return of nothing after a return isn't printed: it's dead, and would make the
    // result `| null`, with a check at every caller the direct route doesn't have.
    const tail = this.classes ? this.deadTail(f) : null;
    // the injected `dead-tail-live` bug: the live return before the dead one left out with it
    const cut = tail === null ? 0 : this.fault === "dead-tail-live" ? 2 : 1;
    this.stmts(cut > 0 ? f.body.slice(0, -cut) : f.body);
    // The string literals (D67), made first thing, before anything can read one.
    if (f.tirName === "__init" && this.strLitInit.length > 0)
      this.body.unshift(...this.strLitInit.map((l) => `  ${l}`));
    // tsc can't always see that a function's end is unreachable, as after a switch that returns in every case.
    const last = f.body[f.body.length - cut - 1];
    if (f.ret.k !== "void" && f.ret.k !== "never" && !endsInJump(last)) {
      this.line(`${this.lowered("unreachable")}();`);
    }
    const decls = [...this.topDecls].map(
      ([n, t]) => `  ${this.declText(n, t, this.topRefs.has(n))}`,
    );
    const attrs = f.attrs.filter((a) => ["inline", "noinline", "noalloc", "nosleep"].includes(a));
    // R23: in `rc`, the string runtime's `charCodeAt` inlined where it's called, at -O1 as at -O2, as a scan calls it a unit
    // at a time (`TMK_R23_OFF=codeat` for tools/r23-pins.ts)
    if (this.rc && this.strs && this.rcCodeAt(f) && !attrs.includes("inline")) attrs.push("inline");
    const name = this.fnNames.get(f)!;
    const tags = attrs.map((a) => `@tsl.${a}`);
    // Class printing makes TSL classes whose members have symbols like the lowering's `P.constructor`: its TIR is tslc's
    // own, so the printed name is the symbol.
    const away = this.modules && (this.fnMod.get(f) ?? this.rootSf) !== this.rootSf;
    if ((name !== f.tirName || away) && !(this.classes && f.tirName.includes(".")))
      tags.push(`@tsl.symbol ${f.tirName}`);
    const doc = tags.length > 0 ? `/** ${tags.join(" ")} */\n` : "";
    if (member !== undefined) {
      return `${doc}${member.name}(${params.join(", ")}): ${ret} {\n${[...decls, ...this.body].join("\n")}\n}`;
    }
    const kw = f.exported ? "export function" : "function";
    return `${doc}${kw} ${this.fnNames.get(f)!}(${params.join(", ")}): ${ret} {\n${[...decls, ...this.body].join("\n")}\n}`;
  }

  /** R23: compiler/rt's `strCharCodeAt`, printed in `rc` over the program's own JsStr. */
  rcCodeAt(f: FuncInst): boolean {
    return (
      !r23Off("codeat") &&
      f.key.includes("/compiler/rt/str.ts") &&
      /^strCharCodeAt(\$\d+)?$/.test(f.tirName)
    );
  }

  /**
   * A variable declared before it's assigned: `let x!: T`, which the lowering knows is assigned on every path before it's
   * read. In `rc` (R2) a reference starts as null instead, since the expansion counts it and drops what it held when it's
   * assigned or goes out of scope; tsc's narrowing it can't see is a `!` at the sites, as everywhere in class printing.
   */
  declText(n: string, t: string, ref: boolean): string {
    if (this.rc && ref) return `let ${n}: ${t.endsWith(" | null") ? t : `${t} | null`} = null;`;
    return `let ${n}!: ${t};`;
  }

  varName(v: Var): string {
    const had = this.varNames.get(v);
    if (had !== undefined) return had;
    let base = sanitize(v.name.replace(/^\$/, "t_"));
    if (RESERVED.has(base) || CORE_TYPES.includes(base)) base = `${base}_`;
    let n = base;
    if (this.usedNames.has(n) || this.topNames.has(n)) n = `${base}_${v.id}`;
    for (let i = 2; this.usedNames.has(n) || this.topNames.has(n); i++) n = `${base}_${v.id}_${i}`;
    this.usedNames.add(n);
    this.varNames.set(v, n);
    return n;
  }

  tempFor(te: TE): string {
    if (!this.classes || te.ty.k !== "ref") return this.temp(te.ty);
    let n = `tmp${this.nextTemp++}`;
    while (this.usedNames.has(n) || this.topNames.has(n)) n = `tmp${this.nextTemp++}`;
    this.usedNames.add(n);
    this.topDecls.set(n, this.teTy(te));
    this.topRefs.add(n);
    return n;
  }

  temp(ty: Ty): string {
    let n = `tmp${this.nextTemp++}`;
    while (this.usedNames.has(n) || this.topNames.has(n)) n = `tmp${this.nextTemp++}`;
    this.usedNames.add(n);
    this.topDecls.set(n, this.tyText(ty));
    return n;
  }

  line(s: string): void {
    this.body.push(`${"  ".repeat(this.ind)}${s}`);
  }

  /** Prints the statements, with what each needs before it. */
  stmts(list: Stmt[]): void {
    for (const s of this.grouped(this.rc ? liveStmts(list) : list)) this.stmt(s);
  }

  /**
   * A vector's push, as the lowering spells it (reserve one more, store at the old length, store the length), is one
   * call to JsArray's `push` (D66), whose own steps are the same.
   */
  grouped(list: Stmt[]): Stmt[] {
    if (!this.classes || this.vecs.size === 0) return list;
    const out: Stmt[] = [];
    for (let i = 0; i < list.length; i++) {
      const [a, b, c] = [list[i]!, list[i + 1], list[i + 2]];
      if (
        a.k === "expr" &&
        a.e.k === "rtcall" &&
        this.vecRt(a.e) === "reserve" &&
        b?.k === "expr" &&
        b.e.k === "fstore" &&
        this.vecElem.has(b.e.base) &&
        c?.k === "expr" &&
        c.e.k === "fstore" &&
        this.isVecLen(c.e) &&
        c.e.base === a.e.args[0] &&
        c.e.val === a.e.args[1]
      ) {
        const next = a.e.args[1]!;
        const idx = (b.e.base as Extract<TE, { k: "elemaddr" }>).idx;
        const v = this.vecData(b.e.base)!;
        const same = (x: TE, y: TE): boolean =>
          x === y || (x.k === "var" && y.k === "var" && x.v === y.v);
        if (
          next.k === "arith" &&
          next.op === "add" &&
          next.b.k === "lit" &&
          Number(next.b.value) === 1 &&
          same(next.a, idx) &&
          same(v, a.e.args[0]!)
        ) {
          out.push({
            k: "expr",
            e: { ...a.e, name: "$push", args: [a.e.args[0]!, b.e.val] } as TE,
          });
          i += 2;
          continue;
        }
      }
      out.push(a);
    }
    return out;
  }

  /** One statement: its expressions first, collecting what they need before them, then the statement. */
  withPre(f: () => string | null): void {
    const was = this.pre;
    this.pre = [];
    const text = f();
    const pre = this.pre;
    this.pre = was;
    for (const p of pre) this.line(p);
    if (text !== null) this.line(text);
  }

  /** Runs an expression's printing into a statement list of its own, for a branch or a loop's condition. */
  captured(f: () => string): { pre: string[]; text: string } {
    const was = this.pre;
    this.pre = [];
    const text = f();
    const pre = this.pre;
    this.pre = was;
    return { pre, text };
  }

  /** Statements printed into strings, at a given indent, for the bodies of hoisted control flow. */
  printedStmts(list: Stmt[], ind: number): string[] {
    const was = { body: this.body, ind: this.ind };
    this.body = [];
    this.ind = ind;
    this.stmts(list);
    const got = this.body;
    this.body = was.body;
    this.ind = was.ind;
    return got.map((l) => (l.trimStart() === l ? l : l.slice(2 * ind)));
  }

  stmt(s: Stmt): void {
    switch (s.k) {
      case "let": {
        // In `rc` (R2) a local given a statement-expression whose value is a temporary it declares, `const c = { const t
        // = new C(); t.init(); t }`, is that temporary: its statements print with the local's name.
        if (
          this.rc &&
          s.init !== null &&
          s.init.k === "blockexpr" &&
          strArgs(s.init) === null && // R10: a string intrinsic prints as its call on JsStr, not its expansion
          s.v.ty.k === "ref" &&
          !this.hoistedVars.has(s.v) &&
          !this.assignedVars.has(s.v)
        ) {
          const b = s.init;
          const res = b.result;
          if (
            res.k === "var" &&
            b.body.some((st) => st.k === "let" && st.v === res.v) &&
            !this.assignedVars.has(res.v) &&
            !this.hoistedVars.has(res.v) &&
            !(this.maps && this.mapNew(b) !== null) &&
            !this.isEnvBlock(b)
          ) {
            this.declared.add(s.v);
            this.varNames.set(res.v, this.varName(s.v));
            // R10: the temporary is the local now, so rcAliases mustn't name it as what it's given (`let t = e`): that left
            // the local undeclared, which a narrowing into a string runtime call (`__dyn_class_name`) first reached
            this.rcNamed.add(res.v);
            this.withPre(() => {
              this.hoistBody(b.body, b.result);
              return null;
            });
            return;
          }
        }
        // In `rc` (R2) a local that only ever names what another does, `const b = a` with neither assigned again, is
        // printed as that one: the expansion would count the copy, a share and a drop for nothing.
        if (
          this.rc &&
          s.init !== null &&
          s.init.k === "var" &&
          s.v.ty.k === "ref" &&
          !this.hoistedVars.has(s.v) &&
          !this.assignedVars.has(s.v) &&
          !this.rcNamed.has(s.v) &&
          (!this.assignedVars.has(s.init.v) || this.fault === "rc-alias-any") &&
          this.declared.has(s.init.v)
        ) {
          this.declared.add(s.v);
          this.varNames.set(s.v, this.varName(s.init.v));
          return;
        }
        this.declared.add(s.v);
        const name = this.varName(s.v);
        const ty = this.varTy(s.v);
        if (this.hoistedVars.has(s.v)) {
          if (s.init !== null) this.withPre(() => `${name} = ${this.value(s.init!)};`);
          return;
        }
        if (s.init === null) {
          // Assigned on every path before it's read, which the lowering knows and tsc can't always see.
          this.line(this.declText(name, ty, this.classes && s.v.ty.k === "ref"));
          return;
        }
        this.withPre(
          () => `${s.constant ? "const" : "let"} ${name}: ${ty} = ${this.value(s.init!)};`,
        );
        return;
      }
      case "expr":
        this.exprStmt(s.e);
        return;
      case "return":
        if (s.val === null) this.line("return;");
        else if (s.val.ty.k === "void" || s.val.ty.k === "never") {
          this.exprStmt(s.val);
          this.line("return;");
        } else this.withPre(() => `return ${this.value(s.val!)};`);
        return;
      case "if": {
        let c = "";
        this.withPre(() => {
          c = this.value(s.c);
          return null;
        });
        this.line(`if (${c}) {`);
        this.block(s.a);
        if (s.b !== null && s.b.length > 0) {
          this.line("} else {");
          this.block(s.b);
        }
        this.line("}");
        return;
      }
      case "block":
        this.line("{");
        this.block(s.body);
        this.line("}");
        return;
      case "label": {
        const name = sanitize(s.name);
        const inner = s.body;
        if (inner.k === "while" || inner.k === "do" || inner.k === "for") {
          this.pendingLabel = name;
          this.stmt(inner);
          return;
        }
        this.line(`${name}: {`);
        this.block([inner]);
        this.line("}");
        return;
      }
      case "break":
        this.line(s.label === null ? "break;" : `break ${sanitize(s.label)};`);
        return;
      case "continue": {
        const want = s.label === null ? null : sanitize(s.label);
        for (let i = this.loops.length - 1; i >= 0; i--) {
          const l = this.loops[i]!;
          if (want !== null && l.label !== want) continue;
          if (l.cont !== null) this.line(`break ${l.cont};`);
          else this.line(want === null ? "continue;" : `continue ${want};`);
          return;
        }
        this.line(want === null ? "continue;" : `continue ${want};`);
        return;
      }
      case "while":
        this.whileStmt(s);
        return;
      case "do":
        this.doStmt(s);
        return;
      case "for":
        this.forStmt(s);
        return;
      case "switch": {
        let v = "";
        this.withPre(() => {
          v = this.value(s.val);
          return null;
        });
        this.line(`switch (${v}) {`);
        this.ind++;
        let clauses = s.clauses;
        if (
          this.fault === "switch-arm" &&
          clauses.length >= 2 &&
          clauses[0]!.keys.length > 0 &&
          clauses[1]!.keys.length > 0
        )
          clauses = [
            { ...clauses[0]!, keys: clauses[1]!.keys },
            { ...clauses[1]!, keys: clauses[0]!.keys },
            ...clauses.slice(2),
          ];
        for (const c of clauses) {
          // A clause with several keys is TS's run of empty cases, which tslc makes a block each at -O0.
          if (c.keys.length + (c.isDefault ? 1 : 0) > 1)
            this.reshape("a switch clause with several keys");
          for (const k of c.keys) this.line(`case ${this.constOf(k)}:`);
          if (c.isDefault) this.line("default:");
          this.line("{");
          this.block(c.body);
          this.line("}");
        }
        this.ind--;
        this.line("}");
        return;
      }
      default:
        this.fail(`the statement ${s.k}`);
    }
  }

  block(list: Stmt[]): void {
    this.ind++;
    this.stmts(list);
    this.ind--;
  }

  takeLabel(): string | null {
    const l = this.pendingLabel;
    this.pendingLabel = null;
    return l;
  }

  whileStmt(s: Extract<Stmt, { k: "while" }>): void {
    const label = this.takeLabel();
    const c = this.captured(() => this.cond(s.c));
    const lp = label !== null ? `${label}: ` : "";
    this.loops.push({ label, cont: null });
    if (c.pre.length === 0) {
      this.line(`${lp}while (${c.text}) {`);
      this.block(s.body);
    } else {
      // Its condition has statements of its own: they run again on every turn, a `continue` included.
      this.hoisted++;
      this.reshape("a loop condition with statements");
      this.line(`${lp}while (true) {`);
      this.ind++;
      for (const p of c.pre) this.line(p);
      this.line(
        `if (${c.text}) {} else break; // the loop's condition: its statements run on every turn`,
      );
      this.stmts(s.body);
      this.ind--;
    }
    this.loops.pop();
    this.line("}");
  }

  doStmt(s: Extract<Stmt, { k: "do" }>): void {
    const label = this.takeLabel();
    const lp = label !== null ? `${label}: ` : "";
    const c = this.captured(() => this.cond(s.c));
    if (c.pre.length === 0) {
      this.loops.push({ label, cont: null });
      this.line(`${lp}do {`);
      this.block(s.body);
      this.loops.pop();
      this.line(`} while (${c.text});`);
      return;
    }
    this.hoisted++;
    this.reshape("a loop condition with statements (do-while)");
    const cont = `cont${this.nextCont++}`;
    this.loops.push({ label, cont });
    this.line(`${lp}do {`);
    this.ind++;
    this.line(`${cont}: {`);
    this.block(s.body);
    this.line("}");
    this.loops.pop();
    for (const p of c.pre) this.line(p);
    this.ind--;
    this.line(`} while (${c.text});`);
  }

  forStmt(s: Extract<Stmt, { k: "for" }>): void {
    const label = this.takeLabel();
    const lp = label !== null ? `${label}: ` : "";
    // The header's own declarations: `let i = 0` stays in the header when it needs nothing before it.
    const inits: string[] = [];
    let initOk = true;
    const initPre: string[] = [];
    const assigns: string[] = [];
    for (const st of s.init) {
      if (st.k === "expr") {
        const c = this.captured(() => this.effect(st.e));
        initPre.push(...c.pre);
        if (c.text !== "") assigns.push(c.text);
        continue;
      }
      if (st.k !== "let" || st.init === null) {
        initOk = false;
        break;
      }
      this.declared.add(st.v);
      const name = this.varName(st.v);
      const c = this.captured(() => this.value(st.init!));
      initPre.push(...c.pre);
      if (this.hoistedVars.has(st.v)) assigns.push(`${name} = ${c.text}`);
      else inits.push(`${name}: ${this.varTy(st.v)} = ${c.text}`);
    }
    if (inits.length > 0 && assigns.length > 0) initOk = false;
    const c = s.c !== null ? this.captured(() => this.cond(s.c!)) : { pre: [], text: "" };
    const steps = s.step.map((e) => this.captured(() => this.effect(e)));
    const simple =
      initOk &&
      initPre.length === 0 &&
      c.pre.length === 0 &&
      steps.every((x) => x.pre.length === 0);
    if (simple) {
      // Each let in a for header has its own type, so a header with two only holds them if they share one.
      const one =
        inits.length <= 1 ||
        new Set(s.init.map((st) => (st.k === "let" ? this.varTy(st.v) : ""))).size === 1;
      if (one) {
        this.loops.push({ label, cont: null });
        const head =
          assigns.length > 0
            ? assigns.join(", ")
            : inits.length === 0
              ? ""
              : `let ${inits.map((x, i) => (i === 0 ? x : x.replace(/^([^:]+): [^=]+=/, "$1 ="))).join(", ")}`;
        const step = steps
          .map((x) => (steps.length === 1 ? this.rcStmt(x.text) : x.text))
          .filter((x) => x !== "")
          .join(", ");
        this.line(`${lp}for (${head}; ${c.text}; ${step}) {`);
        this.block(s.body);
        this.loops.pop();
        this.line("}");
        return;
      }
    }
    // Otherwise a block with the header's statements, and a loop whose end is the step: a `continue` breaks to it.
    this.hoisted++;
    this.reshape("a for step with statements");
    this.line("{");
    this.ind++;
    if (initOk) {
      for (const p of initPre) this.line(p);
      inits.forEach((x) => this.line(`let ${x};`));
      assigns.forEach((x) => this.line(`${x};`));
    } else this.stmts(s.init);
    const cont = `cont${this.nextCont++}`;
    this.loops.push({ label, cont });
    this.line(`${lp}while (true) {`);
    this.ind++;
    for (const p of c.pre) this.line(p);
    if (s.c !== null)
      this.line(
        `if (${c.text}) {} else break; // the loop's condition: its statements run on every turn`,
      );
    this.line(`${cont}: {`);
    this.block(s.body);
    this.line("}");
    this.loops.pop();
    for (const st of steps) {
      for (const p of st.pre) this.line(p);
      if (st.text !== "") this.line(`${this.rcStmt(st.text)};`);
    }
    this.ind--;
    this.line("}");
    this.ind--;
    this.line("}");
  }

  constOf(k: TE): string {
    if (k.k !== "lit") this.fail("a switch case that isn't a literal");
    if (typeof k.value === "string") return String(this.strNum(k.value));
    if (typeof k.value === "boolean") return String(k.value);
    if (typeof k.value === "bigint") return `${k.value}n`;
    return numText(k.value);
  }

  // --- expressions

  /** An expression evaluated for its effect: printed as a statement, or nothing if it has none. */
  exprStmt(e: TE): void {
    this.withPre(() => {
      const t = this.effect(e);
      return t === "" ? null : `${this.rcStmt(t)};`;
    });
  }

  /** Whether this prints in `rc` with classes (R2): tslc's expansion counts what it prints, statement by statement (D74). */
  get rc(): boolean {
    return this.classes && this.memory === "rc";
  }

  /**
   * In `rc`, a statement's own text without the parentheses an expression's printing gives it: the expansion takes an
   * assignment of a counted reference as a statement only when it's plainly one (`a.next = b;`, not `(a.next = b);`).
   */
  rcStmt(t: string): string {
    if (!this.rc || !t.startsWith("(") || !t.endsWith(")")) return t;
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i < t.length - 1) return t;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        // a string literal: what's in it isn't a parenthesis
        for (i++; i < t.length && t[i] !== ch; i++) if (t[i] === "\\") i++;
      } else if (ch === "/" && t[i + 1] === "*") {
        const end = t.indexOf("*/", i + 2);
        if (end < 0) return t;
        i = end + 1;
      }
    }
    return this.rcStmt(t.slice(1, -1));
  }

  /**
   * In `rc`, whether an expression with statements in it is printed as those statements before its own (R2): where it
   * makes, holds or stores a reference, which the expansion counts only in a statement of its own. Arithmetic stays a comma.
   */
  rcHoists(e: TE): boolean {
    if (!this.rc) return false;
    let hit = false;
    eachTE(e, (x) => {
      if (hit) return;
      if (x.k === "alloc") hit = true;
      else if (
        (x.k === "setvar" || x.k === "setglobal" || x.k === "fstore") &&
        x.val.ty.k === "ref"
      )
        hit = true;
    });
    if (!hit && e.k === "blockexpr")
      hit = e.body.some((st) => st.k === "let" && st.v.ty.k === "ref");
    return hit;
  }

  /** An expression's text for its effect alone, "" when it has none. */
  effect(e0: TE): string {
    const e = (e0.k === "blockexpr" ? this.foldedReads.get(e0) : undefined) ?? e0;
    if (this.strs && e.strop !== undefined) return this.strOp(e);
    // An environment's kind (R3), where its class has one kind: nothing to say.
    if (this.classes && e.k === "fstore" && e.fld?.name === "$kind" && !this.envField(e.fld))
      return e.base.k === "var" ? "" : this.effect(e.base);
    switch (e.k) {
      case "lit":
        // A literal nothing uses is still a constant at -O0 in the direct route; kept, so -O0's TIR is the same.
        if (e.ty.k === "int" || e.ty.k === "float" || e.ty.k === "big" || e.ty.k === "lits")
          return this.typedArg(e);
        return "";
      // A read nothing uses is still a read: a variable's last value at a merge is what keeps a load before it, as in the
      // direct route, where the same read makes the same merge (SPEC 4.3's keep rule works from what -O0 uses).
      case "var":
      case "global":
        return this.value(e);
      case "tuple":
        if (e.items.length === 0) return "";
        break;
      case "blockexpr": {
        if (this.isEnvBlock(e)) return this.value(e);
        // R16: a push whose value nothing uses: the lowering's push is a statement-expression whose value is the length read
        // again after it; where nothing uses it, that read of an array the push just wrote prints as nothing, as it can't
        // trap or change anything (at -O0 it was a call to the length getter, and at -O1 and -O2 a load kept for it, as the
        // push's slow path is a call the length can't be known across).
        if (this.simpleBody(e.body) && !this.rcHoists(e) && this.pushedLength(e))
          return this.sequence(this.bodyPartFns(e.body));
        if (this.simpleBody(e.body) && !this.rcHoists(e))
          return this.sequence([...this.bodyPartFns(e.body), () => this.effect(e.result)]);
        this.hoistBody(e.body, e.result);
        // R17: and where `rc` hoists the body (the push a statement of its own), the read after it prints as nothing too,
        // as R16's does in a comma expression. TMK_R17_OFF=pushlen prints it, for tools/r17-pins.ts.
        if (this.rc && !r17Off("pushlen") && this.pushedLength(e)) return "";
        return this.effect(e.result);
      }
      case "seq":
        return this.sequence(
          [...e.items.map((x) => () => this.effect(x)), () => this.effect(e.result)],
          this.rcHoists(e),
        );
      case "fstore":
        if (e.mem.length === 0) return this.effect(e.base);
        break;
      default:
        break;
    }
    // An assignment whose value nothing uses isn't a reference site: a `!` on it would leave tsc a comma's left side
    // with no effect (TS2695), and its value's own site is where a `!` goes.
    if (EMIT_EXC && this.classes && (e.k === "fstore" || e.k === "setvar" || e.k === "setglobal")) {
      this.path.push(e.k);
      this.effectOf = e;
      try {
        return this.value0(e);
      } finally {
        this.effectOf = null;
        this.path.pop();
      }
    }
    return this.value(e);
  }

  /**
   * R16: a statement-expression whose body ends in a push (`$push`, grouped) and whose value is the same array's length read
   * again (maybe converted): in a statement, or anywhere its value is unused, that read is nothing.
   */
  pushedLength(e: Extract<TE, { k: "blockexpr" }>): boolean {
    if (!this.classes || this.vecs.size === 0 || r16Off("pushlen")) return false;
    const body = this.grouped(e.body);
    const last = body[body.length - 1];
    if (last?.k !== "expr" || last.e.k !== "rtcall" || last.e.name !== "$push") return false;
    const v = last.e.args[0];
    let r: TE = e.result;
    while (r.k === "conv") r = r.val;
    if (r.k !== "fload" || !this.isVecLen(r) || v === undefined) return false;
    return r.base === v || (r.base.k === "var" && v.k === "var" && r.base.v === v.v);
  }

  /** A body of lets and expressions only: it can be a comma expression, with its lets declared at the function's top. */
  simpleBody(body: Stmt[]): boolean {
    return body.every((s) => s.k === "let" || s.k === "expr");
  }

  /** A simple body's parts, each printed when it's called: a let as an assignment to a variable declared at the top. */
  bodyPartFns(body: Stmt[]): (() => string)[] {
    const out: (() => string)[] = [];
    for (const s of this.grouped(body)) {
      if (s.k === "let") {
        out.push(() => {
          this.declared.add(s.v);
          const n = this.varName(s.v);
          this.topDecls.set(n, this.varTy(s.v));
          if (this.classes && s.v.ty.k === "ref") this.topRefs.add(n);
          return s.init !== null ? `(${n} = ${this.value(s.init)})` : "";
        });
      } else if (s.k === "expr") out.push(() => this.effect(s.e));
    }
    return out;
  }

  /**
   * A comma expression of these parts, in order, the last one its value. Where a part needs statements before it, every
   * part ahead of it becomes a statement too, after its own, so nothing runs out of order.
   */
  sequence(parts: (() => string)[], hoist = false): string {
    const outs = parts.map((f) => this.captured(f));
    // `hoist` (rc, R2): every part but the last is a statement of its own, before the statement holding it.
    const lastPre = hoist
      ? outs.length - 1
      : outs.reduce((at, o, i) => (o.pre.length > 0 ? i : at), -1);
    if (lastPre > 0)
      this.reshape(
        hoist
          ? "a sequence hoisted into statements (rc)"
          : "a sequence with statements in a part after the first",
      );
    const keep: string[] = [];
    const late: string[] = [];
    outs.forEach((o, i) => {
      this.pre.push(...o.pre);
      const last = i === outs.length - 1;
      if (i < lastPre) {
        if (o.text !== "")
          // R14's `seq-late`: the sequence's own injected bug, its earlier parts run after a later part's statements
          (this.fault === "hoist-late" || this.fault === "seq-late" ? late : this.pre).push(
            `${this.rcStmt(o.text)};`,
          );
      } else if (!last && /^[A-Za-z_$][\w$]*$/.test(o.text)) {
        // A bare read inside a comma is tsc's error (TS2695), and it reads nothing a load needs.
      } else if (o.text !== "" || last) keep.push(o.text);
    });
    this.pre.push(...late);
    const vals = keep.filter((x, i) => x !== "" || i === keep.length - 1);
    if (vals.length === 1) return vals[0]!;
    const body = vals.filter((x) => x !== "");
    if (body.length === 0) return "";
    return body.length === 1 ? body[0]! : `(${body.join(", ")})`;
  }

  /** A statement-expression with control flow in it: its statements go before the statement that holds it. */
  hoistBody(body: Stmt[], result?: TE): void {
    this.hoisted++;
    const pre = this.pre;
    if (this.rc) body = this.rcAliases(body, result);
    const lines = this.printedStmts(body, 0);
    pre.push(...lines);
  }

  /**
   * In `rc` (R2), a statement-expression's temporary that only names a variable another names, `{ let t = a; t.next = b }`,
   * is printed as that variable: the expansion would count the copy, a share and a drop for nothing. Only where neither is
   * assigned in the statement-expression, so the two hold the same reference throughout.
   */
  rcAliases(body: Stmt[], result: TE | undefined): Stmt[] {
    const out: Stmt[] = [];
    const before = new Set<Var>(); // what this statement-expression declared ahead of the one at hand
    for (const st of body) {
      if (
        st.k === "let" &&
        st.v.ty.k === "ref" &&
        st.init !== null &&
        st.init.k === "var" &&
        !this.rcNamed.has(st.v) &&
        (this.declared.has(st.init.v) || before.has(st.init.v))
      ) {
        const src = st.init.v;
        let assigned = false;
        const scan = (root: unknown): void =>
          eachTE(root, (x) => {
            if (x.k === "setvar" && (x.v === src || x.v === st.v)) assigned = true;
          });
        scan(body);
        if (result !== undefined) scan(result);
        // The injected bug (`TMK_TEST_EMIT=rc-alias-any`): a temporary named as its variable though one is assigned.
        if (!assigned || this.fault === "rc-alias-any") {
          this.varNames.set(st.v, this.varName(src));
          this.declared.add(st.v);
          continue;
        }
      }
      if (st.k === "let") before.add(st.v);
      out.push(st);
    }
    return out;
  }

  /** A condition: a bool. */
  cond(e: TE): string {
    return this.value(e);
  }

  /** Operands in order. Statements one of them needs run after the ones before it are evaluated, into temporaries. */
  operands(tes: TE[]): string[] {
    const outs = tes.map((te) => this.captured(() => this.value(te)));
    const lastPre = outs.reduce((at, o, i) => (o.pre.length > 0 ? i : at), -1);
    // Statements before an operand move what's ahead of it: a constant materialises later, a value into a temporary.
    if (lastPre > 0) this.reshape("statements before an operand");
    const texts: string[] = [];
    const late: string[] = [];
    outs.forEach((o, i) => {
      this.pre.push(...o.pre);
      if (i < lastPre && !isConstText(o.text) && !this.rcStable(tes[i]!, tes.slice(i + 1))) {
        const t = this.tempFor(tes[i]!);
        // R10: in `rc`, a reference site's mark or `!` goes with the temporary's use, where the value is used, so tsc's error
        // for a site that needs one (a nullable result given to a parameter that isn't) is found there, not lost on the
        // temporary, which holds `| null`. Where nothing needs one, the text is what it was.
        let text = o.text;
        let use = t;
        const marked = this.rc ? /^\/\*<(\d+)\*\/\(([\s\S]*)\)$/.exec(text) : null;
        if (marked !== null) {
          text = marked[2]!;
          use = `/*<${marked[1]}*/(${t})`;
        } else if (this.rc && tes[i]!.ty.k === "ref" && text.endsWith("!")) {
          text = text.slice(0, -1);
          use = `${t}!`;
        }
        // The injected bug: the earlier operand evaluated after the later one's statements.
        // R14's `operand-late`: the same, for operands alone
        if (this.fault === "hoist-late" || this.fault === "operand-late")
          late.push(`${t} = ${text};`);
        else this.pre.push(`${t} = ${text};`);
        texts.push(use);
      } else texts.push(o.text);
    });
    this.pre.push(...late);
    return texts;
  }

  /**
   * In `rc` (R2), whether an operand that's a variable's read can be read after a later operand's statements instead of
   * into a temporary first: nothing later assigns the variable, so the read gives the same reference either way, and the
   * expansion has no copy to count.
   */
  rcStable(te: TE, later: TE[]): boolean {
    if (!this.rc || te.k !== "var") return false;
    let assigned = false;
    eachTE(later, (x) => {
      if (x.k === "setvar" && x.v === te.v) assigned = true;
    });
    // The injected bug (`TMK_TEST_EMIT=rc-stable-any`): the variable read late though a later operand assigns it.
    return !assigned || this.fault === "rc-stable-any";
  }

  /**
   * In `rc` (R2), a call giving a reference, inside an expression, is a statement of its own first: its result is a count
   * the caller holds, which the expansion gives a local of its own, and it does that only in a statement of its own.
   */
  /**
   * R22, in `rc`: \`a + b + c\` (strConcat of strConcat's result and c) as one call of the program's own \`strConcat3\`, which
   * makes a short result once (jsStrJoined3), where it was made twice: the first join copied a and b into a string of their
   * own, freed straight after, then a second copied them again with c. Only where c is pure (a literal, a variable, module
   * state, or a test or choice of those), as it's now evaluated before a and b are joined, and where nothing here desugars
   * exceptions (strConcat's RangeError is a trap, as the printing has it). Anything longer, or any of them empty, is the two
   * calls as before, in strConcat3. Null where this doesn't apply.
   */
  join3Name: string | null = null;
  join3(e: Extract<TE, { k: "call" }>): string | null {
    const f = this.strConcatFn;
    if (!this.rc || !this.strs || this.excOwn || f === null || e.inst !== f || r22Off("join3"))
      return null;
    const inner = e.args[0];
    const c = e.args[1];
    if (e.args.length !== 2 || inner === undefined || c === undefined) return null;
    if (inner.k !== "call" || inner.inst !== f || inner.args.length !== 2) return null;
    const pure = (x: TE): boolean => {
      switch (x.k) {
        case "gaddr":
        case "var":
        case "lit":
        case "global":
          return true;
        case "cond":
          return pure(x.c) && pure(x.a) && pure(x.b);
        case "cmp":
        case "bit":
          return pure(x.a) && pure(x.b);
        case "not":
          return pure(x.a);
        case "arith":
          // wrapping, so it can't trap, and no division (a zero divisor traps)
          return x.wrap && x.op !== "idiv" && x.op !== "rem" && pure(x.a) && pure(x.b);
        case "fload":
          // module state, read: nothing a join does changes it
          return x.glob !== undefined && pure(x.base);
        default:
          return false;
      }
    };
    if (!pure(c)) return null;
    if (this.join3Name === null) {
      let n = `${this.refFn(f) ?? "strConcat"}3`;
      for (let i = 2; this.topNames.has(n) || this.usedNames.has(n); i++) n = `strConcat3_${i}`;
      this.topNames.add(n);
      this.join3Name = n;
    }
    // the injected `r22-join3-order` bug: the second and third strings joined the other way round
    const args =
      this.fault === "r22-join3-order"
        ? [inner.args[0]!, c, inner.args[1]!]
        : [inner.args[0]!, inner.args[1]!, c];
    return this.rcOwned(e, `${this.join3Name}(${this.operands(args).join(", ")})`);
  }

  /** R22: the program's `strConcat3` (join3), over its own strConcat; empty where nothing called it. */
  join3Text(): string[] {
    if (this.join3Name === null) return [];
    const f = this.refFn(this.strConcatFn!)!;
    const s = this.strName("JsString");
    return [
      `/** R22: \`a + b + c\` (SPEC 3.5's strings in \`rc\`): short, made once; otherwise as two joins. */`,
      `function ${this.join3Name}(a: ${s}, b: ${s}, c: ${s}): ${s} {`,
      "  const la = a.len();",
      "  const lb = b.len();",
      "  const lc = c.len();",
      "  if (la !== 0 && lb !== 0 && lc !== 0 && la + lb + lc <= 64) return jsStrJoined3(a, b, c, la + lb + lc);",
      `  return ${f}(${f}(a, b), c);`,
      "}",
      "",
    ];
  }

  rcOwned(e: TE, call: string): string {
    if (!this.rc || e.ty.k !== "ref" || this.path.length <= 1) return call;
    const t = this.rcLocal();
    // the callee's own result type: where the lowering proved more, the use gets its `!` as any site does
    const ty =
      e.k === "call" && this.retCls.has(e.inst)
        ? this.refText(this.retCls.get(e.inst), `${e.inst.tirName}'s result`)
        : this.teTy(e);
    this.pre.push(`const ${t}: ${ty} = ${call};`);
    return t;
  }

  /** A name for a statement's own `const`, which `rc` hoists a part of an expression into (R2). */
  rcLocal(): string {
    let n = `tmp${this.nextTemp++}`;
    while (this.usedNames.has(n) || this.topNames.has(n)) n = `tmp${this.nextTemp++}`;
    this.usedNames.add(n);
    return n;
  }

  /**
   * In `rc` (R2), an assignment of a reference whose value is used, `a.n = (b.n = x)`, is a statement before the one using
   * it, and the value is what was assigned: the expansion counts an assignment of a counted reference only as a
   * statement. Null where it isn't one.
   */
  rcAssignValue(e: TE): string | null {
    if (!this.rc || (e.k !== "setvar" && e.k !== "setglobal" && e.k !== "fstore")) return null;
    if (e.val.ty.k !== "ref") return null;
    if (
      e.k === "fstore" &&
      (e.glob !== undefined || this.vecElem.has(e.base) || e.fld === undefined)
    )
      return null;
    let x: string;
    let target: string;
    if (e.k === "fstore") {
      const [b, v] = this.operands([e.base, e.val]);
      target = `${paren(b!)}.${this.fieldName(e.fld!)}`;
      x = v!;
    } else {
      x = this.value(e.val);
      if (e.k === "setvar") {
        if (!this.declared.has(e.v))
          this.fail(`the variable ${e.v.name}, set before it's declared here`);
        target = this.varName(e.v);
      } else {
        const n = this.refGlobal(e.g);
        if (n === undefined) this.fail(`the global ${e.g.name}`);
        target = n!;
      }
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(x) && x !== "null") {
      const t = this.rcLocal();
      this.pre.push(`const ${t}: ${this.teTy(e.val)} = ${x};`);
      x = t;
    }
    this.pre.push(`${target} = ${x};`);
    return x;
  }

  /** Two operands. Two literals say their types, or tslc would fold them where the lowering didn't, and tsc would judge them. */
  pair(a: TE, b: TE): string[] {
    return a.k === "lit" && b.k === "lit" ? this.typedOperands([a, b]) : this.operands([a, b]);
  }

  /** Operands in order, a literal among them given its type. */
  typedOperands(tes: TE[]): string[] {
    return this.operands(tes).map((t, i) => {
      const te = tes[i]!;
      if (
        te.k === "lit" &&
        !t.startsWith("cast<") &&
        (te.ty.k === "int" || te.ty.k === "float" || te.ty.k === "big" || te.ty.k === "lits")
      )
        return `${this.lowered("cast")}<${this.tyText(te.ty)}>(${t})`;
      return t;
    });
  }

  loc(te: { loc?: string }): string {
    const l = te.loc;
    if (l === undefined || l === "") return "";
    if (l.includes("*/")) this.fail("a location with */ in it");
    return `/*@ ${l} */ `;
  }

  lowered(name: string, memory = false): string {
    this.loweredUsed.add(name);
    this.intrinsics++;
    if (memory) this.memoryOps++;
    return name;
  }

  core(name: string): string {
    this.coreUsed.add(name);
    return name;
  }

  /** A statement-expression's value: its result, as the type the lowering gave the whole, which can differ by a retyping. */
  resultOf(e: TE & { result: TE }): string {
    const t = this.typedArg(e.result);
    return sameRep(e.ty, e.result.ty) || e.ty.k === "never" || e.result.ty.k === "never"
      ? t
      : this.retyped(t, e.ty, e.result.ty);
  }

  /** A value read as another type of the same leaf: i32 as u32, a literal union as i32. */
  retyped(text: string, to: Ty, from: Ty): string {
    const leafOf = (t: Ty): string =>
      t.k === "int"
        ? t.name === "usize"
          ? "ix"
          : "i32"
        : t.k === "lits" || t.k === "bool" || t.k === "enum"
          ? "i32"
          : t.k;
    if (leafOf(to) !== leafOf(from)) this.fail(`a ${from.k} read as a ${to.k}`);
    return `${this.lowered("cast")}<${this.tyText(to)}>(${text})`;
  }

  /** An expression that never finishes, where tsc wants a value of type t: its statements, then a zero nothing reads. */
  neverValue(x: TE, t: Ty): string {
    const eff = this.effect(x);
    if (eff !== "") this.pre.push(`${eff};`);
    switch (t.k) {
      case "int":
      case "float":
      case "lits":
        return `${this.lowered("cast")}<${this.tyText(t)}>(0)`;
      case "bool":
        return "false";
      case "ref":
        return `${this.lowered("nullRef")}()`;
      default:
        return this.fail(`a value of ${t.k} after something that never finishes`);
    }
  }

  /** A literal of a type intrinsics can't infer: cast<T>(lit) is the literal itself, of that type. */
  typedArg(te: TE): string {
    const v = this.value(te);
    if (
      te.k === "lit" &&
      !v.startsWith("cast<") &&
      (te.ty.k === "int" || te.ty.k === "float" || te.ty.k === "big" || te.ty.k === "lits")
    )
      return `${this.lowered("cast")}<${this.tyText(te.ty)}>(${v})`;
    return v;
  }

  litText(e: Extract<TE, { k: "lit" }>): string {
    const t = e.ty;
    const v = e.value;
    if (t.k === "ref") {
      if (v !== 0) this.fail("a pointer literal that isn't null");
      if (this.classes) return "null";
      return `${this.lowered("nullRef")}()`;
    }
    if (t.k === "nullish" || t.k === "void") this.fail(`a ${t.k} literal as a value`);
    if (t.k === "lits") return typeof v === "string" ? String(this.strNum(v)) : numText(Number(v));
    if (typeof v === "boolean") return String(v);
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "string") return String(this.strNum(v));
    if (t.k === "int" && !Number.isInteger(v)) this.fail("a fractional integer literal");
    // NaN by name trips tsc's check of comparisons with it, and 0 / 0 is folded by tslc: a cast is neither.
    if (Number.isNaN(v))
      return `${this.lowered("cast")}<${this.tyText(t.k === "float" ? t : { k: "float", name: "f64" })}>(NaN)`;
    return numText(v);
  }

  value(e: TE): string {
    this.path.push(e.k);
    try {
      const text = this.value0(e);
      if (!this.classes || e.ty.k !== "ref" || e.k === "lit" || e.k === "alloc") return text;
      // A reference site: `!` where tsc can't see what the lowering proved, and otherwise as it is.
      const k = this.nextSite++;
      // R6: the lowering's null check (the source's `!`) where tsc wants a `!` after it anyway is TSL's own checked `!`, the
      // same node to tslc (a trap 6 if null), where `nonNull(…)!` made two checks at -O1 (M5's R5 record). A string isn't a
      // class, and TSL's `!` checks only a class reference, so a string keeps nonNull's.
      const nn = this.lastNonNull;
      if (this.bangs.has(k) && nn !== null && !r6Off("checks")) {
        // What the site's value is: the last part of a sequence, as the folded read's own block has it.
        let tail: TE = e;
        for (let g = 0; g < 64 && (tail.k === "blockexpr" || tail.k === "seq"); g++)
          tail = tail.k === "blockexpr" ? (this.foldedReads.get(tail) ?? tail).result : tail.result;
        const loc = this.loc(nn.e as { loc?: string });
        const call = `${loc}nonNull(${nn.inner})`;
        const at = text.lastIndexOf(call);
        if (
          tail === nn.e &&
          tail.k === "nonnull" &&
          this.objNode(tail.val.sh) !== null &&
          !isStrSh(tail.val.sh) &&
          at >= 0
        ) {
          // No longer an extension's call: counted out, and not imported where nothing else calls nonNull.
          this.nonNulls--;
          this.intrinsics--;
          return `${text.slice(0, at)}${loc}${paren(nn.inner)}!${text.slice(at + call.length)}`;
        }
      }
      if (this.bangs.has(k)) return `${paren(text)}!`;
      // Marked, the site is in parentheses, so tsc's error for it starts right after its marker.
      return this.marks ? `/*<${k}*/(${text})` : text;
    } finally {
      this.path.pop();
    }
  }

  value0(e0: TE): string {
    const asEffect = this.effectOf === e0;
    const e = (e0.k === "blockexpr" ? this.foldedReads.get(e0) : undefined) ?? e0;
    this.effectOf = null;
    if (!asEffect) {
      const v = this.rcAssignValue(e);
      if (v !== null) return v;
    }
    if (this.strs && e.strop !== undefined) return this.strOp(e);
    switch (e.k) {
      case "lit":
        return this.litText(e);
      case "var": {
        if (!this.declared.has(e.v))
          this.fail(`the variable ${e.v.name}, read before it's declared here`);
        const n = this.varName(e.v);
        // The lowering reads a location as another type with the same leaf, where its range says that's exact.
        return sameRep(e.ty, e.v.ty) ? n : this.retyped(n, e.ty, e.v.ty);
      }
      case "global": {
        const n = this.refGlobal(e.g);
        if (n === undefined) this.fail(`the global ${e.g.name}`);
        return n;
      }
      case "arith": {
        let [a, b] = this.pair(e.a, e.b) as [string, string];
        // Operands the lowering retyped to the operation's type: i32 and u32 of one leaf, as it computes them.
        if (e.ty.k === "int") {
          if (e.a.ty.k === "int" && !sameRep(e.a.ty, e.ty) && e.a.k !== "lit")
            a = this.retyped(a, e.ty, e.a.ty);
          if (e.b.ty.k === "int" && !sameRep(e.b.ty, e.ty) && e.b.k !== "lit")
            b = this.retyped(b, e.ty, e.b.ty);
        }
        if (e.op === "idiv") return `${this.loc(e)}${this.core("idiv")}(${a}, ${b})`;
        const sym = e.op === "add" ? "+" : e.op === "sub" ? "-" : e.op === "mul" ? "*" : "%";
        if (e.op === "rem") return `(${this.loc(e)}${a} % ${b})`;
        if (!e.wrap || (this.fault === "wrap-checked" && e.ty.k === "int" && e.ty.name === "i32"))
          return `(${this.loc(e)}${a} ${sym} ${b})`;
        // A range the lowering proved, or JS's own wrap under a bit operation. TSL proper says this with `| 0` or
        // Math.imul, which -O1 folds to the same; wrap() says it exactly, so -O0's TIR is the direct route's too.
        if (e.ty.k !== "int") this.fail(`wrapping arithmetic on ${e.ty.k}`);
        return `${this.lowered("wrap")}<${this.tyText(e.ty)}>(${a} ${sym} ${b})`;
      }
      case "farith": {
        const [a, b] = this.pair(e.a, e.b);
        const sym = { add: "+", sub: "-", mul: "*", div: "/", rem: "%" }[e.op];
        return `(${a} ${sym} ${b})`;
      }
      case "bit": {
        const [a, b] = this.pair(e.a, e.b);
        const sym = { and: "&", or: "|", xor: "^", shl: "<<", shr: ">>", ushr: ">>>" }[e.op];
        // TSL types >>> as u32 and the rest as i32 (3.3 rule 5); the lowering may have retyped one it proved fits the other.
        const natural: Ty = e.op === "ushr" ? { k: "int", name: "u32" } : { k: "int", name: "i32" };
        const text = `(${a} ${sym} ${b})`;
        return sameRep(e.ty, natural) ? text : this.retyped(text, e.ty, natural);
      }
      case "bitnot":
        return `(~${paren(this.value(e.a))})`;
      case "neg":
        return `(${this.loc(e)}-${paren(this.value(e.a))})`;
      case "not":
        return `(!${paren(this.value(e.a))})`;
      case "cmp": {
        // Two literals: tsc rejects comparing them by their literal types, so each says its type, as the tree has it.
        const ab =
          e.a.k === "lit" && e.b.k === "lit"
            ? this.typedOperands([e.a, e.b])
            : this.operands([e.a, e.b]);
        let a = ab[0]!;
        let b = ab[1]!;
        // Two integer types with one leaf, i32 and u32: the comparison is by the left one's, as lowering does it.
        if (
          e.a.ty.k === "int" &&
          e.b.ty.k === "int" &&
          e.a.ty.name !== e.b.ty.name &&
          (e.a.ty.name === "usize") === (e.b.ty.name === "usize") &&
          e.b.k !== "lit"
        )
          b = `${this.lowered("cast")}<${this.tyText(e.a.ty)}>(${b})`;
        // A typed array against null is its pointer against null: both sides one leaf.
        if (e.a.ty.k === "arr" && e.b.ty.k !== "arr")
          a = `${this.lowered("part")}<Ref>(${a}, 0, 1)`;
        if (e.b.ty.k === "arr" && e.a.ty.k !== "arr")
          b = `${this.lowered("part")}<Ref>(${b}, 0, 1)`;
        // R13: with classes, null is a class's; a typed array's pointer, a Ref, is null by @tsl/lowered's `nullRef()`, as
        // phase 1 prints it (`?? new Uint16Array(n)` on one read from a field, the JPEG decoder's)
        const nullLit = (x: TE): boolean => x.k === "lit" && x.ty.k === "ref";
        // R14: in every mode's class printing, not `strict`'s alone (R13's carried TSL1008 in `leak` and `manual`);
        // TMK_R14_OFF=nullref puts R13's back
        const strictArr = this.classes && (this.memory === "strict" || !r14Off("nullref"));
        if (strictArr && e.a.ty.k === "arr" && nullLit(e.b)) b = `${this.lowered("nullRef")}()`;
        if (strictArr && e.b.ty.k === "arr" && nullLit(e.a)) a = `${this.lowered("nullRef")}()`;
        if (a.includes("part<Ref>") || b.includes("part<Ref>")) this.loweredUsed.add("Ref");
        const sym = { eq: "===", ne: "!==", lt: "<", le: "<=", gt: ">", ge: ">=" }[e.op];
        return `(${a} ${sym} ${b})`;
      }
      case "logic": {
        const a = this.value(e.a);
        const b = this.captured(() => this.value(e.b));
        if (b.pre.length === 0) return `(${a} ${e.op === "and" ? "&&" : "||"} ${b.text})`;
        // The right side has statements: they run only when it's evaluated.
        this.hoisted++;
        this.reshape("a logical operator's right side with statements");
        const t = this.tempFor(e);
        // R14's injected bug `logic-always`: the right side's statements run even where the left side decides
        if (this.fault === "logic-always") {
          this.pre.push(`${t} = ${a};`, ...b.pre);
          this.pre.push(
            e.op === "and" ? `if (${t}) {` : `if (${t}) {} else {`,
            `  ${t} = ${b.text};`,
            "}",
          );
          return t;
        }
        this.pre.push(
          `${t} = ${a};`,
          e.op === "and" ? `if (${t}) {` : `if (${t}) {} else {`,
          ...b.pre.map((p) => `  ${p}`),
          `  ${t} = ${b.text};`,
          "}",
        );
        return t;
      }
      case "cond": {
        const c = this.value(e.c);
        // Two literals have no type of their own in TSL: say which. A branch that never finishes needs a value only for tsc.
        const both = e.a.k === "lit" && e.b.k === "lit";
        const branch = (x: TE): string =>
          x.ty.k === "never" ? this.neverValue(x, e.ty) : both ? this.typedArg(x) : this.value(x);
        const a = this.captured(() => branch(e.a));
        const b = this.captured(() => branch(e.b));
        if (a.pre.length === 0 && b.pre.length === 0) return `(${c} ? ${a.text} : ${b.text})`;
        this.hoisted++;
        this.reshape("a conditional's arm with statements");
        const t = this.tempFor(e);
        // R14's injected bug `cond-arms-first`: each arm's statements run before the test, whichever arm it picks
        if (this.fault === "cond-arms-first") {
          this.pre.push(...a.pre, ...b.pre, `if (${c}) {`, `  ${t} = ${a.text};`, "} else {");
          this.pre.push(`  ${t} = ${b.text};`, "}");
          return t;
        }
        this.pre.push(
          `if (${c}) {`,
          ...a.pre.map((p) => `  ${p}`),
          `  ${t} = ${a.text};`,
          "} else {",
          ...b.pre.map((p) => `  ${p}`),
          `  ${t} = ${b.text};`,
          "}",
        );
        return t;
      }
      case "setvar": {
        if (e.rc !== undefined) this.fail("a counted assignment");
        if (!this.declared.has(e.v))
          this.fail(`the variable ${e.v.name}, set before it's declared here`);
        return `(${this.varName(e.v)} = ${this.value(e.val)})`;
      }
      case "setglobal": {
        const n = this.refGlobal(e.g);
        if (n === undefined) this.fail(`the global ${e.g.name}`);
        return `(${n} = ${this.value(e.val)})`;
      }
      case "seq":
        // A comma's last literal has no type of its own in TSL: it says the tree's.
        return this.sequence(
          [...e.items.map((x) => () => this.effect(x)), () => this.resultOf(e)],
          this.rcHoists(e),
        );
      case "blockexpr": {
        const made = this.maps ? this.mapNew(e) : null;
        // R10: in `rc`, a map made as a call's argument is a statement of its own first, as a call's result is (rcOwned):
        // the expansion takes an allocation among a call's arguments only so
        if (
          made !== null &&
          this.rc &&
          this.path[this.path.length - 2] === "call" &&
          !r10Off("mapargs")
        )
          return this.rcOwned(e, made);
        if (made !== null) return made;
        const env = this.classes ? this.envNew(e) : null;
        if (env !== null) return env;
        if (this.simpleBody(e.body) && !this.rcHoists(e))
          return this.sequence([...this.bodyPartFns(e.body), () => this.resultOf(e)]);
        this.hoistBody(e.body, e.result);
        return this.resultOf(e);
      }
      case "call": {
        const three = this.join3(e);
        if (three !== null) return three;
        const mm = this.maps ? this.mapRt.get(e.inst) : undefined;
        if (mm !== undefined) return this.mapCall(e, mm);
        const sm = this.strs ? this.strMapped.get(e.inst) : undefined;
        if (sm !== undefined) return this.strCall(e, sm);
        const n = this.members.has(e.inst) ? this.fnNames.get(e.inst) : this.refFn(e.inst);
        if (n === undefined) this.fail(`a call to ${e.inst.tirName}, which isn't in the module`);
        const kept = e.args.filter((a, i) => {
          if (!noLeaves(e.inst.params[i]?.ty ?? a.ty)) return true;
          if (!(a.k === "tuple" && a.items.length === 0) && a.k !== "lit")
            this.fail("an argument with no leaves and an effect");
          return false;
        });
        const m = this.members.get(e.inst);
        if (m !== undefined) {
          // A method, called on its receiver, which is the first argument.
          const ops = this.operands(e.args.filter((a, i) => i === 0 || kept.includes(a)));
          const call = `${paren(ops[0]!)}.${m.name}(${ops.slice(1).join(", ")})`;
          return this.rcOwned(
            e,
            sameRep(e.ty, e.inst.ret) ? call : this.retyped(call, e.ty, e.inst.ret),
          );
        }
        const call = `${n}(${this.operands(kept).join(", ")})`;
        return this.rcOwned(
          e,
          sameRep(e.ty, e.inst.ret) ? call : this.retyped(call, e.ty, e.inst.ret),
        );
      }
      case "callclo": {
        // A closure value's call (R3): its environment's `call`, a method of its class, which picks the kind if several.
        const o = this.objNode(e.clo.sh);
        if (o === null || !this.envKinds.has(o.node))
          return this.fail("a call of something that isn't a closure");
        const kept = e.args.filter((a, i) => {
          if (!noLeaves(e.params[i] ?? a.ty)) return true;
          if (!(a.k === "tuple" && a.items.length === 0) && a.k !== "lit")
            this.fail("an argument with no leaves and an effect");
          return false;
        });
        const ops = this.operands([e.clo, ...kept]);
        const call = `${paren(ops[0]!)}.call(${ops.slice(1).join(", ")})`;
        return this.rcOwned(e, sameRep(e.ty, e.ret) ? call : this.retyped(call, e.ty, e.ret));
      }
      case "index": {
        const [a, i] = this.operands([e.arr, e.idx]) as [string, string];
        return `${this.loc(e)}${paren(a)}[${i}]!`;
      }
      case "len":
        return `${paren(this.value(e.arr))}.length`;
      case "setindex": {
        const [a, i, v] = this.operands([e.arr, e.idx, e.val]) as [string, string, string];
        return `(${this.loc(e)}${paren(a)}[${i}] = ${v})`;
      }
      case "builtin":
        return this.builtin(e);
      case "conv": {
        const from = e.val.ty;
        const to = e.ty;
        if (from.k === "int" && to.k === "float" && to.name === "f64")
          return `${this.core("toF64")}(${this.typedArg(e.val)})`;
        // Between integers the target is said at run time too (D71): JS has one kind of number, so the host needs it to
        // make a negative i32 a usize past every length, as natively. tslc reads the type argument and ignores it.
        const named =
          (from.k === "int" || from.k === "big") && (to.k === "int" || to.k === "big")
            ? `, ${JSON.stringify(this.tyText(to))}`
            : "";
        return `${this.lowered("cast")}<${this.tyText(to)}>(${this.typedArg(e.val)}${named})`;
      }
      case "optindex":
        // TSL proper's `a[i]` with no assertion: the lowering never makes one (D72 deleted @tsl/lowered's optIndex).
        return this.fail("an index with no assertion, which the lowering doesn't make");
      case "isundef":
        return `${this.lowered("isUndef")}(${this.value(e.val)}, ${e.negate})`;
      case "optpayload":
        return `${this.lowered("optPayload")}<${this.tyText(e.ty)}>(${this.value(e.val)})`;
      case "tuple":
        if (e.items.length === 0) this.fail(`an empty ${e.ty.k} as a value`);
        if (this.classes && this.arrAllocs.has(e.items[0]!)) return this.newTypedArray(e);
        // R13: a null typed array's pointer is @tsl/lowered's `nullRef()`, a Ref, where with classes `null` is a class's
        // (in `strict`, where R13 prints typed arrays read from fields: the JPEG decoder's `?? new Uint16Array(64)`)
        // R14: in every mode's class printing (TMK_R14_OFF=nullref, `strict` alone as R13 had it)
        if (this.classes && (this.memory === "strict" || !r14Off("nullref")) && e.ty.k === "arr") {
          const parts = this.typedOperands(e.items).map((x, i) =>
            i === 0 && e.items[0]!.k === "lit" && e.items[0]!.ty.k === "ref"
              ? `${this.lowered("nullRef")}()`
              : x,
          );
          return `${this.lowered("pack")}<${this.tyText(e.ty)}>(${parts.join(", ")})`;
        }
        return `${this.lowered("pack")}<${this.tyText(e.ty)}>(${this.typedOperands(e.items).join(", ")})`;
      case "slice":
        return `${this.lowered("part")}<${this.tyText(e.ty)}>(${this.value(e.val)}, ${e.from}, ${e.to})`;
      case "gaddr": {
        // A string literal (D67): the JsString made from its text in `__init`.
        if (this.strs && /^__strlit_\d+$/.test(e.name) && e.off === 16)
          return this.globName(e.name);
        const n = this.refData(e.name);
        const g =
          n !== undefined ? n : this.runtimeGlobals.has(e.name) ? JSON.stringify(e.name) : null;
        if (g === null) this.fail(`the address of ${e.name}`);
        return `${this.lowered("addr", true)}(${g}${e.off !== undefined ? `, ${e.off}` : ""})`;
      }
      case "fload": {
        if (this.classes && e.glob !== undefined && isArrSh(e.glob.sh)) {
          // R9: module state that's a typed array, from its holder's pointer and length
          const g = this.globName(e.glob.name);
          this.loweredUsed.add("Ref");
          return `${this.lowered("pack")}<${this.tyText(e.ty)}>(${this.lowered("cast")}<Ref>(${g}.ptr), ${g}.len)`;
        }
        if (this.classes && e.glob !== undefined) return this.globName(e.glob.name);
        if (this.classes && this.vecElem.has(e.base)) {
          const el = e.base as Extract<TE, { k: "elemaddr" }>;
          const [v, i] = this.operands([this.vecData(el)!, el.idx]);
          // the injected `read-check-wrap` bug (R6): a read whose bounds check was folded into `get` given an index that
          // `get` can't refuse, as a printing that folded the check into a read that doesn't make it would be
          if (this.fault === "read-check-wrap" && this.foldedRead.has(e))
            return `${paren(v!)}${this.arr}.get(${paren(i!)} % ${paren(v!)}${this.arr}.length)`;
          const got = `${paren(v!)}${this.arr}.get(${i})`;
          // R13: a typed array from the holder the array holds
          const ae = this.vecArrElem(this.vecData(el)!);
          if (ae !== null) return `${this.arrVecHelpers(ae).get}(${got})`;
          // R9: a boolean from its byte
          const be = this.vecByteElem(this.vecData(el)!);
          if (be === "void") return this.fail("an element read from an array nothing is put in");
          if (be === "bool" && e.ty.k === "bool") return `(${got} !== 0)`;
          return got;
        }
        if (this.classes && this.isVecLen(e))
          return `${paren(this.value(e.base))}${this.arr}.length`;
        // A string's length is a method, as a dispatch interface has only methods (D70, pipe-split).
        if (this.classes && this.isStrLen(e)) {
          // An i32, which the lowering may read as another 32-bit integer (a u32 a digest is kept in): the same bits.
          const len = `${paren(this.value(e.base))}.len()`;
          return e.ty.k === "int" && e.ty.name !== "i32"
            ? this.retyped(len, e.ty, { k: "int", name: "i32" } as Ty)
            : len;
        }
        if (this.classes && e.fld !== undefined && this.mapField(e.fld)) {
          // A map's size (D72): JsMap's is a u32, the lowering's an i32.
          if (e.fld.name !== "size") this.fail(`${MAPS_NOT}the map's ${e.fld.name}`);
          // R7: read as a double where the lowering has one (a map a caller handed in), the same number
          if (e.ty.k === "float" && MAPS_CROSS)
            return `${this.core("toF64")}(${paren(this.value(e.base))}${this.mapIn}.size)`;
          return `${this.lowered("cast")}<i32>(${paren(this.value(e.base))}${this.mapIn}.size, "i32")`;
        }
        if (this.classes && e.fld !== undefined) {
          const pf = this.planField(e.fld);
          if (pf.arr !== undefined) {
            // R7: the array made from its runtime class's two words
            const on = this.thisBase(e.base) ?? this.onceBase(e.base);
            this.loweredUsed.add("Ref");
            return `${this.lowered("pack")}<${pf.arr}>(${this.lowered("cast")}<Ref>(${on}.${pf.name}.ptr), ${on}.${pf.name}.len)`;
          }
          if (pf.flag !== undefined) {
            // R7: an optional scalar's two fields, flag then value, as the direct route loads them, packed into the value.
            const on = this.thisBase(e.base) ?? this.onceBase(e.base);
            return `${this.lowered("pack")}<${this.tyText(e.ty)}>(${on}.${pf.flag.name}, ${on}.${pf.name})`;
          }
          const f = pf.name;
          // The injected `class-field` bug reads the other field; stores are left alone, so it's a wrong read, not a rename.
          const on = this.thisBase(e.base) ?? paren(this.value(e.base));
          return `${on}.${this.faultSwap.get(f) ?? f}`;
        }
        const base = this.value(e.base);
        const std = stdMem(e.ty, e.mem[0]?.off ?? 0);
        if (std !== null && e.mem.length > 0 && memText(std) === memText(e.mem)) {
          let off = e.mem[0]!.off;
          if (this.fault === "field-offset" && off === 8 && e.ty.k === "float") off = 0; // the injected bug
          // R14: a class id's load, noted invariant (D73) as the direct route notes it, so the TIR is that route's
          const inv =
            e.mem.length === 1 && e.mem[0]!.inv === true && !this.classes && !r14Off("inv")
              ? `, "invariant"`
              : "";
          return `${this.lowered("load", true)}<${this.tyText(e.ty)}>(${base}, ${off}${inv})`;
        }
        // Leaves at offsets other than the type's own: nothing the lowering makes (D72 deleted @tsl/lowered's loadAt).
        return this.fail(`a load of ${memText(e.mem)} as ${this.tyText(e.ty)}`);
      }
      case "fstore": {
        if (this.classes && e.glob !== undefined && isArrSh(e.glob.sh)) return this.globArrStore(e);
        if (this.classes && e.glob !== undefined)
          return `(${this.globName(e.glob.name)} = ${this.value(e.val)})`;
        if (this.classes && this.vecElem.has(e.base)) {
          const el = e.base as Extract<TE, { k: "elemaddr" }>;
          const [v, i, x] = this.operands([this.vecData(el)!, el.idx, e.val]);
          // R13: a typed array in a holder made for it; the store's value, the typed array, from the holder
          const ae = this.vecArrElem(this.vecData(el)!);
          if (ae !== null) {
            const h = this.arrVecHelpers(ae);
            return `${h.get}(${paren(v!)}${this.arr}.set(${i}, ${h.of}(${x})))`;
          }
          // R9: a boolean as its byte, and the store's value as the boolean it stored
          const be = this.vecByteElem(this.vecData(el)!);
          if (be === "void")
            return this.fail("an element written to an array nothing is read from");
          if (be === "bool")
            return `(${paren(v!)}${this.arr}.set(${i}, ${this.boolByte(x!, e.val)}) !== 0)`;
          return `${paren(v!)}${this.arr}.set(${i}, ${x})`;
        }
        if (this.classes && this.isVecLen(e)) {
          const [v, x] = this.operands([e.base, e.val]);
          return `${paren(v!)}${this.arr}.setLength(${x})`;
        }
        if (this.classes && e.fld !== undefined && this.mapField(e.fld))
          this.fail(`${MAPS_NOT}a store to the map's ${e.fld.name}`);
        if (this.classes && e.fld?.name === "$kind") {
          // An environment's kind (R3): which closure it is, numbered as its class's `call` picks them.
          const n = this.canon(findNode(e.fld.node as HeapNode));
          const k = (this.envKinds.get(n) ?? []).indexOf(
            (e.val as Extract<TE, { k: "fnref" }>).inst,
          );
          if (k < 0) this.fail("an environment of a closure its class doesn't have");
          if (!this.envField(e.fld)) return this.value(e.base);
          const [b] = this.operands([e.base]);
          return `(${paren(b!)}.kind = ${k + 1})`;
        }
        if (this.classes && e.fld !== undefined) {
          const pf = this.planField(e.fld);
          if (pf.flag !== undefined) return this.optFieldStore(e, pf);
          if (pf.arr !== undefined) return this.arrFieldStore(e, pf);
          const self = this.thisBase(e.base);
          if (self !== null) return `(${self}.${this.fieldName(e.fld)} = ${this.value(e.val)})`;
          const [b, x] = this.operands([e.base, e.val]);
          return `(${paren(b!)}.${this.fieldName(e.fld)} = ${x})`;
        }
        const [base, v] = this.operands([e.base, e.val]);
        const rc = e.rc !== undefined ? `, "${e.rc}"` : "";
        const t = e.val.ty;
        if (e.mem.length === 0) this.fail("a store of nothing as a value");
        const std = stdMem(t, e.mem[0]!.off);
        if (std !== null && memText(std) === memText(e.mem))
          return `${this.lowered("store", true)}<${this.tyText(t)}>(${base}, ${e.mem[0]!.off}, ${v}${rc})`;
        // As for loads (D72 deleted @tsl/lowered's storeAt).
        return this.fail(`a store of ${memText(e.mem)} as ${this.tyText(t)}`);
      }
      case "elemaddr": {
        const [b, i] = this.operands([e.base, e.idx]);
        return `${this.lowered("elemAddr", true)}(${b}, ${i}, ${e.scale})`;
      }
      case "loadelem": {
        const [p, i] = this.operands([e.ptr, e.idx]);
        return `${this.lowered("loadElem", true)}<${this.tyText(e.ty)}>(${p}, ${i}, "${e.elem}")`;
      }
      case "storeelem": {
        const [p, i, v] = this.operands([e.ptr, e.idx, e.val]);
        return `${this.lowered("storeElem", true)}<${this.tyText(e.val.ty)}>(${p}, ${i}, "${e.elem}", ${v})`;
      }
      case "alloc": {
        if (
          this.classes &&
          !(this.curInst !== null && this.rtScratch(this.curInst) && e.sh === undefined)
        ) {
          const o = this.objNode(e.sh);
          if (o === null) this.fail("an allocation that isn't an object");
          // Placement is tslc's: its escape analysis says stack or heap, and the package's mode says what heap means.
          return `new ${this.clsName(o!.node)}()`;
        }
        // An environment's references matter to `rc` alone, which this route doesn't take yet.
        if (e.rcRefs !== undefined && this.memory === "rc") this.fail("a counted environment");
        const st = e.stack();
        if (st !== null) {
          const size = e.size.k === "lit" && e.size.value === st ? "" : `, ${this.value(e.size)}`;
          return `${this.loc(e)}${this.lowered("allocStack", true)}(${st}, ${e.zero}${size})`;
        }
        const allocator = e.long?.() ?? "__alloc";
        return `${this.loc(e)}${this.lowered("alloc", true)}(${this.value(e.size)}, ${e.zero}, ${JSON.stringify(allocator)})`;
      }
      case "rtcall": {
        if (this.strs && e.name === "$concat") {
          const [a, b] = this.operands([e.args[0]!, e.args[1]!]);
          return `${paren(a!)}.concat(${b})`;
        }
        if (this.classes && e.name === "$push") {
          const [v, x] = this.operands([e.args[0]!, e.args[1]!]);
          // R9: a boolean pushed as its byte
          const be = this.vecByteElem(e.args[0]!);
          if (be === "void") return this.fail("an element pushed to an array of nothing");
          if (be === "bool")
            return `${paren(v!)}${this.arr}.push(${this.boolByte(x!, e.args[1]!)})`;
          // R13: a typed array pushed in a holder made for it
          const ae = this.vecArrElem(e.args[0]!);
          if (ae !== null)
            return `${paren(v!)}${this.arr}.push(${this.arrVecHelpers(ae).of}(${x}))`;
          return `${paren(v!)}${this.arr}.push(${x})`;
        }
        const vr = this.classes ? this.vecRt(e) : null;
        if (vr === "new") {
          const made = this.vecNewText(
            (e.sh as Extract<Shape, { s: "vec" }>).node,
            this.value(e.args[0]!),
          );
          // R3: in `rc` a call, which the expansion takes in a statement of its own
          return this.rc ? this.rcOwned(e, made) : made;
        }
        if (vr === "reserve") {
          const [v, need] = this.operands([e.args[0]!, e.args[1]!]);
          // A splice's room (R3): written before the lowering stores the length, so JsArray's length is raised to it first,
          // its new slots holes, and the lowering's own store of the length after is the same length.
          if (e.grows === true && this.fault !== "splice-room") {
            const a = `${paren(v!)}${this.arr}`;
            this.pre.push(`${a}.reserve(${need});`);
            return `${a}.setLength(${need} > ${a}.length ? ${need} : ${a}.length)`;
          }
          return `${paren(v!)}${this.arr}.reserve(${need})`;
        }
        const args = this.typedOperands(e.args);
        return `${this.lowered("rt")}<${this.tyText(e.ty)}>(${[JSON.stringify(e.name), ...args].join(", ")})`;
      }
      case "intrinsic": {
        if (e.name === STACK_LOW) {
          // The stack test of a recursive function (D49): the stack pointer below the native caller's limit.
          for (const n of ["intrinsic", "load", "Ref"]) this.loweredUsed.add(n);
          const limit = this.dataNames.get("__exc_stack_limit")!;
          return `(${this.lowered("intrinsic")}<Ref>("native.sp") < ${this.lowered("load")}<Ref>(${this.lowered("addr")}(${limit}), 0))`;
        }
        const args = this.typedOperands(e.args);
        return `${this.lowered("intrinsic")}<${this.tyText(e.ty)}>(${[JSON.stringify(e.name), ...args].join(", ")})`;
      }
      case "throwjs": {
        const args = this.typedOperands(e.args);
        return `${this.loc(e)}${this.lowered("throwJs")}(${[String(e.code), JSON.stringify(e.msg), ...args].join(", ")})`;
      }
      case "f2ix":
        return `${this.lowered("f2ix")}(${this.value(e.val)})`;
      case "nonnull": {
        const inner = this.value(e.val);
        this.lastNonNull = { e: e0, inner };
        this.nonNulls++;
        return `${this.loc(e)}${this.lowered("nonNull")}(${inner})`;
      }
      case "trapnow": {
        // A code by its name in @tsl/core's Trap (3.10, TSL1026).
        const n = TRAP_NAMES[e.code];
        if (n === undefined)
          return this.fail(`trap code ${e.code}, which @tsl/core's Trap doesn't name`);
        this.coreUsed.add("Trap");
        return `${this.loc(e)}${this.lowered("trapNow")}(${JSON.stringify(e.kind)}, Trap.${n})`;
      }
      default:
        return this.fail(`the expression ${e.k}`);
    }
  }

  globName(name: string): string {
    const n = this.refData(name);
    if (n === undefined) return this.fail(`the module state ${name}`);
    return n;
  }

  /** An environment class's name (R3): its first closure's, less the lowering's `$clo`, and `Env`. */
  envBase(n: HeapNode): string {
    const f = (this.envKinds.get(n) ?? [])[0];
    const own = f === undefined ? "" : f.tirName.replace(/\$clo(\$\d+)?$/, "");
    return own === "" || own.includes("<") ? "Closure" : `${sanitize(own)}_Closure`;
  }

  /**
   * R19: whether a closure kind's method, in `rc`, is small enough to inline where its environment's `call` (inlined) calls
   * it: one of several kinds, a body of at most SMALL_KIND lines with no loop. -O1 inlines only what's no bigger than a call
   * there (or a small leaf in a loop, which a call copied in by inlining isn't always seen to be in), and a closure called
   * in a loop was its environment's `call`, its compare chain and a call. Only a hint: the optimiser decides.
   */
  private smallKind(node: HeapNode, f: unknown, text: string): boolean {
    if (!this.rc || r19Off("inline")) return false;
    const kinds = this.envKinds.get(node) ?? [];
    if (kinds.length < 2 || !kinds.includes(f as never)) return false;
    const lines = text.split("\n");
    return lines.length <= SMALL_KIND + 2 && !/\b(for|while|do)\b/.test(text);
  }

  /** Whether an environment's class has a kind field (R3): with several kinds. */
  envField(fld: { node: unknown }): boolean {
    return (this.envKinds.get(this.canon(findNode(fld.node as HeapNode))) ?? []).length > 1;
  }

  /**
   * An environment's fields (R3): a kind field where there are several kinds, and each closure's captures. A capture of
   * one kind takes the first field of another kind of the same type that its own kind hasn't taken, as an `unknown`'s
   * classes share fields (D68), so the class is as big as its biggest kind per type, as the direct route's environment is.
   */
  planEnv(n: HeapNode, plan: ClassPlan, used: Set<string>): void {
    const kinds = this.envKinds.get(n) ?? [];
    const all: PlanField[] = [];
    if (kinds.length > 1) {
      const kf = { name: "kind", ty: this.tyText({ k: "int", name: "i32" } as Ty), init: "0" };
      plan.fields.set("$kind", kf);
      all.push(kf);
      used.add("kind");
    }
    const users = new Map<PlanField, number>(); // how many kinds set each field
    for (const f of kinds) {
      const mine = new Set<PlanField>();
      for (const c of f.cloEnv!.caps) {
        const sh = c.sh as Shape;
        let ty: string;
        let init: string | null;
        if (sh.s === "num") {
          ty = this.tyText(locTy(sh.loc));
          init = "0";
        } else if (sh.s === "bool") {
          ty = this.tyText({ k: "bool" } as Ty);
          init = "false";
        } else if (sh.s === "str" && this.strs) {
          // a literal union's small integer, as a field's is (R5)
          ty = "i32";
          init = "0";
          this.coreUsed.add("i32");
        } else if (sh.s === "obj" || sh.s === "vec") {
          const target = this.canon(findNode(sh.node));
          ty = target === n ? "@SELF@" : `@CLS${target.id}@`;
          const nullable = sh.nul !== undefined || findNode(sh.node).dyn === true;
          init = nullable ? "null" : null;
          if (nullable) ty = `${ty} | null`;
        } else return this.fail(`a closure capturing a value of shape ${sh.s}`);
        // the injected `env-share-own` bug: two captures of one kind in one field
        const own = this.fault === "env-share-own";
        let fl = all.find(
          (x) => x.ty === ty && x.init === init && (own || !mine.has(x)) && x.name !== "kind",
        );
        if (fl === undefined) {
          let base = sanitize(c.name);
          if (
            RESERVED.has(base) ||
            CORE_TYPES.includes(base) ||
            base === "call" ||
            /^call_\d+$/.test(base)
          )
            base = `${base}_`;
          let u = base;
          for (let i = 2; used.has(u); i++) u = `${base}_${i}`;
          used.add(u);
          fl = { name: u, ty, init };
          all.push(fl);
        }
        mine.add(fl);
        users.set(fl, (users.get(fl) ?? 0) + 1);
        plan.fields.set(c.key, fl);
      }
    }
    // A reference field that some kind doesn't set is null in that kind's environment.
    for (const f of all)
      if (f.init === null && (users.get(f) ?? 0) < kinds.length) {
        f.ty = `${f.ty} | null`;
        f.init = "null";
      }
    plan.env = all;
  }

  /** Whether a statement-expression is the lowering's making of a closure value (R3), which `envNew` prints. */
  isEnvBlock(e: TE): boolean {
    if (!this.classes || e.k !== "blockexpr") return false;
    const first = e.body[0];
    if (first === undefined || first.k !== "let" || first.init === null || first.init.k !== "alloc")
      return false;
    const o = this.objNode(first.init.sh);
    return o !== null && this.envKinds.has(o.node);
  }

  /**
   * A closure value made (R3): the lowering's environment, allocated and stored into field by field, is its class's
   * constructor given each field, the closure's kind first where the class has several. Null otherwise.
   */
  envNew(e: Extract<TE, { k: "blockexpr" }>): string | null {
    if (!this.isEnvBlock(e)) return null;
    const first = e.body[0];
    if (first === undefined || first.k !== "let" || first.init === null || first.init.k !== "alloc")
      return null;
    const o = this.objNode(first.init.sh);
    if (o === null || !this.envKinds.has(o.node)) return null;
    const plan = this.plans.get(o.node);
    if (plan?.env === undefined) return this.fail("an environment class that wasn't planned");
    const p = first.v;
    if (e.result.k !== "var" || e.result.v !== p)
      return this.fail("an environment made some other way");
    const vals = new Map<PlanField, TE>();
    let kind = -1;
    for (const st of e.body.slice(1)) {
      if (
        st.k !== "expr" ||
        st.e.k !== "fstore" ||
        st.e.base.k !== "var" ||
        st.e.base.v !== p ||
        st.e.fld === undefined
      )
        return this.fail("an environment made some other way");
      if (st.e.fld.name === "$kind") {
        kind =
          (this.envKinds.get(o.node) ?? []).indexOf(
            (st.e.val as Extract<TE, { k: "fnref" }>).inst,
          ) + 1;
        if (kind === 0) this.fail("an environment of a closure its class doesn't have");
        continue;
      }
      const f = plan.fields.get(st.e.fld.name);
      if (f === undefined) return this.fail(`the field ${st.e.fld.name}`);
      vals.set(f, st.e.val);
    }
    const kf = plan.fields.get("$kind");
    const given = plan.env.filter((f) => vals.has(f));
    const ops = this.operands(given.map((f) => vals.get(f)!));
    const args = plan.env.map((f) => {
      if (f === kf) return String(kind);
      const i = given.indexOf(f);
      return i >= 0 ? ops[i]! : f.init!;
    });
    return this.rcOwned(e, `new ${this.clsName(o.node)}(${args.join(", ")})`);
  }

  fieldName(fld: { node: unknown; name: string }): string {
    return this.planField(fld).name;
  }

  planField(fld: { node: unknown; name: string }): PlanField {
    const n = findNode(fld.node as HeapNode);
    const c = this.canon(n);
    const plan = this.plans.get(c);
    const key = c !== n && fld.name !== "$cls" ? `${n.id}|${fld.name}` : fld.name;
    const f = plan?.fields.get(key);
    if (f === undefined) return this.fail(`the field ${fld.name}`);
    return f;
  }

  /** A base read twice (an optional's two fields, R7): a variable as it is, anything else into a temporary first. */
  onceBase(te: TE): string {
    const text = this.value(te);
    if (te.k === "var" || /^[A-Za-z_$][\w$]*$/.test(text)) return paren(text);
    const t = this.tempFor(te);
    this.pre.push(`${t} = ${text};`);
    this.reshape("a field read through a computed base");
    return t;
  }

  /**
   * R7: a store of an optional scalar to its two fields, flag then value, as the direct route stores them. A value made of
   * its two parts (the lowering's `tuple`) gives each its own; any other is read once, into a temporary where it isn't a
   * variable, and taken apart with `part`.
   */
  optFieldStore(e: Extract<TE, { k: "fstore" }>, pf: PlanField): string {
    const self = this.thisBase(e.base);
    let on: string;
    let flag: string;
    let val: string;
    const vt = this.tyText((e.val.ty as Extract<Ty, { k: "opt" }>).of);
    if (e.val.k === "tuple" && e.val.items.length === 2) {
      const [b, f, v] =
        self !== null
          ? [self, ...this.operands([e.val.items[0]!, e.val.items[1]!])]
          : this.operands([e.base, e.val.items[0]!, e.val.items[1]!]);
      on = self ?? paren(b!);
      flag = this.boolText(f!, e.val.items[0]!);
      val = v!;
      // The value is computed before either field is written, as the direct route computes the whole optional first: a
      // value that can trap, or that assigns, mustn't run after the flag says it's there.
      if (!isConstText(val) && !/^[A-Za-z_$][\w$]*$/.test(val)) {
        const t = this.temp(e.val.items[1]!.ty);
        this.pre.push(`${t} = ${val};`);
        this.reshape("an optional field's value computed first");
        val = t;
      }
    } else {
      const [b, x] = self !== null ? [self, this.value(e.val)] : this.operands([e.base, e.val]);
      on = self ?? paren(b!);
      let v = x!;
      if (!/^[A-Za-z_$][\w$]*$/.test(v)) {
        const t = this.temp(e.val.ty);
        this.pre.push(`${t} = ${v};`);
        this.reshape("an optional field's value into a temporary");
        v = t;
      }
      flag = `${this.lowered("part")}<bool>(${v}, 0, 1)`;
      val = `${this.lowered("part")}<${vt}>(${v}, 1, 2)`;
    }
    // the injected `opt-field-flag` bug (R7): every store says the value is there, so an absent one reads as its zero
    if (this.fault === "opt-field-flag") flag = "true";
    return `((${on}.${pf.flag!.name} = ${flag}), (${on}.${pf.name} = ${val}))`;
  }

  /**
   * R7: a store of a typed array to its field's runtime class: pointer then length, as the direct route stores the two
   * words, after the value is computed. A value made of its parts (a null array's `tuple`) gives each its own.
   */
  arrFieldStore(e: Extract<TE, { k: "fstore" }>, pf: PlanField): string {
    const self = this.thisBase(e.base);
    let on: string;
    let ptr: string;
    let len: string;
    if (e.val.k === "tuple" && e.val.items.length === 2 && !this.arrAllocs.has(e.val.items[0]!)) {
      const [b, x, n] =
        self !== null
          ? [self, ...this.operands([e.val.items[0]!, e.val.items[1]!])]
          : this.operands([e.base, e.val.items[0]!, e.val.items[1]!]);
      on = self ?? paren(b!);
      // R9: a null array's pointer is the address 0
      ptr = e.val.items[0]!.k === "lit" && e.val.items[0]!.ty.k === "ref" ? "0" : x!;
      len = n!;
    } else {
      const [b, x] = self !== null ? [self, this.value(e.val)] : this.operands([e.base, e.val]);
      on = self ?? paren(b!);
      let v = x!;
      if (!/^[A-Za-z_$][\w$]*$/.test(v)) {
        const t = this.temp(e.val.ty);
        this.pre.push(`${t} = ${v};`);
        this.reshape("a null array's value into a temporary");
        v = t;
      }
      ptr = `${this.lowered("cast")}<usize>(${this.lowered("part")}<Ref>(${v}, 0, 1))`;
      this.loweredUsed.add("Ref");
      len = `${this.lowered("part")}<usize>(${v}, 1, 2)`;
    }
    // the injected `arr-field-swap` bug (R7): each word stored where the other goes
    if (this.fault === "arr-field-swap")
      return `((${on}.${pf.name}.ptr = ${this.lowered("cast")}<usize>(${len})), (${on}.${pf.name}.len = ${this.lowered("cast")}<usize>(${ptr})))`;
    return `((${on}.${pf.name}.ptr = ${ptr}), (${on}.${pf.name}.len = ${len}))`;
  }

  /**
   * R9: a store to module state that's a typed array: its holder's pointer then its length, as arrFieldStore stores a
   * field's, after the value is computed.
   */
  globArrStore(e: Extract<TE, { k: "fstore" }>): string {
    const on = this.globName(e.glob!.name);
    let ptr: string;
    let len: string;
    if (e.val.k === "tuple" && e.val.items.length === 2 && !this.arrAllocs.has(e.val.items[0]!)) {
      const [x, n] = this.operands([e.val.items[0]!, e.val.items[1]!]);
      ptr = e.val.items[0]!.k === "lit" && e.val.items[0]!.ty.k === "ref" ? "0" : x!;
      len = n!;
    } else {
      let v = this.value(e.val);
      if (!/^[A-Za-z_$][\w$]*$/.test(v)) {
        const t = this.temp(e.val.ty);
        this.pre.push(`${t} = ${v};`);
        this.reshape("a typed array field's value into a temporary");
        v = t;
      }
      this.loweredUsed.add("Ref");
      ptr = `${this.lowered("cast")}<usize>(${this.lowered("part")}<Ref>(${v}, 0, 1))`;
      len = `${this.lowered("part")}<usize>(${v}, 1, 2)`;
    }
    // the injected `glob-arr-len` bug (R9): module state's typed array given a length one short
    if (this.fault === "glob-arr-len") len = `${paren(len)} - 1`;
    return `((${on}.ptr = ${ptr}), (${on}.len = ${len}))`;
  }

  /** R9: an array element that's a byte, a boolean or nothing (`byteElem`), where R9's printing is on. */
  byteElem(es: Shape): "bool" | "void" | null {
    return this.r9 ? byteElem(es) : null;
  }

  /** R9: whether a vector's elements are booleans or nothing, each a byte (`byteElem`), or neither. */
  vecByteElem(v: TE): "bool" | "void" | null {
    const sh = v.sh as Shape | undefined;
    if (sh?.s !== "vec") return null;
    const es = this.vecs.get(this.canon(findNode(sh.node)));
    return es === undefined ? null : this.byteElem(es);
  }

  /** R9: a boolean as the byte an array of booleans holds, 1 or 0 (the lowering's i32 0 or 1, or a `bool`). */
  boolByte(text: string, te: TE): string {
    if (te.k === "lit") return Number(te.value) !== 0 || te.value === true ? "1" : "0";
    if (te.ty.k === "bool") return `(${text} ? 1 : 0)`;
    return `${this.lowered("cast")}<u8>(${text}, "u8")`;
  }

  /** R9: whether module state of this shape prints as a typed array held in a static object of its runtime class. */
  globArr(sh: Extract<Shape, { s: "arr" }>): boolean {
    return !r9Off("globarrs") && this.r9 && !this.rc && ARRAY_BY_ELEM[sh.elem] !== undefined;
  }

  /** An optional's flag as a `bool`: the lowering makes it an i32 0 or 1 (`lit32`), which a `bool` field holds as itself. */
  boolText(text: string, te: TE): string {
    if (te.ty.k === "bool") return text;
    if (te.k === "lit") return Number(te.value) !== 0 ? "true" : "false";
    return `${this.lowered("cast")}<bool>(${text})`;
  }

  builtin(e: Extract<TE, { k: "builtin" }>): string {
    const name = e.name;
    const args = e.args;
    if (
      name.startsWith("Math.") &&
      MATH_TSL.has(name) &&
      args.every((a) => a.ty.k === "float" && a.ty.name === "f64")
    ) {
      return `${this.loc(e)}${name}(${this.operands(args).join(", ")})`;
    }
    if (name === "assert") {
      // A bounds or narrowing check: its code by its name in @tsl/core's Trap, as trapNow's (TSL1026, D72).
      const code = args[1];
      const n = code !== undefined && code.k === "lit" ? TRAP_NAMES[Number(code.value)] : undefined;
      if (n === undefined || args.length !== 2)
        return this.fail("an assert whose code Trap doesn't name");
      this.coreUsed.add("Trap");
      const [c] = this.typedOperands([args[0]!]);
      return `${this.loc(e)}${this.lowered("builtin")}<${this.tyText(e.ty)}>("assert", ${c}, Trap.${n})`;
    }
    const texts = this.typedOperands(args);
    return `${this.loc(e)}${this.lowered("builtin")}<${this.tyText(e.ty)}>(${[JSON.stringify(name), ...texts].join(", ")})`;
  }
}

/** Math functions TSL proper spells as JS does, on doubles (3.10 item 7). */
const MATH_TSL = new Set([
  "Math.floor",
  "Math.ceil",
  "Math.trunc",

  "Math.abs",
  "Math.sqrt",
]);

const LOWERED_NAMES = [
  "rt",
  "intrinsic",
  "builtin",
  "load",
  "store",
  "allocStack",
  "alloc",
  "elemAddr",
  "loadElem",
  "storeElem",
  "data",
  "text",
  "charTable",
  "hashKey",
  "addr",
  "nullRef",
  "f2ix",
  "nonNull",
  "trapNow",
  "throwJs",
  "pack",
  "part",
  "cast",
  "isUndef",
  "optPayload",
  "wrap",
  "unreachable",
  "Ref",
  "Opt",
];
// R9: and the values the printing imports from @tsl/core by name, so a program's own `lit` or `tail` is renamed, not
// shadowed (a literal's `lit`, D67; a typed array's `array`, `tail` and `withTail`)
const CORE_NAMES = [
  "idiv",
  "toF64",
  ...(r9Off("names") ? [] : ["lit", "array", "tail", "withTail"]),
  ...CORE_TYPES,
];

function paren(s: string): string {
  // A marked reference site (class printing's first pass) is in parentheses already, after its marker.
  return /^[A-Za-z0-9_$.]+$/.test(s) || /^\(.*\)$/.test(s) || /^\/\*<\d+\*\/\(.*\)$/.test(s)
    ? s
    : `(${s})`;
}

function isConstText(s: string): boolean {
  return (
    /^-?[0-9][0-9.e+-]*n?$/.test(s) ||
    s === "true" ||
    s === "false" ||
    s === "NaN" ||
    s === "Infinity"
  );
}

/**
 * R5: a function's last statement where it's a `return` right after another: the lowering's return of nothing at a body's
 * end (down.ts's implicitReturn) after a body that always returns. Dead, so it says nothing about what the result can be.
 */
function deadTail(f: FuncInst): Stmt | null {
  const n = f.body.length;
  // TMK_EMIT_DEADTAIL=0: printed as before R5, to find what it moves (tools/r5-pins.ts)
  if (n < 2 || process.env.TMK_EMIT_DEADTAIL === "0") return null;
  const last = f.body[n - 1]!;
  return last.k === "return" && f.body[n - 2]!.k === "return" ? last : null;
}

function endsInJump(s: Stmt | undefined): boolean {
  if (s === undefined) return false;
  if (s.k === "return" || s.k === "break" || s.k === "continue") return true;
  if (s.k === "expr") return s.e.ty.k === "never";
  return false;
}

/**
 * The lowering's lets aren't always TS's blocks: one variable can be declared on two paths and read after both, or read
 * after the block that declared it. Those are declared at the function's top instead, and their lets become assignments.
 */
/** Whether control never goes on past this statement: a jump, or a block or both arms of an `if` that always jump. */
function exits(s: Stmt): boolean {
  if (s.k === "break" || s.k === "continue" || s.k === "return") return true;
  if (s.k === "block") return s.body.length > 0 && exits(s.body[s.body.length - 1]!);
  if (s.k === "if")
    return (
      s.a.length > 0 &&
      exits(s.a[s.a.length - 1]!) &&
      s.b !== null &&
      s.b.length > 0 &&
      exits(s.b[s.b.length - 1]!)
    );
  return false;
}

/**
 * R10: in `rc`, a statement list up to the first that never goes on: what follows is dead (the lowering's `undefined` for a
 * callback's end after every path returned), and the expansion's drops in dead code don't type, as tsc doesn't narrow there.
 */
function liveStmts(list: Stmt[]): Stmt[] {
  if (r10Off("dead")) return list;
  const i = list.findIndex(exits);
  return i < 0 || i === list.length - 1 ? list : list.slice(0, i + 1);
}

function hoistScan(f: FuncInst, rc = false): Set<Var> {
  // Not named `declare`: Bun 1.3.11's transpiler takes a statement `declare(x);` for TypeScript's ambient `declare` and
  // drops it, so on Bun no `let` was ever in scope, the printed TSL hoisted more, and a trap's position in the TIR differed
  // from Node's (`opt-a` box 13 found it, through class printing, whose TIR has the printed file's positions).
  const out = new Set<Var>();
  const lets = new Map<Var, number>();
  const visible: Set<Var>[] = [new Set(f.params)];
  function seen(v: Var): boolean {
    for (const s of visible) if (s.has(v)) return true;
    return false;
  }
  function use(v: Var): void {
    if (!seen(v)) out.add(v);
  }
  function declareVar(v: Var): void {
    const n = (lets.get(v) ?? 0) + 1;
    lets.set(v, n);
    if (n > 1) out.add(v);
    const top = visible[visible.length - 1] as Set<Var>;
    top.add(v);
  }
  function te(e: TE | null | undefined): void {
    if (e === null || e === undefined) return;
    const sa = strArgs(e);
    if (sa !== null) {
      for (const c of sa) te(c);
      return;
    }
    switch (e.k) {
      case "var":
        use(e.v);
        return;
      case "setvar":
        use(e.v);
        te(e.val);
        return;
      case "blockexpr":
        visible.push(new Set());
        // In `rc` a statement-expression's statements print before the statement holding it (R2), so what it declares is
        // in scope for its result.
        if (rc) for (const st of e.body) stmt(st);
        else list(e.body);
        te(e.result);
        visible.pop();
        return;
      default:
        for (const c of childrenOf(e)) te(c);
    }
  }
  function stmt(s: Stmt): void {
    switch (s.k) {
      case "let":
        te(s.init);
        declareVar(s.v);
        return;
      case "expr":
        te(s.e);
        return;
      case "return":
        te(s.val);
        return;
      case "if":
        te(s.c);
        list(s.a);
        if (s.b !== null) list(s.b);
        return;
      case "while":
        te(s.c);
        list(s.body);
        return;
      case "do": {
        list(s.body);
        // its condition's statements print inside the loop, its value after it: what they declare is out of scope there
        const was = rc;
        rc = false;
        te(s.c);
        rc = was;
        return;
      }
      case "for":
        visible.push(new Set());
        for (const i of s.init) stmt(i);
        te(s.c);
        for (const x of s.step) te(x);
        list(s.body);
        visible.pop();
        return;
      case "switch":
        te(s.val);
        for (const c of s.clauses) list(c.body);
        return;
      case "block":
        list(s.body);
        return;
      case "label":
        list([s.body]);
        return;
      default:
        return;
    }
  }
  function list(l: Stmt[]): void {
    visible.push(new Set());
    for (const s of l) stmt(s);
    visible.pop();
  }
  list(f.body);
  return out;
}

/** Every expression directly under this one, whatever its kind. */
function childrenOf(e: TE): TE[] {
  const sa = strArgs(e);
  if (sa !== null) return sa;
  const out: TE[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (
      k === "ty" ||
      k === "sh" ||
      k === "deps" ||
      k === "inst" ||
      k === "g" ||
      k === "v" ||
      k === "rcOwn"
    )
      continue;
    if (Array.isArray(v)) {
      for (const x of v)
        if (x !== null && typeof x === "object" && "ty" in x && "k" in x) out.push(x as TE);
    } else if (v !== null && typeof v === "object" && "ty" in v && "k" in v) out.push(v as TE);
  }
  return out;
}

/** Whether two types print as the same TSL type. */
function sameRep(a: Ty, b: Ty): boolean {
  if (a.k !== b.k) {
    // A literal union and an i32 are both i32 in the printed TSL.
    const i32ish = (t: Ty): boolean =>
      t.k === "lits" || t.k === "enum" || (t.k === "int" && t.name === "i32");
    return i32ish(a) && i32ish(b);
  }
  if (a.k === "int" || a.k === "float" || a.k === "big") return a.name === (b as typeof a).name;
  if (a.k === "arr") return a.elem === (b as typeof a).elem;
  if (a.k === "opt") return sameRep(a.of, (b as typeof a).of);
  return true;
}

/** A type with no leaves in TIR: `undefined` or `null` before it meets anything, or nothing. */
function noLeaves(t: Ty): boolean {
  return t.k === "nullish" || t.k === "void";
}
