// A raw reference has no generation, and a Vec's a strict package's: TSL3008, as for any field in one.
// expect: TSL3008 at 9:10
import { type u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class Item {
  constructor(public id: u32) {}
}
export function f(v: Vec<Item>): void {
  v.push(new Item(1));
}
