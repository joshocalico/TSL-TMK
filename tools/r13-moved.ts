// Written by tools/r13-pins.ts --write: each pin R13 moved (SPEC M5's R13 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R13's changes is, by the name tools/r13-pins.ts's stages give it. */
export const R13_WHY: Record<string, string> = {
  arena:
    "in strict's call arena, what an export gives or is given lives until the caller resets it (D36), and module state is long only where something made after __init can reach it (R13)",
  arrays:
    "in strict, auto's class printing prints arrays as @tsl/jsrt's arena array (JsArenaArray, its buffers the call arena's) and typed arrays made in functions as R9's views, where the printing is exact (R13)",
};

export const R13_MOVED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O1": "arrays",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2": "arrays",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O1": "arrays",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O2": "arrays",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": "arrays",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict": "arrays",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": "arrays",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict": "arrays",
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/generics_mono.ts": "arrays",
};

/** A pin R13 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r13Moved = (k: string): boolean =>
  Object.keys(R13_MOVED).some((x) => x.endsWith(`#${k}`));
