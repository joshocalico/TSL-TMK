// expect: TSL1006 at 3:23
import { type u32 } from "@tsl/core";
export function f(xs: u32[]): u32 {
  return xs.length;
}
