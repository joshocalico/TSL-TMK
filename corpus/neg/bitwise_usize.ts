// expect: TSL2004 at 4:10
import { type i32, type usize } from "@tsl/core";
export function f(a: usize): i32 {
  return a & 1;
}
