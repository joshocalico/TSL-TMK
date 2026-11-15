// expect: TSL1008 at 3:19 // expect: TSL1008 at 4:10
import { type u32 } from "@tsl/core";
export function f(x?: u32): u32 {
  return x ?? 0;
}
