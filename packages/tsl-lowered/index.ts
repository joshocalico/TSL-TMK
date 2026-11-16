// @tsl/lowered: the words down-lowered TSL needs and TSL proper doesn't have (SPEC 4.5, D62, design/pipeline.md). Only a
// package whose tsl.json says "lowered" may import this (TSL1023): `tmk lower --emit tsl` writes such a package, and nothing
// a person writes is one, so the kernel, drivers and every other TSL package can't reach any of it.
//
// Each function is lowered by tslc in place, to exactly one node of the typed tree that down-lowering has always produced,
// so nothing here is a new meaning: it's the existing lowering, given a spelling. Phase 1 of the pipeline keeps the memory
// layer this explicit (design/pipeline.md, "What TSL gains"): what an object is, where it lives and how it's counted is
// decided by the lowering, which is trusted exactly as much as the direct route to TIR was, and the next phases replace
// these loads and stores with TSL classes.
//
// On a JS engine each runs as its host simulation (SPEC 3.10, D71), as @tsl/unsafe's run there, so printed TSL runs on V8
// and JSC unchanged: `tmk milestone pipe-d`'s third route compares it with the source on V8 and with native. A type
// argument is erased on the host, so lowered memory is simulated as cells rather than bytes: a block per allocation, and
// in it each value stored at its offset as the JS value it is, which a load at that offset gives back. Every width the
// host has to know is said at run time (an element's name, a value's leaves), and what's never been stored reads as zero.
import { TslTrap, type bool, type f64, type usize } from "@tsl/core";

declare const refTag: unique symbol;
/** A pointer into lowered memory: an object, a vector, an environment, a counted block. 0 is null. 8 bytes. */
export type Ref = { readonly [refTag]: "ref" };

declare const optTag: unique symbol;
/** A nullable scalar in registers: a present flag, then the value (SPEC 3.3 rule 12, 4.5). */
export type Opt<T> = { readonly [optTag]: T };

/** A typed array's element, for a load or store with no bounds check of its own. */
export type Elem = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64" | "u64" | "i64";

/** Where an allocation goes: the module's call arena, or the memory mode's allocator, named. */
export type Allocator =
  | "__alloc"
  | "__leak_alloc"
  | "__heap_alloc"
  | "__rc_alloc"
  | "__rc_alloc_cyc"
  | (string & {});

// --- the host's simulation

/** A value of several leaves on the host (a typed array's pointer and length, a nullable scalar's flag and value). */
class Leaves {
  constructor(readonly leaves: unknown[]) {}
  /** A typed array's length is its second leaf: printed TSL reads `a.length` as TSL proper does. */
  get length(): number {
    return this.leaves[1] as number;
  }
}

interface Block {
  base: number;
  size: number;
  cells: Map<number, unknown>;
  elem?: Elem; // what its elements are, once one's been read or written as an element: for a view's `a[i]`
  ta?: TypedArray; // a typed array TSL proper made (`new Int32Array(4)`), whose elements are its storage
}

type TypedArray = { length: number; BYTES_PER_ELEMENT: number; [i: number]: number | bigint };
const isTypedArray = (v: unknown): v is TypedArray =>
  ArrayBuffer.isView(v) && !(v instanceof DataView);
const taAt = new WeakMap<object, number>();

/** A typed array's address: its own block, its elements its storage, made the first time printed TSL asks. */
function taAddr(ta: TypedArray): number {
  let at = taAt.get(ta);
  if (at === undefined) {
    at = block(ta.length * ta.BYTES_PER_ELEMENT);
    blocks[blocks.length - 1]!.ta = ta;
    taAt.set(ta, at);
  }
  return at;
}

// Blocks are made at rising addresses, so they're found by a binary search. Addresses start well above the null page, and
// a gap after each block keeps one block's end from being the next one's start.
const blocks: Block[] = [];
let next = 0x10_0000;

// The host's memory is the host's (3.10, divergence 4), but a process has a 3 GiB watchdog: past this many simulated bytes
// or stored values, the simulation runs out as a native page source does, trapping 14.
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_CELLS = 4_000_000;
let bytes = 0;
let cells = 0;

function block(size: number): number {
  // R9: an allocation that runs out takes nothing, as natively, so the next smaller one can still be made
  if (bytes + size > MAX_BYTES) throw new TslTrap(14);
  bytes += size;
  const base = next;
  blocks.push({ base, size, cells: new Map() });
  next += Math.ceil(Math.max(size, 1) / 16) * 16 + 16;
  return base;
}

function find(a: number): Block {
  if (a < 4096) throw new TslTrap(6); // natively a load or store near 0 is an unchecked null dereference (3.10)
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid]!;
    if (a < b.base) hi = mid - 1;
    else if (a > b.base + b.size) lo = mid + 1;
    else return b;
  }
  throw new Error(`@tsl/lowered on the host: no block at 0x${a.toString(16)}`);
}

function addrOf(r: unknown): number {
  if (typeof r === "number") return r;
  if (r instanceof Leaves) return r.leaves[0] as number;
  if (isTypedArray(r)) return taAddr(r);
  if (r === null || r === undefined) return 0;
  throw new Error(`@tsl/lowered on the host: ${String(r)} isn't an address`);
}

function read(a: number): unknown {
  const b = find(a);
  return b.cells.get(a - b.base) ?? 0;
}

function write(a: number, v: unknown): void {
  const b = find(a);
  setCell(b, a - b.base, v);
}

function setCell(b: Block, off: number, v: unknown): void {
  if (!b.cells.has(off) && ++cells > MAX_CELLS) throw new TslTrap(14);
  b.cells.set(off, v);
}

const ELEM_SIZE: Record<Elem, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  f64: 8,
  u64: 8,
  i64: 8,
};

/** A value as an element of this type holds it: what natively a store of that width keeps. */
function asElem(e: Elem, v: unknown): unknown {
  if (typeof v === "boolean") v = v ? 1 : 0;
  switch (e) {
    case "u8":
      return Number(v) & 0xff;
    case "i8":
      return (Number(v) << 24) >> 24;
    case "u16":
      return Number(v) & 0xffff;
    case "i16":
      return (Number(v) << 16) >> 16;
    case "u32":
      return Number(v) >>> 0;
    case "i32":
      return Number(v) | 0;
    case "f32":
      return Math.fround(Number(v));
    case "f64":
      return Number(v);
    case "u64":
      return BigInt.asUintN(64, typeof v === "bigint" ? v : BigInt(Number(v)));
    case "i64":
      return BigInt.asIntN(64, typeof v === "bigint" ? v : BigInt(Number(v)));
  }
}

function zeroOf(e: Elem): unknown {
  return e === "u64" || e === "i64" ? 0n : 0;
}

/** For tools/printed-exec.ts, which places a case's arguments and reads its results as a native caller does (D36). */
function readElem(ptr: number, i: number, e: Elem): unknown {
  const a = ptr + i * ELEM_SIZE[e];
  const b = find(a);
  if (b.ta !== undefined) return b.ta[(a - b.base) / b.ta.BYTES_PER_ELEMENT];
  b.elem ??= e;
  return b.cells.get(a - b.base) ?? zeroOf(e);
}

function writeElem(ptr: number, i: number, e: Elem, v: unknown): void {
  const a = ptr + i * ELEM_SIZE[e];
  const b = find(a);
  if (b.ta !== undefined) {
    const k = (a - b.base) / b.ta.BYTES_PER_ELEMENT;
    b.ta[k] = (typeof b.ta[0] === "bigint" ? asElem(e, v) : Number(asElem(e, v))) as number;
    return;
  }
  b.elem ??= e;
  setCell(b, a - b.base, asElem(e, v));
}

/**
 * A typed array printed TSL made from a pointer and a length (`pack<Int32Array>(alloc(…), n)`): TSL proper reads it as one
 * (`a.length`, `a[i]!`), and its elements are the block's, read and written as the block's elements are.
 */
function view(ptr: number, len: number): Leaves {
  const b = find(ptr);
  if (b.ta !== undefined && ptr === b.base && len === b.ta.length) return b.ta as unknown as Leaves;
  const v = new Leaves([ptr, len]);
  return new Proxy(v, {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) {
        const i = Number(k);
        if (i >= len) return undefined;
        // R9: a view into a typed array TSL proper made (a layout class's array, `subarray` of one) is that array's
        if (b.ta !== undefined) return b.ta[(ptr - b.base) / b.ta.BYTES_PER_ELEMENT + i];
        return b.elem !== undefined
          ? readElem(ptr, i, b.elem)
          : (b.cells.get(ptr - b.base + i) ?? 0);
      }
      return Reflect.get(t, k, r) as unknown;
    },
    set(t, k, x, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) {
        const i = Number(k);
        if (i < len && b.ta !== undefined) {
          const at = (ptr - b.base) / b.ta.BYTES_PER_ELEMENT + i;
          b.ta[at] = (typeof b.ta[0] === "bigint" ? BigInt(x as number) : x) as number;
        } else if (i < len) writeElem(ptr, i, b.elem ?? "f64", x);
        return true;
      }
      return Reflect.set(t, k, x, r);
    },
  });
}

/** A literal-union string's id to its text, as the build's DownMeta gives it: a native caller's table (D36). */
const literalText = new Map<number, string>();

export const hostLowered = {
  setStrings: (t: Record<string, number>): void => {
    for (const [s, n] of Object.entries(t)) literalText.set(n, s);
  },
  block,
  read,
  write,
  readElem,
  writeElem,
  leaves: (v: unknown): unknown[] => leavesOf(v),
  pack: (...parts: unknown[]): unknown => packLeaves(parts),
  addrOf,
  isThrow: (e: unknown): e is LoweredThrow => e instanceof LoweredThrow,
};

/** A down-lowered `throw` where nothing catches (4.5): its code, its constructor's name and its message's text. */
export class LoweredThrow extends Error {
  constructor(
    readonly code: number,
    readonly ctor: string,
    readonly text: string,
  ) {
    super(text);
  }
}

// The lowering's runtime functions on the host: the call arena and the vectors of compiler/host/down-rt.ts, whose header
// is the data pointer at 0, the length at 8 and the capacity at 16.
const RUNTIME: Record<string, (...a: unknown[]) => unknown> = {
  __arena_start: () => undefined,
  __arena_commit: () => undefined,
};
for (const suffix of ["", "_leak", "_heap", "_heapk"]) {
  RUNTIME[`__vec_new${suffix}`] = (len, slot) => {
    const n = Number(len);
    const cap = n < 4 ? 4 : n;
    const h = block(24);
    write(h, block(cap * Number(slot)));
    write(h + 8, n);
    write(h + 16, cap);
    return h;
  };
  RUNTIME[`__vec_reserve${suffix}`] = (v, need, slot) => {
    const h = addrOf(v);
    const cap = Number(read(h + 16));
    if (Number(need) <= cap) return undefined;
    const ncap = Math.max(cap * 2, Number(need));
    const d = block(ncap * Number(slot));
    copy(d, addrOf(read(h)), Number(read(h + 8)) * Number(slot));
    write(h, d);
    write(h + 16, ncap);
    return undefined;
  };
  RUNTIME[`__vec_setlen${suffix}`] = (v, len) => {
    write(addrOf(v) + 8, Number(len));
    return undefined;
  };
}

/** `mem.copy`: the cells of `n` bytes from `src` to `dst`, as a memmove; a typed array's by its bytes. */
function copy(dst: number, src: number, n: number): void {
  if (n <= 0) return;
  const s = find(src);
  const d = find(dst);
  if (s.ta !== undefined || d.ta !== undefined) {
    const bytesOf = (b: Block): Uint8Array | null =>
      b.ta === undefined
        ? null
        : new Uint8Array(
            (b.ta as unknown as Uint8Array).buffer,
            (b.ta as unknown as Uint8Array).byteOffset,
            b.size,
          );
    const sb = bytesOf(s);
    const db = bytesOf(d);
    if (sb !== null && db !== null) {
      db.set(sb.slice(src - s.base, src - s.base + n), dst - d.base);
      return;
    }
    // Between a typed array and cells: element by element, at the typed array's width.
    const w = (s.ta ?? d.ta)!.BYTES_PER_ELEMENT;
    const e = (s.elem ??
      d.elem ??
      ({ 1: "u8", 2: "u16", 4: "i32", 8: "f64" } as Record<number, Elem>)[w])!;
    const vals: unknown[] = [];
    for (let i = 0; i < n / w; i++) vals.push(readElem(src, i, e));
    vals.forEach((v, i) => writeElem(dst, i, e, v));
    return;
  }
  const moved: [number, unknown][] = [];
  for (const [off, v] of s.cells) {
    const a = s.base + off;
    if (a >= src && a < src + n) moved.push([a - src, v]);
  }
  d.elem ??= s.elem; // what's copied keeps its elements' type, for a view's `a[i]`
  const gone: number[] = [];
  for (const off of d.cells.keys())
    if (d.base + off >= dst && d.base + off < dst + n) gone.push(off);
  for (const off of gone) d.cells.delete(off);
  for (const [rel, v] of moved) setCell(d, dst + rel - d.base, v);
}

function f64Words(x: number): [number, number] {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x, true);
  return [v.getInt32(4, true), v.getInt32(0, true)];
}

const INTRINSICS: Record<string, (...a: unknown[]) => unknown> = {
  "mem.copy": (d, s, n) => copy(addrOf(d), addrOf(s), Number(n)),
  // The stack pointer, against the lowest the program allows (D49): the host's stack is V8's, which throws its own
  // RangeError past its limit (3.10, divergence 14), so this is never below it.
  "native.sp": () => Number.MAX_SAFE_INTEGER,
  "math.sin": (x) => Math.sin(Number(x)),
  "math.cos": (x) => Math.cos(Number(x)),
  "math.tan": (x) => Math.tan(Number(x)),
  "math.exp": (x) => Math.exp(Number(x)),
  "math.log": (x) => Math.log(Number(x)),
  "math.atan2": (y, x) => Math.atan2(Number(y), Number(x)),
  "math.pow": (x, y) => Math.pow(Number(x), Number(y)),
};

const BUILTINS: Record<string, (...a: unknown[]) => unknown> = {
  assert: (c, code) => {
    if (c === false || c === 0) throw new TslTrap(Number(code));
    return undefined;
  },
  "fptosi.sat": (x) => {
    const v = Number(x);
    if (Number.isNaN(v)) return 0;
    return Math.trunc(Math.min(Math.max(v, -2147483648), 2147483647));
  },
  toI32: (x) => {
    const v = Number(x);
    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new TslTrap(4);
    return v;
  },
  wrapI32: (x) => Number(x) | 0,
  "tmk.f64hi": (x) => f64Words(Number(x))[0],
  "tmk.f64lo": (x) => f64Words(Number(x))[1],
  "tmk.f64make": (hi, lo) => {
    const v = new DataView(new ArrayBuffer(8));
    v.setInt32(4, Number(hi), true);
    v.setInt32(0, Number(lo), true);
    return v.getFloat64(0, true);
  },
  "tmk.ptrdiff": (a, b) => addrOf(a) - addrOf(b),
  "tmk.addrlo": (a) => addrOf(a) | 0,
};
for (const m of [
  "abs",
  "clz32",
  "fround",
  "imul",
  "max",
  "min",
  "round",
  "floor",
  "ceil",
  "trunc",
  "sqrt",
  "sign",
])
  BUILTINS[`Math.${m}`] = (...a) =>
    (Math as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!(...a);

function named(table: Record<string, (...a: unknown[]) => unknown>, what: string, name: string) {
  const f = table[name];
  if (f === undefined)
    throw new Error(`@tsl/lowered on the host: no simulation of the ${what} ${name}`);
  return f;
}

// Static data with the layout the lowering gives it (D42, compiler/host/down.ts's strFlat): a 16-byte counted header, then
// a flat string's length at 0, its hash word at 4, its units' offset at 8 and its UTF-16 units from 16.
function flat(at: number, s: string): void {
  write(at + 8, 0x40000000);
  write(at + 16, s.length);
  write(at + 24, 16);
  for (let i = 0; i < s.length; i++) write(at + 32 + i * 2, s.charCodeAt(i));
}

// --- the functions

/** A call to the lowering's runtime (compiler/host/down-rt.ts), by its symbol. */
export function rt<R = void>(name: string, ...args: unknown[]): R {
  return named(RUNTIME, "runtime function", name)(...args) as R;
}

/** A TIR intrinsic, by name: `mem.copy`, `math.pow`. */
export function intrinsic<R = void>(name: string, ...args: unknown[]): R {
  return named(INTRINSICS, "intrinsic", name)(...args) as R;
}

/** A builtin of the typed tree that TSL proper spells differently or not at all, such as `fptosi.sat`. */
export function builtin<R = void>(name: string, ...args: unknown[]): R {
  return named(BUILTINS, "builtin", name)(...args) as R;
}

/** The value of type T at `base + off`, laid out as lowering lays a field out (down-model.ts, memOf). */
export function load<T>(base: Ref, off: number, _invariant?: "invariant"): T {
  return read(addrOf(base) + off) as T;
}

/** Stores v at `base + off` and gives it back. `init`: a fresh slot; `move`: the count moves with the value (rc). */
export function store<T>(base: Ref, off: number, v: T, _rc?: "init" | "move"): T {
  write(addrOf(base) + off, v);
  return v;
}

/** A frame slot of `bytes`, zeroed if asked: an allocation lowering proved doesn't outlive its function. */
export function allocStack(bytes: number, _zero: boolean, size?: usize): Ref {
  return block(size ?? bytes) as unknown as Ref;
}

/** `size` bytes from an allocator, zeroed if asked. */
export function alloc(size: usize, _zero: boolean, _allocator: Allocator): Ref {
  return block(Number(size)) as unknown as Ref;
}

/** `base + idx * scale`. */
export function elemAddr(base: Ref, idx: usize, scale: number): Ref {
  return (addrOf(base) + Number(idx) * scale) as unknown as Ref;
}

// A test's injected mistake (`tmk milestone pipe-d` box 17): the host simulation named gives a wrong value, which the
// differential's third route has to catch. Nothing sets it otherwise.
const FAULT = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.TMK_TEST_LOWERED_HOST;

/** An element, with no bounds check: the lowering has one before it. */
export function loadElem<T>(ptr: Ref, idx: usize, elem: Elem): T {
  const v = readElem(addrOf(ptr), Number(idx), elem);
  if (FAULT === "loadElem" && typeof v === "number") return (v + 1) as T;
  return v as T;
}

export function storeElem<T>(ptr: Ref, idx: usize, elem: Elem, v: T): T {
  writeElem(addrOf(ptr), Number(idx), elem, v);
  return v;
}

/** A module-level block of `size` bytes: lowered module state. Declared with a top-level const, its symbol given where it isn't the const's name. */
export function data(size: number, _symbol?: string): Ref {
  return block(size) as unknown as Ref;
}

/** A string literal's static data, laid out as the lowering lays it out (D42): declared with a top-level const. */
export function text(s: string, _symbol?: string): Ref {
  const at = block(32 + Math.max(1, s.length) * 2);
  flat(at, s);
  return at as unknown as Ref;
}

/** The static one-unit strings below 256. */
export function charTable(_symbol?: string): Ref {
  const at = block(256 * 48);
  for (let u = 0; u < 256; u++) flat(at + u * 48, String.fromCharCode(u));
  return at as unknown as Ref;
}

/** The hash key's default (4.5). */
export function hashKey(_symbol?: string): Ref {
  const at = block(8);
  write(at, 0x243f6a88 | 0);
  write(at + 4, 0x85a308d3 | 0);
  return at as unknown as Ref;
}

const globals = new Map<string, number>();

/** The address of a module-level block or a runtime global, plus `off`. */
export function addr(g: Ref | string, off?: number): Ref {
  let at: number;
  if (typeof g === "string") {
    at = globals.get(g) ?? block(64);
    globals.set(g, at);
  } else at = addrOf(g);
  return (at + (off ?? 0)) as unknown as Ref;
}

/** The null reference. */
export function nullRef(): Ref {
  return 0 as unknown as Ref;
}

/** An f64 used as an index: itself if it's a whole number below 2^32, and past every length if it isn't. */
export function f2ix(x: f64): usize {
  return (Number.isInteger(x) && x >= 0 && x < 4294967296 ? x : 4294967295) as usize;
}

/** The value, trapping 6 if its first leaf is zero. */
export function nonNull<T>(v: T): T {
  const first = v instanceof Leaves ? v.leaves[0] : v;
  if (first === 0 || first === 0n || first === null || first === undefined || first === false)
    throw new TslTrap(6);
  return v;
}

/** Where control can't reach, said for tsc's sake: a function that can't fall off its end. Nothing natively. */
export function unreachable(): never {
  throw new Error("@tsl/lowered on the host: reached what the lowering said can't be");
}

/** A trap here, with this kind and code. */
export function trapNow(_kind: string, code: number): never {
  throw new TslTrap(code);
}

/** A string on the host, from what printed TSL holds: lowered string data (D42) or a JsString (D67). */
function textOf(v: unknown): string {
  if (v !== null && typeof v === "object" && "len" in v && "unit" in v) {
    const s = v as { len(): number; unit(i: number): number };
    let out = "";
    for (let i = 0; i < s.len(); i++) out += String.fromCharCode(s.unit(i));
    return out;
  }
  const p = addrOf(v);
  if (p === 0) return "null";
  const n = Number(read(p));
  const at = p + Number(read(p + 8));
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(Number(read(at + i * 2)));
  return out;
}

/** `throw` where nothing can catch: trap `code`, whose message is `msg`, with these parts captured for it (SPEC 4.5). */
export function throwJs(code: number, msg: string, ...parts: unknown[]): never {
  const m = JSON.parse(msg) as { ctor: string; parts: (string | { a: number; k: string })[] };
  let s = "";
  for (const p of m.parts) {
    if (typeof p === "string") s += p;
    else {
      const v = parts[p.a];
      s +=
        p.k === "s"
          ? textOf(v)
          : p.k === "bool"
            ? String(v !== 0 && v !== false)
            : p.k === "str"
              ? (literalText.get(Number(v)) ?? String(v))
              : String(v);
    }
  }
  throw new LoweredThrow(code, m.ctor, s);
}

/** `a + b`, `a - b` or `a * b` with no overflow check: a range the lowering proved, or JS's own wrap under a bit operation. */
export function wrap<T>(arith: T): T {
  return arith;
}

/** A value's leaves: a typed array's are its address and its length. */
function leavesOf(v: unknown): unknown[] {
  if (v instanceof Leaves) return v.leaves;
  if (isTypedArray(v)) return [taAddr(v), v.length];
  return [v];
}

function packLeaves(parts: unknown[]): Leaves {
  const l = parts.flatMap(leavesOf);
  // A pointer into lowered memory and a length: a typed array, which TSL proper indexes.
  if (l.length === 2 && typeof l[0] === "number" && l[0] >= 0x10_0000)
    return view(l[0], Number(l[1]));
  return new Leaves(l);
}

/** A value of type T made of these values' leaves, in order: a typed array from a pointer and a length. */
export function pack<T>(...parts: unknown[]): T {
  return packLeaves(parts) as T;
}

/** Leaves `from` to `to` of a value, as a value of type T: a typed array's pointer. */
export function part<T>(v: unknown, from: number, to: number): T {
  const l = leavesOf(v);
  if (to - from === 1) return (l[from] ?? 0) as T;
  return new Leaves(l.slice(from, to)) as T;
}

/**
 * A change of representation the lowering proved exact: an index known to be non-negative as a usize. A conversion between
 * integer types names its target for the host (`cast<usize>(i, "usize")`), as JS has one kind of number: a negative
 * `i32` as a `usize` is past every length, natively and here.
 */
export function cast<T>(v: unknown, to?: string): T {
  if (to === undefined) return v as T;
  switch (to) {
    case "i32":
      return (typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : Number(v) | 0) as T;
    case "u32":
      return (typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : Number(v) >>> 0) as T;
    case "i8":
    case "u8":
    case "i16":
    case "u16":
      return asElem(to, v) as T;
    case "usize": {
      const n = typeof v === "bigint" ? Number(BigInt.asUintN(64, v)) : Number(v);
      return (n < 0 ? n + 18446744073709551616 : n) as T;
    }
    case "opt":
      // A nullable scalar from TSL proper (`V | undefined`, D72), as the lowering holds one: a flag and a value.
      return (v === undefined ? new Leaves([0, 0]) : new Leaves([1, v])) as T;
    case "u64":
      return BigInt.asUintN(64, typeof v === "bigint" ? v : BigInt(Number(v))) as T;
    case "i64":
      return BigInt.asIntN(64, typeof v === "bigint" ? v : BigInt(Number(v))) as T;
    default:
      return (typeof v === "bigint" ? Number(v) : v) as T;
  }
}

/** Whether a nullable scalar is absent, or, negated, present. */
export function isUndef(v: Opt<unknown>, negate: boolean): bool {
  const flag = v instanceof Leaves ? v.leaves[0] : v;
  const absent = flag === 0 || flag === false || flag === undefined;
  return negate ? !absent : absent;
}

/** A nullable scalar's value, once it's known to be there. */
export function optPayload<T>(v: Opt<T>): T {
  return (v instanceof Leaves ? v.leaves[1] : 0) as T;
}
