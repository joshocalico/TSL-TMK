// expect: TSL3011 at 8:3
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
class Holder {
  inner: Buf;
  constructor() {
    this.inner = new Buf();
  }
}
export function f(): u32 {
  return new Holder().inner.n;
}
