// @tsl.moves holds through the wrapper: the argument is a direct new.
// expect: TSL3006 at 9:9
import { type u32 } from "@tsl/core";
import { Slab } from "@tsl/std";
class Item {
  id: u32 = 0;
}
export function f(s: Slab<Item>, it: Item): void {
  s.add(it);
}
