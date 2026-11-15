// expect: TSL1024 at 5:3
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  a = tail(u8);
  b = tail(u16);
}
export function f(): u32 {
  return 0;
}
