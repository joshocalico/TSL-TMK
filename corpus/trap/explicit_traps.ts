import { assert, panic, trap, type i64, type u32, type u64 } from "@tsl/core";

export function userTrap(code: u32): u32 {
  if (code > 0) trap(code);
  return 0;
}
export function constantTrap(): void {
  trap(Code.Constant);
}
export function failedAssert(x: u32): void {
  assert(x === 0, Code.Assert);
}
export function failedAssertDynamic(x: u32, code: u32): void {
  assert(x === 0, code);
}
export function panics(x: u32): u32 {
  if (x > 0) panic(`bad value ${x}`);
  return x;
}
export function negativeShift(x: u64, n: i64): u64 {
  return x >> n;
}
export function negativeShiftLeft(x: u64, n: i64): u64 {
  return BigInt.asUintN(64, x << n);
}

/** This program's own trap code (3.10: from 1000, named). */
enum Code {
  Constant = 1234,
  Assert = 1001,
}
