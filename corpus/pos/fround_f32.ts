import { type f32, type f64, type usize } from "@tsl/core";

export function fround(x: f64): f32 {
  return Math.fround(x);
}
export function sumThenRound(a: f32, b: f32): f32 {
  return Math.fround(a + b); // computed in double, then rounded, exactly as V8 does
}
export function sumDouble(a: f32, b: f32): f64 {
  return a + b; // f32 + f32 is an f64: JS never computes in single precision
}
export function widen(a: f32): f64 {
  return a;
}
export function exactLiteral(): f32 {
  const half: f32 = 0.5;
  return half;
}
export function roundedLiteral(): f32 {
  return Math.fround(0.1);
}
export function storeRounds(a: Float32Array, i: usize, v: f64): f32 {
  a[i] = v; // a store to a Float32Array rounds
  return a[i]!;
}
export function sumArray(a: Float32Array): f64 {
  let total: f64 = 0;
  for (const x of a) total += x;
  return total;
}
export function assignedValue(a: Float32Array, v: f64): f64 {
  const seen = (a[0] = v); // JS: the value of an assignment is the right-hand side, not the store
  return seen;
}
export function compareF32(a: f32, b: f32): boolean {
  return a < b;
}
