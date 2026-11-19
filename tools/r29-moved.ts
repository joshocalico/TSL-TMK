// Written by tools/r29-pins.ts --write: each pin R29 moved (SPEC M5's R29 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R29_MOVED, as R10 to R28 set theirs.

/** What each of R29's stages is, by the name tools/r29-pins.ts gives it. */
export const R29_WHY: Record<string, string> = {
  jsmap:
    "@tsl/jsrt's JsMap (R29): its lookups' loops test (s - 2) >>> 0 below 2^31 - 2, a table's chain as long as its heads (an insert sets its slot), growth reserving its four arrays before giving them lengths, the old table going in one method, a moved key stored by link, and seek and find inlined; a library change, which moves the pins of a program with maps, lowered or hand-written, at every level",
  links:
    "the table-links proof (R29, D79, links.ts): a JsArray read tslc proves in bounds loses its leading bounds check where the inliner copies it (inline.ts); -O1 and -O2 only (D44)",
};

/** Each pin R29 moved and pinned again, with the stage that moved it. */
export const R29_REPINNED: Record<string, string> = {
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@leak": "jsmap",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@manual": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O2": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O1": "jsmap",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O2": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": "jsmap",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": "jsmap",
};

/** A pin R29 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R29_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak":
    "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual":
    "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": "jsmap",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": "jsmap",
};

/** A pin R29 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r29Moved = (k: string): boolean =>
  Object.keys(R29_MOVED).some((x) => x.endsWith(`#${k}`));
