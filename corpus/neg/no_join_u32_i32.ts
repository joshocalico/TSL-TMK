// expect: TSL2003 at 4:10
import { type i32, type u32 } from "@tsl/core";
export function f(a: u32, b: i32): u32 {
  return a + b;
}
