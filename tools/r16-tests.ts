// R16's tests (SPEC M5's R16 record, D44, D66): class printing's arrays made at their final size in one step and `push`
// with an inlined fast path (@tsl/jsrt's JsArray and JsArenaArray), and native-e box 9's timing check over the median of
// its last iterations.
//
// - corpus/lower/r16/r16_arrays.ts and the corpus's array programs through the dual route with class printing forced, in
//   `strict`, `leak` and `manual`, at -O0 and -O2: every case agrees with the direct route natively, and the printed TSL on
//   V8 and JSC with the source;
// - the shapes, in TIR: in operandWork's class printing at -O1 and -O2, `push` and the constructor are inlined (no call to
//   either), the slow path a call to `pushGrow`, and a literal's making calls no growth;
// - each of R16's bugs (TSL_TEST_PATCH into the two classes' source) caught by those cases, counted by wrong answers;
// - box 9's bugs (`listDiagnosis`'s `fault`), each failing the box's check.
//
//   node tools/r16-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults] [--diag-faults]
import { dirname, join, relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";

export const R16_PROGRAMS = ["corpus/lower/r16/r16_arrays.ts"];

/** The programs R16's bugs are looked for in: R16's own, and the corpus's array programs. */
export const R16_FAULT_PROGRAMS = [
  ...R16_PROGRAMS,
  "corpus/lower/pos/array_vec.ts",
  "corpus/lower/pos/array_methods.ts",
];

const ARRAY = "ex-jsrt-array.ts";
const ARENA = "ex-jsrt-arena.ts";

/** One bug in both classes' source, as TSL_TEST_PATCH takes it: the same text in each. */
function both(from: string, to: string): { file: string; from: string; to: string }[] {
  return [
    { file: ARRAY, from, to },
    { file: ARENA, from, to },
  ];
}

/** The bugs put into R16's construction and `push`, each to be caught by the dual route's cases. */
export const R16_FAULTS: {
  name: string;
  what: string;
  patch: { file: string; from: string; to: string }[];
}[] = [
  {
    name: "literal-short",
    what: "an array (a literal) made one element shorter than asked for",
    patch: both(
      "    this.cap = ncap;\n    this.len = length;\n",
      "    this.cap = ncap;\n    this.len = length > 0 ? length - 1 : 0;\n",
    ),
  },
  {
    name: "push-no-bump",
    what: "push's fast path storing the element and not raising the length",
    patch: both(
      "    if (n >= this.cap) return this.pushGrow(v);\n    this.slot(n).write(v);\n    const m = n + 1;\n    this.len = m;\n",
      "    if (n >= this.cap) return this.pushGrow(v);\n    this.slot(n).write(v);\n    const m = n + 1;\n",
    ),
  },
  {
    name: "push-full",
    what: "push's fast path taken at full capacity, so the element goes one past the buffer",
    patch: both(
      "if (n >= this.cap) return this.pushGrow(v);",
      "if (n > this.cap) return this.pushGrow(v);",
    ),
  },
  {
    name: "grow-short",
    what: "growth copying one element fewer than the array holds",
    patch: both(
      "    const kept = this.len * size;\n",
      "    const kept = (this.len > 0 ? this.len - 1 : 0) * size;\n",
    ),
  },
];

/**
 * The dual route with class printing forced, in `strict`, `leak` and `manual`, at -O0 and -O2, over `files` (each a path
 * relative to the repo): every case agrees with the direct route natively, and the printed TSL on V8 and JSC with the
 * source (the third route; off where a bug is put into the library, which tslc reads and V8 doesn't).
 */
export async function r16Dual(
  accels: Accel[],
  jobs: number,
  files: string[] = R16_FAULT_PROGRAMS,
): Promise<{ failures: string[]; printed: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["strict", "leak", "manual"],
    levels: [0, 2],
    accels,
    jobs,
    classes: true,
    dirs: [...new Set(files.map((f) => dirname(f)))],
    filter: (f) => files.includes(relative(ROOT, f)),
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

/** One of R16's bugs: how many cases caught it, by a wrong answer, and in all. */
export async function r16FaultRun(
  f: (typeof R16_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const was = process.env.TSL_TEST_PATCH;
  // the compile workers take TSL_* with the environment (jobEnv), so each build reads the patched source
  process.env.TSL_TEST_PATCH = patchEnv(f.patch); // checked first (SPEC 8.3): one that doesn't apply throws
  try {
    const { failures } = await r16Dual([accel], jobs);
    faultFailures(failures, f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (failures[0] ?? "").slice(0, 200),
    };
  } finally {
    if (was === undefined) delete process.env.TSL_TEST_PATCH;
    else process.env.TSL_TEST_PATCH = was;
  }
}

/**
 * The shapes in TIR, class printing forced, in `manual` and `strict`: at -O1 and -O2 no call to `push` or to the
 * constructor is left in operandWork (both inlined, the slow path a call to `pushGrow`), and r16_arrays.ts's literals
 * (`lit`) call no growth; at -O0 `push` is still a call (nothing is inlined there). Each row says what it found.
 */
export async function r16Shapes(): Promise<{ ok: boolean; rows: string[]; failures: string[] }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { printFunc } = await import("../compiler/tir/text.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  const calls = (s: string, re: RegExp): number =>
    s.split("\n").filter((l) => /\bcall\b/.test(l) && re.test(l)).length;
  for (const memory of ["manual", "strict"] as const) {
    for (const level of [0, 1, 2] as const) {
      const op = lowerFile(join(ROOT, "bench/reshape/reshape_lowered.ts"), {
        memory,
        opt: level,
        route: "tsl",
        classes: true,
      });
      const lits = lowerFile(join(ROOT, "corpus/lower/r16/r16_arrays.ts"), {
        memory,
        opt: level,
        route: "tsl",
        classes: true,
      });
      if (op.tir === null || lits.tir === null) {
        failures.push(`${memory} -O${level}: no TIR`);
        continue;
      }
      const f = op.tir.funcs.find((x) => x.name === "operandWork");
      const g = lits.tir.funcs.find((x) => x.name === "lit");
      if (f === undefined || g === undefined) {
        failures.push(`${memory} -O${level}: operandWork or lit not found`);
        continue;
      }
      const t = printFunc(f);
      const u = printFunc(g);
      const push = calls(t, /\.push\b/);
      const slow = calls(t, /\.pushGrow\b/);
      const ctor = calls(t, /\.constructor\b/) + calls(u, /\.constructor\b/);
      const grow = calls(u, /\.(grow|pushGrow|reserve)\b/);
      rows.push(
        `${memory} -O${level}: operandWork ${push} push calls, ${slow} pushGrow; constructor calls ${ctor}; lit's growth calls ${grow}`,
      );
      if (grow !== 0)
        failures.push(`${memory} -O${level}: a literal calls growth: ${u.slice(0, 400)}`);
      if (level === 0 && push === 0) failures.push(`${memory} -O0: push inlined at -O0`);
      if (level > 0 && (push !== 0 || ctor !== 0 || slow === 0))
        failures.push(
          `${memory} -O${level}: push or the constructor not inlined, or no slow path: ${push} ${ctor} ${slow}`,
        );
    }
  }
  return { ok: failures.length === 0, rows, failures };
}

/** native-e box 9's check over a diagnosis (the medians of iterations 180 to 199), what each part of it found. */
export function box9Check(diag: import("./rc-tests.ts").ListDiagnosis): {
  ok: boolean;
  samePage: boolean;
  timing: boolean;
  text: string;
} {
  const tail = (what: string) => diag.tails.find((r) => r.what.startsWith(what));
  const row = (what: string) =>
    diag.rows.find((r) => r.what.startsWith(what) && r.iteration === 199);
  const reused = tail("rc, collector off, budget 32");
  const notReused = tail("rc, collector off, blocks");
  const paced = tail("rc, collector off, budget 2");
  const on = tail("rc, collector on");
  const r199 = row("rc, collector off, budget 32");
  const n199 = row("rc, collector off, blocks");
  const p199 = row("rc, collector off, budget 2");
  const whole = diag.tailTo - diag.tailFrom + 1;
  const all =
    [reused, notReused, paced, on, r199, n199, p199].every((x) => x !== undefined) &&
    [reused, notReused, paced, on].every((x) => x!.n === whole);
  const samePage = all && r199!.samePage < 0.1 && n199!.samePage > 0.9 && p199!.samePage > 0.9;
  const timing =
    all && reused!.medianMs > notReused!.medianMs && reused!.medianMs > paced!.medianMs;
  return {
    ok: all && samePage && timing,
    samePage,
    timing,
    text: all
      ? `medians of iterations ${diag.tailFrom} to ${diag.tailTo}: reused ${reused!.medianMs.toFixed(3)} ms, not reused ${notReused!.medianMs.toFixed(3)}, paced ${paced!.medianMs.toFixed(3)}, collector on ${on!.medianMs.toFixed(3)}; same page at 199: ${(100 * r199!.samePage).toFixed(1)}%, ${(100 * n199!.samePage).toFixed(1)}%, ${(100 * p199!.samePage).toFixed(1)}%`
      : `a variant's rows are missing, or fewer than ${whole} of its last iterations`,
  };
}

/** Box 9's bugs, each put into the diagnosis (`listDiagnosis`'s `fault`), each to fail the box's check. */
export const BOX9_FAULTS: { name: string; what: string }[] = [
  {
    name: "ordered-free-list",
    what: "the reused variant's free list keeping the list's order (its freed blocks never reused, so a new node is the next fresh block)",
  },
  {
    name: "short-work",
    what: "the reused variant timed over a tenth of the work the others do",
  },
];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const jobs = Number(flag("--jobs") ?? "4");
  if (process.argv.includes("--faults")) {
    for (const f of R16_FAULTS) {
      const r = await r16FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  } else if (process.argv.includes("--diag-faults")) {
    const { listDiagnosis } = await import("./rc-tests.ts");
    const d = await listDiagnosis(accel);
    console.log(`none: ${JSON.stringify(box9Check(d))}`);
    for (const f of BOX9_FAULTS) {
      const r = box9Check(await listDiagnosis(accel, f.name));
      console.log(`${f.name}: ${JSON.stringify(r)}`);
    }
  } else {
    const s = await r16Shapes();
    for (const r of s.rows) console.log(r);
    for (const x of s.failures) console.log(`  FAIL ${x}`);
    const d = await r16Dual([accel], jobs);
    console.log(`dual: ${d.agreed}/${d.cases}; printed ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
  }
  process.exit(0);
}
