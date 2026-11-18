// Written by tools/r22-pins.ts --write: each pin R22 moved (SPEC M5's R22 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R22_MOVED, as R10 to R21 set theirs.

/** What each of R22's stages is, by the name tools/r22-pins.ts gives it. */
export const R22_WHY: Record<string, string> = {
  gc: "@tsl/gc (R22, D39): a tail's owner word worked out from its store's owner word with no checked multiply and add, and only where its size class changes; freeOne's second step, a visit of slot 1, taken in place rather than by runSteps and freeSteps, the same steps; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  strings:
    "class printing in rc (R22, emit-rcstr.ts and emit-tsl.ts): concatenation's new buffer made out of its line (jsStrGrown), and a + b + c made once where it's short (the program's strConcat3 and the runtime's jsStrJoined3)",
};

/** Each pin R22 moved and pinned again, with the stage that moved it. */
export const R22_REPINNED: Record<string, string> = {
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

/** A pin R22 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R22_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R22 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r22Moved = (k: string): boolean =>
  Object.keys(R22_MOVED).some((x) => x.endsWith(`#${k}`));
