// memory-pages: 4
// A constructor leaves out its stores of zero initialisers where every object starts zeroed (SPEC 3.5, zeroed construction).
// In manual a freed block is the next one of its size, dirty: the heap's new zero-fills it, so the object reads zero.
import { type bool, type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

export class Item {
  count: u32 = 0;
  seen: bool = false;
  link: Item | null = null;
  constructor(public v: u32) {}
}

let keep: Item | null = null;

export function heapReuse(rounds: u32): u32 {
  let bad: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const o = new Item(i);
    keep = o;
    if (o.count !== 0 || o.seen || o.link !== null || o.v !== i) bad++;
    o.count = 0xbeef;
    o.seen = true;
    o.link = o;
    keep = null;
    // SAFETY: o is this iteration's own, nothing holds it now, and it's not used after this.
    unsafeFree(o);
  }
  return bad;
}

/** What the loop left held: nothing, as each round lets go of its object before freeing it. */
export function held(): u32 {
  return keep === null ? 0 : 1;
}
