// Which pinned tirhashes pipe-h moves (SPEC M5's pipe-h record, D67, D68), and why. Found by computing every pinned
// tirhash (opt, pre-std, pre-strings, strict, rc-off and modes) with pipe-h's printer, optimiser and JsString and with
// the files as they were before it, and comparing: nothing else moved in those six. The exceptions corpus in rc at -O2
// (maps' and lang-a's pins) and 31 programs through the TSL route at -O2 (pipe-tirhash.json) are pipe-a box 7's findings,
// moved by the same fold.
export const PIPE_H_MOVED: Record<string, string> = {
  // Pinned through the TSL route at -O2 (pipe-tirhash.json), by the same fold.
  "corpus/lower/exc/dyn_truthy.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/dyn_truthy_nostr.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  // corpus/lower/exc, pinned in rc at -O2 (maps-tirhash.json, lang-a-tirhash.json): every program throws, so has
  // tmkExcDescribe and its number text.
  "corpus/lower/exc/adv_exc_drop.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_events.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_interp.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_parser.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_retry.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_using.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/app_visitor.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/basic_try.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/cast_unknown.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/class_shapes.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/exc_effects.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/exc_exhaust.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/exc_paths.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_catch_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_finally_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_catch_try_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_catch_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_finally_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_finally_try_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_catch_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_finally_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_break.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_breakOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_continue.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_continueOuter.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_normal.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_return.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/gen_finally_try_try_throw.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/runtime_errors.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/throw_values.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/exc/validate_errors.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/std/leak/js_string.ts":
    "a case added (chunks, every size a unit chunk takes) and @tsl/jsrt's JsString changed (pipe-h: unit chunks from a page doubling to 16, unit addresses by element steps, strHash's hash word, the one-unit table's miss never inlined)",
  "corpus/lower/fallback/js_throw_through.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/fallback/throw_value.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/fallback/try_catch.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/rc/adv_temporaries.ts":
    "class printing reads and writes a field through a local only ever set to `this` on `this` itself (pipe-h, emit-tsl.ts thisBase), so tslc has no `!` to check: Holder's constructor stores `this.inner`",
  "corpus/lower/rc-only/cast_lie.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/app_builder.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/app_graph.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/app_json.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/app_text.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/app_wordcount.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/case_all.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/iter_mutation.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/map_basic.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/misc.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/num_text.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/rc_borrow.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
  "corpus/lower/strmap/rc_churn.ts":
    "the optimiser folds an integer compared with itself (pipe-h: simplify.ts, `x !== x` on a value the lowering proved an integer, exposed once compiler/rt's string functions are inlined); found by elimination: these move at -O1 and -O2 in rc too, which class printing and JsString don't reach, and not at -O0",
};

/** In TSL proper at -O1 and -O2 (js_string.ts), lowered programs in the modes listed: the fold at -O1 and -O2 in every mode, the
 * printer's `this` in auto's `leak` and `manual` at every level. */
export const pipeHMoved = (k: string): boolean => {
  const [file, ...rest] = k.split("@");
  if (file === undefined || PIPE_H_MOVED[file] === undefined) return false;
  if (file === "corpus/lower/rc/adv_temporaries.ts")
    return rest[0] === "leak" || rest[0] === "manual";
  if (file === "corpus/std/leak/js_string.ts") return true;
  return rest.includes("O1") || rest.includes("O2");
};
