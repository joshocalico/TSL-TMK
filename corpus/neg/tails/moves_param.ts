// expect: TSL3011 at 12:15
import { tail, withTail, u8, u16, toUsize, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
/** @tsl.moves item */
function keep(item: Buf): u32 {
  return item.n;
}
export function f(): u32 {
  return keep(new Buf());
}
