import { idiv, toU64, type u32 } from "@tsl/core";

export function steps(n0: u32): u32 {
  let n = toU64(n0);
  let count: u32 = 0;
  while (n !== 1n) {
    n = n % 2n === 0n ? n / 2n : 3n * n + 1n;
    count++;
  }
  return count;
}

export function stepsU32(n0: u32): u32 {
  let n = n0;
  let count: u32 = 0;
  do {
    if (n === 1) break;
    n = (n & 1) === 0 ? idiv(n, 2) : 3 * n + 1;
    count++;
  } while (n !== 0);
  return count;
}

export function longestBelow(limit: u32): u32 {
  let best: u32 = 1;
  let bestSteps: u32 = 0;
  for (let i: u32 = 1; i < limit; i++) {
    const s = steps(i);
    if (s > bestSteps) {
      bestSteps = s;
      best = i;
    }
  }
  return best;
}
