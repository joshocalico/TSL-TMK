// Written by tools/r1f-pins.ts --write: each -O1 and -O2 pin that R1f's strength reduction moved (SPEC 4.3's simplify,
// M5's R1f record), by its key. Nothing at -O0 moves.
export const R1F_WHY =
  "R1f's strength reduction (4.3's simplify): an unsigned division or remainder by a power of two a shift or an and, a 64-bit shift by a constant unguarded, a checked << whose test for bits lost folds";

export const R1F_MOVED: ReadonlySet<string> = new Set([
  "corpus/mem/alloc_slab.ts@O1",
  "corpus/mem/alloc_slab.ts@O2",
  "corpus/pos/collatz.ts@O1",
  "corpus/pos/collatz.ts@O2",
  "corpus/pos/xorshift64_u64.ts@O1",
  "corpus/pos/xorshift64_u64.ts@O2",
  "corpus/std/model.ts@O1",
  "corpus/std/model.ts@O2",
  "corpus/std/std_slab_safety.ts@O1",
  "corpus/std/std_slab_safety.ts@O2",
]);

/** A -O1 or -O2 pin R1f's strength reduction moved, as listed. */
export const r1fMoved = (k: string): boolean => /@O[12]$/.test(k) && R1F_MOVED.has(k);
