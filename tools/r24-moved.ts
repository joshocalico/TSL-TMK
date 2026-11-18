// Written by tools/r24-pins.ts --write: each pin R24 moved (SPEC M5's R24 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R24_MOVED, as R10 to R23 set theirs.

/** What each of R24's stages is, by the name tools/r24-pins.ts gives it. */
export const R24_WHY: Record<string, string> = {
  gc: "@tsl/gc (R24, D39): an allocation's freeing with no collector linked in one call (freeAlloc), an object of one slot freed in place and a wider one's rest of slots in freeRest, and visitLeaf reading a leaf's count once, its block given back with its store's entry found from its owner word; the same steps in the same order; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  strings:
    "class printing's strings in rc (R24, emit-rcstr.ts and emit-tsl.ts): a view's fields given to its constructor, a unit read with its length and start as their bits, and a + b and s[i] inlined; auto doesn't take strings in rc",
};

/** Each pin R24 moved and pinned again, with the stage that moved it. */
export const R24_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R24 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R24_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R24 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r24Moved = (k: string): boolean =>
  Object.keys(R24_MOVED).some((x) => x.endsWith(`#${k}`));
