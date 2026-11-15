// expect: TSL3012 at 6:20
import { tail, withTail, u8, u16, toU32, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  constructor() {
    this.n = toU32(this.data.length);
  }
  data = tail(u8);
}
export function f(): u32 {
  return withTail(4, new Buf()).n;
}
