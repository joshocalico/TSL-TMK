// expect: TSL2001 at 4:7
import { type u32, type i32 } from "@tsl/core";
export function f(a: u32, b: i32): void {
  let x = 0;
  x = a;
  x = b;
}
