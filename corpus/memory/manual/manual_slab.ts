// A manual package with Slab objects too (SPEC 3.5): a field holds a plain pointer or a Slab's reference. A
// generation check is off for the plain one, and stays on for anything from a Slab.
import { Heap, Slab } from "@tsl/alloc";
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";
import { pages } from "./pool.ts";

export class Item {
  other: Item | null = null;
  constructor(public v: u32) {}
}

const heap = new Heap(pages);
const items = new Slab<Item>(heap, 8);
let fromSlab: Item | null = null;
let raw: Item | null = null;

export function setUp(a: u32, b: u32): u32 {
  fromSlab = items.add(new Item(a));
  const r = new Item(b);
  r.other = fromSlab;
  raw = r;
  return raw.other!.v + raw.v * 100;
}

export function readSlab(): u32 {
  return raw!.other!.v;
}

export function removeSlab(): void {
  items.remove(fromSlab!);
}

export function freeSlabObject(): void {
  // SAFETY: deliberately wrong: a Slab's reference has a tag, so this traps.
  unsafeFree(fromSlab!);
}
