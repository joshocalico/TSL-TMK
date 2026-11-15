import { toU64, type u64, type usize } from "@tsl/core";

import { take } from "./pagesrc_pool.ts";

/** Hands out one fixed range, taken up front, a page run at a time. Counts calls by tens, unlike QuotaPages. */
export class RangePages {
  calls: usize = 0;
  private next: u64;
  private end: u64;
  constructor(count: usize) {
    this.next = take(count);
    this.end = this.next + toU64(count * 4096);
  }
  pages(n: usize): u64 {
    this.calls += 10;
    const bytes = toU64(n * 4096);
    if (this.next + bytes > this.end) return 0n;
    const at = this.next;
    this.next = at + bytes;
    return at;
  }
}
