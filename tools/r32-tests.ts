// R32's tests (SPEC M5's R32 record, 4.3, 3.5, 4.5, D39, D44, D73): range.ts's facts from a float compare's edge, check
// elimination's ToInt32 of a float proved in range as the saturating conversion, `s[x]` and the one-unit string's table
// read printed in `rc` as tests one inside the other, and @tsl/gc's freeAlloc testing a one-slot object's ways in two
// tests. Here:
//
// - what the range fact must do where it applies: r32_index.ts's `scan` through the TSL route in `rc` at -O2 reads its units
//   with no ToInt32's slow way (the saturating conversion) and fewer unsigned tests of an index against a length than with
//   R32 off (TMK_R32_OFF=range,index,units,stable), where it has a ToInt32 and no saturating conversion;
// - corpus/lower/r32 through the dual route with class printing forced, in `rc` and `leak`, at -O0, -O1 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source;
// - corpus/rc's step-count programs natively in `rc` (rc_steps*), D39's steps exactly as pinned with freeAlloc's tests in
//   their new order;
// - each of R32's bugs caught by a wrong answer or a trap (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r32-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R32_DIR = "corpus/lower/r32";
const INDEX = "corpus/lower/r32/r32_index.ts";
const RC = "ex-gc-rc.ts";

/**
 * R32's bugs, each to be caught by a wrong answer or a trap against V8: in the optimiser by name (TMK_OPT_FAULT, range.ts and
 * checks.ts; also in `OPT_FAULTS`, so opt-a box 12 runs them), in the printing by name (TMK_TEST_EMIT, emit-tsl.ts), or in
 * @tsl/gc by patch (TSL_TEST_PATCH, matched exactly). `levels` is where an optimiser bug acts: -O2's check elimination.
 */
export const R32_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  optFault?: string;
  levels?: (0 | 1 | 2)[];
  patch?: TestPatch;
}[] = [
  {
    name: "r32-float-le",
    what: "range.ts taking a float's `x <= n` (n a converted i32) as `x < n`, so ToInt32 of an index equal to the length is taken as below it and the test against the length goes",
    optFault: "r32-float-le",
    levels: [2],
  },
  {
    name: "r32-float-int",
    what: "range.ts taking every float as an integer, so `x > 0` puts ToInt32 of a fraction at 1 or more",
    optFault: "r32-float-int",
    levels: [2],
  },
  {
    name: "r32-float-nan",
    what: "range.ts taking a failed ordered compare's opposite whether or not the float may be NaN, so NaN through `!(x < 0)` and `!(x >= n)` is taken as below n",
    optFault: "r32-float-nan",
    levels: [2],
  },
  {
    name: "r32-sat-any",
    what: "check elimination making every js.toint32 the saturating conversion, proved in range or not, so a float past 2^31 saturates where JS wraps it",
    optFault: "r32-sat-any",
    levels: [2],
  },
  {
    name: "r32-index-le",
    what: "`s[x]` printed in `rc` with the length itself taken as in range, so reading at the length traps where JS gives undefined",
    emit: "r32-index-le",
  },
  {
    name: "r32-stable-global",
    what: "class printing in `rc` taking any module state's read as a string literal's, the same reference after a later operand's statements, so it's read after a call that assigns it",
    emit: "r32-stable-global",
  },
  {
    name: "r32-free-two-slots",
    what: "@tsl/gc's freeAlloc taking an object of two slots as one of one, in its new order of tests, so its second slot is never visited and what it holds is never let go of, against D39's steps",
    patch: {
      file: RC,
      from: "        if (s > 1) {\n          left = freeRest(head, entry, s, left);",
      to: "        if (s > 2) {\n          left = freeRest(head, entry, s, left);",
    },
  },
];

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

/** What R32's range fact must do where it applies, and must not do where it's off. */
export async function r32Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const look = async (
    off: boolean,
  ): Promise<{ sat: number; toint: number; tests: number } | null> =>
    withEnv({ TMK_R32_OFF: off ? "range,index,units,stable" : undefined }, async () => {
      const r = lowerFile(join(ROOT, INDEX), {
        memory: "rc",
        opt: 2,
        route: "tsl",
        classes: true,
      } as never);
      if (r.tir === null) return null;
      const f = r.tir.funcs.find((x: { name: string }) => x.name === "scan");
      if (f === undefined) return null;
      const ops = f.blocks.flatMap((b: { instrs: { op: string }[] }) => b.instrs.map((i) => i.op));
      return {
        sat: ops.filter((o: string) => o === "fptosi.sat.i32").length,
        toint: ops.filter((o: string) => o === "js.toint32").length,
        tests: ops.filter((o: string) => o === "icmp.uge.ix").length,
      };
    });
  const on = await look(false);
  const off = await look(true);
  if (on === null || off === null) return { failures: ["r32_index.ts's scan didn't build"], rows };
  rows.push(
    `-O2 scan: saturating ${on.sat} (R32 off ${off.sat}), js.toint32 ${on.toint} (off ${off.toint}), index tests ${on.tests} (off ${off.tests})`,
  );
  if (on.sat < 1) failures.push(`scan reads its units with no saturating ToInt32 (${on.sat})`);
  if (off.sat !== 0)
    failures.push(
      `scan has a saturating ToInt32 with R32 off: the switch does nothing (${off.sat})`,
    );
  if (off.toint < 1) failures.push(`scan has no js.toint32 with R32 off (${off.toint})`);
  if (!(on.tests < off.tests))
    failures.push(
      `scan's unit reads test their index against a length as often as with R32 off (${on.tests} against ${off.tests})`,
    );
  return { failures, rows };
}

/**
 * The dual route with class printing forced, over R32's program, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (off where a bug is in).
 */
export async function r32Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R32_DIR],
): Promise<{ failures: string[]; cases: number; agreed: number; handled: number }> {
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
  };
}

/** corpus/rc's step-count programs natively in `rc`: D39's steps as pinned. */
export async function r32Steps(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const r = await runNative("rc", [accel], jobs, "rc_steps", defaultEngines());
  let cases = 0;
  let agreed = 0;
  for (const a of r.agreement) {
    cases += a.cases;
    agreed += a.agreed;
  }
  return { failures: r.failures, cases, agreed };
}

/**
 * One of R32's bugs, put in: what caught it (wrong answers, and the first in a stable order). The optimiser's run over
 * R32's program and R26's scans at -O2 in `rc` and `leak`; the printing's over R32's program in `rc` at -O1 and -O2;
 * @tsl/gc's over corpus/rc's step-count programs natively and R32's, R25's and R24's programs in `rc` at -O2.
 */
export async function r32Fault(
  f: (typeof R32_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const wasOpt = process.env.TMK_OPT_FAULT;
  const run = async (): Promise<string[]> => {
    if (f.patch !== undefined)
      return [
        ...(await r32Steps(accel, jobs)).failures,
        ...(
          await r32Dual(
            [accel],
            jobs,
            [2],
            false,
            undefined,
            ["rc"],
            [R32_DIR, "corpus/lower/r25", "corpus/lower/r24"],
          )
        ).failures,
      ];
    if (f.emit !== undefined)
      return (await r32Dual([accel], jobs, [1, 2], false, f.emit, ["rc"])).failures;
    return (
      await r32Dual(
        [accel],
        jobs,
        f.levels ?? [2],
        false,
        undefined,
        ["rc", "leak"],
        [R32_DIR, "corpus/lower/r26"],
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
  let bad = 0;
  if (!argv.includes("--faults-only")) {
    const s = await r32Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const d = await r32Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
      const st = await r32Steps(accel, jobs);
      console.log(`rc_steps: ${st.agreed}/${st.cases}`);
      for (const x of st.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += st.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R32_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r32Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
