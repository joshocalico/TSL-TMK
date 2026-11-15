import { type u32 } from "@tsl/core";

export function fib(n: u32): u32 {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

export function fibIter(n: u32): u32 {
  let a: u32 = 0;
  let b: u32 = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}
