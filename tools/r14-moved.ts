// Written by tools/r14-pins.ts --write: each pin R14 moved (SPEC M5's R14 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R14's changes is, by the name tools/r14-pins.ts's stages give it. */
export const R14_WHY: Record<string, string> = {
  inv: "phase 1's printing notes a class id's load invariant (load<i32>(o, 0, \"invariant\"), D73) as the direct route notes it, so -O1's and -O2's TIR is the direct route's (R14)",
  trust:
    "auto takes a program phase 1 printed reshaped only by the kinds it trusts (a statement-expression's statements before an operand, after a sequence's first part, in a conditional's arm, on a logical operator's right side), whose TIR is the direct route's (R14)",
};

export const R14_MOVED: Record<string, string> = {
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@leak": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@manual": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual": "trust",
};

/** A pin R14 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r14Moved = (k: string): boolean =>
  Object.keys(R14_MOVED).some((x) => x.endsWith(`#${k}`));
