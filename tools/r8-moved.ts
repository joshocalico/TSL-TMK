// Written by tools/r8-pins.ts --write: each pin R8 moved (SPEC M5's R8 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R8's changes is, by the name tools/r8-pins.ts's stages give it. */
export const R8_WHY: Record<string, string> = {
  gclib:
    "@tsl/gc's weakGen and count read the generation of an object tslc's rc expansion counts from its slot, where its reference no longer carries one (R8)",
  untag:
    "a reference to an object tslc's rc expansion counts is a plain address, with no generation in its top bits (R8): placeObject, placeTail and objectAt make no tag for such a class, so a native caller holds, reads and writes it at its address",
  boundary:
    "rc objects crossing an export printed with a native caller's place, retain and release (R8), which auto doesn't print",
};

export const R8_MOVED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gclib+untag",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O2": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gclib+untag",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/inheritance.ts@rc": "gclib+untag",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc":
    "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/inheritance.ts@rc": "gclib+untag",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gclib+untag",
};

/** A pin R8 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r8Moved = (k: string): boolean =>
  Object.keys(R8_MOVED).some((x) => x.endsWith(`#${k}`));
