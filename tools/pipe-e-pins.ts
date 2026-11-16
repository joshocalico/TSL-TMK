// Which pinned tirhashes the pipeline's phase 2, arrays' speed (pipe-e, SPEC M5's pipe-d record, D66), moves, and why. Found
// by computing every pinned tirhash before and after each change: a byte array's fill as one memset (TMK_TSL_OPT_OFF=bytefill
// is what it was), JsArray's growth, and arrays printed as JsArray in `auto` (TMK_EMIT_VECS=0 is what it was).
export const PIPE_E_MOVED: Record<string, string> = {
  "corpus/lower/pos/generics_mono.ts":
    "in strict, where auto class-prints it since R13 prints its arrays as @tsl/jsrt's arena array (AUTO_STRICT_ARRAYS, tools/r13-pins.ts), whose growth zeroes the new room with a byte array's fill, one memset (TMK_TSL_OPT_OFF=bytefill is a store a byte)",
  "corpus/lower/pos/read_checks.ts":
    "R6's program of reads, which auto class-prints in leak and manual with its arrays as JsArray (D66, AUTO_VECTORS); with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it, so it's on the direct route",
  "corpus/lower/fallback/closure_escape.ts":
    "since R6 auto prints closure values in leak and manual (AUTO_CLOSURES, tools/r6-pins.ts), with its arrays as JsArray; with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it there, so it's on the direct route, as it was before R6",
  "corpus/lower/rc/adv_closure_clears_holder.ts":
    "since R6 auto prints closure values in leak and manual (AUTO_CLOSURES, tools/r6-pins.ts), with its arrays as JsArray; with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it there, so it's on the direct route, as it was before R6",
  "corpus/lower/rc/cyc_churn.ts":
    "since R6 auto prints closure values in leak and manual (AUTO_CLOSURES, tools/r6-pins.ts), with its arrays as JsArray; with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it there, so it's on the direct route, as it was before R6",
  "corpus/lower/rc/cyc_interleave.ts":
    "since R6 auto prints closure values in leak and manual (AUTO_CLOSURES, tools/r6-pins.ts), with its arrays as JsArray; with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it there, so it's on the direct route, as it was before R6",
  "corpus/lower/fallback/escape_global.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/memory/store_closure.ts":
    "since R4 auto builds it in rc through the TSL route (AUTO_RC), its arrays printed as @tsl/gc's JsRoomArray; with arrays not printed (TMK_EMIT_VECS=0) the printer can't take it there, so it's on the direct route, as it was before R4 (tools/r4-pins.ts)",
  "corpus/lower/memory/grow_reuse.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/pos/int_overflow.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/rc/adv_large_drop.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/rc/adv_temporaries.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/rc/cyc_giveup.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/lower/rc/cyc_large.ts":
    "auto's class printing prints its arrays as @tsl/std's JsArray now (D66, AUTO_VECTORS), which it didn't, so it's printed with classes where arrays stopped it",
  "corpus/mem/layout.ts":
    "its Uint8Array.fill is one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/spec/run_std.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/builder.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/ergo_std.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/graph.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/job_queue.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/leak/js_array.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill); and JsArray's growth copies what it keeps and zeroes only the rest, with one memset (D66); and a case added, holesPastTheCopy",
  "corpus/std/leak/std_leak.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/manual/std_manual.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/map_js.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/model.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/named.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/nosource/std_no_source.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/sort.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/stack_holders.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_default.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_gen_adversarial.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_new_safety.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_replaced.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_slab_safety.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/std_vec_safety.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/tree.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/word_count.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
  "corpus/std/zero_ctor.ts":
    "@tsl/std's global allocator zeroes a reused run of pages with one memset now, where it was a store a byte (D66, a byte array's fill)",
};

/** Lowered programs move only in `leak` and `manual`, where class printing prints them; TSL proper's at the levels listed. */
export const pipeEMoved = (k: string): boolean => {
  const [file, mode] = k.split("@");
  if (file === undefined || PIPE_E_MOVED[file] === undefined) return false;
  return !file.startsWith("corpus/lower/") || mode === "leak" || mode === "manual";
};
