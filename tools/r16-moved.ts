// Written by tools/r16-pins.ts --write: each pin R16 moved (SPEC M5's R16 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R16_MOVED, as R10 to R12 set theirs.

/** What each of R16's stages is, by the name tools/r16-pins.ts gives it. */
export const R16_WHY: Record<string, string> = {
  jsrt: "@tsl/jsrt's JsArray and JsArenaArray (R16, D66): made at their final size in one step by an inlined constructor, push inlined with its slow path (pushGrow) out of line, setLength and clear inlined, growth leaner; a library change, which moves a lowered program's pins at every level (D44)",
  pushlen:
    "class printing (R16, emit-tsl.ts's pushedLength): a push whose value nothing uses no longer prints the lowering's read of the array's length after it",
};

/** Each pin R16 moved and pinned again, with the stage that moved it. */
export const R16_REPINNED: Record<string, string> = {
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsrt",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsrt",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": "jsrt+pushlen",
  "corpus/memory/modes-tirhash.json#corpus/lower/fallback/escape_global.ts@manual": "jsrt+pushlen",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsrt+pushlen",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsrt+pushlen",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@leak": "jsrt+pushlen",
  "corpus/memory/modes-tirhash.json#corpus/lower/memory/store_closure.ts@manual": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O1":
    "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak@O2":
    "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O1":
    "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual@O2":
    "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O1": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O2": "jsrt",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@leak@O2": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O1": "jsrt+pushlen",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_large.ts@manual@O2": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@manual":
    "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak":
    "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual":
    "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict": "jsrt",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": "jsrt+pushlen",
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/generics_mono.ts": "jsrt",
};

/** A pin R16 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R16_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@leak": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_escape.ts@manual": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@leak":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@manual":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/grow_reuse.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@leak":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@manual":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/generics_mono.ts@strict": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@leak":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_closure_clears_holder.ts@manual":
    "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_large_drop.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@leak": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@manual": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict": "jsrt",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_churn.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@leak": "jsrt+pushlen",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/cyc_large.ts@manual": "jsrt+pushlen",
};

/** A pin R16 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r16Moved = (k: string): boolean =>
  Object.keys(R16_MOVED).some((x) => x.endsWith(`#${k}`));
