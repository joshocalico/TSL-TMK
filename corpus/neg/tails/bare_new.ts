// expect: TSL3012 at 8:13
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
export function f(): u32 {
  const b = new Buf();
  return b.n;
}
