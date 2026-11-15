// expect: TSL1008 at 4:19
import { type u8 } from "@tsl/core";
export function f(x: u8): u8 {
  const q = x === undefined;
  return q ? 0 : x;
}
