// expect: TSL1010 at 5:5
import { type u32 } from "@tsl/core";
class C {
  constructor(public v: u32) {
    if (v > 1) this.v = 2;
  }
}
export const c = new C(1);
