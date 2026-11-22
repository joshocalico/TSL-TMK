// Written by tools/r36-pins.ts --write: each pin R36 moved (SPEC M5's R36 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R36_MOVED, as R10 to R35 set theirs.

/** What each of R36's stages is, by the name tools/r36-pins.ts gives it. */
export const R36_WHY: Record<string, string> = {
  trust:
    "the route (R36): `TRUSTED_IN` rc's class printing on, so `auto` takes through the TSL route a program in `rc` whose only blocker was a reshape there, its speed rule met at -O1 and -O2; a route switch, at every level, never TSL proper's",
};

/** Each pin R36 moved and pinned again, with the stage that moved it. */
export const R36_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/class_list.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_known.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_known.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/closure_selected.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/relative_import.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/relative_import.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/case_all.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/frag.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/gaps_context.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc@O2": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O1": "trust",
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/smoke.ts@rc@O2": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/class_list.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/closure_known.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/closure_selected.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/relative_import.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/case_all.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/drop_bound.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/frag.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/rc_churn.ts@rc": "trust",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/strmap/smoke.ts@rc": "trust",
};

/** A pin R36 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R36_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/class_list.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/closure_known.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/closure_selected.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/relative_import.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc-only/cyc_exhaust.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_forof_mutation.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_method_this.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_self_assign_swap.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@rc": "trust",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@rc": "trust",
};

/** A pin R36 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r36Moved = (k: string): boolean =>
  Object.keys(R36_MOVED).some((x) => x.endsWith(`#${k}`));
