// expect: TSL3011 at 10:19
import { tail, u8, type u32 } from "@tsl/core";
import { Slab } from "@tsl/std";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
const bufs = new Slab<Buf>();
export function f(): u32 {
  return bufs.add(new Buf()).n;
}
