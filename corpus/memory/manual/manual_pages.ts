// memory-pages: 2
// A manual package out of pages traps with code 14 (SPEC 3.10, divergence 4), and big blocks take whole pages.
import { type u32 } from "@tsl/core";

export class Link {
  next: Link | null = null;
  constructor(public v: u32) {}
}

let head: Link | null = null;

export function grow(n: u32): u32 {
  for (let i: u32 = 0; i < n; i++) {
    const c = new Link(i);
    c.next = head;
    head = c;
  }
  return n;
}
