// R25's tests (SPEC M5's R25 record, 3.5, 4.4, D39, D41): `rc` class printing's strings and freeing, with the same steps.
//
// - corpus/lower/r25 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source. r25_strings.ts
//   searches, splits, joins, walks code points, takes substrings and compares strings, views and flat; r25_free.ts lets go
//   of arrays of one- and two-slot objects and of a split's words, some of what they hold kept and read after;
// - corpus/rc/rc_steps_r25.ts natively against its pins and the host's simulation: the steps each allocation's freeing takes
//   where a budget runs out between a one-slot object's two steps, at budgets 1 to 7, 32 and 33, pinned with @tsl/gc as it
//   was before R25;
// - corpus/trap/wide_add.ts natively at -O0 and -O2 (TSL proper's corpus/trap, run by the native suite): an add the backend
//   leaves its tests out of gives the sum, and one with a wider operand still traps;
// - each of R25's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r25-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--faults-only] [--only name]
import { relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R25_DIR = "corpus/lower/r25";
export const R25_PROGRAMS = ["corpus/lower/r25/r25_strings.ts", "corpus/lower/r25/r25_free.ts"];
export const R25_STEPS = "rc_steps_r25";
export const R25_TRAP = "wide_add";
const RC = "ex-gc-rc.ts";

/**
 * R25's bugs, each to be caught by a wrong answer against V8 (and the direct route), against corpus/rc's pinned step counts,
 * or against corpus/trap's traps: in the printing by name (TMK_TEST_EMIT, emit-rcstr.ts), in tslc's release dispatch by
 * name (TMK_TEST_TSL, elab-native.ts), in the backend by name (TMK_OPT_FAULT, emit.ts), or in @tsl/gc by patch
 * (TSL_TEST_PATCH, matched exactly).
 */
export const R25_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  tslEnv?: string;
  optFault?: string;
  patch?: TestPatch;
}[] = [
  {
    name: "r25-cursor-block-free",
    what: "freeAlloc giving the block of the object at the cursor back without taking that step from the budget, so an allocation frees more than its budget",
    patch: {
      file: RC,
      from: "    left = BigInt.asUintN(64, left - 1n); // giving its block back, a step of its own\n",
      to: "",
    },
  },
  {
    name: "r25-cursor-kept",
    what: "freeAlloc giving the block of the object at the cursor back and leaving the cursor on it, so freeSteps frees it again",
    patch: {
      file: RC,
      from: "    const owner = ownerAt(c).read();\n    cur = 0n;\n",
      to: "    const owner = ownerAt(c).read();\n",
    },
  },
  {
    name: "r25-last-step",
    what: "freeAlloc, with one step left, going on to an object's block after slot 0 where the budget ran out, so the budget wraps and an allocation frees everything",
    // R32: freeAlloc tests its ways in a new order (no step left first), so the bug is that test taking only an object of
    // more slots: the same bug, at the line that now decides it
    patch: {
      file: RC,
      from: "        if (left === 0n) {\n          cur = head;\n          at = 1;\n          slots = s;\n          break;\n        }\n        if (s > 1) {",
      to: "        if (left === 0n && s > 1) {\n          cur = head;\n          at = 1;\n          slots = s;\n          break;\n        }\n        if (s > 1) {",
    },
  },
  {
    name: "r25-release-order",
    what: "callRelease's chain in the order the program shows its stores where their numbers have empty ones last, so a number reaches another class's release function",
    tslEnv: "r25-release-order",
  },
  {
    name: "r25-add-narrow",
    what: "the backend's checked unsigned 64-bit add left without its tests where one operand is 64 bits wide, as if both were 32, so a usize past 2^53 - 1 doesn't trap",
    optFault: "r25-add-narrow",
  },
  {
    name: "r25-cplen-next",
    what: "a code point's length reading its second unit two on, so for...of splits pairs it shouldn't and joins ones it should split",
    emit: "r25-cplen-next",
  },
  {
    name: "r25-index-match",
    what: "indexFrom matching a pattern's unit k against the string's unit k + 1 of the place, so a pattern of more than one unit is found where it isn't",
    emit: "r25-index-match",
  },
  {
    name: "r25-sub-start",
    what: "a substring of a view copied from one unit past its start",
    emit: "r25-sub-start",
  },
  {
    name: "r25-eq-shift",
    what: "equality comparing each unit of one string with the next unit of the other, so equal strings compare unequal",
    emit: "r25-eq-shift",
  },
  {
    name: "r25-copy-one",
    what: "a join's copy of one unit stored a unit early, over what came before it",
    emit: "r25-copy-one",
  },
];

/**
 * The dual route with class printing forced, over R25's programs, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r25Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R25_DIR],
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

/** corpus/rc/rc_steps_r25.ts natively against its pins, and the host's simulation. */
export async function r25Steps(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const r = await runNative("rc", [accel], jobs, R25_STEPS, defaultEngines());
  return {
    failures: r.failures,
    cases: r.agreement.reduce((n, x) => n + x.cases, 0),
    agreed: r.agreement.reduce((n, x) => n + x.agreed, 0),
  };
}

/** corpus/trap/wide_add.ts natively at -O0 and -O2: the sums, and the traps. */
export async function r25Trap(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const was = process.env.TMK_OPT;
  const out = { failures: [] as string[], cases: 0, agreed: 0 };
  try {
    for (const level of ["0", "2"]) {
      process.env.TMK_OPT = level;
      const r = await runNative("trap", [accel], jobs, R25_TRAP, defaultEngines());
      out.failures.push(...r.failures.map((x) => `-O${level}: ${x}`));
      out.cases += r.agreement.reduce((n, x) => n + x.cases, 0);
      out.agreed += r.agreement.reduce((n, x) => n + x.agreed, 0);
    }
  } finally {
    if (was === undefined) delete process.env.TMK_OPT;
    else process.env.TMK_OPT = was;
  }
  return out;
}

/**
 * One of R25's bugs, put in: what caught it (wrong answers, and the first in a stable order). The printing's and tslc's run
 * over R25's programs and R24's, R22's and R21's (whose appends, joins and freeing make strings and objects of every shape),
 * in `rc` at -O2; for a bug in @tsl/gc or tslc's dispatch, corpus/rc's step-count programs natively too, whose pins say the
 * bound; the backend's, corpus/trap natively at -O2.
 */
export async function r25Fault(
  f: (typeof R25_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const P = await import("./pipe-tests.ts");
  const wasTsl = process.env.TMK_TEST_TSL;
  const wasOpt = process.env.TMK_OPT_FAULT;
  const wasLevel = process.env.TMK_OPT;
  const run = async (): Promise<string[]> => {
    if (f.optFault !== undefined) {
      process.env.TMK_OPT = "2";
      return (await runNative("trap", [accel], jobs, undefined, defaultEngines())).failures;
    }
    const out = [
      ...(
        await P.dualRoute({
          modes: ["rc"],
          levels: [2],
          accels: [accel],
          jobs,
          classes: true,
          printed: false,
          dirs: [R25_DIR, "corpus/lower/r24", "corpus/lower/r22", "corpus/lower/r21"],
          v8: () => true,
          ...(f.emit !== undefined ? { fault: f.emit } : {}),
        })
      ).failures,
    ];
    if (f.patch !== undefined || f.tslEnv !== undefined)
      out.push(...(await runNative("rc", [accel], jobs, "rc_steps", defaultEngines())).failures);
    return out;
  };
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
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
    if (wasTsl === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = wasTsl;
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
    const d = await r25Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    const s = await r25Steps(accel, jobs);
    console.log(`steps: ${s.agreed}/${s.cases}`);
    for (const x of s.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    const t = await r25Trap(accel, jobs);
    console.log(`trap: ${t.agreed}/${t.cases}`);
    for (const x of t.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length + s.failures.length + t.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R25_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r25Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
