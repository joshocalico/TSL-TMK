// expect: TSL2006 at 4:17
import { type u32, type u8 } from "@tsl/core";
export function f(a: u32): u8 {
  const r: u8 = a + 1;
  return r;
}
