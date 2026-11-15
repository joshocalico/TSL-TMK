// With no "memory" in its package, and identical to strict_explicit/strict_same.ts: `strict` is the default.
import { Heap, Slab } from "@tsl/alloc";
import { type u32 } from "@tsl/core";
import { pages } from "../mem/pages.ts";

class Item {
  constructor(public v: u32) {}
}
const heap = new Heap(pages);
const items = new Slab<Item>(heap, 4);
let kept: Item | null = null;

export function hold(v: u32): u32 {
  kept = items.add(new Item(v));
  return kept!.v;
}

export function stale(): u32 {
  items.remove(kept!);
  return kept!.v;
}
