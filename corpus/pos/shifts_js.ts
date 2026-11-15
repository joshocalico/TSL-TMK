import { type i32, type i64, type u16, type u32, type u64, type u8 } from "@tsl/core";

export function shl(a: i32, n: u32): i32 {
  return a << n;
}
export function shr(a: i32, n: u32): i32 {
  return a >> n;
}
export function ushr(a: i32, n: u32): u32 {
  return a >>> n;
}
export function top8(x: u32): u8 {
  return x >>> 24; // range-assignable: the result fits u8
}
export function top16(x: u32): u16 {
  return x >>> 16;
}
export function maskedCount(x: u32): u32 {
  return x >>> 32; // JS masks the count to 5 bits, so this is x >>> 0
}
export function bigShr(x: u64, n: u64): u64 {
  return x >> n;
}
export function bigAshr(x: i64, n: u64): i64 {
  return x >> n;
}
export function bigShlChecked(x: u64, n: u64): u64 {
  return x << n;
}
export function bigShlWrap(x: u64, n: u64): u64 {
  return BigInt.asUintN(64, x << n);
}
export function bigShlI64Count(x: u64, n: i64): u64 {
  return x << n;
}
