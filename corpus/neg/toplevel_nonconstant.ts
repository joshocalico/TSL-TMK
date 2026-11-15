// expect: TSL1010 at 6:23
import { type u32 } from "@tsl/core";
function g(): u32 {
  return 1;
}
export const X: u32 = g();
