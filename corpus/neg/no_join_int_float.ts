// expect: TSL2003 at 4:10
import { type f64, type u32 } from "@tsl/core";
export function f(a: u32, b: f64): f64 {
  return a + b;
}
