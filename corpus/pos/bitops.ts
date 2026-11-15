import { type i32, type u32, type u64, type u8 } from "@tsl/core";

export function and(a: u32, b: u32): i32 {
  return a & b;
}
export function or(a: u32, b: u32): i32 {
  return a | b;
}
export function xor(a: i32, b: u8): i32 {
  return a ^ b;
}
export function not(a: u32): i32 {
  return ~a;
}
export function andU32(a: u32, b: u32): u32 {
  return (a & b) >>> 0;
}
export function lowByte(a: u32): u8 {
  return a & 0xff; // range-assignable: 0 <= K <= max(u8)
}
export function highBitMask(a: u32): i32 {
  return a & 0x80000000; // JS sees -2^31 here, so this is negative when the bit is set
}
export function fullMask(a: u32): i32 {
  return a & 0xffffffff; // ToInt32(0xffffffff) is -1, so this isn't assignable to u32
}
export function and64(a: u64, b: u64): u64 {
  return a & b;
}
export function or64(a: u64, b: u64): u64 {
  return a | b;
}
export function xor64(a: u64, b: u64): u64 {
  return a ^ b;
}
export function not64(a: u64): u64 {
  return BigInt.asUintN(64, ~a);
}
export function compound(a: i32, b: i32): i32 {
  let x = a;
  x &= b;
  x |= 0x10;
  x ^= 0x3;
  return x;
}
