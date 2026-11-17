// R17's tests (SPEC M5's R17 record, D39, D66): `@tsl/gc`'s freeing step at the direct route's cost (a store whose release
// function does nothing gives an object back with no call, `make` inlined with its free slot taken in line), and JsArray's
// "no holes" flag for an array of numbers, with the lowering's pop clearing what it drops from an array of references in
// every mode.
//
// - corpus/lower/r17/r17_free.ts through the dual route with class printing forced, in `rc`, `leak` and `manual`, at -O0 and
//   -O2: every case agrees with the direct route natively, and the printed TSL on V8 and JSC with the source;
// - corpus/rc/rc_steps_leaves.ts (hand-written, `rcOnly`): the steps one `new` takes and all of freeing takes, pinned, the
//   host's simulation (which calls every release function) agreeing, as corpus/rc/rc_steps*.ts's are;
// - the shapes, in TIR: `make` inlined into class printing's `new` at -O1 and -O2 (no call to `make` left in
//   adv_forof_mutation.ts's churn, only its slow paths' to `tryMake` and `tryMakeAfter`), and an array of numbers printed
//   with no holes, one of objects with them;
// - each of R17's bugs caught: two put into the freeing step (TSL_TEST_PATCH) and one into tslc's `releaseIsEmpty`, by the
//   pinned step counts and the rc corpus; two into JsArray's holes flag, by corpus/std/leak/js_array.ts's cases.
//
//   node tools/r17-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";

export const R17_PROGRAM = "corpus/lower/r17/r17_free.ts";
export const R17_STEPS = "rc_steps_leaves";

const RC = "ex-gc-rc.ts";
const ARRAY = "ex-jsrt-array.ts";

/** R17's bugs, each with how it's put in and what has to catch it. */
export const R17_FAULTS: {
  name: string;
  what: string;
  patch?: { file: string; from: string; to: string };
  tslEnv?: string;
  std?: string; // caught by this hand-written program of corpus/std (by name), not by the rc corpus
}[] = [
  {
    name: "steps-past-bound",
    what: "the freeing step's quick path for objects with no slots freeing one past its budget",
    patch: {
      file: RC,
      from: "  const all = toU64(n);\n  let left = all;\n  while (left !== 0n) {\n    const slot = waiting;",
      to: "  const all = toU64(n) + 1n;\n  let left = all;\n  while (left !== 0n) {\n    const slot = waiting;",
    },
  },
  {
    name: "leaf-step-uncounted",
    what: "the freeing step's quick path giving a block back without taking the step from its budget (the decrement skipped)",
    patch: {
      file: RC,
      from: "    giveBack(slot, owner, entry);\n    left = BigInt.asUintN(64, left - 1n);\n  }",
      to: "    giveBack(slot, owner, entry);\n  }",
    },
  },
  {
    name: "release-empty-all",
    what: "tslc's releaseIsEmpty taking every release function as one that does nothing, so an object with slots is given back with what it holds unvisited",
    tslEnv: "release-empty-all",
  },
  {
    name: "pop-refs-uncleared",
    what: "JsArray's pop taking the no-holes way whatever the flag, so popping an array of references leaves the reference in its slot and a longer length reads it back where JS reads a hole",
    patch: {
      file: ARRAY,
      from: "    if (this.holes) this.setLength(n - 1);\n    else this.len = n - 1;",
      to: "    this.len = n - 1;",
    },
    std: "js_array",
  },
  {
    name: "longer-unzeroed",
    what: "JsArray's longer length not zeroing what it adds to an array with no holes, so the slots a pop left read back",
    patch: { file: ARRAY, from: "      if (!this.holes) this.clear(len, n);\n", to: "" },
    std: "js_array",
  },
];

/**
 * The dual route with class printing forced, over r17_free.ts, in `modes` at -O0 and -O2: every case agrees with the direct
 * route natively, and the printed TSL on V8 and JSC with the source (the third route).
 */
export async function r17Dual(
  accels: Accel[],
  jobs: number,
  modes: ("rc" | "leak" | "manual")[] = ["rc", "leak", "manual"],
): Promise<{ failures: string[]; printed: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels: [0, 2],
    accels,
    jobs,
    classes: true,
    dirs: ["corpus/lower/r17"],
    filter: (f) => relative(ROOT, f) === R17_PROGRAM,
  });
  return {
    failures: r.failures,
    printed: [
      ...new Set(r.programs.filter((p) => p.handled).map((p) => `${p.file}@${p.mode}`)),
    ].sort(),
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
  };
}

/** The rc corpus's step-count programs (corpus/rc/rc_steps*.ts), natively against their pins and the host's simulation. */
export async function r17Steps(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const r = await runNative("rc", [accel], jobs, "rc_steps", defaultEngines());
  return {
    failures: r.failures,
    cases: r.agreement.reduce((n, x) => n + x.cases, 0),
    agreed: r.agreement.reduce((n, x) => n + x.agreed, 0),
  };
}

/** One of R17's bugs: how many cases caught it, by a wrong answer, and in all. */
export async function r17FaultRun(
  f: (typeof R17_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const saved = { patch: process.env.TSL_TEST_PATCH, tsl: process.env.TMK_TEST_TSL };
  // checked first (SPEC 8.3): a patch that doesn't apply throws, failing the box, never caught
  const patch = f.patch !== undefined ? patchEnv(f.patch) : undefined;
  if (patch !== undefined) process.env.TSL_TEST_PATCH = patch;
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  try {
    // the compile workers take TSL_* and TMK_* with the environment (jobEnv), so each build reads the bug
    const r =
      f.std !== undefined
        ? await runNative("std", [accel], jobs, f.std, defaultEngines())
        : await runNative("rc", [accel], jobs, "rc_steps", defaultEngines());
    // a patch that no longer matches the source throws in every build: that shows nothing, so it's a harness failure (R18)
    const counted = faultFailures(r.failures, f.name);
    return {
      caught: counted.length,
      answers: wrongAnswers(counted),
      first: (r.failures[0] ?? "").slice(0, 200),
    };
  } finally {
    if (saved.patch === undefined) delete process.env.TSL_TEST_PATCH;
    else process.env.TSL_TEST_PATCH = saved.patch;
    if (saved.tsl === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = saved.tsl;
  }
}

/**
 * The shapes in TIR and in the printing: at -O1 and -O2, class printing's `new` in `rc` makes its object in line (no call to
 * an Rc store's `make` left in adv_forof_mutation.ts's churn, only its slow paths', and the freeing it takes first a call
 * to runSteps); at -O0 `make` is still a call. In `leak` and `manual`, r17_free.ts's arrays of numbers are made with no holes
 * and its arrays of objects with them.
 */
export async function r17Shapes(): Promise<{ ok: boolean; rows: string[]; failures: string[] }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { printFunc } = await import("../compiler/tir/text.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  const calls = (s: string, re: RegExp): number =>
    s.split("\n").filter((l) => /\bcall\b/.test(l) && re.test(l)).length;
  for (const level of [0, 1, 2] as const) {
    const r = lowerFile(join(ROOT, "corpus/lower/rc/adv_forof_mutation.ts"), {
      memory: "rc",
      opt: level,
      route: "tsl",
      classes: true,
    });
    const f = r.tir?.funcs.find((x) => x.name === "churn");
    if (f === undefined) {
      // at -O2 churn is inlined into its callers: look at one
      const g = r.tir?.funcs.find((x) => x.name === "replaceCurrent");
      if (g === undefined) {
        failures.push(`rc -O${level}: neither churn nor replaceCurrent found`);
        continue;
      }
      const t = printFunc(g);
      const make = calls(t, /\.make\b/);
      const steps = calls(t, /\.runSteps\b/);
      rows.push(
        `rc -O${level}: replaceCurrent (churn inlined) ${make} calls to make, ${steps} to runSteps`,
      );
      if (level > 0 && (make !== 0 || steps === 0))
        failures.push(
          `rc -O${level}: make not inlined, or no call to runSteps (${make}, ${steps})`,
        );
      continue;
    }
    const t = printFunc(f);
    const make = calls(t, /\.make\b/);
    const steps = calls(t, /\.runSteps\b/);
    rows.push(`rc -O${level}: churn ${make} calls to make, ${steps} to runSteps`);
    if (level === 0 && make === 0) failures.push("rc -O0: make inlined at -O0");
    if (level > 0 && (make !== 0 || steps === 0))
      failures.push(`rc -O${level}: make not inlined, or no call to runSteps (${make}, ${steps})`);
  }
  for (const memory of ["leak", "manual"] as const) {
    const r = lowerFile(join(ROOT, R17_PROGRAM), {
      memory,
      opt: 0,
      route: "tsl",
      classes: true,
    });
    const text = r.tsl?.text ?? "";
    const giveBack = memory === "leak" ? "false" : "true";
    const nums = text.includes(`new JsArray(f64, `) && text.includes(`, ${giveBack}, false)`);
    const objs =
      text.includes(`new JsArray(ref<Leaf | null>(), `) && text.includes(`, ${giveBack}, true)`);
    rows.push(`${memory}: arrays of numbers with no holes ${nums}, of objects with them ${objs}`);
    if (!nums || !objs)
      failures.push(
        `${memory}: r17_free.ts's arrays aren't printed with the holes flag as R17 has it`,
      );
  }
  return { ok: failures.length === 0, rows, failures };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const jobs = Number(flag("--jobs") ?? "4");
  if (process.argv.includes("--faults")) {
    for (const f of R17_FAULTS) {
      const r = await r17FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  } else {
    const s = await r17Shapes();
    for (const r of s.rows) console.log(r);
    for (const x of s.failures) console.log(`  FAIL ${x}`);
    const d = await r17Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases}; printed ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
    const st = await r17Steps(accel, jobs);
    console.log(`steps: ${st.agreed}/${st.cases}`);
    for (const x of st.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
  }
  process.exit(0);
}
