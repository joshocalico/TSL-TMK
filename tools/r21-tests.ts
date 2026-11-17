// R21's tests (SPEC M5's R21 record, 3.5, 4.3, D39, D41, D42, D49): strings and exceptions in `rc` class printing.
//
// - corpus/lower/r21 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r21_units.ts makes
//   every unit to 300 as a one-unit string each way the runtime makes one, where a string from the table's wrong slot, or
//   a unit at or past 256 taken for the table's, shows;
// - each of R21's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r21-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R21_DIR = "corpus/lower/r21";
export const R21_UNITS = "corpus/lower/r21/r21_units.ts";
export const R21_QUICK = "corpus/lower/r21/r21_quick.ts";

/**
 * R21's bugs, each to be caught by a wrong answer against V8 (and the direct route): in the printed string runtime by name
 * (TMK_TEST_EMIT, emit-rcstr.ts), in a library by patch (TSL_TEST_PATCH, matched exactly), or in the backend by name
 * (TMK_TEST_TSL).
 */
export const R21_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  patch?: TestPatch;
  tslEnv?: string;
  optFault?: string;
}[] = [
  {
    name: "rcstr-unit-low7",
    what: "the one-unit table filed by a unit's low 7 bits, so a unit 128 from one already made is given that one's string",
    emit: "rcstr-unit-low7",
  },
  {
    name: "rcstr-unit-past",
    what: "the one-unit table taken for units to 256 inclusive, so unit 256 reads past its 256 slots (a bounds trap)",
    emit: "rcstr-unit-past",
  },
  {
    name: "r21-shrinkwrap-callee",
    what: "shrink-wrapping taking a callee-saved register as one the caller doesn't need kept, so the quick way out writes it before the prologue saves it",
    optFault: "r21-shrinkwrap-callee",
  },
];

/**
 * The dual route with class printing forced, over R21's programs, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r21Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
  fault?: string,
): Promise<{
  failures: string[];
  cases: number;
  agreed: number;
  handled: number;
  printed: string[];
}> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc", "leak"],
    levels,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R21_DIR],
    v8: () => true,
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

/** One of R21's bugs, put in: what caught it (wrong answers, and the first in a stable order). */
export async function r21Fault(
  f: (typeof R21_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const was = process.env.TMK_TEST_TSL;
  const wasOpt = process.env.TMK_OPT_FAULT;
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  try {
    const run = async (): Promise<string[]> =>
      (await r21Dual([accel], jobs, [2], false, f.emit)).failures;
    const failures = faultFailures(
      f.patch !== undefined ? await withPatch(f.patch, run) : await run(),
      f.name,
    );
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = was;
    if (wasOpt === undefined) delete process.env.TMK_OPT_FAULT;
    else process.env.TMK_OPT_FAULT = wasOpt;
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
  const d = await r21Dual([accel], jobs);
  console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
  for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
  if (argv.includes("--faults"))
    for (const f of R21_FAULTS) {
      const x = await r21Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
  process.exitCode = d.failures.length > 0 ? 1 : 0;
}
