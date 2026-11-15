// A static-array page source, for a test that registers its own (SPEC 3.5).
import { array, toU64, u8, type u64, type usize } from "@tsl/core";
import { addrOf, staticView } from "@tsl/unsafe";

const POOL_BYTES: usize = 0x400000;

export class PoolBytes {
  bytes = array(u8, POOL_BYTES);
}

// SAFETY: this module's only storage with an address, and pages() hands out each run of it once.
const POOL = staticView(PoolBytes, 4096);

let used: usize = 0;
let limit: usize = 1024;

/** Hands out zeroed runs of pages, until the limit, and then 0n. */
export function pages(n: usize): u64 {
  if (used + n > limit) return 0n;
  // SAFETY: POOL is a static layout object, so it has an address.
  const at = addrOf(POOL) + toU64(used * 4096);
  used += n;
  return at;
}

/** The pool can be given a smaller limit, so a test can run out of memory. */
export function limitPages(n: usize): void {
  limit = used + n;
}

export function pagesUsed(): usize {
  return used;
}
