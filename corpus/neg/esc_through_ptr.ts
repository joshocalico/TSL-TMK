// expect: TSL3001 at 8:59
import { type u32 } from "@tsl/core";
import { ptrAt, ref } from "@tsl/unsafe";
class Item {
  constructor(public id: u32) {}
}
// SAFETY: a test of the checker.
export function f(): void { ptrAt(ref<Item>(), 64n).write(new Item(1)); }
