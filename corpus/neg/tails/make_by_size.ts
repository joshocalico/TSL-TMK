// expect: TSL3011 at 8:15
import { make, tail, u8, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
export function f(): u32 {
  return make(Buf).n;
}
