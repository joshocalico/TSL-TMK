// expect: TSL2002 at 4:14
import { type u8 } from "@tsl/core";
export function f(x: u8): u8 {
  return x + 256;
}
