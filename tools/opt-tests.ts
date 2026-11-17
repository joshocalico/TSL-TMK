// The optimiser's own tests (SPEC 8.1, D44, D46), for `tmk milestone opt-a` and `tmk test`: random programs at -O0 and
// -O2 natively with every `rc` counter compared, run-time call counts, the bugs that can be put into the passes and which
// test catches each, what each level costs to compile, and how big what it emits is. None of it needs V8.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { OptLevel } from "../compiler/tir/passes/manager.ts";
import { lowerAndBuild } from "./compile-pool.ts";
import { listPrograms, ROOT } from "./corpus.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import type { LowerCase } from "./lower-exec.ts";
import { bulkFor, downResults, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { generate } from "./rc-fuzz.ts";
import { generateStrmap } from "./strmap-fuzz.ts";
import { buildPath } from "./build-dir.ts";
import { sliceGenerated } from "./sweep.ts";

export interface DiffResult {
  seeds: number;
  ran: number;
  cases: number;
  counters: number; // counter values compared, case by case
  failures: string[];
  skipped: boolean;
}

/** One program's results and counters at a level, in `rc`'s poisoning build with its counters. */
async function rcRun(
  file: string,
  level: OptLevel,
  rc: Record<string, unknown>,
  accel: Accel,
  cases?: LowerCase[],
): Promise<
  | { ok: true; results: string[]; stats: Record<string, number>[]; cases: LowerCase[] }
  | { ok: false; why: string; skipped?: boolean }
> {
  const {
    o,
    built,
    cases: used,
  } = await lowerAndBuild({
    file,
    lower: { memory: "rc", rc: { check: true, account: true, ...rc }, opt: level },
    harness: { collect: true, stats: true, bulkBytes: bulkFor() },
    noFallback: true,
    ...(cases !== undefined ? { cases } : {}),
  });
  if (o.diags.length > 0 || o.tir === null || built === null)
    return { ok: false, why: `doesn't build: ${JSON.stringify(o.diags).slice(0, 200)}` };
  const r = await qemuRun({
    name: `opt-diff/${relative(ROOT, file)}/O${level}`,
    image: built.image.bytes,
    accel,
    timeoutMs: 120_000,
    ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
  });
  if (r.skipped) return { ok: false, why: "skipped", skipped: true };
  if (!r.ok) return { ok: false, why: `${r.status}: ${r.why.slice(0, 200)}` };
  const { results, problems } = downResults(
    o.meta as DownMetaLike,
    used,
    built.placements,
    r.lines,
  );
  if (problems.length > 0) return { ok: false, why: problems.slice(0, 3).join("; ") };
  return {
    ok: true,
    results: results.map((x) => JSON.stringify(x.result)),
    stats: rcStatLines(o.tir as never, r.lines),
    cases: used,
  };
}

/** Compares two runs case by case: results, and every counter `rc` keeps, which no level may change. */
function compareRuns(
  name: string,
  a: { results: string[]; stats: Record<string, number>[] },
  b: { results: string[]; stats: Record<string, number>[] },
  level: OptLevel,
  out: DiffResult,
  ignore: string[] = [],
): void {
  a.results.forEach((want, i) => {
    if (b.results[i] !== want)
      out.failures.push(
        `${name} case ${i} at -O${level}: ${b.results[i]?.slice(0, 120)}, -O0 gave ${want.slice(0, 120)}`,
      );
    const sa = a.stats[i] ?? {};
    const sb = b.stats[i] ?? {};
    for (const k of Object.keys(sa)) {
      if (ignore.includes(k)) continue;
      out.counters++;
      if (sa[k] !== sb[k])
        out.failures.push(`${name} case ${i} at -O${level}: counter ${k} ${sb[k]}, -O0 ${sa[k]}`);
    }
  });
}

/** `rc`'s random programs, and the ones over strings, Map and Set, at -O0 and -O2, with no V8 (D44). */
export async function sourceDiff(
  from: number,
  seeds: number,
  accel: Accel,
  jobs: number,
  level: OptLevel = 2,
): Promise<DiffResult> {
  const dir = buildPath("opt-diff");
  mkdirSync(dir, { recursive: true });
  const out: DiffResult = { seeds, ran: 0, cases: 0, counters: 0, failures: [], skipped: false };
  const budgets = [1, 2, 3, 5, 8, 13, 32];
  await pool(
    Array.from({ length: seeds }, (_, i) => from + i),
    jobs,
    async (seed) => {
      // A third each: rc's programs, with cycles, and over strings, Map and Set; each at a budget, so freeing interleaves.
      const kind = seed % 3;
      const file = join(dir, `s${seed}.ts`);
      writeFileSync(file, kind === 2 ? generateStrmap(seed) : generate(seed, kind === 1));
      const rc = { pace: false, budget: budgets[seed % budgets.length]! };
      const a = await rcRun(file, 0, rc, accel);
      if (!a.ok) {
        if (a.skipped === true) out.skipped = true;
        else out.failures.push(`seed ${seed} at -O0: ${a.why}`);
        return;
      }
      const b = await rcRun(file, level, rc, accel, a.cases);
      if (!b.ok) {
        if (b.skipped === true) out.skipped = true;
        else out.failures.push(`seed ${seed} at -O${level}: ${b.why}`);
        return;
      }
      // `calls` is the optimiser's own measure, when asked for, and is meant to differ.
      compareRuns(`seed ${seed}`, a, b, level, out, ["calls"]);
      out.ran++;
      out.cases += a.results.length;
    },
  );
  return out;
}

/** The `rc` corpus at -O0 and at a level, in the counting build: the same results and the same counts, case by case. */
export async function corpusCounters(
  accel: Accel,
  jobs: number,
  level: OptLevel = 2,
  dirs: string[] = ["corpus/lower/rc", "corpus/lower/strmap"],
): Promise<DiffResult> {
  // A phase gate runs a quarter of the generated `finally` programs, a different quarter each day (D51).
  const files = sliceGenerated(
    dirs
      .flatMap((d) => listPrograms(join(ROOT, d)))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".cases.json")),
  );
  const withCases = files.filter((f) => {
    try {
      readFileSync(f.replace(/\.ts$/, ".cases.json"));
      return true;
    } catch {
      return false;
    }
  });
  const out: DiffResult = {
    seeds: withCases.length,
    ran: 0,
    cases: 0,
    counters: 0,
    failures: [],
    skipped: false,
  };
  await pool(withCases, jobs, async (file) => {
    const cases = JSON.parse(
      readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"),
    ) as LowerCase[];
    const a = await rcRun(file, 0, {}, accel, cases);
    if (!a.ok) {
      if (a.skipped === true) out.skipped = true;
      // A program that falls back has no image at either level, which the corpus reports.
      else if (!a.why.startsWith("doesn't build"))
        out.failures.push(`${relative(ROOT, file)} at -O0: ${a.why}`);
      return;
    }
    const b = await rcRun(file, level, {}, accel, cases);
    if (!b.ok) {
      if (b.skipped === true) out.skipped = true;
      else out.failures.push(`${relative(ROOT, file)} at -O${level}: ${b.why}`);
      return;
    }
    compareRuns(relative(ROOT, file), a, b, level, out, ["calls"]);
    out.ran++;
    out.cases += a.results.length;
  });
  return out;
}

export interface CallCounts {
  programs: number;
  staticBefore: number;
  staticAfter: number;
  dynamicBefore: number;
  dynamicAfter: number;
  rows: { file: string; s0: number; s2: number; d0: number; d2: number }[];
  failures: string[];
  skipped: boolean;
}

/**
 * Calls, at -O0 and a level, in the linked images of the `rc` corpus: static, as instructions in the image's code, and
 * at run time, by a counter before each call in the program's code (the runtime the image links isn't counted).
 */
export async function callCounts(
  accel: Accel,
  jobs: number,
  level: OptLevel = 2,
): Promise<CallCounts> {
  const files = [
    ...listPrograms(join(ROOT, "corpus/lower/rc")),
    ...listPrograms(join(ROOT, "corpus/lower/strmap")),
  ];
  const out: CallCounts = {
    programs: 0,
    staticBefore: 0,
    staticAfter: 0,
    dynamicBefore: 0,
    dynamicAfter: 0,
    rows: [],
    failures: [],
    skipped: false,
  };
  const was = process.env.TMK_OPT_COUNT_CALLS;
  process.env.TMK_OPT_COUNT_CALLS = "1";
  try {
    await pool(files, jobs, async (file) => {
      let cases: LowerCase[];
      try {
        cases = JSON.parse(
          readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"),
        ) as LowerCase[];
      } catch {
        return;
      }
      const at = async (l: OptLevel): Promise<{ s: number; d: number } | null> => {
        const { o, built } = await lowerAndBuild({
          file,
          lower: { memory: "rc", opt: l },
          harness: { stats: true, bulkBytes: bulkFor() },
          noFallback: true,
          cases,
        });
        if (o.tir === null || built === null) return null;
        const r = await qemuRun({
          name: `calls/${relative(ROOT, file)}/O${l}`,
          image: built.image.bytes,
          accel,
          timeoutMs: 120_000,
          ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
        });
        if (r.skipped) {
          out.skipped = true;
          return null;
        }
        if (!r.ok) {
          out.failures.push(
            `${relative(ROOT, file)} at -O${l}: ${r.status} ${r.why.slice(0, 160)}`,
          );
          return null;
        }
        const st = rcStatLines(o.tir as never, r.lines).filter((x) => x !== undefined);
        const d = st.at(-1)?.calls ?? 0;
        // Static: every call instruction in the module as linked, the counter's own load and store aside.
        return { s: o.opt?.callsAfter ?? 0, d };
      };
      const a = await at(0);
      const b = await at(level);
      if (a === null || b === null) return;
      out.programs++;
      out.staticBefore += a.s;
      out.staticAfter += b.s;
      out.dynamicBefore += a.d;
      out.dynamicAfter += b.d;
      out.rows.push({ file: relative(ROOT, file), s0: a.s, s2: b.s, d0: a.d, d2: b.d });
    });
  } finally {
    if (was === undefined) delete process.env.TMK_OPT_COUNT_CALLS;
    else process.env.TMK_OPT_COUNT_CALLS = was;
  }
  out.rows.sort((x, y) => (x.file < y.file ? -1 : 1));
  return out;
}

export interface FaultRow {
  fault: string;
  caught: boolean;
  by: string;
  detail: string;
}

/**
 * Each bug the passes can be built with (manager.ts OPT_FAULTS), against the tests in order, cheapest first, until one
 * fails. A bug is caught when a test fails with it in, and the same test passes without it (checked first).
 */
export async function faultsCaught(accel: Accel, jobs: number, only?: string): Promise<FaultRow[]> {
  if (only === undefined && process.env.TMK_FAULT_PARTS !== "off")
    return faultsInParts(accel, jobs);
  return faultsCaught0(accel, jobs, only);
}

/**
 * Bugs run at once, each part in its own process (D76). Two, not four: four, each running its suites, loaded a gate enough that
 * pipe-d box 40's rc images ran past their 60 s limit (MEASURED, T1's first gate), and limits aren't raised.
 */
const FAULT_PARTS_AT_ONCE = 2;
const FAULT_PART = new URL("./opt-fault-part.ts", import.meta.url).pathname;

/**
 * faultsCaught, each bug, and the run with none, in a process of its own (the bug is the process's TMK_OPT_FAULT), a few at
 * once. Each part runs the same tests in the same order as faultsCaught does one after another, and the rows are put
 * together as it would have: the run with no bug failing is the one row, and otherwise each bug's row in OPT_FAULTS's order.
 * A part that doesn't finish fails the box, as the job would have.
 */
async function faultsInParts(accel: Accel, jobs: number): Promise<FaultRow[]> {
  const { OPT_FAULTS } = await import("../compiler/tir/passes/manager.ts");
  const { guardedRun, pool } = await import("./guarded-run.ts");
  const { buildPath } = await import("./build-dir.ts");
  const parts = ["(none)", ...OPT_FAULTS];
  const results = await pool(parts, FAULT_PARTS_AT_ONCE, async (fault) => {
    // A build directory of its own, as every job has: parts at once wrote the same corpus files (MEASURED: the run with no
    // bug failed with them shared, and passes alone). Its QEMU record is under it, which the gate reaps (reapJobDir).
    const dir = buildPath("parts", fault.replace(/[^\w.-]+/g, "_"));
    const r = await guardedRun(
      process.execPath,
      ["--no-warnings", FAULT_PART, accel, String(jobs), fault],
      {
        timeoutMs: 3_600_000,
        label: `opt fault part ${fault}`,
        env: { ...process.env, TMK_BUILD_DIR: dir },
      },
    );
    const line = r.stdout.split("\n").find((l) => l.startsWith("TMK-PART "));
    if (!r.ok || line === undefined)
      throw new Error(`the part for ${fault} didn't finish: ${r.why} ${r.stderr.slice(0, 600)}`);
    return JSON.parse(line.slice("TMK-PART ".length)) as FaultRow;
  });
  const none = results[0]!;
  if (none.caught) return [none];
  return results.slice(1);
}

/** One part: the run with no bug in ("(none)"), whose row says caught if a test failed, or one bug's row. */
export async function faultPart(accel: Accel, jobs: number, fault: string): Promise<FaultRow> {
  const env = process.env;
  if (fault === "(none)") {
    env.TMK_OPT = "2";
    delete env.TMK_OPT_FAULT;
    for (const s of await faultSteps(accel, jobs))
      if (!(await s.run()))
        return {
          fault: "(none)",
          caught: true,
          by: s.name,
          detail: "fails with no bug in: nothing below means anything",
        };
    return { fault: "(none)", caught: false, by: "", detail: "" };
  }
  const rows = await faultsCaught0(
    accel,
    jobs,
    `^${fault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    true,
  );
  const row = rows.find((r) => r.fault === fault);
  if (row === undefined) throw new Error(`no bug ${fault}`);
  return row;
}

async function faultSteps(
  accel: Accel,
  jobs: number,
): Promise<{ name: string; run: () => Promise<boolean> }[]> {
  const { tirFuzz } = await import("./tir-fuzz.ts");
  const { runNative, defaultEngines } = await import("./corpus.ts");
  const engines = defaultEngines();
  return [
    {
      // R15: the loops conds.ts and versioning touch, natively at the bug's level, -O2 (seconds, so first: R15's bugs are
      // caught here, and so may an earlier bug be, which changes only which step names it).
      name: "R15's loops natively at -O2 (corpus/trap/loop_versions.ts, tools/r15-tests.ts)",
      run: async () => {
        const R15 = await import("./r15-tests.ts");
        return (await R15.r15Native(accel, jobs, 2, process.env.TMK_OPT_FAULT)).ok;
      },
    },
    {
      name: "random TIR at -O0, -O1 and -O2, 30 seeds",
      run: async () => (await tirFuzz(100, 30, accel, jobs)).failures.length === 0,
    },
    {
      name: "random programs in rc at -O0 and -O2, results and counters, 24 seeds",
      run: async () => (await sourceDiff(1, 24, accel, jobs)).failures.length === 0,
    },
    {
      name: "native lower in rc's poisoning build at -O2, against V8",
      run: async () =>
        (
          await runNative("lower", [accel], jobs, undefined, engines, "rc", {
            rc: { check: true, account: true },
            harness: { collect: true },
            suffix: "-poison-on",
          })
        ).ok,
    },
    {
      name: "native trap, pos and std at -O2",
      run: async () => {
        for (const k of ["trap", "pos", "std"] as const) {
          if (!(await runNative(k, [accel], jobs, undefined, engines)).ok) return false;
        }
        return true;
      },
    },
    {
      // R7: -O1's loop bounds shapes (no QEMU), and an explicit null check left to a load, natively at each level, inside
      // a case and outside one. Last, so a bug an earlier step catches never gets here.
      name: "R7's tests: the loop bounds shapes at -O1, the null check natively (tools/r7-tests.ts)",
      run: async () => {
        const R7 = await import("./r7-tests.ts");
        if (!R7.loopBoundsCases().every((r) => r.ok)) return false;
        return (await R7.nullChecks(accel)).every((r) => r.ok);
      },
    },
  ];
}

/** One after another, as it always was: TMK_FAULT_PARTS=off, or a bug picked by `only` (and each part, skipping the run with none). */
async function faultsCaught0(
  accel: Accel,
  jobs: number,
  only?: string,
  skipNone = false,
): Promise<FaultRow[]> {
  const { OPT_FAULTS } = await import("../compiler/tir/passes/manager.ts");
  const steps = await faultSteps(accel, jobs);
  const rows: FaultRow[] = [];
  const env = process.env;
  const was = { opt: env.TMK_OPT, fault: env.TMK_OPT_FAULT };
  try {
    env.TMK_OPT = "2";
    // Without a fault each step passes, or a catch would mean nothing.
    delete env.TMK_OPT_FAULT;
    for (const s of skipNone ? [] : steps) {
      if (!(await s.run())) {
        rows.push({
          fault: "(none)",
          caught: true,
          by: s.name,
          detail: "fails with no bug in: nothing below means anything",
        });
        return rows;
      }
    }
    for (const fault of OPT_FAULTS) {
      if (only !== undefined && !new RegExp(only).test(fault)) continue;
      env.TMK_OPT_FAULT = fault;
      let by = "";
      for (const s of steps) {
        let ok: boolean;
        try {
          ok = await s.run();
        } catch (e) {
          ok = false;
          by = `${s.name} (it threw: ${String(e).slice(0, 120)})`;
        }
        if (!ok) {
          by ||= s.name;
          break;
        }
      }
      rows.push({ fault, caught: by !== "", by, detail: "" });
    }
  } finally {
    if (was.opt === undefined) delete env.TMK_OPT;
    else env.TMK_OPT = was.opt;
    if (was.fault === undefined) delete env.TMK_OPT_FAULT;
    else env.TMK_OPT_FAULT = was.fault;
  }
  return rows;
}

export interface CompileTimes {
  rows: { what: string; level: OptLevel; coldMs: number; warmMs: number }[];
  corpus: { level: OptLevel; ms: number; programs: number }[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/**
 * What each level costs to compile. Cold: a fresh `tmk lower` (or `tmk compile`) process, wall clock, median of 3, with
 * V8's bytecode cache warm as `tmk` always has it. Warm: the same program lowered again in one process, median of 5.
 * Corpus: every lowered program in `rc` and every TSL program once each, in one process, at each level.
 */
export async function compileTimes(): Promise<CompileTimes> {
  const { lowerFile, checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const tmk = join(ROOT, "tools/tmk.ts");
  const samples = [
    { what: "jpeg.ts (strict)", file: "bench/jpeg/vendor/jpeg.ts", memory: undefined },
    { what: "map_basic.ts (rc)", file: "corpus/lower/strmap/map_basic.ts", memory: "rc" },
    {
      what: "adv_control_paths.ts (rc)",
      file: "corpus/lower/rc/adv_control_paths.ts",
      memory: "rc",
    },
  ];
  const rows: CompileTimes["rows"] = [];
  for (const s of samples) {
    for (const level of [0, 1, 2] as OptLevel[]) {
      const cold: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        const r = await guardedRun(
          process.execPath,
          [
            "--no-warnings",
            tmk,
            "lower",
            s.file,
            ...(s.memory !== undefined ? ["--memory", s.memory] : []),
            `-O${level}`,
            "--emit",
            "tir",
          ],
          {
            timeoutMs: 120_000,
            label: `cold lower ${s.what} -O${level}`,
            cwd: ROOT,
            env: { ...process.env, TMK_OPT_VERIFY: "0" },
          },
        );
        if (!r.ok) throw new Error(`tmk lower ${s.file} -O${level}: ${r.why}`);
        cold.push(performance.now() - t);
      }
      const warm: number[] = [];
      const opts = { ...(s.memory !== undefined ? { memory: s.memory } : {}), opt: level };
      lowerFile(join(ROOT, s.file), opts);
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        lowerFile(join(ROOT, s.file), opts);
        warm.push(performance.now() - t);
      }
      rows.push({ what: s.what, level, coldMs: median(cold), warmMs: median(warm) });
    }
  }
  const corpus: CompileTimes["corpus"] = [];
  const lowered = [
    ...listPrograms(join(ROOT, "corpus/lower/rc")),
    ...listPrograms(join(ROOT, "corpus/lower/strmap")),
    ...listPrograms(join(ROOT, "corpus/lower/pos")),
  ];
  const tsl = [
    ...listPrograms(join(ROOT, "corpus/pos")),
    ...listPrograms(join(ROOT, "corpus/std")),
  ];
  // Each file once at -O0 first, so the libraries are parsed before anything is timed.
  for (const f of lowered) lowerFile(f, { memory: "rc", opt: 0 });
  const verifyWas = process.env.TMK_OPT_VERIFY;
  process.env.TMK_OPT_VERIFY = "0";
  try {
    for (const level of [0, 1, 2] as OptLevel[]) {
      const t = performance.now();
      let n = 0;
      for (const f of lowered) {
        lowerFile(f, { memory: "rc", opt: level });
        n++;
      }
      for (const f of tsl) {
        const c = checkFile(f);
        if (c.typed !== null) compileTyped(c.typed, { opt: level });
        n++;
      }
      corpus.push({ level, ms: performance.now() - t, programs: n });
    }
  } finally {
    if (verifyWas === undefined) delete process.env.TMK_OPT_VERIFY;
    else process.env.TMK_OPT_VERIFY = verifyWas;
  }
  return { rows, corpus };
}

export interface CodeSizes {
  rows: { what: string; programs: number; bytes: [number, number, number] }[];
}

/** Bytes of code in the linked test images, at each level: what a program pays in size for speed. */
export async function codeSizes(): Promise<CodeSizes> {
  const { lowerFile, checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { buildDownImage, buildTslImage } = await import("./native-exec.ts");
  const rows: CodeSizes["rows"] = [];
  const groups: { what: string; files: string[]; memory?: string }[] = [
    {
      what: "corpus/lower/rc and strmap, in rc",
      files: [
        ...listPrograms(join(ROOT, "corpus/lower/rc")),
        ...listPrograms(join(ROOT, "corpus/lower/strmap")),
      ],
      memory: "rc",
    },
    { what: "corpus/lower/pos, strict", files: listPrograms(join(ROOT, "corpus/lower/pos")) },
    {
      what: "corpus/pos, corpus/mem and corpus/std, TSL",
      files: [
        ...listPrograms(join(ROOT, "corpus/pos")),
        ...listPrograms(join(ROOT, "corpus/mem")),
        ...listPrograms(join(ROOT, "corpus/std")),
      ],
    },
  ];
  for (const g of groups) {
    const bytes: [number, number, number] = [0, 0, 0];
    let programs = 0;
    for (const f of g.files) {
      let cases: never[];
      try {
        cases = JSON.parse(readFileSync(f.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
      } catch {
        continue;
      }
      const sizes: number[] = [];
      for (const level of [0, 1, 2] as OptLevel[]) {
        try {
          if (g.what.includes("TSL")) {
            const c = checkFile(f);
            if (c.typed === null) break;
            const o = compileTyped(c.typed, { opt: level });
            sizes.push(buildTslImage(o.tir, o.meta as never, cases).codeBytes);
          } else {
            const o = lowerFile(f, {
              ...(g.memory !== undefined ? { memory: g.memory } : {}),
              opt: level,
            });
            if (o.tir === null || o.tir.externs.length > 0 || o.fallbackDiags.length > 0) break;
            sizes.push(buildDownImage(o.tir, o.meta as never, cases).image.codeBytes);
          }
        } catch {
          break;
        }
      }
      if (sizes.length !== 3) continue;
      programs++;
      sizes.forEach((s, i) => {
        bytes[i] = bytes[i]! + s;
      });
    }
    rows.push({ what: g.what, programs, bytes });
  }
  return { rows };
}
