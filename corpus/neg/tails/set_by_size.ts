// expect: TSL3011 at 9:7
import { set, tail, u8, withTail, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
export function f(): u32 {
  const b = withTail(4, new Buf());
  set(b, { n: 3 });
  return b.n;
}
