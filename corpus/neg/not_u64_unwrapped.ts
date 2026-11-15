// expect: TSL2013 at 4:10
import { type u64 } from "@tsl/core";
export function f(a: u64): u64 {
  return ~a;
}
