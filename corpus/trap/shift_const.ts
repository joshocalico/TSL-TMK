import { toU64, type u32, type u64 } from "@tsl/core";

// R1f: a `<<` by a constant is checked for bits lost as one by a variable is. The optimiser removes the check only where the
// value's width proves nothing can be lost (an `and` with a constant, a zero extension), and a guard against a count of 64
// or more only where the count is a constant below it. Each pair: one that loses bits and traps, one that can't.
export function shl32(a: u64): u64 {
  return a << 32n;
}
export function shl32Masked(a: u64): u64 {
  return (a & 0xffff_ffffn) << 32n;
}
export function shl40Masked24(a: u64): u64 {
  return (a & 0xff_ffffn) << 40n;
}
export function shl41Masked24(a: u64): u64 {
  return (a & 0xff_ffffn) << 41n;
}
export function shlWide32(a: u32): u64 {
  return toU64(a) << 32n;
}
export function shlWide33(a: u32): u64 {
  return toU64(a) << 33n;
}
export function shrBack(a: u64): u64 {
  return (a >> 16n) << 16n;
}
export function shr63(a: u64): u64 {
  return a >> 63n;
}
