// expect: TSL2012 at 4:11
import { type u32 } from "@tsl/core";
export function f(a: u32, b: u32): u32 {
  return (a * b) >>> 0;
}
