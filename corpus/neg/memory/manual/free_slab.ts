// expect: TSL5008 at 14:14
import { Heap, Slab } from "@tsl/alloc";
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";
import { pages } from "../../../memory/manual/pool.ts";
class I {
  constructor(public v: u32) {}
}
const heap = new Heap(pages);
const items = new Slab<I>(heap, 4);
export function f(): void {
  const i = items.add(new I(1))!;
  // SAFETY: never reached: it doesn't compile.
  unsafeFree(i);
}
