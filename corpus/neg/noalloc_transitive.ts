// expect: TSL1017 at 13:3
// expect-msg: ex-heap.Heap.allocBytes
import { Heap, Vec } from "@tsl/alloc";
import { u32 as u32h, type u32, type u64, type usize } from "@tsl/core";
const none = (_n: usize): u64 => 0n;
const heap = new Heap(none);
function helper(v: Vec<u32>): void {
  v.push(1);
}
/** @tsl.noalloc */
export function f(): void {
  const v = new Vec(u32h, heap);
  helper(v);
}
