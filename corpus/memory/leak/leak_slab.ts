// A leak package holding Slab objects too (SPEC 3.5): a field can hold either kind. A leak object is a static
// object made at run time, whose generation never changes, so one check suits both, and removing from the Slab
// still makes a stored reference trap with code 5.
import { type u32 } from "@tsl/core";
import { Heap, Slab } from "@tsl/alloc";
import { pages } from "./pool.ts";

export class Item {
  other: Item | null = null;
  constructor(public v: u32) {}
}

const heap = new Heap(pages);
const items = new Slab<Item>(heap, 8);
let held: Item | null = null;
let fromLeak: Item | null = null;
let chain: Item | null = null;

function freshLeak(v: u32): Item {
  return new Item(v);
}

export function holdSlab(v: u32): u32 {
  held = items.add(new Item(v));
  return held!.v;
}

export function holdLeak(v: u32): u32 {
  fromLeak = freshLeak(v);
  return fromLeak.v;
}

export function mixed(a: u32, b: u32): u32 {
  const s = items.add(new Item(a))!;
  const l = freshLeak(b);
  s.other = l; // a leak object in a Slab object's field
  l.other = s; // and a Slab object in a leak object's field
  chain = l;
  return chain.other!.other!.v + chain.other!.v * 100;
}

export function readHeld(): u32 {
  return held === null ? 0 : held.v;
}

export function readLeak(): u32 {
  return fromLeak === null ? 0 : fromLeak.v;
}

export function removeHeld(): void {
  if (held !== null) items.remove(held);
}

export function removeThroughChain(): u32 {
  const s = chain!.other!;
  const was = s.v;
  items.remove(s);
  return was;
}

export function staleThroughLeak(): u32 {
  return chain!.other!.v; // traps: the leak object's field holds a removed Slab object
}

export function leakStaysGood(): u32 {
  return chain!.v;
}

export function removeLeak(): void {
  items.remove(fromLeak!); // a leak object isn't in a Slab
}
