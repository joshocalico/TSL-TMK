// R9's tests (SPEC M5's R9 record, 4.5, D36, D62, D66, D69): typed arrays made inside functions, module state that's a
// typed array, and arrays of booleans and of nothing, printed as TSL in `leak` and `manual`, each with the bug put into
// its printing (or into tslc's placement of it) caught.
//
//   node tools/r9-tests.ts [--accel hvf|tcg] [--faults]
import type { Accel } from "./qemu-run.ts";
import type { R2Fault } from "./r2-tests.ts";

/**
 * R9's own programs, and every program its printing brought onto the TSL route in `leak` and `manual` (route-blockers.ts's
 * count, before and after), each built through both routes by the differential and run on V8 and JSC by the third.
 */
export const R9_PROGRAMS = [
  "corpus/lower/pipe/typed_arrays.ts", // R9's own: every way a typed array is made in a function, and kept
  "bench/memory/typed_lowered.ts", // R9's benchmark
  // typed arrays made in a function
  "corpus/lower/pos/alloc_rules.ts",
  "corpus/lower/pos/array_methods.ts",
  "corpus/lower/pos/typed_array.ts",
  "corpus/lower/rc/adv_array_release.ts",
  "corpus/lower/rc/cyc_shapes.ts",
  "corpus/lower/memory/results_d36.ts", // and a result read from module state, given its `!` (bangSites)
  "corpus/lower/pos/math_spread.ts", // subarray's element address, the next blocker
  "corpus/lower/pos/string_bytes.ts", // the same
  // module state that's a typed array
  "corpus/lower/pos/module_state.ts",
  "corpus/lower/memory/churn.ts",
  "corpus/lower/memory/exhaust.ts",
  "corpus/lower/memory/globals_across_calls.ts",
  "corpus/lower/rc-only/exhaust_drains.ts",
  // arrays of booleans
  "corpus/lower/pos/d36_layout.ts",
  "corpus/lower/pos/generics_mono.ts",
  "corpus/lower/pos/math_host.ts",
  "corpus/lower/strmap/misc.ts",
  // arrays of nothing (a Set's values)
  "corpus/lower/fallback/map_set.ts",
  "corpus/lower/exc/exc_paths.ts",
  "corpus/lower/maps/drop_moving.ts",
  "corpus/lower/maps/move_iter.ts",
  "corpus/lower/strmap/iter_mutation.ts",
  "corpus/lower/strmap/rc_borrow.ts",
];

/**
 * R9's programs that print in `rc` too: its arrays of booleans, and a typed array's element address (`subarray`) on an
 * argument (a typed array made in a function and module state that's one don't, in `rc`).
 */
export const R9_RC_PROGRAMS = [
  "corpus/lower/pos/d36_layout.ts",
  "corpus/lower/pos/generics_mono.ts",
  "corpus/lower/pos/math_host.ts",
  "corpus/lower/pos/math_spread.ts",
  "corpus/lower/pos/string_bytes.ts",
];

/**
 * A case allowed to differ between the routes only as one running out of memory (trap 14) where the other gives the case's
 * own answer, and only after an earlier case ran memory out in both: what's left of the heap then depends on how each
 * route laid out what came before (JsArray's buffers grow as the direct route's vectors don't), not on the program.
 * exhaust_drains.ts's last case makes one 16-byte object after `reallyOut` has used up all 300 pages, in `leak` and
 * `manual`, where nothing is freed: the direct route's leak heap has no 16 bytes left, the TSL route's has. It's written
 * for `rc` (its directory's name), where a drain frees memory first and both routes give 5.
 */
export const AFTER_EXHAUSTION: Record<string, string[]> = {
  "corpus/lower/rc-only/exhaust_drains.ts": ["stillAlive"],
};

/** Whether a dual-route failure line is one AFTER_EXHAUSTION allows. */
export function afterExhaustion(line: string): boolean {
  const file = line.split(" ")[0]!;
  const fns = AFTER_EXHAUSTION[file];
  if (fns === undefined) return false;
  const m = /: (\w+)#\d+: direct (\{.*?\}), TSL (\{.*\})$/.exec(line);
  if (m === null || !fns.includes(m[1]!)) return false;
  const oom = '{"result":{"trap":14}';
  return (m[2]!.startsWith(oom) ? 1 : 0) + (m[3]!.startsWith(oom) ? 1 : 0) === 1;
}

const PIPE = "corpus/lower/pipe";

/** The bugs put into R9's printing and into tslc's placement of what it prints, each to be caught. */
export const R9_FAULTS: R2Fault[] = [
  {
    name: "typed-array-short",
    what: "a typed array made in a function one element short (its layout class's array, or its tail's length)",
    transform:
      "a typed array made in a function printed as a layout class's array or a tail (emit-tsl.ts's newTypedArray)",
    where: "printer",
    dirs: [PIPE],
    modes: ["leak", "manual"],
    classes: true,
    only: "typed_arrays",
  },
  {
    name: "region-tail-dirty",
    what: "an object with a tail placed in the per-call region and not zeroed, so a new typed array reads what the region held",
    transform: "an object with a tail in the per-call region (lower-native.ts's heapObject)",
    where: "backend",
    dirs: [PIPE],
    modes: ["leak", "manual"],
    classes: true,
    only: "typed_arrays",
  },
  {
    name: "region-view-escaping",
    what: "a view kept past the export call not followed, so the class whose storage it is goes in the per-call region",
    transform: "the views region.ts follows (viewsEscaping)",
    where: "backend",
    dirs: [PIPE],
    modes: ["leak", "manual"],
    classes: true,
    only: "typed_arrays",
  },
  {
    name: "view-int-unheaped",
    what: "a typed array's pointer kept as an integer (a field's or module state's) with its object left on the stack",
    transform: "escape analysis of a view's pointer made an integer (escape.ts)",
    where: "backend",
    dirs: [PIPE],
    modes: ["leak", "manual"],
    classes: true,
    only: "typed_arrays",
  },
  {
    name: "glob-arr-len",
    what: "module state that's a typed array stored with a length one short",
    transform:
      "module state that's a typed array, held in a static object (emit-tsl.ts's globArrStore)",
    where: "printer",
    dirs: ["corpus/lower/memory"],
    modes: ["leak", "manual"],
    classes: true,
    only: "globals_across",
  },
  {
    name: "bool-elem-size",
    what: "an array of booleans laid out two bytes an element, where a bool is one (D36, 3.4)",
    transform: "an array of booleans printed as JsArray of bytes (emit-tsl.ts's vecElemText)",
    where: "printer",
    dirs: ["corpus/lower/pos"],
    modes: ["leak", "manual"],
    classes: true,
    only: "d36_layout",
  },
  {
    // An array of nothing (a Set's values in the map runtime) is made, held and passed, and never read, written or
    // measured, so what it takes is all a bug in its printing can change: here, memory, until a program runs out (trap 14).
    name: "void-vec-room",
    what: "an array of nothing (a Set's values) made 2^28 elements long, room for elements it never has",
    transform: "an array of nothing printed as JsArray of bytes (emit-tsl.ts's vecNewText)",
    where: "printer",
    dirs: ["corpus/lower/maps"],
    modes: ["leak", "manual"],
    classes: true,
    only: "move_iter",
  },
];

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const { r2FaultRun } = await import("./r2-tests.ts");
  const { defaultEngines } = await import("./corpus.ts");
  if (process.argv.includes("--faults"))
    for (const f of R9_FAULTS) {
      const x = await r2FaultRun(f, accel, 3, defaultEngines());
      console.log(
        `${f.name}: caught ${x.caught} (answers ${x.answers})${x.broken ? " BROKEN" : ""} ${x.first}`,
      );
    }
}
