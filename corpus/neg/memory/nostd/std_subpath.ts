// expect: TSL1018 at 3:1
import { type u32 } from "@tsl/core";
import { y } from "@tsl/std/map";
export function f(): u32 {
  return y;
}
