import { type u32, type u64 } from "@tsl/core";

export function next(x0: u64): u64 {
  let x = x0;
  x = x ^ BigInt.asUintN(64, x << 13n);
  x = x ^ (x >> 7n);
  x = x ^ BigInt.asUintN(64, x << 17n);
  return x;
}

export function run(seed: u64, n: u32): u64 {
  let x = seed;
  for (let i: u32 = 0; i < n; i++) x = next(x);
  return x;
}

let state: u64 = 88172645463325252n; // a mutable global: state carries across calls

export function step(): u64 {
  state = next(state);
  return state;
}
