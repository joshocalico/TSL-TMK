// expect: TSL1016 at 4:1
import { type u32, type u64 } from "@tsl/core";
/** @tsl.size 8 */
export class P {
  a: u32 = 0;
  b: u64 = 0n;
}
