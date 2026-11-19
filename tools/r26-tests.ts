// R26's tests (SPEC M5's R26 record, 4.3, 3.5, D44, D73): the optimiser's proofs and copies that take scans' checks and
// loads, `charCodeAt` printed in integers in `rc`, and @tsl/gc's fresh slot's size.
//
// - corpus/lower/r26 through the dual route with class printing forced, in `rc` and `leak`, at -O0, -O1 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r26_scans.ts scans
//   flat strings and views from below 0, from 0 and past the end, to the length, one short and one past, by its own length
//   and another string's, arrays the same, and tests by a constant in a loop;
// - each of R26's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r26-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--faults-only] [--only name]
import { relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R26_DIR = "corpus/lower/r26";
export const R26_PROGRAMS = ["corpus/lower/r26/r26_scans.ts"];
const RC = "ex-gc-rc.ts";

/**
 * R26's bugs, each to be caught by a wrong answer against V8 (and the direct route): in the optimiser by name
 * (TMK_OPT_FAULT, range.ts, loopbounds.ts, unswitch.ts; also in `OPT_FAULTS`, so opt-a box 12 runs them), in the printing
 * by name (TMK_TEST_EMIT, emit-tsl.ts), or in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly). `levels` is where an
 * optimiser bug acts: -O1's loopbounds, -O2's range analysis and copying rounds.
 */
export const R26_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  optFault?: string;
  levels?: (0 | 1 | 2)[];
  patch?: TestPatch;
}[] = [
  {
    name: "r26-rel-any",
    what: "range.ts reading a signed loop test as the unsigned one whatever either side's sign, so an index from below 0 is taken as below the length",
    optFault: "r26-rel-any",
    levels: [2],
  },
  {
    name: "r26-fcmp-swap",
    what: "range.ts deciding a float compare of two converted i32s from the integers the other way round, so charCodeAt's test of an index in range says it's past the end",
    optFault: "r26-fcmp-swap",
    levels: [2],
  },
  {
    name: "r26-round-swap",
    what: "-O2's second or later copying round sending each of an unswitched loop's two copies the other's way, so a scan over a view reads as a flat string's and the reverse",
    optFault: "r26-round-swap",
    levels: [2],
  },
  {
    name: "r26-lb-const",
    what: "-O1's loopbounds taking `k < c` as false for any constant c, not only 0, so `i < 1` is false on the first turn",
    optFault: "r26-lb-const",
    levels: [1],
  },
  {
    name: "r26-codeat-past",
    what: "charCodeAt printed in integers taking an index equal to the length as in range, so a scan one past the end reads a unit where JS gives NaN",
    emit: "r26-codeat-le",
  },
  {
    name: "r26-page-half",
    what: "@tsl/gc's fresh slot of size class k cut half its size, so two objects share bytes",
    patch: {
      file: RC,
      from: "  const size = BigInt.asUintN(64, toU64(1) << toU64(k));\n",
      to: "  const size = BigInt.asUintN(64, (toU64(1) << toU64(k)) >> 1n);\n",
    },
  },
];

/**
 * The dual route with class printing forced, over R26's programs (and others), in `rc` and `leak`: every case agrees with V8
 * natively and with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is in).
 */
export async function r26Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R26_DIR],
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
    levels: levels as never,
    accels,
    jobs,
    classes: true,
    printed,
    dirs,
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

/**
 * One of R26's bugs, put in: what caught it (wrong answers, and the first in a stable order). The optimiser's and the
 * printing's run over R26's program and R25's strings (whose scans, views and flat strings are the shapes the bugs touch), in
 * `rc` and `leak` at the bug's levels (the printing's at -O1 and -O2); @tsl/gc's over R25's and R24's programs in `rc` at
 * -O2 and corpus/rc's step-count programs natively.
 */
export async function r26Fault(
  f: (typeof R26_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const wasOpt = process.env.TMK_OPT_FAULT;
  const run = async (): Promise<string[]> => {
    if (f.patch !== undefined)
      return [
        ...(
          await r26Dual(
            [accel],
            jobs,
            [2],
            false,
            undefined,
            ["rc"],
            [R26_DIR, "corpus/lower/r25", "corpus/lower/r24"],
          )
        ).failures,
        ...(await runNative("rc", [accel], jobs, "rc_steps", defaultEngines())).failures,
      ];
    return (
      await r26Dual(
        [accel],
        jobs,
        f.levels ?? [1, 2],
        false,
        f.emit,
        f.emit !== undefined ? ["rc"] : ["rc", "leak"],
        [R26_DIR, "corpus/lower/r25"],
      )
    ).failures;
  };
  if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  try {
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
  if (!argv.includes("--faults-only")) {
    const d = await r26Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R26_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r26Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
