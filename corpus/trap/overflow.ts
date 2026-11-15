import {
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
export function subU8(a: u8, b: u8): u8 {
  return a - b;
}
export function addI8(a: i8, b: i8): i8 {
  return a + b;
}
export function mulU16(a: u16, b: u16): u16 {
  return a * b;
}
export function addI32(a: i32, b: i32): i32 {
  return a + b;
}
export function mulI32(a: i32, b: i32): i32 {
  return a * b;
}
export function addU32(a: u32, b: u32): u32 {
  return a + b;
}
export function subU32(a: u32, b: u32): u32 {
  return a - b;
}
export function mulU32(a: u32, b: u32): u32 {
  return a * b;
}
export function subUsize(a: usize, b: usize): usize {
  return a - b;
}
export function addU64(a: u64, b: u64): u64 {
  return a + b;
}
export function subU64(a: u64, b: u64): u64 {
  return a - b;
}
export function mulU64(a: u64, b: u64): u64 {
  return a * b;
}
export function addI64(a: i64, b: i64): i64 {
  return a + b;
}
export function subI64(a: i64, b: i64): i64 {
  return a - b;
}
export function mulI64(a: i64, b: i64): i64 {
  return a * b;
}
export function negI32(a: i32): i32 {
  return -a;
}
export function negI8(a: i8): i8 {
  return -a;
}
export function absI32(a: i32): i32 {
  return Math.abs(a);
}
export function bump(a: u8): u8 {
  let x = a;
  x++;
  return x;
}
export function shlU64(a: u64, n: u64): u64 {
  return a << n;
}
export function narrowJoinFirst(a: u8, b: u8, c: u32): u32 {
  return a + b + c; // a + b is u8 by rule 3, even though the sum would fit a u32
}
