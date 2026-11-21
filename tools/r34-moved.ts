// Written by tools/r34-pins.ts --write: each pin R34 moved (SPEC M5's R34 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R34_MOVED, as R10 to R33 set theirs.

/** What each of R34's stages is, by the name tools/r34-pins.ts gives it. */
export const R34_WHY: Record<string, string> = {
  gc: "@tsl/gc (R34): a run of waiting leaves given back in one pass at a leaf's allocation (makeTailLeaf), in line, a step each with the budget brought down once (freeLeaves, leafRun); freeing taking a leaf a release function hands it (`RC_HANDED`, takeHanded); a store's leaf entry for objects made with no references (`makeTailLeaf`); the same steps in the same order for everything made as before; a library change, which moves the pins of a program that frees, at every level",
  hand: "tslc (R34): a release function handing a leaf or a room back to freeing through what it returns (`handLeaf`, `trimHand`, `RC_HANDED`), where it gave one back through `spare` (`visitLeaf`, `trim`); visitLeaf's steps exactly; a compiler change, at every level",
  leaf: "tslc (R34): `withTail(n, new C(…))` made with `makeTailLeaf` where C's references are all null there and only its constructor sets them (a flat string), so freeing gives it back as one step with no call (D39's R34); a compiler change, at every level",
};

/** Each pin R34 moved and pinned again, with the stage that moved it. */
export const R34_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gc+hand",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gc+hand",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc+hand",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc+hand",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc+hand",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc+hand",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+hand",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+hand",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+hand",
};

/** A pin R34 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R34_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc+hand",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc+hand",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc+hand",
};

/** A pin R34 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r34Moved = (k: string): boolean =>
  Object.keys(R34_MOVED).some((x) => x.endsWith(`#${k}`));
