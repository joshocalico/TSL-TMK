// expect: TSL2007 at 4:7
import { type u32 } from "@tsl/core";
export function f(a: u32): u32 {
  if (a) return 1;
  return 0;
}
