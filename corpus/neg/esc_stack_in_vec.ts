// expect: TSL3001 at 11:10
import { Heap, Vec, ref } from "@tsl/alloc";
import { type u32, type u64, type usize } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
const none = (_n: usize): u64 => 0n;
const heap = new Heap(none);
export function f(): void {
  using v = new Vec(ref<Item>(), heap);
  v.push(new Item(1));
}
