// expect: TSL1008 at 3:28 // expect: TSL1008 at 4:16
import { type u32 } from "@tsl/core";
export function f(x: u32 | null): u32 {
  return x === null ? 0 : x;
}
