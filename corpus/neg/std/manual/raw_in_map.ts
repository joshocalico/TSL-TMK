// expect: TSL3008 at 8:12
import { u32 } from "@tsl/core";
import { Map } from "@tsl/std";
class Item {
  constructor(public id: u32) {}
}
export function f(m: Map<u32, Item>): void {
  m.set(1, new Item(1));
}
