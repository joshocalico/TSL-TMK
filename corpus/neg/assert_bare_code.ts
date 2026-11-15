// expect: TSL1026 at 5:17
// A table code given to assert as a bare number (3.10, D72): it's a trap code like trap's, Trap.Bounds.
import { assert, type u32 } from "@tsl/core";
export function f(i: u32, n: u32): u32 {
  assert(i < n, 2);
  return i;
}
