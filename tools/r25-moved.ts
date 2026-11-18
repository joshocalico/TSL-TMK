// Written by tools/r25-pins.ts --write: each pin R25 moved (SPEC M5's R25 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R25_MOVED, as R10 to R24 set theirs.

/** What each of R25's stages is, by the name tools/r25-pins.ts gives it. */
export const R25_WHY: Record<string, string> = {
  gc: "@tsl/gc (R25, D39): freeAlloc takes the block's step of an object at the cursor whose slots are all visited, then frees on, and takes its last step in place (slot 0's visit, the cursor left at slot 1), where both went to runSteps and freeSteps; the same steps in the same order; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  release:
    "tslc's release dispatch (R25, elab-native.ts): callRelease's compare chain with the release functions that do something first, the empty ones (never called: R17 marks their stores) last, so a class's own is reached by fewer compares; @tsl/gc's rooms' empty release came first by the order of modules; the same calls with the same effects; a change of tslc's code for @tsl/gc's dispatch, which moves the pins of every rc program whose chain had an empty release before one that isn't, lowered or hand-written, at every level (D44, as a library change does)",
  strings:
    "class printing's strings in rc (R25, emit-rcstr.ts and emit-tsl.ts): strIndexOf's search JsStr's indexFrom, cpLen through unit, sub's common ways, copyFrom and equality's quick answers inlined, slice, substring and the index conversions inlined; auto doesn't take strings in rc",
};

/** Each pin R25 moved and pinned again, with the stage that moved it. */
export const R25_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc+release",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc+release",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc+release",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc+release",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc+release",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc+release",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc+release",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+release",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+release",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+release",
};

/** A pin R25 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R25_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc+release",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc+release",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc":
    "gc+release",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+release",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+release",
};

/** A pin R25 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r25Moved = (k: string): boolean =>
  Object.keys(R25_MOVED).some((x) => x.endsWith(`#${k}`));
