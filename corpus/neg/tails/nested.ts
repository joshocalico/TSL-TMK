// expect: TSL3011 at 9:18
import { nested, tail, u32, u8, type usize } from "@tsl/core";
class Buf {
  n: usize = 0;
  data = tail(u8);
}
class Desc {
  len = u32();
  inner = nested(Buf);
}
export function f(): usize {
  return 0;
}
