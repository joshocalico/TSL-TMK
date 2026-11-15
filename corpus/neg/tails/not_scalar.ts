// expect: TSL1024 at 5:15
import { be16, tail, withTail, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(be16);
}
export function f(): u32 {
  return withTail(4, new Buf()).n;
}
