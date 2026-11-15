// expect: TSL1015 at 5:3
import { u32, type u32 as U32 } from "@tsl/core";
export class L {
  x = u32();
  y: U32 = 0;
}
