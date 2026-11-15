// expect: TSL1016 at 6:1
import { assertSize, u16, u32 } from "@tsl/core";
export class L {
  a = u16(); b = u32();
}
assertSize(L, 6);
