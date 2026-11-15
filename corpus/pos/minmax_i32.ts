import { type f64, type i32, type u32 } from "@tsl/core";

export function minI32(a: i32, b: i32): i32 {
  return Math.min(a, b);
}
export function maxI32(a: i32, b: i32): i32 {
  return Math.max(a, b);
}
export function minU32(a: u32, b: u32): u32 {
  return Math.min(a, b);
}
export function maxU32(a: u32, b: u32): u32 {
  return Math.max(a, b);
}
export function abs(a: i32): i32 {
  return Math.abs(a);
}
export function clamp(x: i32, lo: i32, hi: i32): i32 {
  return Math.max(lo, Math.min(x, hi));
}
export function ternaryMax(a: i32, b: i32): i32 {
  return a > b ? a : b;
}
export function minF64(a: f64, b: f64): f64 {
  return Math.min(a, b);
}
export function maxF64(a: f64, b: f64): f64 {
  return Math.max(a, b);
}
