import { toU32, toU64, type i64, type u32, type u64 } from "@tsl/core";

export function mul64(a: u64, b: u64): u64 {
  return BigInt.asUintN(64, a * b);
}
export function add64(a: u64, b: u64): u64 {
  return BigInt.asUintN(64, a + b);
}
export function sub64(a: u64, b: u64): u64 {
  return BigInt.asUintN(64, a - b);
}
export function mulI64(a: i64, b: i64): i64 {
  return BigInt.asIntN(64, a * b);
}
export function reinterpret(a: i64): u64 {
  return BigInt.asUintN(64, a);
}
export function low32(a: u64): u32 {
  return toU32(a & 0xffffffffn);
}
export function mulHiLo(a: u32, b: u32): u64 {
  return toU64(a) * toU64(b);
}
export function div64(a: u64, b: u64): u64 {
  return a / b;
}
export function rem64(a: i64, b: i64): i64 {
  return a % b;
}
export function divI64(a: i64, b: i64): i64 {
  return a / b;
}
