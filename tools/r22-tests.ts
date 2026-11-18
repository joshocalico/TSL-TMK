// R22's tests (SPEC M5's R22 record, 3.5, D39, D41, D49, D68): `rc`'s remaining per-object costs in class printing.
//
// - corpus/lower/r22 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r22_joins.ts joins
//   three strings every way (`a + b + c` made once where it's short), r22_throws.ts throws and catches errors with and without
//   causes (a thrown object of several slots freed two steps an allocation), r22_steps.ts frees objects of two to four slots with
//   the collector linked (freeOne's second step taken in place), and every program makes tails of lengths that change;
// - each of R22's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r22-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R22_DIR = "corpus/lower/r22";
export const R22_PROGRAMS = [
  "corpus/lower/r22/r22_joins.ts",
  "corpus/lower/r22/r22_throws.ts",
  "corpus/lower/r22/r22_steps.ts",
];
const RC = "ex-gc-rc.ts";

/**
 * R22's bugs, each to be caught by a wrong answer against V8 (and the direct route): in the printing by name
 * (TMK_TEST_EMIT, emit-tsl.ts and emit-rcstr.ts), or in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly).
 */
export const R22_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  patch?: TestPatch;
}[] = [
  {
    name: "r22-join3-order",
    what: "a + b + c made once with b and c the other way round",
    emit: "r22-join3-order",
  },
  {
    name: "r22-grown-offset",
    what: "a concatenation's new buffer, made out of line, given the second string's units at the second string's length in place of the first's",
    emit: "r22-grown-offset",
  },
  {
    name: "r22-second-step",
    what: "freeOne's second step, taken in place, visiting slot 2 in place of slot 1, so slot 1's child is never let go of and slot 2's is let go of twice",
    patch: {
      file: RC,
      from: "    callRelease(ptrAt(u32, entry).read(), objectAt<Counted0>(slot), at, Visit.Drop);",
      to: "    callRelease(ptrAt(u32, entry).read(), objectAt<Counted0>(slot), at + 1, Visit.Drop);",
    },
  },
  {
    name: "r22-tail-owner",
    what: "a tail's owner word, worked out from its store's, naming the size class above its own, so a freed tail goes back on the bigger size's list and a later object overruns it",
    patch: {
      file: RC,
      from: "  return ((owner & 0xffff_ff00) | toU32(k)) >>> 0;",
      to: "  return ((owner & 0xffff_ff00) | toU32(k + 1)) >>> 0;",
    },
  },
];

/**
 * The dual route with class printing forced, over R22's programs, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r22Dual(
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
    dirs: [R22_DIR],
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
 * One of R22's bugs, put in: what caught it (wrong answers, and the first in a stable order). Run over R22's programs and
 * R21's (whose one-unit strings and appends make tails of every length), in `rc` at -O2.
 */
export async function r22Fault(
  f: (typeof R22_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const P = await import("./pipe-tests.ts");
  const run = async (): Promise<string[]> =>
    (
      await P.dualRoute({
        modes: ["rc"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
        printed: false,
        dirs: [R22_DIR, "corpus/lower/r21"],
        v8: () => true,
        ...(f.emit !== undefined ? { fault: f.emit } : {}),
      })
    ).failures;
  const failures = faultFailures(
    f.patch !== undefined ? await withPatch(f.patch, run) : await run(),
    f.name,
  );
  return {
    caught: failures.length,
    answers: wrongAnswers(failures),
    first: (firstInOrder(failures) ?? "").slice(0, 200),
  };
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
    const d = await r22Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R22_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r22Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
