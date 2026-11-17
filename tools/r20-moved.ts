// Written by tools/r20-pins.ts --write: each pin R20 moved (SPEC M5's R20 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R20_MOVED, as R10 to R19 set theirs.

/** What each of R20's stages is, by the name tools/r20-pins.ts gives it. */
export const R20_WHY: Record<string, string> = {
  alloca:
    "partial inlining at -O2 (R20, inline.ts, D46): a callee whose entry gives a frame slot that the copied paths don't use taken partially, the slot left out of the copy, so its side-effect-free entry and the paths with no call are inlined and the rest calls it; an rc class printing's new on a rare path (a throw's object, a slow path's) builds in such a slot",
};

/** Each pin R20 moved and pinned again, with the stage that moved it. */
export const R20_REPINNED: Record<string, string> = {
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_events.ts@rc@O2": "alloca",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2": "alloca",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2": "alloca",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2": "alloca",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2": "alloca",
  "corpus/memory/lang-a-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_events.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_parser.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_retry.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/app_using.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/basic_try.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/exc/validate_errors.ts@rc@O2": "alloca",
  "corpus/memory/maps-tirhash.json#corpus/lower/maps/move_ops.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_builder.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_lru.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_text.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_wordcount.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps.ts@rc+check@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/map_basic.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/num_text.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@manual@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc+off@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_cycles.ts@rc@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_memory.ts@O2": "alloca",
  "corpus/memory/opt-tirhash.json#corpus/std/builder.ts@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_events.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_events.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_parser.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_parser.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_retry.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/app_retry.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/basic_try.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/basic_try.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/validate_errors.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/exc/validate_errors.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/maps/move_ops.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/maps/move_ops.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_builder.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_builder.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_tokenizer.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_wordcount.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/app_wordcount.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/drop_bound.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/drop_bound.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/num_text.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/num_text.ts@manual@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/rc_churn.ts@leak@O2": "alloca",
  "corpus/memory/pipe-tirhash.json#corpus/lower/strmap/rc_churn.ts@manual@O2": "alloca",
};

/** A pin R20 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R20_MOVED: Record<string, string> = {};

/** A pin R20 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r20Moved = (k: string): boolean =>
  Object.keys(R20_MOVED).some((x) => x.endsWith(`#${k}`));
