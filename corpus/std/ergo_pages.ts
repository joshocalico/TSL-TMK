// The page source ergo_alloc.ts has to name, as every @tsl/alloc program does, and @tsl/std has as its default (SPEC 3.5).
import type { u64, usize } from "@tsl/core";
import { sourcePages } from "@tsl/unsafe";

export function sourcePagesOf(n: usize): u64 {
  // SAFETY: the environment's own source, which is trusted to return what it promises (3.8).
  return sourcePages(n);
}
