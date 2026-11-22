// Written by tools/r38-pins.ts --write: each pin R38 moved (SPEC M5's R38 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R38_MOVED, as R10 to R37 set theirs.

/** What each of R38's stages is, by the name tools/r38-pins.ts gives it. */
export const R38_WHY: Record<string, string> = {
  units:
    "the printing (R38): rc's string runtime answers `compare` and `jsStrEq` of two strings of one unit each by their units in line, in every lowered rc program class printing gives strings to, at every level (the runtime is printed TSL), never TSL proper's",
  kinds:
    "the route (R38): `TRUSTED_RESHAPES_IN` rc, so `auto` takes in rc's class printing a program reshaped by a loop whose step or condition has statements of its own (and otherwise by kinds it trusts), every one no slower at -O1 and -O2; a route switch, at every level, never TSL proper's",
  exc: "the route (R38): `TRUSTED_EXC_IN` rc on, so `auto` takes in rc's class printing a program with exceptions printed reshaped only by kinds it trusts there, every one no slower at -O1 and -O2; a route switch, at every level, never TSL proper's",
};

/** Each pin R38 moved and pinned again, with the stage that moved it. */
export const R38_REPINNED: Record<string, string> = {
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O2": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O0": "exc",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_using.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O0":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O2":
    "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O2": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O0": "exc",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc@O1": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc@O2": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O1": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O2": "exc",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc@O1": "kinds",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc@O2": "kinds",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc@O1": "kinds",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc@O2": "kinds",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc@O2": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O2": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O2": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O2": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O2": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O1": "units",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O2": "units",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@rc": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@rc": "exc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc": "kinds",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc": "kinds",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/case_all.ts@rc": "units",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc": "units",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@rc": "units",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc": "units",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@rc": "units",
};

/** A pin R38 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R38_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@rc": "exc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@rc": "exc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_control_paths.ts@rc": "kinds",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_shared_capture.ts@rc": "kinds",
};

/** A pin R38 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r38Moved = (k: string): boolean =>
  Object.keys(R38_MOVED).some((x) => x.endsWith(`#${k}`));
