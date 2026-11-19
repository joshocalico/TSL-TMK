// Written by tools/r27-pins.ts --write: each pin R27 moved (SPEC M5's R27 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R27_MOVED, as R10 to R26 set theirs.

/** What each of R27's stages is, by the name tools/r27-pins.ts gives it. */
export const R27_WHY: Record<string, string> = {
  sep: "fresh-allocation separation (R27, D77): tslc's rule (separate.ts) separates a class's u64 field that holds only blocks no object can be in (@tsl/jsrt's JsArray.data), and the optimiser (memory.ts) takes a store into such a block as unable to change any object's field, and a call that writes only such blocks and its own frame as writing no field, so value numbering, LICM and peeling keep a length or a field read across them, and a check the kept value proves goes; -O1 and -O2 only (D44)",
};

/** Each pin R27 moved and pinned again, with the stage that moved it. */
export const R27_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O2": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1": "sep",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O2": "sep",
};

/** A pin R27 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R27_MOVED: Record<string, string> = {};

/** A pin R27 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r27Moved = (k: string): boolean =>
  Object.keys(R27_MOVED).some((x) => x.endsWith(`#${k}`));
