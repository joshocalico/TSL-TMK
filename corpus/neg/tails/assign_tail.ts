// expect: TSL2006 at 9:3
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
export function f(x: Uint8Array): u32 {
  const b = withTail(4, new Buf());
  b.data = x;
  return b.n;
}
