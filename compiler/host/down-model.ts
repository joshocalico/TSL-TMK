// Down-lowering's model of a program (SPEC 4.5): where numbers live and what is known about them, and
// which heap objects can flow into which. All of it only ever rises, so analysis reaches a fixed point.
import type { ElemName, MemLeaf, Ty } from "./types.ts";
import { T } from "./types.ts";

export const I32_MIN = -2147483648;
export const I32_MAX = 2147483647;
export const U32_MAX = 4294967295;

/** A storage location of `number`. Every value a location has held fits these facts. */
export interface NumLoc {
  parent: NumLoc | null;
  float: boolean; // holds, or may hold, a value only an f64 represents
  lo: number;
  hi: number;
  negz: boolean; // may hold -0
  seen: boolean;
}

export function newLoc(): NumLoc {
  return { parent: null, float: false, lo: 0, hi: 0, negz: false, seen: false };
}

export function findLoc(l: NumLoc): NumLoc {
  let cur = l;
  while (cur.parent !== null) cur = cur.parent;
  return cur;
}

/** The representation a location gets: f64 is always exact, and integers are an optimisation. */
export function locTy(l0: NumLoc): Ty {
  const l = findLoc(l0);
  if (l.float) return T.f64;
  if (!l.seen) return T.i32;
  if (l.lo >= I32_MIN && l.hi <= I32_MAX) return T.i32;
  if (l.lo >= 0 && l.hi <= U32_MAX) return T.u32;
  return T.f64;
}

export interface Fact {
  float: boolean;
  lo: number;
  hi: number;
  negz: boolean;
}

/** Joins a fact in, widening in jumps so loops settle in a few rounds. Returns true on a change. */
export function joinLoc(l0: NumLoc, f: Fact): boolean {
  const l = findLoc(l0);
  let changed = false;
  if (f.float && !l.float) {
    l.float = true;
    changed = true;
  }
  if (f.negz && !l.negz) {
    l.negz = true;
    changed = true;
  }
  if (!l.seen) {
    l.seen = true;
    l.lo = f.lo;
    l.hi = f.hi;
    return true;
  }
  if (f.lo < l.lo) {
    l.lo = f.lo >= 0 ? 0 : f.lo >= I32_MIN ? I32_MIN : -Infinity;
    changed = true;
  }
  if (f.hi > l.hi) {
    l.hi = f.hi <= I32_MAX ? I32_MAX : f.hi <= U32_MAX ? U32_MAX : Infinity;
    changed = true;
  }
  return changed;
}

export function unifyLocs(a0: NumLoc, b0: NumLoc): boolean {
  const a = findLoc(a0);
  const b = findLoc(b0);
  if (a === b) return false;
  b.parent = a;
  if (b.seen) joinLoc(a, { float: b.float, lo: b.lo, hi: b.hi, negz: b.negz });
  else if (b.float && !a.float) a.float = true;
  return true;
}

export type Nul = "null" | "undefined";

export type Shape =
  | { s: "num"; loc: NumLoc }
  | { s: "bool" }
  | { s: "str" }
  | { s: "arr"; elem: ElemName; node: HeapNode; nul?: Nul }
  | { s: "vec"; node: HeapNode; nul?: Nul }
  | { s: "obj"; node: HeapNode; nul?: Nul }
  | { s: "opt"; of: Shape; nul: Nul }
  | { s: "fn" }
  | { s: "void" };

/** A set of heap objects that may alias: an object, vector or typed array of one flow class. */
export interface HeapNode {
  parent: HeapNode | null;
  id: number;
  kind: "obj" | "vec" | "arr" | "fn"; // fn: a closure, whose environment this is (SPEC 4.5)
  long: boolean; // memory modes only: outlives the export call, so it's in the mode's allocator
  params: Shape[]; // fn: one representation per parameter, shared by every closure that can get here
  ret: Shape | null; // fn
  caps: Shape[]; // fn: what environments of this class hold, so reachability can follow it
  escapes: boolean; // reachable after the allocating function returns
  global: boolean; // reachable from a module-level binding
  written: boolean; // something writes through it, so JS must see the changes
  external: boolean; // comes from JS, so its numbers can be anything
  fields: Map<string, Shape>; // obj
  elem: Shape | null; // vec
  klass: string | null; // obj: the class it was made from, if any
  variants: { tag: string; value: string | number | boolean; fields: string[] }[];
  weakOf?: Shape; // `rc`: this is a WeakRef, and that's what it can give back. It holds no count on it.
  tupleLen?: number; // an object that's a tuple of mixed element shapes: fields "0", "1" and so on
  chainOnly?: boolean; // a class whose self-reference only ever points at something newer: not a cycle
  // Classes (SPEC 3.4, 4.5, D50): which classes' instances are in this flow class, and whether they carry a class id in
  // their first word, which `instanceof`, a dispatch and an `unknown` read. Only a node that needs one has one.
  classes?: Set<object>;
  cls?: boolean;
  dyn?: boolean; // the one node of `unknown` values: a pointer to a class instance or a box, or null for undefined
  dynTargets?: HeapNode[]; // dyn: what flows in, so the type graph sees its edges
}

let nextNode = 1;
let allNodes: HeapNode[] = [];

export function resetNodeIds(): void {
  nextNode = 1;
  allNodes = [];
  layoutNotes.clear();
}

export function liveNodes(): HeapNode[] {
  return allNodes;
}

export function newNode(kind: HeapNode["kind"]): HeapNode {
  const made: HeapNode = {
    parent: null,
    id: nextNode++,
    kind,
    long: false,
    params: [],
    ret: null,
    caps: [],
    escapes: false,
    global: false,
    written: false,
    external: false,
    fields: new Map(),
    elem: null,
    klass: null,
    variants: [],
  };
  allNodes.push(made);
  return made;
}

export function findNode(n: HeapNode): HeapNode {
  let cur = n;
  while (cur.parent !== null) cur = cur.parent;
  return cur;
}

export function tyOf(sh: Shape): Ty {
  switch (sh.s) {
    case "num":
      return locTy(sh.loc);
    case "bool":
      return T.bool;
    case "str":
      return { k: "lits", kind: "str", values: [] };
    case "arr":
      return { k: "arr", elem: sh.elem };
    case "vec":
    case "obj":
      return { k: "ref" };
    case "opt":
      return { k: "opt", of: tyOf(sh.of) };
    case "fn":
      return T.i32;
    case "void":
      return T.void;
  }
}

// --- memory layout, which is the compiler's choice and never observable (SPEC 3.1)
//
// R6 (D36, D62's rulings): TSL's own layout rules (3.4), so what the direct route lays out is what the TSL route's classes
// are: a `bool` takes 1 byte, an optional scalar is a `bool` flag and then its value, each at its own natural alignment,
// and an object's size is rounded up to its alignment only. `TMK_R6_OFF=layout` gives D36's old rule back (a `bool` 4
// bytes, an optional scalar's flag a word of its own, every object a multiple of 8 and at least 8), only so that
// tools/r6-pins.ts can show which pins the change moved and that nothing else did.

/**
 * One of R6's changes turned off, for tools/r6-pins.ts's comparison only, which shows each pin that moved moved by the change
 * it names and nothing else: `layout` (D36's old rule), `checks` (a read's bounds check printed beside JsArray's own and
 * `nonNull(…)!` for a non-null read, R5's printing), `region` (no per-call region: every escaping `new` in the mode's heap),
 * `closures` and `boundary` (`auto`'s choices in `leak` and `manual` as R5 left them: tslc.ts's autoClosures, boundaryIn).
 */
/**
 * R13: whether a part of R13 is turned off by TMK_R13_OFF, for computing what it moved (tools/r13-pins.ts): `arrays`,
 * `strict`'s arrays and typed arrays printed (the arena array, R9's views); `arena`, what crosses an export in `strict` kept
 * in the caller's arena, as the direct route keeps it; `boundary` and `closures`, those printed in `strict`.
 */
/**
 * R14: whether a part of R14 is turned off by TMK_R14_OFF, for computing what it moved (tools/r14-pins.ts): `trust`, `auto`
 * taking a printing reshaped only by the kinds it trusts (tslc.ts's TRUSTED_RESHAPES); `inv`, phase 1's printing of a class id's
 * load noted invariant (`load<i32>(o, 0, "invariant")`, D73), as the direct route notes it; `nullref`, a typed array's
 * pointer against null printed `nullRef()` in `leak`'s, `manual`'s and `rc`'s class printing, as R13 printed it in `strict`.
 */
export function r14Off(part: "trust" | "inv" | "nullref"): boolean {
  return (process.env.TMK_R14_OFF ?? "").split(",").includes(part);
}

/**
 * R36: whether a part of R36 is turned off by TMK_R36_OFF, for computing what it moved (tools/r36-pins.ts): `trust`, `auto`
 * not trusting reshapes in `rc`'s class printing (tslc.ts's TRUSTED_IN), as before R36.
 */
export function r36Off(part: "trust"): boolean {
  return (process.env.TMK_R36_OFF ?? "").split(",").includes(part);
}

/**
 * R37: whether a part of R37 is turned off by TMK_R37_OFF, for computing what it moved (tools/r37-pins.ts): `exc`, `auto`
 * not taking a program with exceptions reshaped in a mode TRUSTED_EXC_IN trusts (tslc.ts), as before R37.
 */
export function r37Off(part: "exc"): boolean {
  return (process.env.TMK_R37_OFF ?? "").split(",").includes(part);
}

/**
 * R17: whether a part of R17 is turned off by TMK_R17_OFF, for computing what it moved (tools/r17-pins.ts): `pop`, the
 * lowering's pop clearing the slot it drops in an array of references in every mode (before R17, only in `rc`); `jsrt` and
 * `holes`, the printing's JsArray constructor (emit-tsl.ts).
 */
export function r17Off(part: string): boolean {
  return (process.env.TMK_R17_OFF ?? "").split(",").includes(part);
}

/**
 * R18: whether a part of R18 is turned off by TMK_R18_OFF, for computing what it moved (tools/r18-pins.ts): `stack`, `rc`
 * class printing keeping a class on the stack where the lowering keeps every object of it there (emit-tsl.ts's planStack,
 * expand-rc.ts's `@tsl.stack`).
 */
export function r18Off(part: "stack"): boolean {
  return (process.env.TMK_R18_OFF ?? "").split(",").includes(part);
}

/**
 * R19's switches, for tools/r19-pins.ts's comparison: `TMK_R19_OFF=inline` prints an `rc` environment's `call` and its small
 * kinds as before, not `@tsl.inline` (emit-tsl.ts).
 */
export function r19Off(part: "inline"): boolean {
  return (process.env.TMK_R19_OFF ?? "").split(",").includes(part);
}

export function r13Off(part: "arrays" | "arena" | "boundary" | "closures"): boolean {
  return (process.env.TMK_R13_OFF ?? "").split(",").includes(part);
}

export function r6Off(part: "layout" | "checks" | "region" | "closures" | "boundary"): boolean {
  return (process.env.TMK_R6_OFF ?? "").split(",").includes(part);
}

/**
 * R9's changes, each of which TMK_R9_OFF (a list) turns off, for tools/r9-pins.ts's stages: `names`, @tsl/core's `lit`,
 * `array`, `tail` and `withTail` kept from a program's own names; `escape`, escape analysis following a typed array's
 * pointer; `regionviews`, the per-call region following views; `regiontails`, an object with a tail in the per-call region;
 * `arrays`, typed arrays made in a function printed as TSL (layout classes and tails); `globarrs`, module state that's a
 * typed array; `boolvecs`, arrays of booleans; `voidvecs`, arrays of nothing.
 */
export function r9Off(
  part:
    | "names"
    | "escape"
    | "regionviews"
    | "regiontails"
    | "arrays"
    | "globarrs"
    | "boolvecs"
    | "voidvecs",
): boolean {
  return (process.env.TMK_R9_OFF ?? "").split(",").includes(part);
}

/** D36's rule as it was before R6, for tools/r6-pins.ts's comparison only. */
export function oldLayout(): boolean {
  return r6Off("layout");
}

/**
 * What this lowering laid out that D36's old rule and TSL's lay out differently (R6): tools/r6-pins.ts asks, for each pin the
 * layout moved, so each such pin is shown to be a build with an object, vector or module state laid out by D36's rule.
 * Cleared with the node ids, at the start of each lowering.
 */
export const layoutNotes = new Set<string>();

export function alignOf(sh: Shape): number {
  if (sh.s === "num") return locTy(sh.loc).k === "float" ? 8 : 4;
  if (sh.s === "bool") return oldLayout() ? 4 : 1;
  if (sh.s === "str" || sh.s === "fn") return 4;
  if (sh.s === "opt" && !oldLayout()) return alignOf(sh.of);
  return sh.s === "void" ? 1 : 8;
}

/** Where an optional scalar's value is, past its flag: the flag is a `bool`, and the value at its own alignment after it. */
export function optValueOff(sh: Extract<Shape, { s: "opt" }>): number {
  return oldLayout() ? 8 : Math.max(1, alignOf(sh.of));
}

export function sizeOf(sh: Shape): number {
  switch (sh.s) {
    case "num":
      return locTy(sh.loc).k === "float" ? 8 : 4;
    case "bool":
      if (oldLayout()) return 4;
      layoutNotes.add("a bool in memory, a byte where it was 4");
      return 1;
    case "str":
    case "fn":
      return 4;
    case "arr":
      return 16;
    case "vec":
    case "obj":
      return 8;
    case "opt":
      if (oldLayout()) return 8 + ((sizeOf(sh.of) + 7) & ~7);
      layoutNotes.add("an optional scalar in memory, a bool flag before its value");
      return optValueOff(sh) + sizeOf(sh.of);
    case "void":
      return 0;
  }
}

/** The value's leaves in memory, at an offset. `ptr` and `ix` take 8 bytes on every target. A `bool` is a byte (`i8`),
 * loaded and widened to its register's `i32` (lower.ts's memLoad), as TSL's own are. */
export function memOf(sh: Shape, off: number): MemLeaf[] {
  switch (sh.s) {
    case "num":
      return [{ t: locTy(sh.loc).k === "float" ? "f64" : "i32", off }];
    case "bool":
      if (oldLayout()) return [{ t: "i32", off }];
      layoutNotes.add("a bool in memory, a byte where it was 4");
      // `tmk milestone pipe-d`'s injected bug (R6): laid out as a byte, stored and loaded as a word, over what follows it
      return [{ t: process.env.TMK_TEST_DOWN === "d36-bool-word" ? "i32" : "i8", off }];
    case "str":
    case "fn":
      return [{ t: "i32", off }];
    case "arr":
      return [
        { t: "ptr", off },
        { t: "ix", off: off + 8 },
      ];
    case "vec":
    case "obj":
      return [{ t: "ptr", off }];
    case "opt":
      return [{ t: oldLayout() ? "i32" : "i8", off }, ...memOf(sh.of, off + optValueOff(sh))];
    case "void":
      return [];
  }
}

export interface Layout {
  size: number;
  offs: Map<string, number>;
}

/**
 * An object's layout, by TSL's rule (3.4, R6): fields in the lowering's order, a hierarchy's class id first, each at its
 * natural alignment, and the size rounded up to the largest alignment. What an allocation asks for is at least 8 bytes
 * (`allocBytes`), as TSL's own `new` asks (lower-native.ts's heapObject), so nothing is ever 0 bytes long.
 */
export function layoutOf(n0: HeapNode): Layout {
  const n = findNode(n0);
  let at = 0;
  let align = 1;
  const offs = new Map<string, number>();
  // A class id is the first word, so every class in a flow class finds it in the same place (D50).
  const order = n.fields.has("$cls")
    ? [["$cls", n.fields.get("$cls")!] as const, ...[...n.fields].filter(([k]) => k !== "$cls")]
    : n.fields;
  for (const [name, sh] of order) {
    const a = alignOf(sh);
    at = Math.ceil(at / a) * a;
    offs.set(name, at);
    at += sizeOf(sh);
    align = Math.max(align, a);
  }
  const old = Math.max(8, Math.ceil(at / 8) * 8);
  if (oldLayout()) return { size: old, offs };
  const size = Math.ceil(at / align) * align;
  if (size !== old)
    layoutNotes.add("an object whose size TSL's rule rounds to its alignment, not to 8");
  return { size, offs };
}

/** What an object of this size is allocated with: TSL's `new` asks for at least 8 bytes (R6). */
export function allocBytes(size: number): number {
  return Math.max(8, size);
}

// --- what blocks a function, and how it's reported (SPEC 4.5)

export const BLOCKERS: Record<string, { code: string; suggest: string }> = {
  "hot-call-to-fallback": {
    code: "TSLD0100",
    suggest: "lower the callee, or move the call out of the loop",
  },
  "any-type": { code: "TSLD0201", suggest: "give the value an exact type" },
  reflection: { code: "TSLD0202", suggest: "use a known shape instead of reflection" },
  "string-from-spread": { code: "TSLD0203", suggest: 'compare bytes with lit("JFIF")' },
  "string-use": {
    code: "TSLD0204",
    suggest:
      "compile with --memory rc, leak or manual; otherwise use bytes or a literal union, as other string uses stay in JS",
  },
  "try-catch": { code: "TSLD0205", suggest: "return a Result instead of catching" },
  async: { code: "TSLD0206", suggest: "async needs a runtime; keep it in JS" },
  generator: { code: "TSLD0207", suggest: "use an explicit loop" },
  regexp: { code: "TSLD0208", suggest: "scan the bytes" },
  date: { code: "TSLD0209", suggest: "take the time as a parameter" },
  "map-set": {
    code: "TSLD0210",
    suggest: "compile with --memory rc, leak or manual, or use a typed array or a Slab",
  },
  "computed-key": { code: "TSLD0211", suggest: "use a fixed shape" },
  "prototype-mutation": { code: "TSLD0212", suggest: "use a plain function" },
  "escape-global": { code: "TSLD0213", suggest: "return the value, or use a Slab or Vec (D28)" },
  "closure-escape": {
    code: "TSLD0214",
    suggest: "call the closure where it is known, or pass a plain function",
  },
  "instantiation-cap": {
    code: "TSLD0215",
    suggest: "reduce the number of distinct type arguments",
  },
  inheritance: { code: "TSLD0216", suggest: "use composition" },
  "union-mixed": { code: "TSLD0217", suggest: "use a discriminated union of object shapes" },
  "throw-non-error": { code: "TSLD0218", suggest: "throw new Error(message)" },
  callee: { code: "TSLD0219", suggest: "fix the callee's root cause" },
  "closure-recursive": { code: "TSLD0220", suggest: "make the recursive closure's captures const" },
  bigint: { code: "TSLD0221", suggest: "use @tsl/core's u64 or i64 in TSL" },
  weakref: {
    code: "TSLD0228",
    suggest: "compile with --memory rc, and hold a class, object, array or closure",
  },
  finalization: {
    code: "TSLD0229",
    suggest: "release what you hold explicitly; nothing runs a callback at a free",
  },
  "shared-state": { code: "TSLD0222", suggest: "keep module state on one side of the boundary" },
  "export-signature": {
    code: "TSLD0223",
    suggest: "use scalars, typed arrays and plain shapes across the boundary",
  },
  "nullish-both": { code: "TSLD0224", suggest: "use null or undefined, not both" },
  "global-init": {
    code: "TSLD0225",
    suggest: "make the initialiser something lowered code can run",
  },
  "unsound-cast": {
    code: "TSLD0226",
    suggest: "cast only upwards, or narrow with a check the checker can see",
  },
  "shape-widened": {
    code: "TSLD0227",
    suggest: "give the wider shape its own type, or make the extra field optional",
  },
  "field-before-init": {
    code: "TSLD0230",
    suggest:
      "give the field a type that includes undefined, or don't reach an override from a base constructor",
  },
  unsupported: { code: "TSLD0299", suggest: "see the detail; this form isn't lowered yet" },
};

export class Blocked extends Error {
  blocker: string;
  node: unknown;
  detail: string;
  root?: string;
  constructor(blocker: string, node: unknown, detail: string, root?: string) {
    super(`${blocker}: ${detail}`);
    this.blocker = blocker;
    this.node = node;
    this.detail = detail;
    if (root !== undefined) this.root = root;
  }
}
