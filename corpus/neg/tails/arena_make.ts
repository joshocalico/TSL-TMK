// expect: TSL3011 at 10:17
import { arenaOver, tail, u8, type u32 } from "@tsl/core";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
const backing = new Uint8Array(256);
export function f(): u32 {
  using a = arenaOver(backing);
  return a.make(Buf).n;
}
