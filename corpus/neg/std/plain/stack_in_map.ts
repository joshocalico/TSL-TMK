// expect: TSL3001 at 8:12
import { u32 } from "@tsl/core";
import { Map, ref } from "@tsl/std";
class Item {
  id: u32 = 0;
}
export function f(m: Map<u32, Item>): void {
  m.set(1, new Item());
}
export const made = new Map(u32, ref<Item>());
