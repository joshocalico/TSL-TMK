// expect: TSL3011 at 8:17
import { sizeOf, tail, u8, type usize } from "@tsl/core";
class Buf {
  n: usize = 0;
  data = tail(u8);
}
export function f(): usize {
  return sizeOf(Buf);
}
