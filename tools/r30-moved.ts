// Written by tools/r30-pins.ts --write: each pin R30 moved (SPEC M5's R30 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R30_MOVED, as R10 to R29 set theirs.

/** What each of R30's stages is, by the name tools/r30-pins.ts gives it. */
export const R30_WHY: Record<string, string> = {
  gc: "@tsl/gc (R30): make and makeTail find only the slot out of line (slotSlow, slotAfter, tailSlot, tailSlotAfter) and place the object in line, so it's never given to a call; with the collector, a fresh slot cut from its chunk in line (chunkCut) where slotFor's dryStep would do nothing; a library change, which moves the pins of a program that makes counted objects, at every level",
  zeroed:
    "rc class printing's jsStrZeroed (R30, emit-rcstr.ts): its length tested once, as a u32, where it was tested as an i32 twice and checked again by toUsize; a printer change, at every level",
  copy: "rc class printing (R30, emit-tsl.ts, emit-rcstr.ts): compiler/rt's strCopy as JsStr's copyFrom, and strRepeat's loop of strCopy calls as JsStr's repeatFrom, copies that double; a printer change, at every level",
  sroa: "scalar replacement (R30, sroa.ts): a copy out of a frame slot (a new object placed in its slot) written as stores of its fields, and a fill as stores of zero a word at a time, in any block that dominates the slot's uses; -O2, and at -O1 a copy out of a slot alone (D44)",
};

/** Each pin R30 moved and pinned again, with the stage that moved it. */
export const R30_REPINNED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O1": "gc+sroa",
  "corpus/memory/opt-tirhash.json#bench/memory/churn_lowered.ts@rc@O2": "gc+sroa",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O1": "gc+sroa",
  "corpus/memory/opt-tirhash.json#bench/memory/list_lowered.ts@rc@O2": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O1": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc@O2": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O1": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/escape_global.ts@rc@O2": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@leak@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/fallback/inheritance.ts@manual@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O2": "gc+sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@leak@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@manual@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@strict@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/generics_mono.ts@strict@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@leak@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_method_this.ts@manual@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_temporaries.ts@strict@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_heap.ts@O1": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_heap.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/alloc_vec.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/gen_adversarial.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/lang_misc.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/layout.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/mem/plain_class.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/memory/leak/leak_list.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/memory/manual/manual_list.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/memory/manual/manual_slab.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/spec/run_memory.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/std/job_queue.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/std/stack_holders.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/std/std_gen_adversarial.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/std/std_vec_safety.ts@O2": "sroa",
  "corpus/memory/opt-tirhash.json#corpus/std/word_count.ts@O2": "sroa",
  "corpus/memory/pre-std-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R30 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R30_MOVED: Record<string, string> = {
  "corpus/memory/pre-strings-tirhash.json#bench/memory/churn_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#bench/memory/list_lowered.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/closure_outlives.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/fallback/escape_global.ts@rc": "gc",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/memory/store_closure.ts@rc": "gc",
};

/** A pin R30 moved and set aside, by its key (`file@mode@O1` and the like). */
export const r30Moved = (k: string): boolean =>
  Object.keys(R30_MOVED).some((x) => x.endsWith(`#${k}`));
