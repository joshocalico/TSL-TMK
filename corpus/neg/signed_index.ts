// expect: TSL2006 at 4:12
import { type i32, type u8 } from "@tsl/core";
export function f(a: Uint8Array, i: i32): u8 {
  return a[i]!;
}
