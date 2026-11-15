// expect: TSL5009 at 6:17
import { type u64, type usize } from "@tsl/core";
import { setPageSource } from "@tsl/unsafe";
export function f(g: (n: usize) => u64): void {
  // SAFETY: never reached: it doesn't compile.
  setPageSource(g);
}
