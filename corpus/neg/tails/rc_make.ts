// expect: TSL3011 at 16:20
import { tail, u8, type u32, type usize } from "@tsl/core";
import { Rc, Visit } from "@tsl/gc";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
function releaseBuf(_b: Buf, _at: usize, _op: Visit): usize {
  return 0;
}
const bufs = new Rc<Buf>(releaseBuf);
// R1b: a store no longer names a stepping function;
// these lines keep the expected position where it was,
// since the program's lines are what the test pins.
export function f(): u32 {
  return bufs.make(new Buf()).n;
}
