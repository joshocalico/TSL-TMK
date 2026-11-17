// R20's tests (SPEC M5's R20 record, 5.10, D39, D42, D49): the runtime's copy and fill of short sizes. `__rt_memmove`'s
// last bytes, under 32, and `__rt_memset`'s, under 16, are steps by the bits of the count where they were a byte at a time:
// most of a short string's copy (strings in `rc` through the TSL route copy units into a fresh tail), and of a thrown
// object's placing (`Dyn`, past the 48 bytes the backend copies in line).
//
// - corpus/r20/r20_steps.ts, TSL proper, natively at -O0 and -O2: a byte array's `set` from a run of itself (a copy over
//   itself, down and up) of every length to 40, and `fill` of every length to 24, each against a byte loop (no byte differs);
// - corpus/lower/r20/r20_copies.ts through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2:
//   every case agrees with V8 natively (the runtime is both routes', so the routes agreeing alone proves nothing), with the
//   TSL route, and the printed TSL on V8 and JSC with the source;
// - each of R20's bugs caught by a wrong answer (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r20-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R20_DIR = "corpus/lower/r20";
export const R20_PROGRAM = "corpus/lower/r20/r20_copies.ts";
export const R20_STEPS = "corpus/r20/r20_steps.ts";

/**
 * R20's bugs, each to be caught by a wrong answer: in the backend's runtime by name (TMK_TEST_TSL), against V8; and in the
 * inliner (TMK_OPT_FAULT, also opt-a box 12's), against the direct route.
 */
export const R20_FAULTS: { name: string; what: string; tslEnv?: string; optFault?: string }[] = [
  {
    name: "memmove-skip4",
    what: "a copy's last bytes missing their 4-byte step, either way",
    tslEnv: "memmove-skip4",
  },
  {
    name: "memmove-back-skip1",
    what: "a copy up over itself (a destination above its source) missing its last byte",
    tslEnv: "memmove-back-skip1",
  },
  {
    name: "memset-skip2",
    what: "a fill of under 16 bytes missing its 2-byte store",
    tslEnv: "memset-skip2",
  },
  {
    name: "inline-alloca-pure-block",
    what: "partial inlining taking a callee's entry with a frame slot as free of effects, so its rare path moves a count twice",
    optFault: "inline-alloca-pure-block",
  },
];

/**
 * The dual route with class printing forced, over R20's program, in `rc` and `leak`: every case agrees with V8 natively and
 * with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r20Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
): Promise<{ failures: string[]; cases: number; agreed: number; handled: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc", "leak"],
    levels,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R20_DIR],
    v8: () => true,
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    handled: r.programs.filter((p) => p.handled && relative(ROOT, p.file) !== "").length,
  };
}

/** corpus/r20/r20_steps.ts natively at each level: each case's pinned value (no byte differs from a byte loop's). */
export async function r20Steps(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 2],
): Promise<{ failures: string[]; cases: number; agreed: number; skipped: boolean }> {
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { buildTslImage, tslResults, bulkFor } = await import("./native-exec.ts");
  const { qemuRun } = await import("./qemu-run.ts");
  const file = join(ROOT, R20_STEPS);
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
  const failures: string[] = [];
  let n = 0;
  let agreed = 0;
  for (const opt of levels) {
    const c = checkFile(file);
    if (c.typed === null) {
      failures.push(
        `${R20_STEPS} -O${opt}: ${c.diags.map((d) => `${d.code} ${d.msg}`).join("; ")}`,
      );
      continue;
    }
    const o = compileTyped(c.typed, { opt });
    if (opt === 1 || opt === 2) o.tir.opt = opt;
    const image = buildTslImage(o.tir, o.meta as never, cases, undefined, bulkFor());
    const q = await qemuRun({
      name: `r20-steps-O${opt}`,
      image: image.bytes,
      accel,
      timeoutMs: 120_000,
      ...(image.bulk !== undefined ? { bulk: image.bulk } : {}),
    });
    if (q.skipped) return { failures, cases: n, agreed, skipped: true };
    if (!q.ok) {
      failures.push(`${R20_STEPS} -O${opt}: ${q.status} ${q.why.slice(0, 200)}`);
      continue;
    }
    const { results, problems } = tslResults(o.meta as never, cases, q.lines);
    failures.push(...problems.map((p) => `${R20_STEPS} -O${opt}: ${p}`));
    results.forEach((r, i) => {
      n++;
      if (r.pin === "ok") agreed++;
      else failures.push(`${R20_STEPS} -O${opt}: ${r.fn}#${i}: ${r.pin ?? "no pin"}`);
    });
  }
  return { failures, cases: n, agreed, skipped: false };
}

/** One of R20's bugs, put in: what caught it (wrong answers, and the first in a stable order). */
export async function r20Fault(
  f: (typeof R20_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const was = process.env.TMK_TEST_TSL;
  const wasOpt = process.env.TMK_OPT_FAULT;
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  try {
    const r = await r20Dual([accel], jobs, [2], false);
    const st = await r20Steps(accel, [2]);
    const failures = faultFailures([...st.failures, ...r.failures], f.name);
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
  const st = await r20Steps(accel);
  console.log(`steps: ${st.agreed}/${st.cases} cases${st.skipped ? " (SKIPPED)" : ""}`);
  for (const x of st.failures.slice(0, 20)) console.log(`FAIL ${x}`);
  const d = await r20Dual([accel], jobs);
  console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
  for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
  if (argv.includes("--faults"))
    for (const f of R20_FAULTS) {
      const x = await r20Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
  process.exitCode = d.failures.length + st.failures.length > 0 ? 1 : 0;
}
