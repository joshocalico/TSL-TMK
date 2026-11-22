// Which pinned tirhashes the pipeline's phase 2, third chunk, moves, and why (SPEC M5, 3.5). Each program is listed with the
// change that moves it, found by computing every pinned tirhash with that change on and off (TMK_TSL_OPT_OFF=ctorzero).
export const PIPE_C_MOVED: Record<string, string> = {
  "corpus/lower/pos/generics_mono.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in strict, where auto class-prints it since R13 prints its arrays as @tsl/jsrt's arena array (AUTO_STRICT_ARRAYS, tools/r13-pins.ts)",
  "corpus/lower/pos/class_struct.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R7 prints a typed-array field as a runtime class of its pointer and length (tools/r7-pins.ts)",
  "corpus/lower/pos/read_checks.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); R6's program of reads, which auto class-prints in leak and manual (its arrays as JsArray)",
  "corpus/lower/pos/closure_selected.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R6 prints closure values there (AUTO_CLOSURES, tools/r6-pins.ts)",
  "corpus/lower/fallback/closure_escape.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R6 prints closure values there (AUTO_CLOSURES, tools/r6-pins.ts)",
  "corpus/lower/rc/adv_closure_clears_holder.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R6 prints closure values there (AUTO_CLOSURES, tools/r6-pins.ts)",
  "corpus/lower/rc/cyc_churn.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R6 prints closure values there (AUTO_CLOSURES, tools/r6-pins.ts)",
  "corpus/lower/rc/cyc_interleave.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since R6 prints closure values there (AUTO_CLOSURES, tools/r6-pins.ts)",
  "corpus/lower/fallback/closure_outlives.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto builds it through the TSL route since R4 (AUTO_RC, tools/r4-pins.ts)",
  "corpus/lower/memory/store_closure.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto builds it through the TSL route since R4 (AUTO_RC, tools/r4-pins.ts)",
  "bench/memory/list_lowered.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto builds it through the TSL route since R4 (AUTO_RC, tools/r4-pins.ts)",
  "bench/memory/churn_lowered.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto builds it through the TSL route since R4 (AUTO_RC, tools/r4-pins.ts)",
  "corpus/lower/fallback/escape_global.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/memory/grow_reuse.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/pos/int_overflow.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/rc/adv_large_drop.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/rc/adv_temporaries.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/rc/cyc_large.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in leak and manual, where auto class-prints it since its arrays print as JsArray (pipe-e, D66)",
  "corpus/lower/fallback/inheritance.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/memory/class_list.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/rc-only/cyc_exhaust.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/rc/adv_control_paths.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/rc/adv_method_this.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/rc/cyc_giveup.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/lower/rc/rc_shared.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/alloc_heap.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/alloc_slab.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/alloc_vec.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  // R36: `TRUSTED_IN` rc on, so auto class-prints these in rc, where zeroed construction applies.
  "corpus/lower/pos/relative_import.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/memory/map_grow_oom.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/rc/adv_forof_mutation.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/rc/adv_self_assign_swap.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/case_all.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/drop_bound.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/frag.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/gaps_context.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/rc_churn.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  "corpus/lower/strmap/smoke.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since R36 trusts rc's class printing (TRUSTED_IN, tools/r36-pins.ts)",
  // pipe-dispatch's page sources as objects (D70): new programs, each with a `calls: usize = 0` field.
  "corpus/mem/pagesrc_one.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/pagesrc_two.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/closures.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/gen_adversarial.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/inline_mem.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/lang_misc.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/mem/plain_class.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/leak/leak_cross.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/leak/leak_exhaust.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/leak/leak_list.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/leak/leak_pages.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/leak/leak_slab.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/manual/manual_free.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/manual/manual_list.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/manual/manual_pages.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/manual/manual_slab.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/strict_explicit/strict_same.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/strict_same.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/memory/strict_user.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/spec/run_memory.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/spec/run_std.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/builder.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/ergo_alloc.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/ergo_std.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/graph.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/job_queue.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/leak/std_leak.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/manual/std_manual.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/map_js.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/model.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/named.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/nosource/std_no_source.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/rc_gc.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/sort.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/stack_holders.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_default.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_gen_adversarial.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_new_safety.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_replaced.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_slab_safety.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/std_vec_safety.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/tree.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  "corpus/std/word_count.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction)",
  // R38: `TRUSTED_EXC_IN` rc and `TRUSTED_RESHAPES_IN` rc on, so auto class-prints these in rc, where zeroed construction applies.
  "corpus/lower/fallback/js_throw_through.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since exceptions trusted in rc's class printing since R38 (TRUSTED_EXC_IN, tools/r38-pins.ts)",
  "corpus/lower/fallback/throw_value.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since exceptions trusted in rc's class printing since R38 (TRUSTED_EXC_IN, tools/r38-pins.ts)",
  "corpus/lower/fallback/try_catch.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since exceptions trusted in rc's class printing since R38 (TRUSTED_EXC_IN, tools/r38-pins.ts)",
  "corpus/lower/rc/adv_shared_capture.ts":
    "a field initialiser of zero is not stored by a constructor all of whose objects start zeroed, and a constructor left empty is neither called nor emitted (SPEC 3.5, zeroed construction); in rc, where auto class-prints it since a for step with statements trusted in rc's class printing since R38 (TRUSTED_RESHAPES_IN, tools/r38-pins.ts)",
};

/** A lowered program's pin moves only where class printing takes it, `leak` and `manual`; a TSL program's at any level. */
export const pipeCMoved = (k: string): boolean => {
  const [file, mode] = k.split("@");
  if (file === undefined || PIPE_C_MOVED[file] === undefined) return false;
  return !file.startsWith("corpus/lower/") || mode === "leak" || mode === "manual";
};
