import {
  toI32,
  toI64,
  toI8,
  toU16,
  toU32,
  toU64,
  toU8,
  toUsize,
  type f64,
  type i32,
  type i64,
  type i8,
  type u16,
  type u32,
  type u64,
  type u8,
  type usize,
} from "@tsl/core";

export function literal(): u8 {
  return toU8(300);
}
export function fromU32(x: u32): u8 {
  return toU8(x);
}
export function fromI32(x: i32): u16 {
  return toU16(x);
}
export function u32ToI32(x: u32): i32 {
  return toI32(x);
}
export function i32ToU32(x: i32): u32 {
  return toU32(x);
}
export function i32ToI8(x: i32): i8 {
  return toI8(x);
}
export function i32ToUsize(x: i32): usize {
  return toUsize(x);
}
export function u64ToU32(x: u64): u32 {
  return toU32(x);
}
export function u64ToI64(x: u64): i64 {
  return toI64(x);
}
export function i64ToU64(x: i64): u64 {
  return toU64(x);
}
export function i32ToU64(x: i32): u64 {
  return toU64(x);
}
export function floatFraction(x: f64): i32 {
  return toI32(x);
}
export function floatToU64(x: f64): u64 {
  return toU64(x);
}
export function floatToUsize(x: f64): usize {
  return toUsize(x);
}
