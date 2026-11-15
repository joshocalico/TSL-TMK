// The list by hand in `manual` TSL, for comparison with the same thing in C (bench/memory/list.c).
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

class Node {
  next: Node | null = null;
  constructor(public value: u32) {}
}

let head: Node | null = null;

export function listCycle(n: u32): u32 {
  let h: Node | null = null;
  for (let i: u32 = 0; i < n; i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  head = h;
  let t: u32 = 0;
  for (let r: u32 = 0; r < 4; r++) {
    for (let c = head; c !== null; c = c.next) t = (t + c.value) >>> 0;
  }
  while (head !== null) {
    const c: Node = head;
    head = c.next;
    // SAFETY: the list was the only holder of c, and it's just been unlinked.
    unsafeFree(c);
  }
  return t;
}
