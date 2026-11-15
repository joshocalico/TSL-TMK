// expect: TSL1003 at 4:10
import { type u32, type u8 } from "@tsl/core";
export function f(x: u32): u8 {
  return x as u8;
}
