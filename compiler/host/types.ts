// tslc's own view of TSL types (SPEC 3.2 to 3.5), and the typed tree both TIR lowering and
// --emit=js-checked read, so the two can't disagree about where the checks go.
import type { Extern, Func, Global, TirType, TrapSite } from "../tir/ir.ts";

export type IntName = "i8" | "i16" | "i32" | "u8" | "u16" | "u32" | "usize";
export type BigName = "u64" | "i64";
export type FloatName = "f32" | "f64";
export type ElemName = IntName | BigName | FloatName;

export interface Field {
  name: string;
  ty: Ty;
}

export interface Variant {
  tag: boolean | string | number;
  fields: Field[]; // without the tag
  slots: Map<string, number[]>; // field name to positions in the flattened union, tag excluded
}

export type Ty =
  | { k: "int"; name: IntName }
  | { k: "big"; name: BigName }
  | { k: "float"; name: FloatName }
  | { k: "bool" }
  | { k: "enum"; name: string; members: Map<string, number> }
  | { k: "lits"; kind: "str" | "num"; values: (string | number)[] }
  | { k: "rec"; fields: Field[] }
  | { k: "union"; tag: string; variants: Variant[]; slots: TirType[] }
  | { k: "arr"; elem: ElemName }
  | { k: "fn"; params: Ty[]; ret: Ty; env?: boolean } // env: a code pointer and an environment pointer
  | { k: "cls"; c: ClassInst } // a reference: 48-bit pointer, 16-bit generation (SPEC 3.5)
  | { k: "ptr"; of: Ty; elem: ElemInfo } // @tsl/unsafe's Ptr<T>: natively a u64
  | { k: "elem"; of: Ty; elem: ElemInfo } // an element descriptor: a compile-time constant, no leaves
  | { k: "larr"; of: ClassInst; n: number } // arrayOf(Elem, n): the address of its first element
  | { k: "bits"; width: number; be: boolean; fields: BitField[] } // bits(u16, {...}): its container's address
  | { k: "arena" }
  | { k: "opt"; of: Ty } // a nullable scalar: a present flag, then the payload (SPEC 3.3, 4.5)
  | { k: "ref" } // a pointer to a heap object in down-lowered code; 0 is null
  | { k: "nullish" } // a literal null or undefined, before it meets its target
  | { k: "void" }
  | { k: "never" }
  | { k: "lit-num" } // an untyped numeric literal or constant, which adapts to its context
  | { k: "lit-big" }
  | { k: "unk" }; // not known yet, during inference; or the poison left behind by a reported error

/**
 * @tsl/core's `Trap` (3.10's table): each code's name, which TSL1026 suggests and the printer prints (`Trap.Bounds`).
 * packages/tsl-core/index.ts declares the enum; tools/spec-extract.ts's check keeps the two and the table in step.
 */
export const TRAP_NAMES: Record<number, string> = {
  1: "Overflow",
  2: "Bounds",
  3: "DivZero",
  4: "Conversion",
  5: "Stale",
  6: "Null",
  7: "Assert",
  8: "ShiftCount",
  9: "Misaligned",
  10: "Panic",
  11: "NoAddress",
  12: "NoStub",
  13: "Loan",
  14: "OutOfMemory",
  15: "Hole",
  16: "RcCheck",
  17: "BadCast",
  18: "Dispatch",
};

export const T = {
  i8: { k: "int", name: "i8" },
  i16: { k: "int", name: "i16" },
  i32: { k: "int", name: "i32" },
  u8: { k: "int", name: "u8" },
  u16: { k: "int", name: "u16" },
  u32: { k: "int", name: "u32" },
  usize: { k: "int", name: "usize" },
  u64: { k: "big", name: "u64" },
  i64: { k: "big", name: "i64" },
  f32: { k: "float", name: "f32" },
  f64: { k: "float", name: "f64" },
  bool: { k: "bool" },
  void: { k: "void" },
  never: { k: "never" },
  litNum: { k: "lit-num" },
  litBig: { k: "lit-big" },
  unk: { k: "unk" },
} as const satisfies Record<string, Ty>;

export const INT_RANGE: Record<IntName, readonly [number, number]> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  usize: [0, 9007199254740991],
};

const WIDENS: Record<IntName, readonly IntName[]> = {
  u8: ["u8", "u16", "u32", "usize", "i16", "i32"],
  u16: ["u16", "u32", "usize", "i32"],
  u32: ["u32", "usize"],
  usize: ["usize"],
  i8: ["i8", "i16", "i32"],
  i16: ["i16", "i32"],
  i32: ["i32"],
};

const JOIN_ORDER: readonly IntName[] = ["u8", "i8", "u16", "i16", "u32", "i32", "usize"];

export function intWidens(a: IntName, b: IntName): boolean {
  return WIDENS[a].includes(b);
}

export function intJoin(a: IntName, b: IntName): IntName | null {
  for (const c of JOIN_ORDER) if (intWidens(a, c) && intWidens(b, c)) return c;
  return null;
}

export function tyKey(t: Ty): string {
  switch (t.k) {
    case "int":
    case "big":
    case "float":
      return t.name;
    case "enum":
      return `enum ${t.name}`;
    case "lits":
      return `lits(${[...t.values].sort().join("|")})`;
    case "rec":
      return `{${t.fields.map((f) => `${f.name}:${tyKey(f.ty)}`).join(",")}}`;
    case "union":
      return `union(${t.tag};${t.variants
        .map((v) => `${String(v.tag)}:${v.fields.map((f) => `${f.name}:${tyKey(f.ty)}`).join(",")}`)
        .join("|")})`;
    case "arr":
      return `arr(${t.elem})`;
    case "fn":
      return `fn(${t.params.map(tyKey).join(",")})${tyKey(t.ret)}`;
    case "cls":
      return t.c.key;
    case "ptr":
      return `ptr(${tyKey(t.of)};${t.elem.mode})`;
    case "elem":
      return `elem(${tyKey(t.of)};${t.elem.mode})`;
    case "larr":
      return `larr(${t.of.key};${t.n})`;
    case "bits":
      return `bits(${t.width};${t.be};${t.fields.map((f) => `${f.name}:${f.n}`).join(",")})`;
    case "opt":
      return `opt(${tyKey(t.of)})`;
    default:
      return t.k;
  }
}

/** A name for messages. */
export function tyName(t: Ty): string {
  if (t.k === "lit-num" || t.k === "lit-big") return "literal";
  if (t.k === "arr") return `${t.elem} array`;
  if (t.k === "rec" || t.k === "union") return "value type";
  return tyKey(t);
}

/** The TIR values one TSL value flattens to (SPEC 3.5, 4.3). */
export function leaves(t: Ty): TirType[] {
  switch (t.k) {
    case "int":
      return [t.name === "usize" ? "ix" : "i32"];
    case "big":
      return ["i64"];
    case "float":
      return [t.name];
    case "bool":
    case "enum":
    case "lits":
      return ["i32"];
    case "rec":
      return t.fields.flatMap((f) => leaves(f.ty));
    case "union":
      return ["i32", ...t.slots];
    case "arr":
      return ["ptr", "ix"];
    case "fn":
      return t.env === true ? ["ptr", "ptr"] : ["ptr"];
    case "ref":
      return ["ptr"];
    case "cls":
    case "ptr":
    case "larr":
    case "bits":
    case "arena":
      return ["i64"];
    case "opt":
      return ["i32", ...leaves(t.of)];
    default:
      return [];
  }
}

/**
 * Builds a value union: discriminant first, then each variant's fields in declaration order,
 * sharing a slot with an earlier variant where the TIR type is equal (normative, SPEC 3.5).
 */
export function makeUnion(tag: string, parts: { tag: Variant["tag"]; fields: Field[] }[]): Ty {
  const slots: TirType[] = [];
  const variants: Variant[] = parts.map((p) => {
    const used = new Set<number>();
    const map = new Map<string, number[]>();
    for (const f of p.fields) {
      const positions: number[] = [];
      for (const leaf of leaves(f.ty)) {
        let at = slots.findIndex((s, i) => s === leaf && !used.has(i));
        if (at < 0) {
          at = slots.length;
          slots.push(leaf);
        }
        used.add(at);
        positions.push(at);
      }
      map.set(f.name, positions);
    }
    return { tag: p.tag, fields: p.fields, slots: map };
  });
  return { k: "union", tag, variants, slots };
}

/** How an element of a Ptr or Vec sits in memory: its stride, and whether it's a reference or the object itself. */
export interface ElemInfo {
  mode: "scalar" | "ref" | "inline";
  size: number;
  be: boolean;
}

export interface BitField {
  name: string;
  shift: number;
  n: number;
}

/** One field of a class: where it lives, and how a value of its type sits there. */
export interface ClsField {
  name: string;
  ty: Ty;
  off: number;
  size: number;
  align: number;
  // value: the bytes are the value. none: no memory (an element descriptor). inline: an object held in
  // place, so reading it gives an address (nested, arrayOf, bits, and an embedded `new`). array: a typed array.
  // tail: the class's variable-length tail (D69): the field's own bytes are its length, a u32, and its elements follow the
  // fixed part, at the class's tailAt.
  store: "value" | "none" | "inline" | "array" | "tail";
  be: boolean;
  arrLen: number;
  checkedEnum: boolean; // enumOf: an unknown value traps with code 4
  elemConst?: Ty; // the descriptor an elem field holds
}

/** A class, monomorphised. Natively a struct plus functions (SPEC 3.4). */
export interface ClassInst {
  key: string;
  name: string;
  layout: boolean;
  tyArgs: Ty[];
  decl: unknown; // ts.ClassDeclaration, kept opaque so this file doesn't need TypeScript's API
  env: unknown;
  fields: ClsField[];
  size: number;
  align: number;
  laidOut: 0 | 1 | 2; // not yet, in progress, done
  methods: Map<string, FuncInst>;
  ctor: FuncInst | null;
  ctorKnown: boolean;
  firstAt?: unknown; // the ts.Node that first asked for this instance
  firstIn?: ClassInst; // and, if that was in a method of another generic instance, which
  // Nothing of this class can go stale, as a whole-program fact (SPEC 3.5, D38): no Slab or other placeObject or objectAt
  // makes one, none is static or in an arena, and no generation check is ever made on one. So an escaping `new` of it in
  // `leak` has no prefix, and every reference to it is a plain pointer, with no tag to mask.
  plain?: boolean;
  // A variable-length tail of scalars (D69): its field (the u32 length's place), its element, and where element 0 is.
  // `size` is then the fixed part's size, and an object's real size is tailBytes(c, n).
  tail?: { f: ClsField; elem: ElemName; esize: number; at: number };
  tailBad?: boolean; // its tail's declaration had an error, already reported
  // A dispatch interface's value (3.4, D70): a reference to an object of one of `set`, told apart by the class id each of
  // them keeps in its first field. Only a method call reaches through it: a compare of the id per arm, a direct call in
  // each, and a trap (code 4) for an id that isn't one of them.
  iface?: { set: ClassInst[]; ids: number[] };
}

/** The real size of an object of a class with a tail of n elements (D69): the fixed part, then the tail, aligned. */
export function tailBytes(c: ClassInst, n: number): number {
  const t = c.tail;
  if (t === undefined) return c.size;
  const a = Math.max(c.align, 8); // as the allocators round, so a block is the same size made and freed
  return Math.ceil((t.at + n * t.esize) / a) * a;
}

export const ELEM_BY_ARRAY: Record<string, ElemName> = {
  Uint8Array: "u8",
  Int8Array: "i8",
  Uint16Array: "u16",
  Int16Array: "i16",
  Uint32Array: "u32",
  Int32Array: "i32",
  Float32Array: "f32",
  Float64Array: "f64",
  BigUint64Array: "u64",
  BigInt64Array: "i64",
};

export const ARRAY_BY_ELEM = Object.fromEntries(
  Object.entries(ELEM_BY_ARRAY).map(([a, e]) => [e, a]),
) as Partial<Record<ElemName, string>>;

export function elemTy(e: ElemName): Ty {
  return T[e];
}

export function elemSize(e: ElemName): number {
  switch (e) {
    case "u8":
    case "i8":
      return 1;
    case "u16":
    case "i16":
      return 2;
    case "u64":
    case "i64":
    case "f64":
      return 8;
    default:
      return 4;
  }
}

// --- typed tree

export interface Var {
  id: number;
  name: string;
  ty: Ty;
  boxed?: boolean; // captured by a closure, so it lives in memory on its owner's frame (SPEC 3.5, 4.3)
}

export interface GlobalDef {
  memory?: "leak" | "manual"; // its package's memory mode, when it isn't strict
  name: string;
  jsName: string;
  ty: Ty;
  mutable: boolean;
  value?: number | bigint | boolean | string; // scalars
  object?: StaticObject;
  array?: {
    elem: ElemName;
    length: number;
    bytes?: Uint8Array;
    values?: (number | bigint)[];
    text?: string;
  };
  table?: FuncInst[];
}

/** A top-level `new` or staticView: its bytes, worked out at compile time, with a generation prefix. */
export interface StaticObject {
  c: ClassInst;
  off: number; // the object's offset in the global, after its prefix
  total: number;
  align: number;
  bytes: Uint8Array; // the object, without the prefix
  relocs: { off: number; func?: FuncInst; obj?: GlobalDef }[];
}

export interface FuncInst {
  key: string;
  tirName: string;
  jsName: string;
  params: Var[];
  ret: Ty;
  exported: boolean;
  attrs: string[];
  body: Stmt[];
  // Native TSL only.
  memory?: "leak" | "manual"; // its package's memory mode, when it isn't strict (SPEC 3.5)
  at?: string; // where it's declared, for messages
  display?: string; // a name for messages
  isClosure?: boolean;
  captures?: Var[]; // what a closure's environment points at
  // Down-lowering (R3): a lifted closure, whose first parameter is its environment, of this flow class, holding these
  // captures, each keyed as its loads and stores' `fld` are, for class printing (an environment class, D62).
  cloEnv?: { node: unknown; caps: { key: string; name: string; sh: unknown }[] };
  moves?: number[]; // @tsl.moves parameters
  tailMoves?: number[]; // @tsl.tailed parameters: a moved object may be of a class with a tail (D69)
  owner?: ClassInst;
  ctorInits?: number; // a synthesised constructor: how many leading statements are field initialisers (SPEC 3.5)
  regionMark?: boolean; // R6: an export of a package with region placements: it gives back the per-call region at each return
}

export type TE = {
  ty: Ty;
  deps?: unknown[];
  range?: readonly [number, number];
  negz?: boolean; // down-lowering: JS may hold -0 here, which an integer register can't
  sh?: unknown; // down-lowering: the value's shape, which carries its heap node
  rcOwn?: Var; // `rc`: this is that local with an increment, which its last use can leave out
  rcFlat?: boolean; // `rc`: a block of count bookkeeping, whose temporaries' scope is the statement it's part of
  at?: string; // native TSL: the source position, for escape errors
  isNull?: boolean; // down-lowering: a nullish literal that's `null`, not `undefined`, which an `unknown` tells apart
  fld?: { node: unknown; name: string }; // down-lowering: the flow class and field a load or store is of, for printing (D62)
  grows?: boolean; // down-lowering: a vector's reserve whose new room is written before its length is (splice), for printing (R3)
  glob?: { name: string; sh: unknown }; // down-lowering: the module-state binding a load or store is of, for printing
  strop?: { op: string; args: TE[] }; // down-lowering: a string intrinsic of compiler/rt and its operands, for printing (D67)
} & TEK;

/** Whether a member access checks a generation: `tagged` only if the reference has one (SPEC 3.5). */
export type GenCheck = boolean | "tagged";

export type TEK =
  | { k: "err" }
  | { k: "lit"; value: number | bigint | boolean | string; undef?: true } // undef: `undefined`, not `null` (SPEC 3.3)
  | { k: "var"; v: Var }
  | { k: "global"; g: GlobalDef }
  | { k: "fnref"; inst: FuncInst }
  | { k: "tableget"; g: GlobalDef; idx: TE; loc: string }
  | { k: "index"; arr: TE; idx: TE; loc: string }
  | { k: "len"; arr: TE }
  | {
      k: "arith";
      op: "add" | "sub" | "mul" | "rem" | "idiv";
      a: TE;
      b: TE;
      wrap: boolean;
      loc: string;
    }
  | { k: "farith"; op: "add" | "sub" | "mul" | "div" | "rem"; a: TE; b: TE }
  | { k: "bigshift"; op: "shl" | "shr"; a: TE; b: TE; wrap: boolean; loc: string }
  | { k: "bit"; op: "and" | "or" | "xor" | "shl" | "shr" | "ushr"; a: TE; b: TE }
  | { k: "bitnot"; a: TE }
  | { k: "neg"; a: TE; loc: string }
  | { k: "not"; a: TE }
  | { k: "cmp"; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; a: TE; b: TE }
  | { k: "logic"; op: "and" | "or"; a: TE; b: TE }
  | { k: "cond"; c: TE; a: TE; b: TE }
  | { k: "setvar"; v: Var; val: TE; rc?: "assign" | "raw" } // rc: down-rc.ts's, for a counted local
  | { k: "setglobal"; g: GlobalDef; val: TE }
  | { k: "setindex"; arr: TE; idx: TE; val: TE; loc: string }
  | { k: "seq"; items: TE[]; result: TE }
  | { k: "call"; inst: FuncInst; args: TE[]; argAts?: string[] }
  | { k: "callind"; fn: TE; args: TE[] }
  | { k: "builtin"; name: string; args: TE[]; loc: string; text?: string; info?: BuiltinInfo }
  // Native TSL (SPEC 3.4, 3.5): class fields, stack `new`, closures, and a receiver's generation check.
  // inv: a field nothing writes after construction (3.4's "Class ids don't change", tslc's markInvariantFields), whose
  // load is invariant at -O1 and -O2 (D73)
  // sep: a separated field (R27, D77, separate.ts): a block no object can be in, which lowering notes for the optimiser
  | {
      k: "ofield";
      obj: TE;
      c: ClassInst;
      f: ClsField;
      check: GenCheck;
      loc: string;
      inv?: true;
      sep?: true;
    }
  | { k: "osetfield"; obj: TE; c: ClassInst; f: ClsField; val: TE; check: GenCheck; loc: string }
  | {
      k: "new";
      c: ClassInst;
      ctor: FuncInst | null;
      args: TE[];
      init: { f: ClsField; val: TE }[];
      into: { obj: TE; f: ClsField } | null; // an embedded field, built in place
      argAts: string[];
      // it escapes in a package with a memory mode: the mode's allocator (SPEC 3.5); or, in a lowered `leak` or `manual`
      // package, the per-call region, where nothing outlives the export call (R6, region.ts)
      heap?: "leak" | "manual" | "region";
      tail?: TE; // withTail(n, new T()): the tail's length, a usize (D69). Always on the heap
    }
  | { k: "closure"; inst: FuncInst }
  | { k: "chkref"; val: TE; check: GenCheck; loc: string }
  | { k: "record"; fields: { name: string; val: TE }[] }
  | { k: "ulit"; variant: Variant; tagText: string; fields: { name: string; val: TE }[] }
  | { k: "field"; obj: TE; name: string; variant?: Variant }
  | { k: "conv"; val: TE }
  // A nullable scalar (SPEC 3.3, rule 12): a[i] with no assertion, its test, and its narrowed payload.
  | { k: "optindex"; arr: TE; idx: TE }
  | { k: "isundef"; val: TE; negate: boolean }
  | { k: "optpayload"; val: TE }
  // The rest appear only in down-lowered code (SPEC 4.5).
  | { k: "tuple"; items: TE[] } // the items' leaves, in order
  | { k: "slice"; val: TE; from: number; to: number } // a range of a value's leaves
  | { k: "gaddr"; name: string; off?: number } // the address of a global, or of a place inside it
  | { k: "fload"; base: TE; mem: MemLeaf[] }
  // rc: `init`, a fresh slot with nothing to release; `move`, a count that moves with the value (down-rc.ts).
  | { k: "fstore"; base: TE; mem: MemLeaf[]; val: TE; rc?: "init" | "move" }
  | { k: "elemaddr"; base: TE; idx: TE; scale: number }
  | { k: "loadelem"; ptr: TE; idx: TE; elem: ElemName } // no bounds check: the caller has one
  | { k: "storeelem"; ptr: TE; idx: TE; elem: ElemName; val: TE }
  | {
      k: "alloc";
      size: TE;
      zero: boolean;
      stack: () => number | null;
      loc: string;
      long?: () => string | null; // memory modes: the runtime allocator, when it outlives the export call
      rcRefs?: () => { off: number; sh: unknown }[]; // `rc`, an environment: where its references are
    }
  | { k: "callclo"; clo: TE; args: TE[]; params: Ty[]; ret: Ty } // down-lowering: a closure value (SPEC 4.5)
  | { k: "rtcall"; name: string; args: TE[] }
  | { k: "intrinsic"; name: string; args: TE[] }
  | { k: "blockexpr"; body: Stmt[]; result: TE }
  | { k: "throwjs"; args: TE[]; msg: string; code: number; loc: string }
  | { k: "f2ix"; val: TE } // an f64 index as an ix; anything that isn't one is past every length
  | { k: "nonnull"; val: TE; loc: string } // the value's first leaf, trapping 6 if it is zero
  | { k: "trapnow"; kind: string; code: number; loc: string }
  // Down-lowered exceptions (SPEC 4.5, D49): a thrown value, an `unknown`. down-exc.ts turns it into stores and a jump,
  // with the check after every call that can throw, before `rc` or TIR sees the tree.
  | { k: "raise"; val: TE; loc: string };

/** One leaf of a value in memory. Offsets don't depend on the target: `ptr` and `ix` take 8 bytes. */
export interface MemLeaf {
  t: TirType;
  off: number;
  /** A class id (D50): written by construction only, so its load is invariant at -O1 and -O2 (D73). Loads only. */
  inv?: true;
}

/** What a native TSL builtin needs beyond its arguments. */
export interface BuiltinInfo {
  c?: ClassInst;
  elem?: ElemInfo;
  of?: Ty;
  shift?: number;
  n?: number;
  size?: number;
  fns?: FuncInst[]; // unsafe.releaseIndex: @tsl/gc's release functions, numbered from 1 (R1d)
}

export type Stmt =
  | { k: "let"; v: Var; init: TE | null; constant: boolean; at?: string }
  | { k: "using"; v: Var; dispose: TE | null }
  | { k: "expr"; e: TE }
  | { k: "if"; c: TE; a: Stmt[]; b: Stmt[] | null }
  | { k: "while"; c: TE; body: Stmt[] }
  | { k: "do"; body: Stmt[]; c: TE }
  | { k: "for"; init: Stmt[]; c: TE | null; step: TE[]; body: Stmt[] }
  | { k: "forof"; v: Var; arr: TE; body: Stmt[]; loc: string }
  | { k: "switch"; val: TE; clauses: { keys: TE[]; isDefault: boolean; body: Stmt[] }[] }
  | { k: "block"; body: Stmt[] }
  | { k: "label"; name: string; body: Stmt }
  | { k: "break"; label: string | null }
  | { k: "continue"; label: string | null }
  | { k: "return"; val: TE | null; at?: string }
  // Down-lowered only, and gone after down-exc.ts: `try`, its `catch` with or without a binding, and its `finally`.
  | {
      k: "try";
      body: Stmt[];
      cv: Var | null;
      cvSh?: unknown;
      handler: Stmt[] | null;
      fin: Stmt[] | null;
    };

export interface TypedModule {
  file: string; // repo-relative
  funcs: FuncInst[];
  globals: GlobalDef[];
  strings: Map<string, number>; // literal-union and tag text to its small integer
  nativeOnly?: boolean; // uses classes, closures or pointers, which only the native path carries so far
  // Down-lowering's additions: its globals, its runtime in TIR, and its fallback shims.
  extraGlobals?: Global[];
  extraFuncs?: Func[];
  extraTraps?: TrapSite[];
  externs?: Extern[];
  // A build whose strings are @tsl/jsrt's (D67, D70): where a native caller finds each string class's id, length and units.
  strLayout?: StrLayout;
  // R10: a lowered `rc` build whose strings are its own JsStr (emit-rcstr.ts): where a native caller finds a string's parts.
  rcStrLayout?: RcStrLayout;
  // R6: what tslc placed in the per-call region (region.ts), in a lowered `leak` or `manual` package.
  region?: {
    sites: number;
    heapSites: number;
    long: Set<string>;
    why: Map<string, string>;
    arenaBytes?: boolean; // R13: `strict`'s call arena, which an arena array takes bytes from wherever it is (region.ts)
  };
}

/**
 * D36's string ABI where strings are @tsl/jsrt's JsString (pipe-split), as the build lays the classes out: a string's class
 * id is the `u32` at p; a flat string's length is the `u32` at p + `flat.len` and its units start at p + `flat.units`; a
 * view's length is the `i32` at p + `view.len` and its units start at the address in the word at p + `view.addr`.
 */
export interface StrLayout {
  flat: { id: number; len: number; units: number };
  view: { id: number; len: number; addr: number };
}

/**
 * R10: D36's string ABI in a lowered `rc` build through the TSL route, where a string is the program's own `JsStr`
 * (emit-rcstr.ts), as tslc lays it out: its length is the `i32` at p + `len`; if the word at p + `buf` is null its units are
 * its own, from p + `units`, and otherwise they're its buffer's, from that buffer's address + `bufUnits` + 2 × the `i32` at
 * p + `start`.
 */
export interface RcStrLayout {
  len: number;
  start: number;
  buf: number;
  units: number;
  bufUnits: number;
}

/** A JSON description of a type, for the Wasm glue and for comparing results. */
export type Desc =
  | { k: "scalar"; name: string }
  | { k: "enum" }
  | { k: "strs" }
  | { k: "nums" }
  | { k: "arr"; elem: ElemName }
  | { k: "rec"; fields: { name: string; ty: Desc }[] }
  | {
      k: "union";
      tag: string;
      variants: {
        tag: boolean | string | number;
        leaf: number;
        fields: { name: string; ty: Desc; slots: number[] }[];
      }[];
      nslots: number;
      slotTypes: string[];
    }
  | { k: "fn" }
  | { k: "void" };

export function tagLeaf(tag: boolean | string | number, strings: Map<string, number>): number {
  if (typeof tag === "boolean") return tag ? 1 : 0;
  if (typeof tag === "number") return tag;
  return strings.get(tag)!;
}

export function describe(t: Ty, strings: Map<string, number>): Desc {
  switch (t.k) {
    case "int":
    case "big":
    case "float":
      return { k: "scalar", name: t.name };
    case "bool":
      return { k: "scalar", name: "bool" };
    case "enum":
      return { k: "enum" };
    case "lits":
      return t.kind === "str" ? { k: "strs" } : { k: "nums" };
    case "arr":
      return { k: "arr", elem: t.elem };
    case "rec":
      return {
        k: "rec",
        fields: t.fields.map((f) => ({ name: f.name, ty: describe(f.ty, strings) })),
      };
    case "union":
      return {
        k: "union",
        tag: t.tag,
        nslots: t.slots.length,
        slotTypes: t.slots,
        variants: t.variants.map((v) => ({
          tag: v.tag,
          leaf: tagLeaf(v.tag, strings),
          fields: v.fields.map((f) => ({
            name: f.name,
            ty: describe(f.ty, strings),
            slots: v.slots.get(f.name)!,
          })),
        })),
      };
    case "fn":
      return { k: "fn" };
    default:
      return { k: "void" };
  }
}
