// R23's tests (SPEC M5's R23 record, 3.5, 4.4, D39, D41, D49, D68, D75): throws and strings in `rc` class printing.
//
// - corpus/lower/r23 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r23_throws.ts throws
//   every shape the out-of-line builders take (classes of the program's own and Error's, literals that differ between the
//   throws of one class, variables, a constructor that throws itself) a frame and a hundred up; r23_codeat.ts reads
//   `charCodeAt` over strings made every way and at indices of every kind;
// - each of R23's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r23-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--faults-only] [--only re]
import { relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R23_DIR = "corpus/lower/r23";
export const R23_PROGRAMS = ["corpus/lower/r23/r23_throws.ts", "corpus/lower/r23/r23_codeat.ts"];
/** R22's finding: a smaller `Dyn` in the 64-byte size class runs this program out of pages through the TSL route in `rc`. */
export const EXC_EXHAUST = "corpus/lower/exc/exc_exhaust.ts";

/**
 * R23's bugs, each to be caught by a wrong answer against V8 (and the direct route): in the printing by name (TMK_TEST_EMIT,
 * emit-exc.ts and emit-tsl.ts), or in the backend by name (TMK_OPT_FAULT). `where` says what each is run over: R23's and
 * R22's programs through both routes in `rc` at -O2, corpus/lower/exc/exc_exhaust.ts likewise, or corpus/trap natively at
 * -O2 (the backend's range checks, where `toUsize` of a negative i32 has to trap).
 */
export const R23_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  optFault?: string;
  where: "programs" | "exhaust" | "trap";
}[] = [
  {
    name: "r23-made-key",
    what: "a thrown object's builder shared by throws whose literal arguments differ, so every one of them gets the first one's literals",
    emit: "r23-made-key",
    where: "programs",
  },
  {
    name: "r23-made-cid",
    what: "a thrown object built out of line without its class id, so instanceof and catch tell it as no class",
    emit: "r23-made-cid",
    where: "programs",
  },
  {
    name: "r23-none-pad",
    what: "an unknown's never-stored reference fields printed as getters without their 8 bytes kept, so a thrown object moves to a smaller size class",
    emit: "r23-none-pad",
    where: "exhaust",
  },
  {
    name: "r23-range-lo",
    what: "a 32-bit signed range check whose upper bound is the type's own left out with its lower bound too, so toUsize of a negative i32 passes",
    optFault: "r23-range-lo",
    where: "trap",
  },
];

/**
 * The dual route with class printing forced, over R23's programs (or `dirs`, picked by `filter`), in `rc` and `leak`: every
 * case agrees with V8 natively and with the TSL route, and the printed TSL on V8 and JSC with the source (the third route;
 * off where a bug is put in).
 */
export async function r23Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R23_DIR],
  filter?: (file: string) => boolean,
): Promise<{
  failures: string[];
  cases: number;
  agreed: number;
  handled: number;
  printed: string[];
}> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels,
    accels,
    jobs,
    classes: true,
    printed,
    dirs,
    // against V8 too, but for the exceptions corpus's exhaustion, where native runs out of pages and V8 doesn't (3.10)
    v8: (f) => !relative(ROOT, f).startsWith("corpus/lower/exc/"),
    ...(filter !== undefined ? { filter } : {}),
    ...(fault !== undefined ? { fault } : {}),
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    handled: r.programs.filter((p) => p.handled && relative(ROOT, p.file) !== "").length,
    printed: r.programs
      .filter((p) => p.handled)
      .map((p) => `${p.file}@${p.mode}`)
      .sort(),
  };
}

/** One of R23's bugs, put in: what caught it (wrong answers, and the first in a stable order). */
export async function r23Fault(
  f: (typeof R23_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const wasOpt = process.env.TMK_OPT_FAULT;
  const wasLevel = process.env.TMK_OPT;
  if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  try {
    let failures: string[];
    if (f.where === "trap") {
      // corpus/trap natively at -O2, the backend's -O1 and -O2 code shape (TSL proper, so no route to compare)
      process.env.TMK_OPT = "2";
      failures = (await runNative("trap", [accel], jobs, undefined, defaultEngines())).failures;
    } else if (f.where === "exhaust") {
      const file = `${ROOT}/${EXC_EXHAUST}`;
      failures = (
        await r23Dual(
          [accel],
          jobs,
          [2],
          false,
          f.emit,
          ["rc"],
          ["corpus/lower/exc"],
          (x) => x === file,
        )
      ).failures;
    } else {
      failures = (
        await r23Dual([accel], jobs, [2], false, f.emit, ["rc"], [R23_DIR, "corpus/lower/r22"])
      ).failures;
    }
    failures = faultFailures(failures, f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  } finally {
    if (wasOpt === undefined) delete process.env.TMK_OPT_FAULT;
    else process.env.TMK_OPT_FAULT = wasOpt;
    if (wasLevel === undefined) delete process.env.TMK_OPT;
    else process.env.TMK_OPT = wasLevel;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const accel = (val("--accel") ?? "hvf") as Accel;
  const jobs = Number(val("--jobs") ?? 4);
  if (!argv.includes("--faults-only")) {
    const d = await r23Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R23_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r23Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
