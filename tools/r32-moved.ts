// Written by tools/r32-pins.ts --write: each pin R32 moved (SPEC M5's R32 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R32_MOVED, as R10 to R31 set theirs.

/** What each of R32's stages is, by the name tools/r32-pins.ts gives it. */
export const R32_WHY: Record<string, string> = {
  gc: "@tsl/gc (R32): freeAlloc tests a one-slot object's ways (no step left, more slots, the block's step) in two tests where R24's order took three, the same steps in the same order; a library change, which moves the pins of a program that frees through freeAlloc, at every level",
  units:
    "class printing (R32): in `rc`, the one-unit string table read with its three tests one inside the other, so the table's global is read once; a printer change, at every level",
  index:
    "class printing (R32): in `rc`, compiler/rt's strIndex with a float index (`s[x]`) as three tests one inside the other, where it joined their opposites by `||`; a printer change, at every level",
  stable:
    "class printing (R32): in `rc`, a string literal ahead of a later operand's statements read where it's used, as nothing assigns a literal's module state after `__init`, where it was held in a temporary the expansion counted (a share and a drop a use); a printer change, at every level",
  range:
    "the optimiser (R32, -O2): range.ts's facts from a float compare's edge (a float not NaN, at least 0 and below a converted i32 or a constant: its ToInt32's range, and below n the fact toint32(x) <= n - 1, with n at least 1), so check elimination takes a test the facts prove and makes a proved ToInt32 the saturating conversion",
};

/** Each pin R32 moved and pinned again, with the stage that moved it. */
export const R32_REPINNED: Record<string, string> = {
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

/** A pin R32 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R32_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R32 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r32Moved = (k: string): boolean =>
  Object.keys(R32_MOVED).some((x) => x.endsWith(`#${k}`));
