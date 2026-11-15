// expect: TSL1026 at 5:20
// A table code given to trap as a bare number (3.10, D71): it's Trap.Bounds.
import { trap, type u32 } from "@tsl/core";
export function f(i: u32, n: u32): u32 {
  if (i >= n) trap(2);
  return i;
}
