// expect: TSL1024 at 5:3
import { tail, withTail, u8, u16, toU32, toUsize, type u32 } from "@tsl/core";
class Buf<T> {
  item: T | null = null;
  data = tail(u8);
}
export function f(): u32 {
  return toU32(withTail(4, new Buf<u32>()).data.length);
}
