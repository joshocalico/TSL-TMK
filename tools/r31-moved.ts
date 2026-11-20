// Written by tools/r31-pins.ts --write: each pin R31 moved (SPEC M5's R31 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R31_MOVED, as R10 to R30 set theirs.

/** What each of R31's stages is, by the name tools/r31-pins.ts gives it. */
export const R31_WHY: Record<string, string> = {
  gc: "@tsl/gc (R31): with the collector, a chunk's pages taken from the page source straight (chunkPages), the run the heap's allocBytes gave for anything over its largest class, without its walk up its classes, with cutSlot's arithmetic wrapping where it can't overflow, and collectAll's count of what's live taken only where the table has a candidate; a library change, which moves the pins of a program that links the collector, at every level",
};

/** Each pin R31 moved and pinned again, with the stage that moved it. */
export const R31_REPINNED: Record<string, string> = {
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

/** A pin R31 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R31_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R31 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r31Moved = (k: string): boolean =>
  Object.keys(R31_MOVED).some((x) => x.endsWith(`#${k}`));
