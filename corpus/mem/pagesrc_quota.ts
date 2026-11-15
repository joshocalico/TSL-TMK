import { type u64, type usize } from "@tsl/core";
import { type PageSource } from "./pagesrc_heap.ts";
import { take } from "./pagesrc_pool.ts";

/** Draws on a quota of pages, which is this object's own state, not the module's. */
export class QuotaPages implements PageSource {
  calls: usize = 0;
  constructor(private quota: usize) {}
  pages(n: usize): u64 {
    this.calls += 1;
    if (n > this.quota) return 0n;
    this.quota -= n;
    return take(n);
  }
}
