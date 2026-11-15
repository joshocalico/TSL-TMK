import { type u32, type usize } from "@tsl/core";

/** Marks composites in `flags` (0 means prime), and returns how many primes are below its length. */
export function sieve(flags: Uint8Array): u32 {
  const n = flags.length;
  let count: u32 = 0;
  for (let i: usize = 2; i < n; i++) {
    if (flags[i]! !== 0) continue;
    count++;
    for (let j = i * i; j < n; j += i) {
      flags[j] = 1;
    }
  }
  return count;
}
