// Each -O1 and -O2 pin R1d moved (D73's unreached pass, M5's R1d record), by its key, found by tools/r1d-pins.ts: each moves
// with the pass on and is as pinned with it off. Nothing at -O0 moves: the pass doesn't run there.
export const R1D_WHY =
  "the unreached pass (D73, R1d): at -O1 and -O2 a tslc module loses the functions nothing reaches from its exports and the runtime's __ names, here helpers every call to which was inlined";

export const R1D_MOVED: ReadonlySet<string> = new Set([
  "corpus/pos/gcd.ts@O1",
  "corpus/pos/generic_mono.ts@O1",
  "corpus/pos/inline_rules.ts@O1",
  "corpus/pos/switch_dispatch.ts@O1",
  "corpus/pos/tagged_result.ts@O1",
  "corpus/trap/inline_traps.ts@O1",
  "corpus/pos/gcd.ts@O2",
  "corpus/pos/generic_mono.ts@O2",
  "corpus/pos/tagged_result.ts@O2",
]);

/** A -O1 or -O2 pin R1d moved, as listed. */
export const r1dMoved = (k: string): boolean => /@O[12]$/.test(k) && R1D_MOVED.has(k);
