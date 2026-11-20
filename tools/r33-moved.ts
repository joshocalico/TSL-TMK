// Written by tools/r33-pins.ts --write: each pin R33 moved (SPEC M5's R33 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R33_MOVED, as R10 to R32 set theirs.

/** What each of R33's stages is, by the name tools/r33-pins.ts gives it. */
export const R33_WHY: Record<string, string> = {
  gc: "@tsl/gc (R33): `stepping` and `spare` set around a release call behind `releasesTouch` (answered true here), freeing's loops over an object's slots with the budget tested inside, and the object made in each release call; the same steps in the same order; a library change, which moves the pins of a program that frees, at every level",
  touch:
    "tslc (R33): `releasesTouch` answered over the whole program's call graph, so where no release function may read or write `stepping` or `spare`, @tsl/gc's writes of them around release calls are a branch never taken; a compiler change, at every level",
  order:
    "tslc (R33): the release dispatch's compare chain with the classes made in the most places first (each `new`, and each call of a function or method that makes one), the empty ones last as before; the same calls with the same arguments; a compiler change, at every level",
};

/** Each pin R33 moved and pinned again, with the stage that moved it. */
export const R33_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc+touch",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc+touch",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc+touch",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc+touch",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc+touch",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc+touch",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc+touch",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+touch",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+touch",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+touch",
};

/** A pin R33 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R33_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc+touch",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc+touch",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+touch",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+touch",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+touch",
};

/** A pin R33 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r33Moved = (k: string): boolean =>
  Object.keys(R33_MOVED).some((x) => x.endsWith(`#${k}`));
