// expect: TSL3011 at 9:19
import { arrayOf, tail, u32, u8, type usize } from "@tsl/core";
class Buf {
  n: usize = 0;
  data = tail(u8);
}
class Ring {
  len = u32();
  items = arrayOf(Buf, 4);
}
export function f(): usize {
  return 0;
}
