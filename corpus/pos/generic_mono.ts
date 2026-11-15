import {
  toF64,
  toU64,
  type f64,
  type i32,
  type i8,
  type u16,
  type u32,
  type u64,
  type u8,
  type Result,
} from "@tsl/core";

function max<T extends number>(a: T, b: T): T {
  return a > b ? a : b;
}

function maxBig<T extends bigint>(a: T, b: T): T {
  return a > b ? a : b;
}

function pick<T>(cond: boolean, a: T, b: T): T {
  return cond ? a : b;
}

// tsc says a + b is number, which doesn't assign back to T. So arithmetic in a generic returns a
// concrete type, and the checks still follow the type the generic was instantiated at.
function sum3<T extends number>(a: T, b: T, c: T): u32 {
  return toU32Of(a) + toU32Of(b) + toU32Of(c);
}

function toU32Of<T extends number>(x: T): u32 {
  return x >>> 0;
}

function twoParams<A extends number, B extends number>(a: A, b: B): f64 {
  return toF64(a) + toF64(b);
}

type Wrapped<T> = { readonly value: T; readonly count: u32 };

function wrap1(x: u8): Wrapped<u8> {
  return { value: x, count: 1 };
}

function unwrap(w: Wrapped<u16>): u16 {
  return w.value;
}

export function maxU8(a: u8, b: u8): u8 {
  return max(a, b);
}
export function maxI8(a: i8, b: i8): i8 {
  return max(a, b);
}
export function maxU16(a: u16, b: u16): u16 {
  return max<u16>(a, b);
}
export function maxI32(a: i32, b: i32): i32 {
  return max(a, b);
}
export function maxU32(a: u32, b: u32): u32 {
  return max(a, b);
}
export function maxF64(a: f64, b: f64): f64 {
  return max(a, b);
}
export function maxWiden(a: u8, b: u32): u32 {
  return max(a, b); // T is the join, u32
}
export function maxLiteral(a: u16): u16 {
  return max(a, 300);
}
export function maxU64(a: u64, b: u64): u64 {
  return maxBig(a, b);
}
export function pickBool(c: boolean, a: boolean, b: boolean): boolean {
  return pick(c, a, b);
}
export function sum3U8(a: u8, b: u8, c: u8): u32 {
  return sum3(a, b, c);
}
export function sum3I32(a: i32, b: i32, c: i32): u32 {
  return sum3(a, b, c);
}
export function mixedParams(a: u8, b: f64): f64 {
  return twoParams(a, b);
}
export function wrapped(x: u8): u16 {
  const w = wrap1(x);
  return unwrap(w);
}
export function genericResult(x: u32): Result<u32, u8> {
  return x === 0 ? { ok: false, error: 1 } : { ok: true, value: x };
}
export function big(x: u32): u64 {
  return toU64(x);
}
