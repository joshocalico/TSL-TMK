// A page source a test can run dry: the same on the host and natively (SPEC 3.5).
import { array, toU64, u8, type u64, type usize } from "@tsl/core";
import { addrOf, staticView } from "@tsl/unsafe";

const POOL_PAGES: usize = 2048;

export class PoolBytes {
  bytes = array(u8, POOL_PAGES * 4096);
}

// SAFETY: this module's only storage with an address, and poolPages() hands out each run of it once.
const POOL = staticView(PoolBytes, 4096);

let used: usize = 0;
let limit: usize = POOL_PAGES;

/** Hands out zeroed runs of pages until the limit, and then 0n. */
export function poolPages(n: usize): u64 {
  if (used + n > limit) return 0n;
  // SAFETY: POOL is a static layout object, so it has an address.
  const at = addrOf(POOL) + toU64(used * 4096);
  used += n;
  return at;
}

/** So many more pages from now on, so a test can run out. */
export function limitPages(n: usize): void {
  limit = used + n;
}

export function pagesUsed(): usize {
  return used;
}
