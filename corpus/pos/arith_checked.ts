import {
  type i16,
  type i32,
  type i64,
  type i8,
  type u16,
  type u32,
  type u64,
  type u8,
  type usize,
} from "@tsl/core";

export function addU8(a: u8, b: u8): u8 {
  return a + b;
}
export function subI8(a: i8, b: i8): i8 {
  return a - b;
}
export function mulU16(a: u16, b: u16): u16 {
  return a * b;
}
export function mulI16(a: i16, b: i16): i16 {
  return a * b;
}
export function sumMixed(a: u8, b: u16, c: u32): u32 {
  return a + b + c; // u8 + u16 joins to u16, then to u32
}
export function signedJoin(a: u8, b: i8): i16 {
  return a + b; // u8 and i8 meet at i16
}
export function mulI32(a: i32, b: i32): i32 {
  return a * b;
}
export function subUsize(a: usize, b: usize): usize {
  return a - b;
}
export function mulU64(a: u64, b: u64): u64 {
  return a * b;
}
export function addI64(a: i64, b: i64): i64 {
  return a + b;
}
export function negate(a: i32): i32 {
  return -a;
}
export function remainders(a: i32, b: i32): i32 {
  return a % b;
}
export function countDown(n: u32): u32 {
  let left = n;
  let steps: u32 = 0;
  while (left > 0) {
    left--;
    steps += 2;
  }
  return steps;
}
