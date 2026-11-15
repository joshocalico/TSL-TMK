// Written by tools/r6-pins.ts --write: each pin R6 moved (SPEC M5's R6 record), by pin file and key, with the change that
// moved it and, for the layout, what in the build D36's old rule and TSL's lay out differently (down-model.ts's
// layoutNotes). maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R6's changes is, by the name tools/r6-pins.ts's stages give it. */
export const R6_WHY: Record<string, string> = {
  jsrt: "@tsl/jsrt's source changed (R6): JsArray's growth asks whether the array is in the per-call region (inCallRegion), which a build with nothing there answers with a constant, and JsMap's scratch word traps 14 when the global allocator has none",
  layout:
    "D36 moved to TSL's own layout, per the owner's ruling (D62, R6): a bool a byte, an optional scalar a bool flag then its value, an object's size rounded to its alignment only; the build lays out an object, vector or module state that way",
  checks:
    "a vector read's bounds check printed as JsArray's get alone, and the source's ! on a read as TSL's own checked ! (R6: one check of each where -O1 made two)",
  region:
    "tslc's per-call region (R6, region.ts): a heap new no export call outlives placed in the call arena, which each export gives back at its returns",
  closures:
    "auto prints closure values as environment classes in leak and manual (R6: AUTO_CLOSURES), where the direct route built them",
  boundary:
    "auto prints an exported function taking or giving an object with classes (R6: AUTO_BOUNDARY), in D36's listed layout, where phase 1's printing built it",
};

export const R6_MOVED: Record<string, [string, string?]> = {
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/adv_exc_drop.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_events.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_events.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_interp.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_visitor.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_visitor.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/class_init_order.ts@rc@O0": [
    "layout",
    "an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/class_init_order.ts@rc@O2": [
    "layout",
    "an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_effects.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_exhaust.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_paths.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/exc_paths.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_catch_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continue.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_finally_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_breakOuter.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_catch_try_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continue.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_catch_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continue.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_normal.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_return.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_finally_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_finally_try_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_breakOuter.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_catch_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_breakOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O0":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_continueOuter.ts@rc@O2":
    [
      "layout",
      "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
    ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_finally_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_break.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_breakOuter.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continue.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_continueOuter.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_normal.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_return.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/gen_finally_try_try_throw.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/runtime_errors.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/throw_values.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/throw_values.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O0": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_outlives.ts@leak": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_outlives.ts@manual": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": ["jsrt+region"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": ["jsrt+region"],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/init_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/init_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/map_set.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/map_set.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/shape_widened.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/shape_widened.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": ["jsrt+region"],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": ["jsrt+region"],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/results_d36.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/results_d36.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@leak": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@manual": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/closure_selected.ts@leak": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/closure_selected.ts@manual": ["closures"],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/destructure_spread.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/destructure_spread.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/export_glue.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/export_glue.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/generics_mono.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/generics_mono.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/math_host.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/math_host.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/nullable.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/nullable.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@manual@O1": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@manual@O2": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O1": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O2": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O1": [
    "jsrt+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O2": [
    "jsrt+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+check@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+off@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/map_set.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@leak@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@leak@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@manual@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@manual@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+off@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+off@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@strict@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/shape_widened.ts@strict@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/throw_value.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/try_catch.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O1": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O2": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O1": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O2": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/results_d36.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@manual@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@manual@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@leak@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@leak@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@manual@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@manual@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+off@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+off@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@strict@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/destructure_spread.ts@strict@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@leak@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@leak@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@manual@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@manual@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+off@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc+off@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@rc@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@strict@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/export_glue.ts@strict@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@strict@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/math_host.ts@strict@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@leak@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@leak@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@manual@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@manual@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+check@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+check@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+off@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc+off@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@rc@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@strict@O1": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/nullable.ts@strict@O2": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@leak@O1": ["checks"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@leak@O2": ["checks"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@manual@O1": ["checks"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@manual@O2": ["checks"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O1": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O2": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O1": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O2": [
    "closures",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak@O1": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak@O2": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual@O1": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual@O2": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O1": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O2": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O1": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O2": ["jsrt+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak@O1": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak@O2": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual@O1": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual@O2": ["region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O1": [
    "jsrt+checks+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O2": [
    "jsrt+checks+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O1": [
    "jsrt+checks+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O2": [
    "jsrt+checks+region",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O2": ["closures"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O1": ["jsrt+checks+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O2": ["jsrt+checks+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O1": ["jsrt+checks+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O2": ["jsrt+checks+region"],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_json.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/misc.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@leak@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@leak@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@manual@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@manual@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+check@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+check@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+off@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc+off@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O1": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O2": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": ["jsrt+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": [
    "jsrt+region",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/init_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/init_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/map_set.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/map_set.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/map_set.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/shape_widened.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/throw_value.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/try_catch.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": ["jsrt+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": ["jsrt+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/results_d36.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/results_d36.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/results_d36.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/results_d36.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@manual": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/closure_selected.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/closure_selected.ts@manual": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/destructure_spread.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/export_glue.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/math_host.ts@strict": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/nullable.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@leak": ["checks"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@manual": ["checks"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak": [
    "closures",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak": ["region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual": ["region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": ["jsrt+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": ["jsrt+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak": ["region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual": ["region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": [
    "jsrt+checks+region",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": [
    "jsrt+checks+region",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": ["closures"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": ["jsrt+checks+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": ["jsrt+checks+region"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_graph.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_graph.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_graph.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_json.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_json.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_json.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_json.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_json.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_lru.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_lru.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_lru.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_text.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/iter_mutation.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/iter_mutation.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/iter_mutation.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/map_basic.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/map_basic.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/map_basic.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/misc.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/misc.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/misc.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/misc.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/misc.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_borrow.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_borrow.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_borrow.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_cycles.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/callee_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/callee_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@leak": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": [
    "jsrt+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": [
    "jsrt+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/init_blocked.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/init_blocked.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/map_set.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/map_set.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/map_set.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/map_set.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/shape_widened.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/throw_value.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/try_catch.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": ["jsrt+region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": [
    "jsrt+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/results_d36.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/results_d36.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/results_d36.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/results_d36.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@leak": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/closure_selected.ts@leak": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/closure_selected.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/destructure_spread.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/export_glue.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@leak": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@manual": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@rc+off": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/math_host.ts@strict": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@leak": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@manual": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@rc+off": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/nullable.ts@strict": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@leak": ["checks"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@manual": ["checks"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual": [
    "closures",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_control_paths.ts@leak": ["region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_control_paths.ts@manual": ["region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": ["jsrt+region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": [
    "jsrt+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak": ["region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual": ["region"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": [
    "jsrt+checks+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": [
    "jsrt+checks+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": ["closures"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": [
    "jsrt+checks+region",
  ],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": [
    "jsrt+checks+region",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/callee_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/inheritance.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/inheritance.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/init_blocked.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/map_set.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/map_set.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/shape_widened.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/throw_value.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/throw_value.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/try_catch.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/fallback/try_catch.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/memory/results_d36.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/memory/results_d36.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4; an object whose size TSL's rule rounds to its alignment, not to 8",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/destructure_spread.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/export_glue.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/export_glue.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/generics_mono.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/generics_mono.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/math_host.ts@rc+check": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/math_host.ts@rc": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/nullable.ts@rc+check": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/rc-off-tirhash.json#corpus/lower/pos/nullable.ts@rc": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/fallback/shape_widened.ts": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/destructure_spread.ts": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/export_glue.ts": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/generics_mono.ts": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/math_host.ts": [
    "layout",
    "a bool in memory, a byte where it was 4",
  ],
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/nullable.ts": [
    "layout",
    "an object whose size TSL's rule rounds to its alignment, not to 8; an optional scalar in memory, a bool flag before its value",
  ],
};

/** Why a pin moved, by the stages that moved it (`layout+region`: both). */
export const r6Why = (stage: string): string =>
  stage
    .split("+")
    .map((s) => R6_WHY[s] ?? s)
    .join("; and ");

/** A pin R6 moved, by its key (`file@mode@O2` and the like), in any pin file. */
export const r6Moved = (k: string): boolean =>
  Object.keys(R6_MOVED).some((x) => x.endsWith(`#${k}`));
