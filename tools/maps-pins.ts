// Which pinned tirhashes the maps work moves, and why (SPEC M5, Maps phase).
import { r4Moved } from "./r4-pins.ts";
import { r5Moved } from "./r5-pins.ts";
import { r6Moved } from "./r6-moved.ts";
import { r7Moved } from "./r7-moved.ts";
import { r8Moved } from "./r8-moved.ts";
import { r9Moved } from "./r9-moved.ts";
import { r10Moved } from "./r10-moved.ts";
import { r11Moved } from "./r11-moved.ts";
import { r12Moved } from "./r12-moved.ts";
import { r13Moved } from "./r13-moved.ts";
import { r14Moved } from "./r14-moved.ts";
import { r15Moved } from "./r15-moved.ts";
import { r16Moved } from "./r16-moved.ts";
import { r17Moved } from "./r17-moved.ts";
import { r18Moved } from "./r18-moved.ts";
import { r19Moved } from "./r19-moved.ts";
import { r20Moved } from "./r20-moved.ts";
import { r21Moved } from "./r21-moved.ts";
import { r22Moved } from "./r22-moved.ts";
import { r24Moved } from "./r24-moved.ts";
import { r25Moved } from "./r25-moved.ts";
import { r26Moved } from "./r26-moved.ts";
import { r27Moved } from "./r27-moved.ts";
import { r29Moved } from "./r29-moved.ts";
import { r30Moved } from "./r30-moved.ts";
import { r31Moved } from "./r31-moved.ts";
import { clsidMoved } from "./clsid-moved.ts";
import { r1dMoved } from "./r1d-moved.ts";
import { r1fMoved } from "./r1f-moved.ts";
import { optBMoved } from "./opt-b-moved.ts";
import { pipeBMoved } from "./pipe-b-pins.ts";
import { pipeCMoved } from "./pipe-c-pins.ts";
import { pipeEMoved } from "./pipe-e-pins.ts";
import { pipeHMoved } from "./pipe-h-pins.ts";
/**
 * In a memory mode only (`mapsMoved` never matches a strict build): `@tsl/std`'s maps changed (D47).
 */
export const MAPS_MOVED: Record<string, string> = {
  "corpus/spec/run_std.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/ergo_std.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/graph.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/job_queue.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/leak/std_leak.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/manual/std_manual.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/model.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/named.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/std_new_safety.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
  "corpus/std/word_count.ts": "uses @tsl/std's Map, now ExactMap, or the new JS Map (D47)",
};

/**
 * In any build, strict's included: the lowered programs whose integer arithmetic wasn't proved to fit i32 and is f64 now
 * (4.5), most of them, with what else moved them; and the exceptions corpus, whose runtime's description of a thrown boolean
 * was fixed. `tmk milestone maps` pins the maps and exceptions corpora again in corpus/memory/maps-tirhash.json.
 */
export const INT_MOVED: Record<string, string> = {
  "bench/memory/churn_lowered.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "bench/memory/list_lowered.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/callee_blocked.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/closure_outlives.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/escape_global.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/inheritance.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/init_blocked.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/map_set.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/reflection.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/string_use.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/throw_value.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/fallback/try_catch.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/churn.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/class_list.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/closures_returned.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/cycles.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/exhaust.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/globals_across_calls.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/grow_reuse.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/results_d36.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/memory/store_closure.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/alloc_rules.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/array_methods.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/array_vec.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/class_struct.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/closure_known.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/closure_selected.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/control_flow.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/floor_div.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/generics_mono.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/literal_param.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/module_state.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/nullable.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/number_float.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/number_int.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/object_is.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/object_shape.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/relative_import.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/string_bytes.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/throw_trap.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/pos/wrap_forms.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc-only/cyc_exhaust.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc-only/cyc_weak.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc-only/exhaust_drains.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc-only/release_observed.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc-only/weak_cleared.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_array_release.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_callee_clears_arg.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_closure_clears_holder.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_control_paths.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_forof_mutation.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_large_drop.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_method_this.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_misc.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_self_assign_swap.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_shared_capture.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/adv_temporaries.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/cyc_churn.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/cyc_interleave.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/cyc_large.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/cyc_shapes.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/rc/weak_held.ts":
    "integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_builder.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_graph.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_json.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_lru.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_text.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_tokenizer.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/app_wordcount.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/case_all.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/drop_bound.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/frag.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/gaps.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/gaps_context.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/iter_mutation.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/map_basic.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/misc.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/num_text.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/rc_borrow.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/rc_churn.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/rc_cycles.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/smoke.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/strmap/str_methods.ts":
    "uses Map or Set, whose runtime now grows incrementally (D47); and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/adv_exc_drop.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_events.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_interp.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_parser.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_retry.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_using.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/app_visitor.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/basic_try.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/class_init_order.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/class_shapes.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/exc_effects.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/exc_exhaust.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/exc_paths.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_catch_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_finally_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_catch_try_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_catch_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_finally_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_finally_try_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_catch_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_finally_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_break.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_breakOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_continue.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_continueOuter.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_normal.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_return.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/gen_finally_try_try_throw.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/runtime_errors.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/throw_values.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
  "corpus/lower/exc/validate_errors.ts":
    "throws, so has tmkExcDescribe, whose boolean through an unknown was read wrong and is fixed; and integer arithmetic its ranges don't prove fits i32 is f64 now, where it was a checked i32 that trapped where V8 gives a result (4.5)",
};

/** A pin of a program this phase moves, each listed with why. */
/**
 * Moved by the maps phase, or since by the pipeline's phase 2 (tools/pipe-b-pins.ts, tools/pipe-c-pins.ts,
 * tools/pipe-e-pins.ts, tools/pipe-h-pins.ts), each listed with why; and -O1 and -O2 pins optimiser phase B moved, each
 * with the pass that moved it (tools/opt-b-moved.ts, written by tools/opt-b-pins.ts); and those marking class ids' loads
 * invariant moved (tools/clsid-moved.ts, written by tools/clsid-pins.ts); R1d's unreached pass
 * (tools/r1d-moved.ts, found by tools/r1d-pins.ts); and R1f's strength reduction (tools/r1f-moved.ts, written by
 * tools/r1f-pins.ts); and R5's dead return no longer printed (tools/r5-pins.ts); and R6's (tools/r6-moved.ts, written by
 * tools/r6-pins.ts, each with the change that moved it); and R7's (tools/r7-moved.ts, written by tools/r7-pins.ts); and
 * R8's (tools/r8-moved.ts, written by tools/r8-pins.ts); and R9's (tools/r9-moved.ts, written by tools/r9-pins.ts); and
 * R10's and R11's (tools/r10-moved.ts and tools/r11-moved.ts, written by tools/r10-pins.ts and tools/r11-pins.ts); and
 * R12's, R13's and R14's (tools/r12-moved.ts, r13-moved.ts and r14-moved.ts, written by their pins tools); and R15's
 * (tools/r15-moved.ts, written by tools/r15-pins.ts, each with the pass that moved it and its counts); and R16's, R17's, R18's
 * and R19's (tools/r16-moved.ts, tools/r17-moved.ts, tools/r18-moved.ts and tools/r19-moved.ts, written by their pins tools); and R20's
 * and R21's (tools/r20-moved.ts and tools/r21-moved.ts, written by tools/r20-pins.ts and tools/r21-pins.ts); and R22's
 * (tools/r22-moved.ts, written by tools/r22-pins.ts); and R24's (tools/r24-moved.ts, written by tools/r24-pins.ts); and
 * R25's (tools/r25-moved.ts, written by tools/r25-pins.ts); and R26's, R27's, R29's, R30's and R31's (tools/r26-moved.ts,
 * r27-moved.ts, r29-moved.ts, r30-moved.ts and r31-moved.ts, written by their pins tools).
 */
export const mapsMoved = (k: string): boolean =>
  r31Moved(k) ||
  r30Moved(k) ||
  r29Moved(k) ||
  r27Moved(k) ||
  r26Moved(k) ||
  r25Moved(k) ||
  r24Moved(k) ||
  r22Moved(k) ||
  r21Moved(k) ||
  r20Moved(k) ||
  r19Moved(k) ||
  r18Moved(k) ||
  r17Moved(k) ||
  r16Moved(k) ||
  r15Moved(k) ||
  r14Moved(k) ||
  r13Moved(k) ||
  r12Moved(k) ||
  r11Moved(k) ||
  r10Moved(k) ||
  r9Moved(k) ||
  r8Moved(k) ||
  r7Moved(k) ||
  r6Moved(k) ||
  r5Moved(k) ||
  r4Moved(k) ||
  optBMoved(k) ||
  r1dMoved(k) ||
  r1fMoved(k) ||
  clsidMoved(k) ||
  pipeBMoved(k) ||
  pipeCMoved(k) ||
  pipeEMoved(k) ||
  pipeHMoved(k) ||
  Object.keys(INT_MOVED).some((p) => k === p || k.startsWith(`${p}@`)) ||
  (!k.includes("@strict") && Object.keys(MAPS_MOVED).some((p) => k === p || k.startsWith(`${p}@`)));
