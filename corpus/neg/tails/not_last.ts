// expect: TSL1024 at 4:3
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  data = tail(u8);
  n: u32 = 0;
}
export function f(): u32 {
  return withTail(4, new Buf()).n;
}
