// expect: TSL3012 at 7:11
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
const b = new Buf();
export function f(): u32 {
  return 0;
}
