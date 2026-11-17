// Written by tools/r21-pins.ts --write: each pin R21 moved (SPEC M5's R21 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R21_MOVED, as R10 to R20 set theirs.

/** What each of R21's stages is, by the name tools/r21-pins.ts gives it. */
export const R21_WHY: Record<string, string> = {
  gc: "@tsl/gc (R21, D39): a tail's owner word kept with its size class, so a make of a tail as long as the last has no checked multiply; an object of one slot not dispatched on its release function a second time to find it has no more; and runSteps handing the first waiting object to freeFlat with nothing to add up, the same steps; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  units:
    "class printing in rc (R21, emit-rcstr.ts): the one-unit strings below 256 from a table in module state (JsStrUnits, an array holder of the runtime's own), its hit inlined and its miss out of line, and an append or prepend of one unit a checked store",
};

/** Each pin R21 moved and pinned again, with the stage that moved it. */
export const R21_REPINNED: Record<string, string> = {
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

/** A pin R21 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R21_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R21 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r21Moved = (k: string): boolean =>
  Object.keys(R21_MOVED).some((x) => x.endsWith(`#${k}`));
