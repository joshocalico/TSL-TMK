// R18: `@tsl/std`'s JS Map (D47) running out of memory part way through a `trySet`, as std_new_safety.ts runs ExactMap out:
// whichever of its arrays runs out first, the Map stays as it was, with no key left behind. Map's trySet is ExactMap's code over
// again, and until R18 only ExactMap's was tried, so a key Map left behind when its values ran out was caught by nothing (SPEC
// 8.3's fault rule found it: the patch that put the bug into ExactMap's copy of the text was taken as the bug in both).
import { toU32, toU64, u32, u64, u8, type bool, type usize } from "@tsl/core";
import { globalAllocator, Map } from "@tsl/std";
import { limitPages, poolPages } from "./pool.ts";

/** @tsl.global-allocator */
export const heap = globalAllocator(poolPages);

// Values larger than keys: whichever of heads, keys, values or chain runs out, at every small limit.
function holdsWhenItFails(limit: usize): bool {
  limitPages(limit);
  const m = new Map(u32, u64);
  let n: u32 = 0;
  while (m.trySet(n, 7n)) n++;
  let seen: u32 = 0;
  m.forEach((v, k) => {
    if (k === seen && v === 7n) seen++;
  });
  const ok = seen === n && toU32(m.size) === n && !m.has(n);
  m.free();
  return ok;
}

export function trySetFailsPartWay(): bool {
  for (let limit: usize = 0; limit < 40; limit++) {
    if (!holdsWhenItFails(limit)) return false;
  }
  return true;
}

// Keys larger than values.
function holdsWhenKeysFail(limit: usize): bool {
  limitPages(limit);
  const m = new Map(u64, u8);
  let n: u32 = 0;
  while (m.trySet(toU64(n), 1)) n++;
  let seen: u32 = 0;
  m.forEach(() => {
    seen++;
  });
  const ok = seen === n && toU32(m.size) === n;
  m.free();
  return ok;
}

export function trySetFailsPartWayKeys(): bool {
  for (let limit: usize = 0; limit < 40; limit++) {
    if (!holdsWhenKeysFail(limit)) return false;
  }
  return true;
}
