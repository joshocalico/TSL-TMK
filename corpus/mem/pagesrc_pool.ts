// The raw memory both page sources carve from: a static array, as corpus/mem/pages.ts.
import { array, toU64, u8, type u64, type usize } from "@tsl/core";
import { addrOf, staticView } from "@tsl/unsafe";

export class PoolBytes {
  bytes = array(u8, 0x100000);
}

// SAFETY: this module's only storage with an address, and take() hands out each run once.
const POOL = staticView(PoolBytes, 4096);
let used: usize = 0;

export function take(n: usize): u64 {
  if (used + n > 256) return 0n;
  // SAFETY: POOL is a static layout object, so it has an address.
  const at = addrOf(POOL) + toU64(used * 4096);
  used += n;
  return at;
}
