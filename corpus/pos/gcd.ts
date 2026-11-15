import { idiv, type u32, type u64 } from "@tsl/core";

export function gcd(a0: u32, b0: u32): u32 {
  let a = a0;
  let b = b0;
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function gcdRec(a: u32, b: u32): u32 {
  return b === 0 ? a : gcdRec(b, a % b);
}

export function gcd64(a0: u64, b0: u64): u64 {
  let a = a0;
  let b = b0;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function lcm(a: u32, b: u32): u32 {
  return idiv(a, gcdF(a, b)) * b;
}

function gcdF(a: u32, b: u32): u32 {
  return gcd(a, b);
}
