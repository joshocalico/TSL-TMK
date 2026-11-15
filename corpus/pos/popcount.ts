import { type i32, type u32, type u64 } from "@tsl/core";

export function popcount(x0: u32): u32 {
  let x = x0;
  let n: u32 = 0;
  while (x !== 0) {
    x = (x & (x - 1)) >>> 0;
    n++;
  }
  return n;
}

export function swar(x: u32): i32 {
  // & yields i32 and x is u32, so each masked operand needs >>> 0 to have a join with x.
  const half = ((x >>> 1) & 0x55555555) >>> 0;
  const a = (x - half) >>> 0;
  const b = ((a & 0x33333333) + ((a >>> 2) & 0x33333333)) >>> 0;
  const c = (b + (b >>> 4)) & 0x0f0f0f0f;
  return Math.imul(c, 0x01010101) >>> 24;
}

export function popcount64(x0: u64): u32 {
  let x = x0;
  let n: u32 = 0;
  while (x !== 0n) {
    x = x & (x - 1n);
    n++;
  }
  return n;
}

export function leadingZeros(x: u32): u32 {
  return Math.clz32(x);
}
