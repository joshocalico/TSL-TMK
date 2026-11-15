// expect: TSL5009 at 7:17
import { type u64, type usize } from "@tsl/core";
import { setPageSource } from "@tsl/unsafe";
export function f(base: u64): void {
  const g = (n: usize): u64 => base + BigInt.asUintN(64, 0n);
  // SAFETY: never reached: it doesn't compile.
  setPageSource(g);
}
