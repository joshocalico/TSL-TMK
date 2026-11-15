// expect: TSL3011 at 11:31
import { tail, u8, type u32, type u64 } from "@tsl/core";
import { placeObject } from "@tsl/unsafe";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
/** @tsl.moves item */
export function put(slot: u64, item: Buf): u32 {
  // SAFETY: a test of the checker only.
  return placeObject(slot, 1, item).n;
}
