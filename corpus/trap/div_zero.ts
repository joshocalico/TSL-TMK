import {
  idiv,
  type i16,
  type i32,
  type i64,
  type i8,
  type u32,
  type u64,
  type usize,
} from "@tsl/core";

export function idivU32(a: u32, b: u32): u32 {
  return idiv(a, b);
}
export function idivI32(a: i32, b: i32): i32 {
  return idiv(a, b);
}
export function idivI8(a: i8, b: i8): i8 {
  return idiv(a, b);
}
export function idivI16(a: i16, b: i16): i16 {
  return idiv(a, b);
}
export function idivUsize(a: usize, b: usize): usize {
  return idiv(a, b);
}
export function remU32(a: u32, b: u32): u32 {
  return a % b;
}
export function remI32(a: i32, b: i32): i32 {
  return a % b;
}
export function divU64(a: u64, b: u64): u64 {
  return a / b;
}
export function remU64(a: u64, b: u64): u64 {
  return a % b;
}
export function divI64(a: i64, b: i64): i64 {
  return a / b;
}
