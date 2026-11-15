// expect: TSL3001 at 9:10
// expect-msg: Vec
import { type u32 } from "@tsl/core";
import { ref, Vec } from "@tsl/std";
class Item {
  constructor(public id: u32) {}
}
export function f(v: Vec<Item>): void {
  v.push(new Item(1));
}
