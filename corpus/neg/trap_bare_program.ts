// expect: TSL1026 at 5:21
// A program's own code given to trap as a bare number (3.10, D71): it's named by the program's enum or constant.
import { trap, type u32 } from "@tsl/core";
export function f(x: u32): u32 {
  if (x === 7) trap(1234);
  return x;
}
