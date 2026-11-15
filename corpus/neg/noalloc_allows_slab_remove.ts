// expect: TSL1017 at 17:3
// expect-msg: Slab
import { Heap, Slab } from "@tsl/alloc";
import { type u32, type u64, type usize } from "@tsl/core";
const none = (_n: usize): u64 => 0n;
const heap = new Heap(none);
class Item {
  constructor(public id: u32) {}
}
const items = new Slab<Item>(heap, 2);
/** @tsl.noalloc */
export function fine(i: Item): void {
  items.remove(i);
}
/** @tsl.noalloc */
export function bad(): void {
  items.add(new Item(1));
}
