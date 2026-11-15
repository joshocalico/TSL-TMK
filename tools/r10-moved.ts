// Written by tools/r10-pins.ts --write: each pin R10 moved (SPEC M5's R10 record), by pin file and key, with the change
// that moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead. (R10's run moved 8 of 3,862, all by
// `dead`: a statement after a `return` in an `rc` program's closure method, `return 0;`, which can't run, no longer printed.)

/** What each of R10's changes is, by the name tools/r10-pins.ts's stages give it. */
export const R10_WHY: Record<string, string> = {
  dead: "in rc, a statement list printed up to its first statement that never goes on, what follows being dead (R10)",
  mapargs: "in rc, a map made as a call's argument printed as a statement of its own first (R10)",
  typed:
    "in rc, a constant length's typed array made in a function printed as an uncounted layout class's array, on the stack (R10)",
  strings:
    "strings in rc printed as the program's own JsStr, exceptions and the map runtime refused by name in rc (R10), which auto doesn't print",
};

export const R10_MOVED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "dead",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "dead",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "dead",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "dead",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "dead",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "dead",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "dead",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "dead",
};

/** A pin R10 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r10Moved = (k: string): boolean =>
  Object.keys(R10_MOVED).some((x) => x.endsWith(`#${k}`));
