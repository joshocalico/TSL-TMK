// Written by tools/r37-pins.ts --write: each pin R37 moved (SPEC M5's R37 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R37_MOVED, as R10 to R36 set theirs.

/** What each of R37's stages is, by the name tools/r37-pins.ts gives it. */
export const R37_WHY: Record<string, string> = {
  exc: "the route (R37): `TRUSTED_EXC_IN` leak and manual on, so `auto` takes through phase 1's printing a program with exceptions in leak or manual whose reshapes are all kinds it trusts, its machine code at -O1 and -O2 the direct route's byte for byte; a route switch, at every level, never TSL proper's",
};

/** Each pin R37 moved and pinned again, with the stage that moved it. */
export const R37_REPINNED: Record<string, string> = {
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": "exc",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": "exc",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": "exc",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O1": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O2": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O1": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O2": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O1": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O1": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": "exc",
};

/** A pin R37 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R37_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": "exc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": "exc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": "exc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": "exc",
};

/** A pin R37 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r37Moved = (k: string): boolean =>
  Object.keys(R37_MOVED).some((x) => x.endsWith(`#${k}`));
