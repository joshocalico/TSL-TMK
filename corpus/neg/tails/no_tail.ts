// expect: TSL3012 at 7:22
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Plain {
  n: u32 = 0;
}
export function f(): u32 {
  return withTail(4, new Plain()).n;
}
