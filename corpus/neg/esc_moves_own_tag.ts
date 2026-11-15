// expect: TSL3006 at 11:15
import { type u32 } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
/** @tsl.moves item */
function take(item: Item): u32 {
  return item.id;
}
export function f(i: Item): u32 {
  return take(i);
}
