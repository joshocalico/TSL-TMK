// Written by tools/r15-pins.ts --write: each pin R15 moved (SPEC M5's R15 record), by pin file and key, with the pass that
// moved it and that pass's counts for the build. Each is pinned again in its file, so every pin is still compared exactly:
// none is set aside (r15Moved is false for all), and this is the record of why each moved.

/** What each of R15's passes is, by the name tools/r15-pins.ts's stages give it. */
export const R15_WHY: Record<string, string> = {
  conds:
    "conds.ts (R15, -O1 and -O2): a test a test above it answered goes, a branch on a value a dominating branch decided, a compare the relations known decide, a bounds check under a test that proves it",
  version:
    "version.ts (R15, -O2): a loop whose checks a guard before it proves gets a fast copy without them, and keeps the loop as it was for when the guard fails",
};

/** Each pin R15 moved and pinned again, with the pass that moved it and that pass's counts for the build. */
export const R15_REPINNED: Record<string, string> = {
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O2":
    "conds+version (conds: 12 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_events.ts@rc@O2":
    "conds+version (conds: 26 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O2":
    "conds+version (conds: 15 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2":
    "conds+version (conds: 14 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_visitor.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/class_init_order.ts@rc@O2":
    "conds+version (conds: 68 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/class_shapes.ts@rc@O2":
    "conds+version (conds: 28 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_paths.ts@rc@O2":
    "conds+version (conds: 21 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O2":
    "conds+version (conds: 15 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/throw_values.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O2":
    "conds+version (conds: 12 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_events.ts@rc@O2":
    "conds+version (conds: 26 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O2":
    "conds+version (conds: 15 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2":
    "conds+version (conds: 14 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_visitor.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/cast_unknown.ts@rc@O2":
    "conds+version (conds: 14 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/class_init_order.ts@rc@O2":
    "conds+version (conds: 68 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/class_shapes.ts@rc@O2":
    "conds+version (conds: 28 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_paths.ts@rc@O2":
    "conds+version (conds: 21 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O2":
    "conds (conds: 30 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O2":
    "conds+version (conds: 15 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/throw_values.ts@rc@O2":
    "conds+version (conds: 11 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/maps/drop_moving.ts@rc@O2":
    "conds+version (conds: 130 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/maps/move_iter.ts@rc@O2":
    "conds (conds: 179 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/maps-tirhash.json#corpus/lower/maps/move_ops.ts@rc@O2":
    "conds+version (conds: 37 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/any_type.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/any_type.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/any_type.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/async_gen.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/async_gen.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/async_gen.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/bigint_plain.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/bigint_plain.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/bigint_plain.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check@O2":
    "conds (conds: 28 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off@O1":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off@O2":
    "conds (conds: 141 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc@O1":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc@O2":
    "conds (conds: 141 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc+off@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc+off@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/computed_key.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/computed_key.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/computed_key.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/definite_assignment.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/definite_assignment.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/definite_assignment.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc+off@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1":
    "conds (conds: 9 branches, 9 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2":
    "conds (conds: 69 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/export_forms.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/export_forms.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/export_forms.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/finalization.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/finalization.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/finalization.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/generic_cap.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/generic_cap.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/generic_cap.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O1":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off@O2":
    "conds (conds: 39 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc@O2":
    "conds (conds: 39 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/instantiation_cap.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/instantiation_cap.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/instantiation_cap.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/lying_cast.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/lying_cast.ts@rc+off@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/lying_cast.ts@rc@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_new_untyped.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_new_untyped.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_new_untyped.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@leak@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@manual@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check@O2":
    "conds (conds: 24 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off@O2":
    "conds (conds: 74 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc@O2":
    "conds (conds: 74 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/object_is_object.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/object_is_object.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/object_is_object.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/partial_fill.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/partial_fill.ts@rc+off@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/partial_fill.ts@rc@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/prototype.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/prototype.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/prototype.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/reflection.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/reflection.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/reflection.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/regexp_date.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/regexp_date.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/regexp_date.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+off@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@leak@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@manual@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc+check@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc+off@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc+off@O2":
    "conds+version (conds: 6 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/string_use.ts@rc@O2":
    "conds+version (conds: 6 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check@O2":
    "conds (conds: 18 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+off@O2":
    "conds (conds: 164 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check@O2":
    "conds (conds: 17 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off@O2":
    "conds (conds: 163 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/weakref_mode.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/weakref_mode.ts@rc+off@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/weakref_mode.ts@rc@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/churn.ts@rc+check@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/churn.ts@rc+off@O2":
    "conds (conds: 37 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/churn.ts@rc@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc+off@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc+off@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/closures_returned.ts@rc+check@O2":
    "conds (conds: 22 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/closures_returned.ts@rc+off@O2":
    "conds (conds: 52 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/closures_returned.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/cycles.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/cycles.ts@rc+off@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/cycles.ts@rc+off@O2":
    "conds (conds: 24 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/cycles.ts@rc@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/cycles.ts@rc@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/exhaust.ts@rc+check@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/exhaust.ts@rc+off@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/exhaust.ts@rc+off@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/exhaust.ts@rc@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/exhaust.ts@rc@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/globals_across_calls.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/globals_across_calls.ts@rc+off@O2":
    "conds (conds: 21 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/globals_across_calls.ts@rc@O2":
    "conds (conds: 21 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc+off@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+off@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1":
    "conds (conds: 9 branches, 9 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2":
    "conds (conds: 64 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/alloc_rules.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/alloc_rules.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/alloc_rules.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_methods.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_methods.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_methods.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_vec.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_vec.ts@rc+off@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/array_vec.ts@rc@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_known.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_known.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_known.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/control_flow.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/control_flow.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/control_flow.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/float_rem.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/float_rem.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+off@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/literal_param.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/literal_param.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_spread.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_spread.ts@rc+off@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_spread.ts@rc@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/module_state.ts@rc+check@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/module_state.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/module_state.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable_field_order.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable_field_order.ts@rc+off@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable_field_order.ts@rc@O2":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/number_float.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/number_float.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/number_int.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/number_int.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/object_is.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/object_is.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/object_shape.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/object_shape.ts@rc+off@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/object_shape.ts@rc@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/relative_import.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/relative_import.ts@rc+off@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/relative_import.ts@rc@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/string_bytes.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/string_bytes.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/string_bytes.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/throw_trap.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/throw_trap.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/throw_trap.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/typed_array.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/typed_array.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/typed_array.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/unions.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/unions.ts@rc+off@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/unions.ts@rc@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc+off@O2":
    "conds (conds: 16 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_weak.ts@rc+check@O2":
    "conds (conds: 18 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_weak.ts@rc+off@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_weak.ts@rc+off@O2":
    "conds (conds: 37 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_weak.ts@rc@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_weak.ts@rc@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/exhaust_drains.ts@rc+check@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/exhaust_drains.ts@rc+off@O2":
    "conds (conds: 18 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/exhaust_drains.ts@rc@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/release_observed.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/release_observed.ts@rc+off@O2":
    "conds (conds: 36 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/release_observed.ts@rc@O2":
    "conds (conds: 36 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/weak_cleared.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/weak_cleared.ts@rc+off@O2":
    "conds (conds: 35 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/weak_cleared.ts@rc@O2":
    "conds (conds: 35 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_array_release.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_array_release.ts@rc+off@O2":
    "conds (conds: 59 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_array_release.ts@rc@O2":
    "conds (conds: 59 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_callee_clears_arg.ts@rc+check@O2":
    "conds (conds: 16 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_callee_clears_arg.ts@rc+off@O2":
    "conds (conds: 43 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_callee_clears_arg.ts@rc@O2":
    "conds (conds: 43 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc+off@O2":
    "conds (conds: 45 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak@O1":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual@O1":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc+check@O2":
    "conds (conds: 28 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc+off@O1":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc+off@O2":
    "conds (conds: 66 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc@O1":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc@O2":
    "conds (conds: 15 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict@O1":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc+check@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc+off@O2":
    "conds (conds: 33 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc@O2":
    "conds (conds: 33 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc+off@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc+check@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc+off@O2":
    "conds (conds: 31 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_misc.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_misc.ts@rc+off@O1":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_misc.ts@rc+off@O2":
    "conds (conds: 137 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_misc.ts@rc@O1":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_misc.ts@rc@O2":
    "conds (conds: 29 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc+off@O2":
    "conds (conds: 45 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc+check@O2":
    "conds (conds: 8 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc+off@O2":
    "conds (conds: 37 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc@O2":
    "conds (conds: 37 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O1":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O2":
    "conds (conds: 53 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O1":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O2":
    "conds (conds: 53 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc+check@O2":
    "conds (conds: 18 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc+off@O2":
    "conds (conds: 39 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O1":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O2":
    "conds (conds: 50 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O2":
    "conds (conds: 50 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc+check@O2":
    "conds (conds: 16 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc+off@O2":
    "conds (conds: 31 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O2":
    "conds+version (conds: 60 branches, 0 compares, 0 bounds checks; version: 1 loops, 1 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O2":
    "conds+version (conds: 60 branches, 0 compares, 0 bounds checks; version: 1 loops, 1 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc+check@O2":
    "conds (conds: 23 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc+off@O2":
    "conds (conds: 76 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O2":
    "conds (conds: 49 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@rc+off@O2":
    "conds (conds: 39 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@rc@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_shapes.ts@rc+check@O2":
    "conds (conds: 10 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_shapes.ts@rc+off@O2":
    "conds (conds: 37 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_shapes.ts@rc@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/weak_held.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/weak_held.ts@rc+off@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/weak_held.ts@rc@O2":
    "conds (conds: 20 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@leak@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@manual@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc+check@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc+off@O1":
    "conds (conds: 1 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc+off@O2":
    "conds+version (conds: 39 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc@O1":
    "conds (conds: 1 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc@O2":
    "conds+version (conds: 39 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O1":
    "conds (conds: 6 branches, 3 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O2":
    "conds+version (conds: 26 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O1":
    "conds (conds: 6 branches, 3 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O2":
    "conds+version (conds: 25 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+check@O1":
    "conds (conds: 6 branches, 3 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+check@O2":
    "conds+version (conds: 94 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off@O1":
    "conds (conds: 21 branches, 3 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off@O2":
    "conds+version (conds: 486 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc@O1":
    "conds (conds: 21 branches, 3 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc@O2":
    "conds+version (conds: 486 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@leak@O1":
    "conds (conds: 4 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@leak@O2":
    "conds+version (conds: 17 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@manual@O1":
    "conds (conds: 4 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@manual@O2":
    "conds+version (conds: 17 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+check@O1":
    "conds (conds: 4 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+check@O2":
    "conds+version (conds: 70 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+off@O1":
    "conds (conds: 7 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+off@O2":
    "conds+version (conds: 206 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc@O1":
    "conds (conds: 7 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc@O2":
    "conds+version (conds: 24 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@leak@O2":
    "conds+version (conds: 6 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@manual@O2":
    "conds+version (conds: 6 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+check@O2":
    "conds+version (conds: 34 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off@O1":
    "conds (conds: 6 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off@O2":
    "conds+version (conds: 222 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc@O1":
    "conds (conds: 6 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc@O2":
    "conds+version (conds: 222 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@leak@O1":
    "conds (conds: 0 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@leak@O2":
    "conds+version (conds: 17 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@manual@O1":
    "conds (conds: 0 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@manual@O2":
    "conds+version (conds: 17 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+check@O1":
    "conds (conds: 0 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+check@O2":
    "conds+version (conds: 134 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+off@O1":
    "conds (conds: 12 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+off@O2":
    "conds+version (conds: 421 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc@O1":
    "conds (conds: 12 branches, 6 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc@O2":
    "conds+version (conds: 39 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O2":
    "conds+version (conds: 15 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O2":
    "conds+version (conds: 19 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+check@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+check@O2":
    "conds+version (conds: 20 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off@O1":
    "conds (conds: 1 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off@O2":
    "conds+version (conds: 112 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc@O1":
    "conds (conds: 1 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc@O2":
    "conds+version (conds: 112 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O1":
    "conds (conds: 4 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O2":
    "conds+version (conds: 15 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O1":
    "conds (conds: 4 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O2":
    "conds+version (conds: 15 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+check@O1":
    "conds (conds: 4 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+check@O2":
    "conds+version (conds: 34 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off@O1":
    "conds (conds: 7 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off@O2":
    "conds+version (conds: 200 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc@O1":
    "conds (conds: 7 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc@O2":
    "conds+version (conds: 200 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc+off@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc@O2":
    "conds (conds: 11 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O2":
    "conds+version (conds: 8 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O2":
    "conds+version (conds: 8 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+check@O2":
    "conds+version (conds: 36 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off@O1":
    "conds (conds: 3 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off@O2":
    "conds+version (conds: 208 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O1":
    "conds (conds: 3 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O2":
    "conds+version (conds: 208 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+check@O2":
    "conds (conds: 12 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+off@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+off@O2":
    "conds (conds: 59 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O2":
    "conds (conds: 59 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@leak@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@manual@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc+check@O2":
    "conds+version (conds: 22 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc+off@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc+off@O2":
    "conds+version (conds: 17 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc@O2":
    "conds+version (conds: 9 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@leak@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@leak@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@manual@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@manual@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+check@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+check@O2":
    "conds (conds: 47 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+off@O1":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+off@O2":
    "conds (conds: 231 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O1":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O2":
    "conds (conds: 231 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@leak@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@manual@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+check@O2":
    "conds+version (conds: 90 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+off@O1":
    "conds (conds: 5 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+off@O2":
    "conds+version (conds: 404 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc@O1":
    "conds (conds: 5 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc@O2":
    "conds+version (conds: 404 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@leak@O1":
    "conds (conds: 8 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@leak@O2":
    "conds+version (conds: 39 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@manual@O1":
    "conds (conds: 8 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@manual@O2":
    "conds+version (conds: 39 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+check@O1":
    "conds (conds: 8 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+check@O2":
    "conds+version (conds: 182 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off@O1":
    "conds (conds: 24 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off@O2":
    "conds+version (conds: 1022 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc@O1":
    "conds (conds: 24 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc@O2":
    "conds+version (conds: 1022 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@leak@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@leak@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@manual@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@manual@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+check@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+check@O2":
    "conds (conds: 34 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+off@O1":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+off@O2":
    "conds (conds: 144 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc@O1":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc@O2":
    "conds (conds: 144 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@leak@O1":
    "conds (conds: 0 branches, 7 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@leak@O2":
    "conds+version (conds: 2 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@manual@O1":
    "conds (conds: 0 branches, 7 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@manual@O2":
    "conds+version (conds: 2 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc+check@O1":
    "conds (conds: 0 branches, 7 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc+check@O2":
    "conds+version (conds: 4 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc+off@O1":
    "conds (conds: 0 branches, 7 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc+off@O2":
    "conds+version (conds: 24 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc@O1":
    "conds (conds: 0 branches, 7 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc@O2":
    "conds+version (conds: 24 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@leak@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@manual@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+check@O2":
    "conds (conds: 150 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+off@O1":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+off@O2":
    "conds (conds: 495 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc@O1":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc@O2":
    "conds (conds: 28 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+check@O2":
    "conds+version (conds: 28 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off@O1":
    "conds (conds: 2 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off@O2":
    "conds+version (conds: 159 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O1":
    "conds (conds: 2 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O2":
    "conds+version (conds: 159 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@leak@O2":
    "conds+version (conds: 18 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual@O2":
    "conds+version (conds: 18 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+check@O2":
    "conds+version (conds: 108 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off@O1":
    "conds (conds: 5 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off@O2":
    "conds+version (conds: 297 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc@O1":
    "conds (conds: 5 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc@O2":
    "conds+version (conds: 23 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@leak@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@leak@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@manual@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@manual@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+check@O1":
    "conds (conds: 0 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+check@O2":
    "conds+version (conds: 12 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+off@O1":
    "conds (conds: 1 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+off@O2":
    "conds+version (conds: 45 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O1":
    "conds (conds: 1 branches, 2 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O2":
    "conds+version (conds: 45 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@leak@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@leak@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@manual@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@manual@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc+check@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc+check@O2":
    "conds+version (conds: 19 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc+off@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc+off@O2":
    "conds+version (conds: 55 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc@O1":
    "conds (conds: 0 branches, 5 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/str_methods.ts@rc@O2":
    "conds+version (conds: 55 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_slab.ts@O1":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_slab.ts@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_vec.ts@O2":
    "conds (conds: 9 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/gen_adversarial.ts@O1":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/gen_adversarial.ts@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/lang_misc.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/mem/lang_misc.ts@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/leak/leak_slab.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/leak/leak_slab.ts@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/manual/manual_slab.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/manual/manual_slab.ts@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/strict_explicit/strict_same.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/strict_explicit/strict_same.ts@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/strict_same.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/memory/strict_same.ts@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/native/math_values.ts@rc+check@O2":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/native/math_values.ts@rc+off@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/pos/matmul_f64.ts@O2":
    "version (version: 3 loops, 5 checks)",
  "corpus/memory/opt-tirhash.json#corpus/pos/rle.ts@O1":
    "conds (conds: 0 branches, 0 compares, 2 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_memory.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_memory.ts@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_std.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_std.ts@O2":
    "conds (conds: 70 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/builder.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/builder.ts@O2":
    "conds (conds: 33 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/ergo_alloc.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/ergo_alloc.ts@O2":
    "conds+version (conds: 13 branches, 0 compares, 0 bounds checks; version: 1 loops, 1 checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/ergo_std.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/ergo_std.ts@O2":
    "conds (conds: 59 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/graph.ts@O2":
    "conds (conds: 71 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/job_queue.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/job_queue.ts@O2":
    "conds (conds: 73 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/leak/std_leak.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/leak/std_leak.ts@O2":
    "conds (conds: 72 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/manual/std_manual.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/manual/std_manual.ts@O2":
    "conds (conds: 60 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/model.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/model.ts@O2":
    "conds (conds: 118 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/named.ts@O2":
    "conds (conds: 57 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/sort.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/sort.ts@O2":
    "conds (conds: 89 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/stack_holders.ts@O2":
    "conds (conds: 51 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_default.ts@O2":
    "conds (conds: 50 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_gen_adversarial.ts@O1":
    "conds (conds: 5 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_gen_adversarial.ts@O2":
    "conds (conds: 68 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_new_safety.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_new_safety.ts@O2":
    "conds (conds: 176 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_replaced.ts@O2":
    "conds (conds: 51 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_slab_safety.ts@O1":
    "conds (conds: 4 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_slab_safety.ts@O2":
    "conds (conds: 79 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/std_vec_safety.ts@O2":
    "conds (conds: 58 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/tree.ts@O1":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/tree.ts@O2":
    "conds (conds: 57 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/word_count.ts@O1":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/opt-tirhash.json#corpus/std/word_count.ts@O2":
    "conds (conds: 69 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@leak@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@manual@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_events.ts@leak@O2":
    "conds+version (conds: 5 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_events.ts@manual@O2":
    "conds+version (conds: 5 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_interp.ts@leak@O2":
    "conds+version (conds: 5 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_interp.ts@manual@O2":
    "conds+version (conds: 5 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_parser.ts@leak@O2":
    "conds+version (conds: 19 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_parser.ts@manual@O2":
    "conds+version (conds: 19 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_retry.ts@leak@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_retry.ts@manual@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_using.ts@leak@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_using.ts@manual@O2":
    "conds+version (conds: 4 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_visitor.ts@leak@O2":
    "conds+version (conds: 2 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_visitor.ts@manual@O2":
    "conds+version (conds: 2 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/basic_try.ts@leak@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/basic_try.ts@manual@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/cast_unknown.ts@leak@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/cast_unknown.ts@manual@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/class_init_order.ts@leak@O2":
    "conds+version (conds: 28 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/class_init_order.ts@manual@O2":
    "conds+version (conds: 28 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/class_shapes.ts@leak@O2":
    "conds+version (conds: 0 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/class_shapes.ts@manual@O2":
    "conds+version (conds: 0 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/dyn_truthy.ts@leak@O2":
    "conds+version (conds: 2 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/dyn_truthy.ts@manual@O2":
    "conds+version (conds: 2 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/dyn_truthy_nostr.ts@leak@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/dyn_truthy_nostr.ts@manual@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_effects.ts@leak@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_effects.ts@manual@O2":
    "conds (conds: 6 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_exhaust.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_exhaust.ts@manual@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_paths.ts@leak@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/exc_paths.ts@manual@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/runtime_errors.ts@leak@O2":
    "conds+version (conds: 3 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/runtime_errors.ts@manual@O2":
    "conds+version (conds: 3 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/throw_values.ts@leak@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/throw_values.ts@manual@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/validate_errors.ts@leak@O2":
    "conds+version (conds: 3 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/validate_errors.ts@manual@O2":
    "conds+version (conds: 3 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual@O2":
    "conds (conds: 7 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/js_throw_through.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/js_throw_through.ts@manual@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/map_set.ts@leak@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/map_set.ts@manual@O2":
    "conds (conds: 3 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O2":
    "conds (conds: 2 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/maps/move_ops.ts@leak@O2":
    "conds+version (conds: 22 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/maps/move_ops.ts@manual@O2":
    "conds+version (conds: 22 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/rc-only/cast_lie.ts@leak@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/rc-only/cast_lie.ts@manual@O2":
    "conds (conds: 1 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_builder.ts@leak@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_builder.ts@manual@O2":
    "conds+version (conds: 3 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O2":
    "conds+version (conds: 26 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O2":
    "conds+version (conds: 25 branches, 10 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_json.ts@leak@O2":
    "conds+version (conds: 17 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_json.ts@manual@O2":
    "conds+version (conds: 17 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_text.ts@leak@O2":
    "conds+version (conds: 17 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_text.ts@manual@O2":
    "conds+version (conds: 17 branches, 13 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O2":
    "conds+version (conds: 15 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O2":
    "conds+version (conds: 19 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O2":
    "conds+version (conds: 15 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O2":
    "conds+version (conds: 15 branches, 4 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O2":
    "conds+version (conds: 8 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O2":
    "conds+version (conds: 8 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/gaps_context.ts@leak@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/gaps_context.ts@manual@O2":
    "conds (conds: 14 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/misc.ts@leak@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/misc.ts@manual@O2":
    "conds (conds: 13 branches, 0 compares, 0 bounds checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/num_text.ts@leak@O2":
    "conds+version (conds: 2 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/num_text.ts@manual@O2":
    "conds+version (conds: 2 branches, 8 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O2":
    "conds+version (conds: 0 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/smoke.ts@leak@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/smoke.ts@manual@O2":
    "conds+version (conds: 1 branches, 3 compares, 0 bounds checks; version: 4 loops, 4 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/str_methods.ts@leak@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/str_methods.ts@manual@O2":
    "conds+version (conds: 9 branches, 6 compares, 0 bounds checks; version: 7 loops, 7 checks)",
};

/** A pin R15 moved and set aside: none (each is pinned again, above). */
export const R15_MOVED: Record<string, string> = {};

/** A pin R15 moved, by its key (`file@mode@O1` and the like), in any pin file: none is set aside. */
export const r15Moved = (k: string): boolean =>
  Object.keys(R15_MOVED).some((x) => x.endsWith(`#${k}`));
