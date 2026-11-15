import { toF64, toU32, type f64, type u32 } from "@tsl/core";

export function isqrt(n: u32): u32 {
  return toU32(Math.floor(Math.sqrt(toF64(n))));
}

/** Newton's method: float division is fine, and it's only integer / that's banned. */
export function newton(x: f64): f64 {
  if (x <= 0) return 0;
  let r = x;
  for (let i: u32 = 0; i < 60; i++) {
    r = (r + x / r) / 2;
  }
  return r;
}

export function hypot(a: f64, b: f64): f64 {
  return Math.sqrt(a * a + b * b);
}

export function rounding(x: f64): f64 {
  return Math.floor(x) + Math.ceil(x) * 2 + Math.trunc(x) * 4 + Math.abs(x) * 8;
}
