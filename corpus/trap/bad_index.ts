import { type f64, type i32, type u8, type usize } from "@tsl/core";

const STATIC = new Uint8Array(4);

export function readByte(a: Uint8Array, i: usize): u8 {
  return a[i]!;
}
export function writeByte(a: Uint8Array, i: usize, v: u8): void {
  a[i] = v;
}
export function readF64(a: Float64Array, i: usize): f64 {
  return a[i]!;
}
export function readStatic(i: usize): u8 {
  return STATIC[i]!;
}
export function bumpAt(a: Int32Array, i: usize): void {
  a[i]! += 1;
}

type F = (x: i32) => i32;
function one(x: i32): i32 {
  return x;
}
const TABLE: readonly F[] = [one];

export function callTable(i: usize, x: i32): i32 {
  return TABLE[i]!(x);
}
