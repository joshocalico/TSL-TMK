// expect: TSL3006 at 13:13
// expect-msg: moves item
import { Heap, Slab } from "@tsl/alloc";
import { type u32, type u64, type usize } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
const none = (_n: usize): u64 => 0n;
const heap = new Heap(none);
const items = new Slab<Item>(heap, 4);
export function f(): void {
  const i = new Item(1);
  items.add(i);
}
