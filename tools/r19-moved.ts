// Written by tools/r19-pins.ts --write: each pin R19 moved (SPEC M5's R19 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R19_MOVED, as R10 to R18 set theirs.

/** What each of R19's stages is, by the name tools/r19-pins.ts gives it. */
export const R19_WHY: Record<string, string> = {
  gc: "@tsl/gc (R19, D39): a tail of any length made in line (tailFast, sizeClass inlined), roomMake and roomAddr inlined, a fresh slot cut from a page of its size class without the collector (pageSlot, freshSlot, slotFor's fast path inlined), and an object freed with the cursor idle by freeFlat, the same steps; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  inline:
    "class printing in rc (R19, emit-tsl.ts): an environment's call, and each of its kinds' methods of six lines or fewer with no loop, printed @tsl.inline, so a closure called in a loop is its compare chain and its kind's code there",
  ctorfields:
    "tslc (R19, markInvariantFields, D73): a lowered rc package's counted class's fields stored by its constructor alone (an environment's kind and captures) noted invariant, load.T.inv at -O1 and -O2",
};

/** Each pin R19 moved and pinned again, with the stage that moved it. */
export const R19_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1":
    "gc+inline+ctorfields",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2":
    "gc+inline+ctorfields",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc+ctorfields",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc+ctorfields",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+inline",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R19 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R19_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc":
    "gc+inline",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R19 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r19Moved = (k: string): boolean =>
  Object.keys(R19_MOVED).some((x) => x.endsWith(`#${k}`));
