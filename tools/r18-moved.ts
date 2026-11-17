// Written by tools/r18-pins.ts --write: each pin R18 moved (SPEC M5's R18 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R18_MOVED, as R10 to R17 set theirs.

/** What each of R18's stages is, by the name tools/r18-pins.ts gives it. */
export const R18_WHY: Record<string, string> = {
  stack:
    "class printing in rc (R18, emit-tsl.ts, expand-rc.ts, lower-native.ts): a class the lowering keeps every object of on the stack, holding numbers, booleans and other such classes, prints tagged @tsl.stack and isn't counted, its new a stack object tslc's escape checking places, zeroed by one mem.fill",
};

/** Each pin R18 moved and pinned again, with the stage that moved it. */
export const R18_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O1": "stack",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O2": "stack",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/inheritance.ts@rc": "stack",
};

/** A pin R18 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R18_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/inheritance.ts@rc": "stack",
};

/** A pin R18 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r18Moved = (k: string): boolean =>
  Object.keys(R18_MOVED).some((x) => x.endsWith(`#${k}`));
