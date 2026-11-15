// @tsl/core: flavoured numeric types and the host runtime (SPEC Appendix A): traps, conversions, value
// results, layout helpers, arenas, and the host's stand-ins for MMIO descriptors and atomics.
declare const flavor: unique symbol;
export type Num<B extends string> = number & { readonly [flavor]?: B };
export type Int<B extends string> = Num<B>;
export type Big<B extends string> = bigint & { readonly [flavor]?: B };
// A flavour lists everything that widens to it, so u8 assigns to u32 and the reverse is a tsc error.
export type i8 = Num<"i8">;
export type i16 = Num<"i8" | "i16" | "u8">;
export type i32 = Num<"i8" | "i16" | "i32" | "u8" | "u16">;
export type isize = Num<"i8" | "i16" | "i32" | "isize" | "u8" | "u16" | "u32">;
export type u8 = Num<"u8">;
export type u16 = Num<"u8" | "u16">;
export type u32 = Num<"u8" | "u16" | "u32">;
export type usize = Num<"u8" | "u16" | "u32" | "usize">;
export type f32 = Num<"f32">;
export type f64 = Num<"f32" | "f64">;
export type i64 = Big<"i64">;
export type u64 = Big<"u64">;
export type bool = boolean;

// The ES lib has no console or TextEncoder, and TSL programs must not see them either.
declare const console: { log(s: string): void; error(s: string): void };
declare class TextEncoder {
  encode(s: string): Uint8Array;
}

export class TslTrap extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`trap ${code}`);
    this.code = code;
  }
}

/**
 * The trap codes of SPEC 3.10's table, by name (D71). A code given to `trap` or `trapNow` is named, never a bare number
 * (TSL1026): these for the table's, and a program's own enum or constant for its codes, from 1000. tslc reads it as a
 * numeric enum, whose members are constants. It's spelt as a constant object and a type, not `enum`, because Node's type
 * stripping loads @tsl/core without tools/ts-hook.mjs where the Wasm glue and checked JS import it, and it rejects `enum`.
 */
export const Trap = {
  Overflow: 1,
  Bounds: 2,
  DivZero: 3,
  Conversion: 4,
  Stale: 5,
  Null: 6,
  Assert: 7,
  ShiftCount: 8,
  Misaligned: 9,
  Panic: 10,
  NoAddress: 11,
  NoStub: 12,
  Loan: 13,
  OutOfMemory: 14,
  Hole: 15,
  RcCheck: 16,
  BadCast: 17,
  Dispatch: 18,
} as const;
export type Trap = (typeof Trap)[keyof typeof Trap];

export function trap(code: Trap | u32): never {
  throw new TslTrap(code);
}
export function assert(cond: bool, code: Trap | u32): void {
  if (!cond) throw new TslTrap(code);
}
export function panic(msg: string): never {
  console.error(msg);
  throw new TslTrap(10);
}
export function log(msg: string): void {
  console.log(msg);
}

const MAX_USIZE = 9007199254740991;

function checked(x: number | bigint, lo: number, hi: number): number {
  if (typeof x === "bigint") {
    if (x < BigInt(lo) || x > BigInt(hi)) throw new TslTrap(4);
    return Number(x);
  }
  if (!Number.isInteger(x) || x < lo || x > hi) throw new TslTrap(4);
  return x;
}
function checkedBig(x: number | bigint, lo: bigint, hi: bigint): bigint {
  if (typeof x === "number" && !Number.isInteger(x)) throw new TslTrap(4);
  const b = BigInt(x);
  if (b < lo || b > hi) throw new TslTrap(4);
  return b;
}

export const toI8 = (x: number | bigint): i8 => checked(x, -128, 127);
export const toI16 = (x: number | bigint): i16 => checked(x, -32768, 32767);
export const toI32 = (x: number | bigint): i32 => checked(x, -2147483648, 2147483647);
export const toU8 = (x: number | bigint): u8 => checked(x, 0, 255);
export const toU16 = (x: number | bigint): u16 => checked(x, 0, 65535);
export const toU32 = (x: number | bigint): u32 => checked(x, 0, 4294967295);
export const toUsize = (x: number | bigint): usize => checked(x, 0, MAX_USIZE);
export const toU64 = (x: number | bigint): u64 => checkedBig(x, 0n, 18446744073709551615n);
export const toI64 = (x: number | bigint): i64 =>
  checkedBig(x, -9223372036854775808n, 9223372036854775807n);
/** Adds zero so that an integer -0, which V8 can produce and a register can't, becomes +0. */
export const toF64 = (x: number): f64 => x + 0;

export const wrapI8 = (x: number | bigint): i8 =>
  typeof x === "bigint" ? Number(BigInt.asIntN(8, x)) : (x << 24) >> 24;
export const wrapI16 = (x: number | bigint): i16 =>
  typeof x === "bigint" ? Number(BigInt.asIntN(16, x)) : (x << 16) >> 16;
export const wrapI32 = (x: number | bigint): i32 =>
  typeof x === "bigint" ? Number(BigInt.asIntN(32, x)) : x | 0;
export const wrapU8 = (x: number | bigint): u8 =>
  typeof x === "bigint" ? Number(BigInt.asUintN(8, x)) : x & 0xff;
export const wrapU16 = (x: number | bigint): u16 =>
  typeof x === "bigint" ? Number(BigInt.asUintN(16, x)) : x & 0xffff;
export const wrapU32 = (x: number | bigint): u32 =>
  typeof x === "bigint" ? Number(BigInt.asUintN(32, x)) : x >>> 0;

/**
 * Exact for all ranges (uses BigInt when |a| >= 2^31). Traps on b = 0. MIN / -1 depends on T, which
 * doesn't exist at run time, so tslc and js-checked catch it and the host keeps going (3.10, item 1).
 */
export function idiv<T extends number>(a: T, b: T): T {
  if (b === 0) throw new TslTrap(3);
  if (Math.abs(a) < 2147483648) return Math.trunc(a / b) as T;
  return Number(BigInt(a) / BigInt(b)) as T;
}

export function lit(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// --- layout helpers (SPEC 3.4): each name is a type above and a value here. The host reads a class's
// layout by making one instance in capture mode, where a helper returns a marker saying what it is.
// tslc reads the same initialisers at compile time, and the corpus checks that the two agree.
type Width = 1 | 2 | 4 | 8;
export type ScalarDesc = {
  k: "num" | "big";
  size: Width;
  signed: boolean;
  be: boolean;
  float: boolean;
};
type FieldKind =
  | ScalarDesc
  | { k: "bits"; size: Width; be: boolean; fields: Record<string, number> }
  | {
      k: "enum";
      size: Width;
      signed: boolean;
      be: boolean;
      members: Record<string, string | number>;
    }
  | { k: "array"; elem: ScalarDesc; length: number }
  | { k: "nested"; cls: LayoutClass }
  | { k: "nestedArray"; cls: LayoutClass; length: number }
  | { k: "pad"; size: number };
type LayoutClass<T = object> = (new () => T) & { name: string };

class FieldMark {
  readonly kind: FieldKind;
  constructor(kind: FieldKind) {
    this.kind = kind;
  }
}

let capturing = false;

function mark<T>(kind: FieldKind, zero: () => T): T {
  return capturing ? (new FieldMark(kind) as T) : zero();
}

export type Scalar<T> = (() => T) & { readonly desc: unknown };

function scalar<T>(size: Width, flags: Partial<ScalarDesc>, zero: T): Scalar<T> {
  const desc: ScalarDesc = {
    k: typeof zero === "bigint" ? "big" : "num",
    size,
    signed: false,
    be: false,
    float: false,
    ...flags,
  };
  return Object.assign(() => mark(desc, () => zero), { desc });
}

export const u8: Scalar<u8> = scalar<u8>(1, {}, 0);
export const u16: Scalar<u16> = scalar<u16>(2, {}, 0);
export const u32: Scalar<u32> = scalar<u32>(4, {}, 0);
export const u64: Scalar<u64> = scalar<u64>(8, {}, 0n);
export const i8: Scalar<i8> = scalar<i8>(1, { signed: true }, 0);
export const i16: Scalar<i16> = scalar<i16>(2, { signed: true }, 0);
export const i32: Scalar<i32> = scalar<i32>(4, { signed: true }, 0);
export const i64: Scalar<i64> = scalar<i64>(8, { signed: true }, 0n);
export const f32: Scalar<f32> = scalar<f32>(4, { float: true }, 0);
export const f64: Scalar<f64> = scalar<f64>(8, { float: true }, 0);
export const be16: Scalar<u16> = scalar<u16>(2, { be: true }, 0);
export const be32: Scalar<u32> = scalar<u32>(4, { be: true }, 0);
export const be64: Scalar<u64> = scalar<u64>(8, { be: true }, 0n);

function descOf(s: Scalar<unknown>): ScalarDesc {
  return s.desc as ScalarDesc;
}

export function pad(size: number): never {
  return mark<never>({ k: "pad", size }, () => undefined as never);
}

/** Reads and writes bits within a container, masked as they are natively. */
function bitAccessors(
  fields: Record<string, number>,
  read: () => number,
  write: (x: number) => void,
): object {
  const out = {};
  let shift = 0;
  for (const [name, n] of Object.entries(fields)) {
    const at = shift;
    const mask = n === 32 ? 0xffffffff : 2 ** n - 1;
    shift += n;
    Object.defineProperty(out, name, {
      enumerable: true,
      get: () => {
        const x = Math.floor(read() / 2 ** at) % (mask + 1);
        return n === 1 ? x === 1 : x;
      },
      set: (v: number | boolean) => {
        const cur = read();
        const old = Math.floor(cur / 2 ** at) % (mask + 1);
        const next = Number(v) % (mask + 1);
        write(cur + (next - old) * 2 ** at);
      },
    });
  }
  return out;
}

export function bits<const M extends Record<string, number>>(
  w: Scalar<number>,
  m: M,
): { -readonly [K in keyof M]: M[K] extends 1 ? boolean : number } {
  const d = descOf(w);
  return mark({ k: "bits", size: d.size, be: d.be, fields: m }, () => {
    let word = 0;
    return bitAccessors(
      m,
      () => word,
      (x) => {
        word = x;
      },
    ) as never;
  });
}

export function enumOf<E extends Record<string, string | number>>(
  w: Scalar<number>,
  e: E,
): E[keyof E] {
  const d = descOf(w);
  // A new object is zeroed, like every other: a zero that's not a member traps natively (3.10, item 1).
  return mark(
    { k: "enum", size: d.size, signed: d.signed, be: d.be, members: e },
    () => 0 as E[keyof E],
  );
}

export function enumValue<E extends Record<string, string | number>>(
  e: E,
  x: number,
): E[keyof E] | null {
  return typeof e[x] === "string" ? (x as E[keyof E]) : null;
}

export type ArrayOf<T> = [T] extends [u8]
  ? Uint8Array
  : [T] extends [i8]
    ? Int8Array
    : [T] extends [u16]
      ? Uint16Array
      : [T] extends [i16]
        ? Int16Array
        : [T] extends [u32]
          ? Uint32Array
          : [T] extends [u64]
            ? BigUint64Array
            : [T] extends [i64]
              ? BigInt64Array
              : [T] extends [i32]
                ? Int32Array
                : [T] extends [f32]
                  ? Float32Array
                  : [T] extends [f64]
                    ? Float64Array
                    : never;

type ArrayCtor = new (
  a: number | ArrayBuffer,
  off?: number,
  len?: number,
) => ArrayBufferView & { length: number };

/** The typed array for a scalar. Used by @tsl/unsafe's slices too. */
export function arrayCtorOf(d: ScalarDesc): ArrayCtor {
  const pick = (): unknown => {
    if (d.k === "big") return d.signed ? BigInt64Array : BigUint64Array;
    if (d.float) return d.size === 4 ? Float32Array : Float64Array;
    if (d.signed) return d.size === 1 ? Int8Array : d.size === 2 ? Int16Array : Int32Array;
    return d.size === 1 ? Uint8Array : d.size === 2 ? Uint16Array : Uint32Array;
  };
  return pick() as ArrayCtor;
}

export function array<T>(elem: Scalar<T>, length: number): ArrayOf<T> {
  const d = descOf(elem);
  return mark({ k: "array", elem: d, length }, () => new (arrayCtorOf(d))(length) as ArrayOf<T>);
}

// --- tails (SPEC 3.4, D69): a plain class's last field may be `units = tail(u16)`, a variable-length array of scalars sized
// when the object is made, by `withTail(n, new T(…))`. On the host the tail is a typed array the object holds, empty until
// withTail gives it its length; the program can't tell, as nothing but withTail and placeTail ever makes one of a class with
// a tail, and its constructor can't read it (TSL3012). @tsl/unsafe swaps in a maker that puts tails in simulated memory, so
// tailAddr has an address to give.
const tailMarks = new WeakSet<object>();
const tailOf = new WeakMap<object, { name: string; desc: ScalarDesc }>();
type TailMaker = (desc: ScalarDesc, n: number) => ArrayBufferView & { length: number };
let tailMaker: TailMaker = (desc, n) => new (arrayCtorOf(desc))(n);

/** @tsl/unsafe's hook: where a tail's elements live on the host. */
export function hostSetTailMaker(f: TailMaker): void {
  tailMaker = f;
}

export function tail<T>(elem: Scalar<T>): ArrayOf<T> {
  const d = descOf(elem);
  const a = new (arrayCtorOf(d))(0);
  tailMarks.add(a);
  return a as unknown as ArrayOf<T>;
}

/** Gives a just-made object of a class with a tail its tail of n elements, zeroed (D69). */
export function hostAttachTail<T extends object>(n: number | bigint, o: T): T {
  const len = Number(n);
  if (!Number.isInteger(len) || len < 0 || len > 0xffffffff) throw new TslTrap(14);
  const rec = o as Record<string, unknown>;
  for (const name of Object.keys(rec)) {
    const v = rec[name];
    if (typeof v === "object" && v !== null && tailMarks.has(v)) {
      const desc = descOfArray(v as ArrayBufferView);
      const a = tailMaker(desc, len);
      Object.defineProperty(rec, name, {
        value: a,
        writable: false,
        enumerable: true,
        configurable: true,
      });
      tailOf.set(o, { name, desc });
      return o;
    }
  }
  throw new TypeError("withTail takes a new of a class with a tail (TSL3012)");
}

/** The tail an object of a class with a tail holds, for @tsl/unsafe. */
export function hostTailOf(o: object): (ArrayBufferView & { length: number }) | undefined {
  const t = tailOf.get(o);
  return t === undefined
    ? undefined
    : ((o as Record<string, unknown>)[t.name] as ArrayBufferView & { length: number });
}

function descOfArray(a: ArrayBufferView): ScalarDesc {
  const by: [unknown, ScalarDesc][] = [
    [Uint8Array, { k: "num", size: 1, signed: false, be: false, float: false }],
    [Int8Array, { k: "num", size: 1, signed: true, be: false, float: false }],
    [Uint16Array, { k: "num", size: 2, signed: false, be: false, float: false }],
    [Int16Array, { k: "num", size: 2, signed: true, be: false, float: false }],
    [Uint32Array, { k: "num", size: 4, signed: false, be: false, float: false }],
    [Int32Array, { k: "num", size: 4, signed: true, be: false, float: false }],
    [Float32Array, { k: "num", size: 4, signed: false, be: false, float: true }],
    [Float64Array, { k: "num", size: 8, signed: false, be: false, float: true }],
    [BigUint64Array, { k: "big", size: 8, signed: false, be: false, float: false }],
    [BigInt64Array, { k: "big", size: 8, signed: true, be: false, float: false }],
  ];
  for (const [c, d] of by) if (a instanceof (c as new () => object)) return d;
  throw new TypeError("not a tail");
}

/** `withTail(n, new T(…))`: a T whose tail has n elements, all zero, made on the heap at its real size (D69). */
export function withTail<T extends object>(n: usize, o: T): T {
  return hostAttachTail(n, o);
}

export interface LayoutArray<T> {
  readonly length: usize;
  at(i: usize): T;
}

export function nested<T>(cls: new () => T): T {
  return mark({ k: "nested", cls: cls as LayoutClass }, () => new cls());
}

export function arrayOf<T>(cls: new () => T, length: number): LayoutArray<T> {
  return mark({ k: "nestedArray", cls: cls as LayoutClass, length }, () => {
    const items = Array.from({ length }, () => new cls());
    return {
      length,
      at: (i: usize): T => {
        if (i >= length) throw new TslTrap(2);
        return items[i]!;
      },
    };
  });
}

interface LaidField {
  name: string;
  kind: FieldKind;
  at: number;
}
export interface Layout {
  fields: LaidField[];
  size: number;
  align: number;
}

const layouts = new Map<LayoutClass, Layout>();

function sizeAlign(k: FieldKind): [number, number] {
  switch (k.k) {
    case "num":
    case "big":
    case "bits":
    case "enum":
      return [k.size, k.size];
    case "array":
      return [k.elem.size * k.length, k.elem.size];
    case "nested": {
      const l = layoutOf(k.cls);
      return [l.size, l.align];
    }
    case "nestedArray": {
      const l = layoutOf(k.cls);
      return [l.size * k.length, l.align];
    }
    case "pad":
      return [k.size, 1];
  }
}

/** The normative layout algorithm (SPEC 3.4). A class with a non-helper field isn't a layout class. */
export function layoutOf(cls: LayoutClass): Layout {
  const hit = layouts.get(cls);
  if (hit !== undefined) return hit;
  const was = capturing;
  capturing = true;
  let inst: Record<string, unknown>;
  try {
    inst = new cls() as Record<string, unknown>;
  } finally {
    capturing = was;
  }
  let off = 0;
  let align = 1;
  const fields: LaidField[] = [];
  const names = Object.keys(inst);
  if (names.length === 0) throw new TypeError(`${cls.name} is not a layout class`);
  for (const name of names) {
    const m = inst[name];
    if (!(m instanceof FieldMark)) {
      throw new TypeError(`${cls.name}.${name} is not a layout field (TSL1015)`);
    }
    const [s, a] = sizeAlign(m.kind);
    off = Math.ceil(off / a) * a;
    fields.push({ name, kind: m.kind, at: off });
    off += s;
    align = Math.max(align, a);
  }
  const l: Layout = { fields, align, size: Math.ceil(off / align) * align };
  layouts.set(cls, l);
  return l;
}

const addresses = new WeakMap<object, number>();
/** The simulated address of a view, if it has one. */
export const hostAddress = (o: object): number | undefined => addresses.get(o);

function readScalar(m: DataView, at: number, d: ScalarDesc): number | bigint {
  const le = !d.be;
  if (d.k === "big") return d.signed ? m.getBigInt64(at, le) : m.getBigUint64(at, le);
  if (d.float) return d.size === 4 ? m.getFloat32(at, le) : m.getFloat64(at, le);
  if (d.size === 1) return d.signed ? m.getInt8(at) : m.getUint8(at);
  if (d.size === 2) return d.signed ? m.getInt16(at, le) : m.getUint16(at, le);
  return d.signed ? m.getInt32(at, le) : m.getUint32(at, le);
}

function writeScalar(m: DataView, at: number, d: ScalarDesc, v: number | bigint): void {
  const le = !d.be;
  if (d.k === "big") {
    if (d.signed) m.setBigInt64(at, v as bigint, le);
    else m.setBigUint64(at, v as bigint, le);
  } else if (d.float) {
    if (d.size === 4) m.setFloat32(at, v as number, le);
    else m.setFloat64(at, v as number, le);
  } else if (d.size === 1) m.setUint8(at, v as number);
  else if (d.size === 2) m.setUint16(at, v as number, le);
  else m.setUint32(at, v as number, le);
}

export { readScalar as hostReadScalar, writeScalar as hostWriteScalar };

/** An object with T's prototype and accessors over bytes, so methods work on views as on plain objects. */
export function hostView<T extends object>(
  cls: new () => T,
  mem: DataView,
  base: number,
  addr?: number,
): T {
  const lay = layoutOf(cls as LayoutClass);
  if ((mem.byteOffset + base) % lay.align !== 0) throw new TslTrap(9);
  if (base + lay.size > mem.byteLength) throw new TslTrap(2);
  const out = Object.create(cls.prototype) as T;
  if (addr !== undefined) addresses.set(out, addr);
  for (const f of lay.fields) {
    const at = base + f.at;
    const k = f.kind;
    const def = (get: () => unknown, set?: (x: never) => void): void => {
      Object.defineProperty(out, f.name, { get, set, enumerable: true });
    };
    switch (k.k) {
      case "num":
      case "big":
        def(
          () => readScalar(mem, at, k),
          (x) => {
            writeScalar(mem, at, k, x);
          },
        );
        break;
      case "enum": {
        const d: ScalarDesc = { k: "num", size: k.size, signed: k.signed, be: k.be, float: false };
        def(
          () => {
            const r = readScalar(mem, at, d) as number;
            if (typeof k.members[r] !== "string") throw new TslTrap(4);
            return r;
          },
          (x) => {
            writeScalar(mem, at, d, x);
          },
        );
        break;
      }
      case "bits": {
        const d: ScalarDesc = { k: "num", size: k.size, signed: false, be: k.be, float: false };
        const o = bitAccessors(
          k.fields,
          () => readScalar(mem, at, d) as number,
          (x) => {
            writeScalar(mem, at, d, x);
          },
        );
        def(() => o);
        break;
      }
      case "array": {
        const a = new (arrayCtorOf(k.elem))(
          mem.buffer as ArrayBuffer,
          mem.byteOffset + at,
          k.length,
        );
        def(() => a);
        break;
      }
      case "nested": {
        const n = hostView(k.cls, mem, at, addr === undefined ? undefined : addr + f.at);
        def(() => n);
        break;
      }
      case "nestedArray": {
        const s = layoutOf(k.cls).size;
        const len = k.length;
        const c = k.cls;
        const fieldAddr = addr === undefined ? undefined : addr + f.at;
        const arr = {
          length: len,
          at: (i: usize): object => {
            if (i >= len) throw new TslTrap(2);
            return hostView(
              c,
              mem,
              at + i * s,
              fieldAddr === undefined ? undefined : fieldAddr + i * s,
            );
          },
        };
        def(() => arr);
        break;
      }
      case "pad":
        break;
    }
  }
  return out;
}

export type Init<T> = { [K in keyof T as T[K] extends number | bigint ? K : never]?: T[K] };

export function make<T extends object>(cls: new () => T, values?: Init<T>): T {
  layoutOf(cls as LayoutClass);
  const o = new cls();
  if (values !== undefined) Object.assign(o, values);
  return o;
}

export function over<T extends object>(cls: new () => T, bytes: Uint8Array, offset: usize): T {
  return hostView(cls, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset);
}

export function set<T extends object>(target: T, values: Init<T>): T {
  return Object.assign(target, values);
}

export function sizeOf(cls: new () => object): usize {
  return layoutOf(cls as LayoutClass).size;
}

export function alignOf(cls: new () => object): usize {
  return layoutOf(cls as LayoutClass).align;
}

export function offsetOf<T extends object>(cls: new () => T, field: keyof T & string): usize {
  return layoutOf(cls as LayoutClass).fields.find((f) => f.name === field)!.at;
}

export function assertSize(cls: new () => object, n: usize): void {
  const got = sizeOf(cls);
  if (got !== n) throw new TypeError(`${cls.name}: size ${got}, expected ${n}`);
}

// --- arenas (Heap, Slab and Vec are library code: @tsl/alloc)
export interface Arena extends Disposable {
  bytes(n: usize): Uint8Array;
  u32s(n: usize): Uint32Array;
  make<T extends object>(cls: new () => T): T;
}

export function arenaOver(backing: Uint8Array): Arena {
  let off = 0;
  const take = (n: number, a: number): number => {
    const at = Math.ceil((backing.byteOffset + off) / a) * a - backing.byteOffset;
    if (at + n > backing.byteLength) throw new TslTrap(2);
    off = at + n;
    backing.fill(0, at, off);
    return at;
  };
  return {
    bytes: (n) => backing.subarray(take(n, 1), off),
    u32s: (n) => new Uint32Array(backing.buffer, backing.byteOffset + take(n * 4, 4), n),
    make: <T extends object>(cls: new () => T): T => {
      const l = layoutOf(cls as LayoutClass);
      const at = take(l.size, l.align);
      return hostView(
        cls,
        new DataView(backing.buffer, backing.byteOffset, backing.byteLength),
        at,
      );
    },
    [Symbol.dispose]() {
      off = backing.byteLength;
    },
  };
}

// --- value results
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

// --- MMIO descriptors. Natively, compile-time only; out of scope until the kernel needs them.
export type Access = "ro" | "wo" | "rw";
export type RegDesc<A extends Access, T> = {
  readonly offset: number;
  readonly access: A;
  readonly width: number;
  readonly __value?: T;
};
const r =
  <A extends Access, T>(access: A, width: number) =>
  (offset: number): RegDesc<A, T> => ({ offset, access, width });
export const reg = {
  ro8: r<"ro", u8>("ro", 1),
  wo8: r<"wo", u8>("wo", 1),
  rw8: r<"rw", u8>("rw", 1),
  ro16: r<"ro", u16>("ro", 2),
  wo16: r<"wo", u16>("wo", 2),
  rw16: r<"rw", u16>("rw", 2),
  ro32: r<"ro", u32>("ro", 4),
  wo32: r<"wo", u32>("wo", 4),
  rw32: r<"rw", u32>("rw", 4),
  ro64: r<"ro", u64>("ro", 8),
  wo64: r<"wo", u64>("wo", 8),
  rw64: r<"rw", u64>("rw", 8),
};
// oxlint-disable-next-line typescript/no-explicit-any
export type RegMap = { readonly [name: string]: RegDesc<Access, any> };
export type MmioDesc<R extends RegMap> = { readonly regs: R; readonly size: number };
export type RegHandle<A extends Access, T> = (A extends "wo" ? object : { read(): T }) &
  (A extends "ro" ? object : { write(v: T): void });
export type MmioRef<D> =
  D extends MmioDesc<infer R>
    ? { readonly [K in keyof R]: R[K] extends RegDesc<infer A, infer T> ? RegHandle<A, T> : never }
    : never;
export const mmio = <const R extends RegMap>(size: number, regs: R): MmioDesc<R> => ({
  regs,
  size,
});

// --- atomics. A single-threaded host, so these are plain accesses.
export type LoadOrder = "relaxed" | "acquire" | "seqcst";
export type StoreOrder = "relaxed" | "release" | "seqcst";
export type RmwOrder = "relaxed" | "acquire" | "release" | "acqrel" | "seqcst";
export const atomic = {
  load<R, K extends keyof R>(o: R, f: K, _order: LoadOrder): R[K] {
    return o[f];
  },
  store<R, K extends keyof R>(o: R, f: K, v: R[K], _order: StoreOrder): void {
    o[f] = v;
  },
  fetchAdd<R, K extends keyof R>(o: R, f: K, v: R[K], _order: RmwOrder): R[K] {
    const old = o[f];
    (o as Record<K, unknown>)[f] = (old as number) + (v as number);
    return old;
  },
  cas<R, K extends keyof R>(o: R, f: K, e: R[K], d: R[K], _order: RmwOrder): bool {
    if (o[f] !== e) return false;
    o[f] = d;
    return true;
  },
  fence(_order: RmwOrder): void {},
};
