// R28's tests (SPEC M5's R28 record, 3.5, 4.3, D44, D73, D78): the rest of `TRUSTED_IN` rc's list and scans' last costs.
// Fresh slots cut in line (@tsl/gc's pageCut), a lowered `rc` package's references with no tag (lower-native.ts's
// untaggedRcClass, callRelease's arms), a module variable written only by `__init` borrowed by a call (expand-rc.ts's
// initOnly), placeTail's zeroing in line, and the optimiser's: a tag or'd into a reference's top bits taken off before
// `ref.addr` (simplify.ts), two equal constants one operand to dominating conditions (conds.ts), a callee no bigger than its
// call inlined past the growth limit (inline.ts), and -O2's loops the first versioning pass left versioned after the
// copying rounds (manager.ts, version.ts). Here:
//
// - corpus/lower/r28 (and R26's and R27's programs) through the dual route with class printing forced, in `rc` and `leak`, at
//   -O0, -O1 and -O2: every case agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC;
// - each of R28's bugs caught by wrong answers or traps (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r28-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--faults-only] [--only name]
import { relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R28_DIR = "corpus/lower/r28";
export const R28_PROGRAMS = ["corpus/lower/r28/r28_rc.ts"];
const RC = "ex-gc-rc.ts";

/**
 * R28's bugs, each to be caught by a wrong answer or a trap against V8: in the optimiser by name (TMK_OPT_FAULT; also in
 * `OPT_FAULTS`, so opt-a box 12 runs them), in tslc by name (TMK_TEST_TSL, lower-native.ts and elab-native.ts; TMK_TEST_RC_TSL,
 * expand-rc.ts), or in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly). `levels` is where an optimiser bug acts.
 */
export const R28_FAULTS: {
  name: string;
  what: string;
  optFault?: string;
  tslEnv?: string;
  rcEnv?: string;
  levels?: (0 | 1 | 2)[];
  patch?: TestPatch;
}[] = [
  {
    name: "r28-untag-arm",
    what: "callRelease's arm for a lowered rc package's class handed its object tagged, though its fields are read with no mask",
    tslEnv: "r28-untag-arm",
    levels: [0, 2],
  },
  {
    name: "r28-untag-any",
    what: "every class's references taken as having no tag, so a field of @tsl/gc's own objects (a store, a room) is read through a tagged address",
    tslEnv: "r28-untag-any",
    levels: [0, 2],
  },
  {
    name: "r28-init-any",
    what: "every module variable taken as written only by __init, so a call given a variable it overwrites borrows the old value with no count of its own, and it's freed under the call",
    rcEnv: "r28-init-any",
    levels: [0, 2],
  },
  {
    name: "r28-zero-short",
    what: "placeTail's zeroing in line a word short, so a reused slot's last tail word keeps what it held",
    tslEnv: "r28-zero-short",
    levels: [0, 2],
  },
  {
    name: "r28-cut-past",
    what: "@tsl/gc's in-line cut not testing the page's end, so a fresh slot runs past the page into the next block",
    patch: {
      file: RC,
      from: "  if (slot === 0n || BigInt.asUintN(64, slot + size) > at.add(CLASSES).read()) return 0n;\n",
      to: "  if (slot === 0n) return 0n;\n",
    },
    levels: [2],
  },
  {
    name: "r28-consts-any",
    what: "dominating conditions taking any two integer constants of a type as the same operand, so a test of index 0 answers a read of index 2",
    optFault: "r28-consts-any",
    levels: [1, 2],
  },
  {
    name: "r28-tag-keep-wrong",
    what: "`ref.addr (or x, tag)` folded to the tag's pointer, so the address is dropped",
    optFault: "r28-tag-keep-wrong",
    levels: [1, 2],
  },
  {
    name: "r28-shrink-store",
    what: "a callee no bigger than its call, inlined past the caller's growth limit, copied without its first store (a printed class's init leaves a field zero)",
    optFault: "r28-shrink-store",
    levels: [2],
  },
  {
    name: "r28-version-again",
    what: "-O2's second versioning pass (loops the copying rounds made) letting the fast copy run one turn more than its checks allow",
    optFault: "r28-version-again",
    levels: [2],
  },
];

/**
 * The dual route with class printing forced, over R28's program (and others), in `rc` and `leak`: every case agrees with V8
 * natively and with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is in).
 */
export async function r28Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R28_DIR],
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

function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const was: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return f().finally(() => {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/**
 * One of R28's bugs, put in: what caught it (wrong answers and traps, and the first in a stable order). Each runs over R28's
 * program and R26's and R27's (scans, views, fills) in `rc` at the bug's levels, through the dual route; @tsl/gc's also over
 * corpus/rc's step-count programs natively.
 */
export async function r28Fault(
  f: (typeof R28_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const dirs = [R28_DIR, "corpus/lower/r26", "corpus/lower/r27"];
  const run = async (): Promise<string[]> => {
    const d = await r28Dual([accel], jobs, f.levels ?? [1, 2], false, undefined, ["rc"], dirs);
    if (f.patch === undefined) return d.failures;
    return [
      ...d.failures,
      ...(await runNative("rc", [accel], jobs, "rc_steps", defaultEngines())).failures,
    ];
  };
  const env: Record<string, string | undefined> = {};
  if (f.optFault !== undefined) env.TMK_OPT_FAULT = f.optFault;
  if (f.tslEnv !== undefined) env.TMK_TEST_TSL = f.tslEnv;
  if (f.rcEnv !== undefined) env.TMK_TEST_RC_TSL = f.rcEnv;
  const failures = faultFailures(
    await withEnv(env, () => (f.patch !== undefined ? withPatch(f.patch, run) : run())),
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
    const d = await r28Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
    console.log(`printed: ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
    process.exitCode = d.failures.length > 0 ? 1 : 0;
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R28_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r28Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
}
