// memory-pages: 1
// An environment's own page source, registered from an unsafe module with setPageSource, replacing the runtime's:
// the runtime's limit here is one page, and this source's is the static pool's (SPEC 3.5).
import { toU32, type u32, type u64, type usize } from "@tsl/core";
import { setPageSource } from "@tsl/unsafe";
import { limitPages, pages, pagesUsed } from "./pool.ts";

export class Cell {
  next: Cell | null = null;
  constructor(public v: u32) {}
}

let head: Cell | null = null;

function source(n: usize): u64 {
  return pages(n);
}

export function register(limit: usize): u32 {
  limitPages(limit);
  // SAFETY: source hands out zeroed runs from a static pool, each once, and 0n when it's out.
  setPageSource(source);
  return 1;
}

export function grow(n: u32): u32 {
  for (let i: u32 = 0; i < n; i++) {
    const c = new Cell(i);
    c.next = head;
    head = c;
  }
  return toU32(pagesUsed());
}
