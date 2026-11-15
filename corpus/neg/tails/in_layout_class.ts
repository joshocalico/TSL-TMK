// expect: TSL1024 at 5:3
import { tail, u32, type usize } from "@tsl/core";
class Desc {
  len = u32();
  data = tail(u32);
}
export function f(): usize {
  return 0;
}
