// R24's tests (SPEC M5's R24 record, 3.5, D39, D41): `rc` class printing's strings and freeing, with the same steps.
//
// - corpus/lower/r24 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r24_strings.ts makes
//   views every way and reads them at every index, and indexes strings at every kind of index; r24_free.ts frees objects of
//   no slots, one and five with no collector linked, some of what they hold kept and read after;
// - corpus/rc/rc_steps_r24.ts natively against its pins and the host's simulation: the steps each allocation's freeing takes
//   where what waits has one slot or two, at budgets 1 to 5 and RC_BUDGET, pinned with @tsl/gc as it was before R24;
// - each of R24's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r24-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--faults-only] [--only name]
import { relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R24_DIR = "corpus/lower/r24";
export const R24_PROGRAMS = ["corpus/lower/r24/r24_strings.ts", "corpus/lower/r24/r24_free.ts"];
export const R24_STEPS = "rc_steps_r24";
const RC = "ex-gc-rc.ts";

/**
 * R24's bugs, each to be caught by a wrong answer against V8 (and the direct route) or against corpus/rc's pinned step
 * counts: in the printing by name (TMK_TEST_EMIT, emit-rcstr.ts), or in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly).
 */
export const R24_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  patch?: TestPatch;
}[] = [
  {
    name: "r24-alloc-block-step",
    what: "freeAlloc giving an object's block back, its slots visited, without taking that step from the budget, so an allocation frees more than its budget",
    patch: {
      file: RC,
      from: "        left = BigInt.asUintN(64, left - 1n); // every slot visited: giving its block back, a step of its own\n",
      to: "",
    },
  },
  {
    name: "r24-alloc-cursor",
    what: "freeAlloc leaving the cursor at slot 2 where the budget runs out after slot 0, so slot 1's child is never let go of",
    patch: {
      file: RC,
      from: "          at = 1;\n          slots = s;\n          break;",
      to: "          at = 2;\n          slots = s;\n          break;",
    },
  },
  {
    name: "r24-rest-from-two",
    what: "freeRest visiting an object's slots from 2, so slot 1's child is never let go of",
    patch: {
      file: RC,
      // R33: freeRest's start matched by what comes before it, as `stepping` is set where a release function may read it
      from: "  let left = n;\n  let a: usize = 1;",
      to: "  let left = n;\n  let a: usize = 2;",
    },
  },
  {
    name: "r24-leaf-twice",
    what: "visitLeaf taking two off a leaf's count where one is left, so a leaf still held is freed under its holder",
    patch: {
      file: RC,
      from: "        c.write(BigInt.asUintN(64, n - 1n));",
      to: "        c.write(BigInt.asUintN(64, n - 2n));",
    },
  },
  {
    name: "r24-leaf-class",
    what: "leafBack giving a leaf's block back on the list of the size class above its own, so a later, bigger object overruns it",
    patch: {
      file: RC,
      from: "  giveBack(slot, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));",
      to: "  giveBack(slot, owner + 1, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));",
    },
  },
  {
    name: "r24-view-start",
    what: "a view's constructor given its start one on, so every unit read through it is its neighbour's",
    emit: "r24-view-start",
  },
  {
    name: "r24-unit-start",
    what: "a view's unit read from its length's bits where its start's are",
    emit: "r24-unit-start",
  },
];

/**
 * The dual route with class printing forced, over R24's programs, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r24Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
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
    dirs: [R24_DIR],
    v8: () => true,
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

/** corpus/rc/rc_steps_r24.ts natively against its pins, and the host's simulation. */
export async function r24Steps(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const r = await runNative("rc", [accel], jobs, R24_STEPS, defaultEngines());
  return {
    failures: r.failures,
    cases: r.agreement.reduce((n, x) => n + x.cases, 0),
    agreed: r.agreement.reduce((n, x) => n + x.agreed, 0),
  };
}

/**
 * One of R24's bugs, put in: what caught it (wrong answers, and the first in a stable order). Run over R24's programs and
 * R21's and R22's (whose appends, joins and freeing make strings and objects of every shape), in `rc` at -O2, and for a bug
 * in @tsl/gc, over corpus/rc's step-count programs natively too, whose pins say the bound.
 */
export async function r24Fault(
  f: (typeof R24_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const P = await import("./pipe-tests.ts");
  const run = async (): Promise<string[]> => {
    const out = [
      ...(
        await P.dualRoute({
          modes: ["rc"],
          levels: [2],
          accels: [accel],
          jobs,
          classes: true,
          printed: false,
          dirs: [R24_DIR, "corpus/lower/r22", "corpus/lower/r21"],
          v8: () => true,
          ...(f.emit !== undefined ? { fault: f.emit } : {}),
        })
      ).failures,
    ];
    if (f.patch !== undefined)
      out.push(...(await runNative("rc", [accel], jobs, "rc_steps", defaultEngines())).failures);
    return out;
  };
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
    const d = await r24Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    const s = await r24Steps(accel, jobs);
    console.log(`steps: ${s.agreed}/${s.cases}`);
    for (const x of s.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length + s.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R24_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r24Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
