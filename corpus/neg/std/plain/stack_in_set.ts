// expect: TSL3001 at 9:9
import { type u32 } from "@tsl/core";
import { Set } from "@tsl/std";
class Item {
  id: u32 = 0;
}
export function f(s: Set<Item>): void {
  const it = new Item();
  s.add(it);
}
