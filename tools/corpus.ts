// The differential corpus (SPEC 8.1): positive programs on four configurations, must-fail programs
// with exact codes and positions, and programs that must trap with a given code.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { guardedRun, pool, type GuardResult } from "./guarded-run.ts";
import { qemuRun, reapOrphans, type Accel, type BulkLayout } from "./qemu-run.ts";
import type { BuildResult } from "./corpus-compile.ts";
import type { CaseResult } from "./corpus-exec.ts";
import type { LowerBuild } from "./lower-compile.ts";
import type { LowerCase, LowerCaseResult } from "./lower-exec.ts";
import { buildPath } from "./build-dir.ts";
import { sliceGenerated } from "./sweep.ts";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXEC = join(ROOT, "tools/corpus-exec.ts");
const COMPILE = join(ROOT, "tools/corpus-compile.ts");
const HOOK = join(ROOT, "tools/ts-hook.mjs");
const CASE_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 90_000;
const NATIVE_TIMEOUT_MS = 60_000;

export interface Engines {
  node: string;
  bun: string;
}

export function defaultEngines(): Engines {
  return { node: process.execPath, bun: process.env.TMK_BUN ?? "bun" };
}

/**
 * Whether a failure is a case or an image that ran out of time, rather than a wrong result or trap code. How many do depends
 * on the host's load: a bug that leaks makes cases run until they time out, and a loaded host times out sooner (pipe-h for
 * std-tests.ts's faultRun, R7 for every other injected bug's run). An injected bug's `answers` count leaves these out.
 */
export function ranOutOfTime(failure: string): boolean {
  // R12: and a child that guarded-run killed at its wall-clock limit ("over the 30000 ms wall-clock limit"), which R7's
  // wording missed, and a case a route's run never gave because that run ran out of time (pipe-tests.ts's dual route).
  return /never finished|timed out|timeout|over the \d+ ms (wall-clock )?limit|ran out of time/i.test(
    failure,
  );
}

/** The failures that are wrong answers: the load-independent count an injected bug's run reports as `answers`. */
export function wrongAnswers(failures: readonly string[]): number {
  return failures.filter((x) => !ranOutOfTime(x)).length;
}

/**
 * How a box's detail says how many cases caught an injected bug: the wrong answers, which don't depend on the load, or that
 * only cases running out of time caught it (native-g box 6's wording, pipe-h; every bug's run since R7).
 */
export function caughtText(r: { caught: number; answers: number }): string {
  return String(r.answers > 0 ? r.answers : r.caught > 0 ? "caught by time alone" : 0);
}

/**
 * How many failures an injected bug's run caused, as a box says it (R12): its wrong answers, which don't depend on the load,
 * or that only failures that ran out of time caught it. The boxes that said `failures.length` said a count that the load
 * moved, as box 21's did; whether the bug was caught is still every failure's.
 */
export function faultCount(failures: readonly string[]): string {
  const n = wrongAnswers(failures);
  return n > 0 ? String(n) : failures.length > 0 ? "by time alone" : "0";
}

export interface SuiteResult {
  name: string;
  ok: boolean;
  summary: string;
  failures: string[];
  count: number;
}

export function listPrograms(dir: string, filter?: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && (filter === undefined || name.includes(filter))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Dealt round, so a directory of slow programs (the generated `finally` tests at -O2) doesn't land in one batch. */
function chunks<T>(items: T[], n: number): T[][] {
  const k = Math.max(1, Math.min(n, items.length));
  const out: T[][] = Array.from({ length: k }, () => []);
  items.forEach((x, i) => out[i % k]!.push(x));
  return out.filter((g) => g.length > 0);
}

export async function compileBatch(
  files: string[],
  outDir: string,
  jobs: number,
  engine: string,
  checkOnly = false,
): Promise<BuildResult[]> {
  mkdirSync(outDir, { recursive: true });
  const groups = chunks(files, jobs);
  const runs = await pool(groups, jobs, (group) =>
    guardedRun(engine, [COMPILE, JSON.stringify({ files: group, outDir, checkOnly })], {
      timeoutMs: BATCH_TIMEOUT_MS,
      label: `compile ${basename(group[0]!)}..`,
      cwd: ROOT,
    }),
  );
  const out: BuildResult[] = [];
  runs.forEach((r, i) => {
    if (!r.ok) {
      for (const f of groups[i]!) {
        out.push({ file: f, diags: [], crash: `${r.why}\n${r.stderr.slice(0, 2000)}` });
      }
      return;
    }
    out.push(...(JSON.parse(r.stdout) as BuildResult[]));
  });
  return out;
}

type Config = "source-v8" | "source-jsc" | "wasm-v8" | "wasm-jsc" | "checked-v8" | "checked-jsc";

function configCommand(
  config: Config,
  file: string,
  outDir: string,
  engines: Engines,
  program = file,
  cycles?: Record<string, number>,
): { cmd: string; args: string[] } {
  const base = join(outDir, basename(file, ".ts"));
  const cases = file.replace(/\.ts$/, ".cases.json");
  const meta = `${base}.meta.json`;
  const onBun = config.endsWith("jsc");
  let job: object;
  if (config.startsWith("source"))
    job = { mode: "source", program, cases, meta, ...(cycles !== undefined ? { cycles } : {}) };
  else if (config.startsWith("wasm")) {
    job = { mode: "wasm", program: `${base}.glue.mjs`, wasm: `${base}.wasm`, cases, meta };
  } else job = { mode: "checked", program: `${base}.checked.mjs`, cases, meta };
  if (onBun) return { cmd: engines.bun, args: [EXEC, JSON.stringify(job)] };
  const hook = config.startsWith("source") ? ["--import", HOOK] : [];
  return { cmd: engines.node, args: [...hook, "--no-warnings", EXEC, JSON.stringify(job)] };
}

interface ConfigRun {
  program: string;
  config: Config;
  run: GuardResult;
  results: CaseResult[] | null;
}

async function runConfigs(
  files: string[],
  configs: Config[],
  outDir: string,
  jobs: number,
  engines: Engines,
): Promise<ConfigRun[]> {
  const tasks: { file: string; config: Config }[] = [];
  for (const file of files) for (const config of configs) tasks.push({ file, config });
  return pool(tasks, jobs, async ({ file, config }) => {
    const { cmd, args } = configCommand(config, file, outDir, engines);
    const run = await guardedRun(cmd, args, {
      timeoutMs: CASE_TIMEOUT_MS,
      label: `${basename(file)} on ${config}`,
      cwd: ROOT,
    });
    let results: CaseResult[] | null = null;
    if (run.ok) {
      try {
        results = JSON.parse(run.stdout) as CaseResult[];
      } catch {
        results = null;
      }
    }
    return { program: file, config, run, results };
  });
}

/** `tmk corpus`: agreement with the same source on V8, on all four configurations. */
export async function runPositive(
  jobs: number,
  filter: string | undefined,
  engines: Engines,
  outDir = buildPath("corpus/pos"),
): Promise<SuiteResult> {
  const files = listPrograms(join(ROOT, "corpus/pos"), filter);
  const failures: string[] = [];
  const builds = await compileBatch(files, outDir, jobs, engines.node);
  const built = new Set<string>();
  for (const b of builds) {
    if (b.crash !== undefined) failures.push(`${rel(b.file)}: compiler failed: ${b.crash}`);
    else if (b.diags.length > 0) {
      failures.push(
        `${rel(b.file)}: ${b.diags.map((d) => `${d.line}:${d.col} ${d.code} ${d.msg}`).join("; ")}`,
      );
    } else built.add(b.file);
  }
  for (const f of files) {
    if (!existsSync(f.replace(/\.ts$/, ".cases.json"))) failures.push(`${rel(f)}: no .cases.json`);
  }
  const usable = files.filter((f) => built.has(f) && existsSync(f.replace(/\.ts$/, ".cases.json")));
  // The four the milestone names, plus js-checked: it has to agree too, or 3.10's trap half means little.
  const configs: Config[] = ["source-v8", "source-jsc", "wasm-v8", "wasm-jsc", "checked-v8"];
  const runs = await runConfigs(usable, configs, outDir, jobs, engines);
  let caseCount = 0;
  const byProgram = new Map<string, ConfigRun[]>();
  for (const r of runs) {
    const list = byProgram.get(r.program) ?? [];
    list.push(r);
    byProgram.set(r.program, list);
  }
  let passedPrograms = 0;
  for (const [file, list] of byProgram) {
    const before = failures.length;
    const ref = list.find((x) => x.config === "source-v8");
    if (ref?.results === null || ref === undefined) {
      failures.push(
        `${rel(file)}: reference failed on V8: ${ref?.run.why} ${ref?.run.stderr.slice(0, 600)}`,
      );
      continue;
    }
    caseCount += ref.results.length;
    for (const x of list) {
      if (x.results === null) {
        failures.push(`${rel(file)} on ${x.config}: ${x.run.why} ${x.run.stderr.slice(0, 600)}`);
        continue;
      }
      x.results.forEach((c, i) => {
        const want = ref.results![i]!;
        if ("throw" in Object(c.result) || "missing" in Object(c.result)) {
          failures.push(`${rel(file)} ${c.fn}#${i} on ${x.config}: ${JSON.stringify(c.result)}`);
        }
        if (JSON.stringify(c.result) !== JSON.stringify(want.result)) {
          failures.push(
            `${rel(file)} ${c.fn}#${i} on ${x.config}: ${JSON.stringify(c.result)}, V8 gave ${JSON.stringify(want.result)}`,
          );
        }
        if (JSON.stringify(c.arrays) !== JSON.stringify(want.arrays)) {
          failures.push(`${rel(file)} ${c.fn}#${i} on ${x.config}: typed-array output differs`);
        }
        if (c.pin !== null && c.pin !== "ok") {
          failures.push(`${rel(file)} ${c.fn}#${i} on ${x.config}: ${c.pin}`);
        }
      });
    }
    if (failures.length === before) passedPrograms++;
  }
  return {
    name: "corpus",
    ok: failures.length === 0 && files.length > 0,
    summary: `${passedPrograms}/${files.length} programs, ${caseCount} cases, 4 configurations plus js-checked`,
    failures,
    count: passedPrograms,
  };
}

/** `tmk corpus --neg`: must-fail programs, by exact code and position. */
export async function runNegative(
  jobs: number,
  filter: string | undefined,
  engines: Engines,
): Promise<SuiteResult> {
  const files = listPrograms(join(ROOT, "corpus/neg"), filter);
  const builds = await compileBatch(files, buildPath("corpus/neg"), jobs, engines.node, true);
  const failures: string[] = [];
  let passed = 0;
  for (const b of builds) {
    if (b.crash !== undefined) {
      failures.push(`${rel(b.file)}: compiler failed: ${b.crash}`);
      continue;
    }
    const expects = [
      ...readFileSync(b.file, "utf8").matchAll(/\/\/ expect: (\S+) at (\d+):(\d+)/g),
    ].map((m) => `${m[1]!} at ${m[2]!}:${m[3]!}`);
    const got = b.diags.map((d) => `${d.code} at ${d.line}:${d.col}`);
    // An error has to name where the problem is, as well as say what it is (SPEC 12.1, risk 14).
    const wantText = [...readFileSync(b.file, "utf8").matchAll(/\/\/ expect-msg: (.*)/g)].map(
      (m) => m[1]!,
    );
    const text = b.diags.map((d) => d.msg).join("\n");
    const missing = wantText.filter((w) => !text.includes(w));
    // An error reported in another module than the one compiled says which.
    const wantFile = /\/\/ expect-file: (\S+)/.exec(readFileSync(b.file, "utf8"))?.[1];
    if (wantFile !== undefined && b.diags.some((d) => d.file !== wantFile)) {
      failures.push(
        `${rel(b.file)}: expected the error in ${wantFile}, got ${b.diags.map((d) => d.file).join()}`,
      );
    } else if (expects.length === 0) failures.push(`${rel(b.file)}: no // expect: comment`);
    else if ([...expects].sort().join() !== [...got].sort().join()) {
      failures.push(
        `${rel(b.file)}: expected [${expects.join(", ")}], got [${got.join(", ")}]: ${text.slice(0, 300)}`,
      );
    } else if (missing.length > 0) {
      failures.push(`${rel(b.file)}: the message doesn't say "${missing[0]!}": ${text}`);
    } else passed++;
  }
  return {
    name: "corpus --neg",
    ok: failures.length === 0 && files.length > 0,
    summary: `${passed}/${files.length} must-fail programs, exact code and position`,
    failures,
    count: passed,
  };
}

/** `tmk corpus --trap`: programs that trap with a given code on Wasm and js-checked. */
export async function runTrap(
  jobs: number,
  filter: string | undefined,
  engines: Engines,
  outDir = buildPath("corpus/trap"),
): Promise<SuiteResult> {
  const files = listPrograms(join(ROOT, "corpus/trap"), filter);
  const failures: string[] = [];
  const builds = await compileBatch(files, outDir, jobs, engines.node);
  const built = new Set<string>();
  for (const b of builds) {
    if (b.crash !== undefined) failures.push(`${rel(b.file)}: compiler failed: ${b.crash}`);
    else if (b.diags.length > 0) {
      failures.push(
        `${rel(b.file)}: ${b.diags.map((d) => `${d.line}:${d.col} ${d.code} ${d.msg}`).join("; ")}`,
      );
    } else built.add(b.file);
  }
  const configs: Config[] = ["wasm-v8", "wasm-jsc", "checked-v8", "checked-jsc"];
  const runs = await runConfigs(
    files.filter((f) => built.has(f)),
    configs,
    outDir,
    jobs,
    engines,
  );
  let caseCount = 0;
  const failedPrograms = new Set<string>();
  for (const x of runs) {
    const cases = JSON.parse(readFileSync(x.program.replace(/\.ts$/, ".cases.json"), "utf8")) as {
      fn: string;
      trap?: number;
    }[];
    if (x.results === null) {
      failures.push(`${rel(x.program)} on ${x.config}: ${x.run.why} ${x.run.stderr.slice(0, 600)}`);
      failedPrograms.add(x.program);
      continue;
    }
    if (x.config === "wasm-v8") caseCount += cases.length;
    x.results.forEach((r, i) => {
      const c = cases[i]!;
      const want = c.trap;
      const got = (r.result as { trap?: number } | null)?.trap;
      if (want !== got) {
        failures.push(
          `${rel(x.program)} ${c.fn}#${i} on ${x.config}: expected trap ${want}, got ${JSON.stringify(r.result)}`,
        );
        failedPrograms.add(x.program);
      }
    });
  }
  return {
    name: "corpus --trap",
    ok: failures.length === 0 && files.length > 0,
    summary: `${files.length - failedPrograms.size}/${files.length} programs, ${caseCount} cases, ${configs.length} configurations`,
    failures,
    count: files.length - failedPrograms.size,
  };
}

/** Each positive file loads and runs its cases with no build step (M1 acceptance). */
export async function runNoBuild(jobs: number, engines: Engines): Promise<SuiteResult> {
  const files = listPrograms(join(ROOT, "corpus/pos"));
  const failures: string[] = [];
  const tasks = files.flatMap((f) => [
    { file: f, engine: "node" },
    { file: f, engine: "bun" },
  ]);
  await pool(tasks, jobs, async ({ file, engine }) => {
    const job = JSON.stringify({
      mode: "source",
      program: file,
      cases: file.replace(/\.ts$/, ".cases.json"),
    });
    const r =
      engine === "node"
        ? await guardedRun(engines.node, ["--import", HOOK, "--no-warnings", EXEC, job], {
            timeoutMs: CASE_TIMEOUT_MS,
            label: `${basename(file)} under Node`,
            cwd: ROOT,
          })
        : await guardedRun(engines.bun, [EXEC, job], {
            timeoutMs: CASE_TIMEOUT_MS,
            label: `${basename(file)} under Bun`,
            cwd: ROOT,
          });
    if (!r.ok) failures.push(`${rel(file)} under ${engine}: ${r.why} ${r.stderr.slice(0, 400)}`);
  });
  return {
    name: "no-build",
    ok: failures.length === 0 && files.length > 0,
    summary: `${files.length} programs under Node with ts-hook.mjs and under Bun directly`,
    failures,
    count: files.length,
  };
}

// --- down-lowering's corpus (SPEC 4.5): ordinary TS compared with V8 and JSC

const LOWER_EXEC = join(ROOT, "tools/lower-exec.ts");
const LOWER_COMPILE = join(ROOT, "tools/lower-compile.ts");

export interface RcOptionsLike {
  check: boolean;
  account: boolean;
  elide: boolean;
  omitInc: number;
  omitDec: number;
  budget: number;
}
export interface RcHarnessLike {
  stats?: boolean;
  collect?: boolean;
  excTrap?: boolean;
}

export async function lowerBatch(
  files: string[],
  outDir: string,
  jobs: number,
  engine: string,
  memory?: string,
  rc?: Partial<RcOptionsLike>,
): Promise<LowerBuild[]> {
  mkdirSync(outDir, { recursive: true });
  // Small batches, so no one batch's wall-clock limit is the sum of many slow -O2 compiles; `jobs` of them at a time.
  const groups = chunks(files, Math.max(jobs, Math.ceil(files.length / 4)));
  const runs = await pool(groups, jobs, (group) =>
    guardedRun(engine, [LOWER_COMPILE, JSON.stringify({ files: group, outDir, memory, rc })], {
      timeoutMs: BATCH_TIMEOUT_MS,
      label: `lower ${basename(group[0]!)}..`,
      cwd: ROOT,
    }),
  );
  const out: LowerBuild[] = [];
  runs.forEach((r, i) => {
    if (!r.ok) {
      for (const f of groups[i]!)
        out.push({ file: f, diags: [], crash: `${r.why}\n${r.stderr.slice(0, 2000)}` });
      return;
    }
    out.push(...(JSON.parse(r.stdout) as LowerBuild[]));
  });
  return out;
}

function directives(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`^// expect-${name}: (.*)$`, "gm")))
    out.push(m[1]!.trim());
  return out;
}

/** Checks a program's report against what its header says should happen. */
function checkReport(b: LowerBuild, failures: string[]): void {
  const src = readFileSync(b.file, "utf8");
  const name = rel(b.file);
  const tir = b.tirPath !== undefined ? readFileSync(b.tirPath, "utf8") : "";
  for (const re of directives(src, "tir")) {
    if (!new RegExp(re).test(tir)) failures.push(`${name}: TIR should match /${re}/`);
  }
  for (const re of directives(src, "no-tir")) {
    if (new RegExp(re).test(tir)) failures.push(`${name}: TIR should not match /${re}/`);
  }
  const wanted = directives(src, "fallback").map((d) => d.split(/\s+/) as [string, string]);
  const got = b.fallbackDiags ?? [];
  for (const [fn, blocker] of wanted) {
    const hit = got.find((d) => d.fn === fn);
    if (hit === undefined)
      failures.push(`${name}: ${fn} should fall back with ${blocker}, and it lowered`);
    else if (hit.blocker !== blocker) {
      failures.push(
        `${name}: ${fn} fell back with ${hit.blocker} (${hit.detail}), expected ${blocker}`,
      );
    }
  }
  for (const d of got) {
    if (
      !wanted.some(([fn]) => fn === d.fn) &&
      !(d.fn === "<module init>" && /global-init/.test(src))
    ) {
      failures.push(
        `${name}: unexpected fallback of ${d.fn}: ${d.blocker}: ${d.detail} (${d.line}:${d.col})`,
      );
    }
    if (d.code === "" || d.suggest === "")
      failures.push(`${name}: ${d.fn} has no code or suggestion`);
  }
  for (const fn of directives(src, "lowered")) {
    const row = b.rows?.find((r) => r.fn === fn);
    if (row?.outcome !== "lowered")
      failures.push(`${name}: ${fn} should lower, got ${row?.outcome}`);
  }
  for (const d of directives(src, "blocked")) {
    const [root, caller] = d.split(/\s+/) as [string, string];
    const hit = got.find((x) => x.fn === root);
    if (hit?.blocked_callers.includes(caller) !== true) {
      failures.push(
        `${name}: ${root} should list ${caller} as blocked, got ${JSON.stringify(hit?.blocked_callers)}`,
      );
    }
  }
  for (const code of directives(src, "warning")) {
    if (b.warnings?.some((w) => w.code === code) !== true)
      failures.push(`${name}: expected warning ${code}`);
  }
  for (const note of directives(src, "note")) {
    if (note === "alloc-stack" && b.allocs?.some((a) => a.where === "stack") !== true) {
      failures.push(`${name}: expected a stack allocation`);
    }
    if (note === "alloc-arena" && b.allocs?.some((a) => a.where === "arena") !== true) {
      failures.push(`${name}: expected an arena allocation`);
    }
    if (note === "closure-inlined" && b.rows?.some((r) => r.note.startsWith("inlined")) !== true) {
      failures.push(`${name}: expected an inlined closure`);
    }
  }
}

type LowerConfig = "source-v8" | "source-jsc" | "wasm-v8" | "wasm-jsc";

export function lowerCommand(
  c: LowerConfig,
  file: string,
  outDir: string,
  engines: Engines,
): { cmd: string; args: string[] } {
  const base = join(outDir, basename(file, ".ts"));
  const cases = file.replace(/\.ts$/, ".cases.json");
  const job = c.startsWith("source")
    ? { mode: "source", program: file, cases }
    : { mode: "wasm", program: `${base}.glue.mjs`, wasm: `${base}.wasm`, cases };
  if (c.endsWith("jsc")) return { cmd: engines.bun, args: [LOWER_EXEC, JSON.stringify(job)] };
  const hook = c.startsWith("source") ? ["--import", HOOK] : [];
  return { cmd: engines.node, args: [...hook, "--no-warnings", LOWER_EXEC, JSON.stringify(job)] };
}

/** `tmk corpus --lower`: each rule in 4.5 against V8, plus programs that must fall back. */
export async function runLower(
  jobs: number,
  filter: string | undefined,
  engines: Engines,
): Promise<SuiteResult> {
  const outDir = buildPath("corpus/lower");
  const files = [
    ...listPrograms(join(ROOT, "corpus/lower/pos"), filter),
    ...listPrograms(join(ROOT, "corpus/lower/fallback"), filter),
  ];
  const failures: string[] = [];
  const builds = await lowerBatch(files, outDir, jobs, engines.node);
  const usable: string[] = [];
  const failed = new Set<string>();
  for (const b of builds) {
    if (b.crash !== undefined) {
      failures.push(`${rel(b.file)}: compiler failed: ${b.crash.slice(0, 1500)}`);
      failed.add(b.file);
      continue;
    }
    if (b.diags.length > 0) {
      failures.push(
        `${rel(b.file)}: ${b.diags.map((d) => `${d.line}:${d.col} ${d.code} ${d.msg}`).join("; ")}`,
      );
      failed.add(b.file);
      continue;
    }
    const seen = failures.length;
    checkReport(b, failures);
    if (failures.length > seen) failed.add(b.file);
    if (existsSync(b.file.replace(/\.ts$/, ".cases.json"))) usable.push(b.file);
    else failures.push(`${rel(b.file)}: no .cases.json`);
  }
  const configs: LowerConfig[] = ["source-v8", "source-jsc", "wasm-v8", "wasm-jsc"];
  const tasks = usable.flatMap((file) => configs.map((config) => ({ file, config })));
  const runs = await pool(tasks, jobs, async ({ file, config }) => {
    const { cmd, args } = lowerCommand(config, file, outDir, engines);
    const run = await guardedRun(cmd, args, {
      timeoutMs: CASE_TIMEOUT_MS,
      label: `${basename(file)} on ${config}`,
      cwd: ROOT,
    });
    return { file, config, run };
  });
  let caseCount = 0;
  let trapCount = 0;
  for (const file of usable) {
    const before = failures.length;
    const cases = JSON.parse(
      readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"),
    ) as LowerCase[];
    const of = (c: LowerConfig): LowerCaseResult[] | null => {
      const r = runs.find((x) => x.file === file && x.config === c);
      if (r === undefined || !r.run.ok) {
        failures.push(`${rel(file)} on ${c}: ${r?.run.why} ${r?.run.stderr.slice(0, 800)}`);
        return null;
      }
      return JSON.parse(r.run.stdout) as LowerCaseResult[];
    };
    const ref = of("source-v8");
    caseCount += cases.length;
    if (ref !== null) {
      for (const c of ["source-jsc", "wasm-v8", "wasm-jsc"] as const) {
        const got = of(c);
        if (got === null) continue;
        got.forEach((x, i) => {
          const spec = cases[i]!;
          const r = ref[i]!;
          if (c !== "source-jsc" && spec.lowered_trap !== undefined) {
            const t = (x.result as { trap?: number }).trap;
            if (t !== spec.lowered_trap) {
              failures.push(
                `${rel(file)} ${x.fn}#${i} on ${c}: expected trap ${spec.lowered_trap}, got ${JSON.stringify(x.result)}`,
              );
            } else if (c === "wasm-v8") trapCount++;
            return;
          }
          // Engines word their own TypeErrors differently. A thrown Error's message must still match.
          const engineWords = (v: unknown): unknown => {
            const o = v as { threw?: string; message?: string };
            return c === "source-jsc" && o.threw === "TypeError" ? { threw: o.threw } : v;
          };
          const a = JSON.stringify(engineWords(x.result));
          const b = JSON.stringify(engineWords(r.result));
          if (a !== b) failures.push(`${rel(file)} ${x.fn}#${i} on ${c}: ${a}, V8 gave ${b}`);
          const aa = JSON.stringify(x.args);
          const bb = JSON.stringify(r.args);
          if (aa !== bb)
            failures.push(`${rel(file)} ${x.fn}#${i} on ${c}: arguments ended ${aa}, on V8 ${bb}`);
        });
      }
    }
    if (failures.length > before) failed.add(file);
  }
  const passed = files.length - failed.size;
  return {
    name: "corpus --lower",
    ok: failures.length === 0 && files.length > 0,
    summary: `${passed}/${files.length} programs, ${caseCount} cases (${trapCount} declared trap divergences), V8, JSC, Wasm on V8, Wasm on JSC`,
    failures,
    count: passed,
  };
}

// --- the native configuration (SPEC 8.1): the same corpus, the same reference, the same comparison

export type NativeKind = "pos" | "trap" | "lower" | "mem" | "memory" | "std" | "exc" | "rc";

/**
 * An `rc` program as tslc expands it onto @tsl/gc (SPEC 3.5, D74), written out where V8 and JSC can import it: the host's
 * simulation of `Rc` has to give what native code gives, counts and steps included. Gives the expanded root's path.
 */
/**
 * The type graph's groups by class name, for the host's simulation of @tsl/gc's cycle collector (SPEC 3.5, D41): tslc's
 * own table, for any program that counts with @tsl/gc, so the host decides what native code decides.
 */
export async function hostCycles(file: string): Promise<Record<string, number> | undefined> {
  const src = readFileSync(file, "utf8");
  const { findTslJson, createTslProgram } = await import("../compiler/host/program.ts");
  if (!src.includes("@tsl/gc") && findTslJson(file)?.memory !== "rc") return undefined;
  const { hostCycleTable } = await import("../compiler/host/cycle-graph.ts");
  return hostCycleTable(createTslProgram(file), file);
}

export async function writeRcExpanded(file: string, outDir: string): Promise<string> {
  const { createTslProgram } = await import("../compiler/host/program.ts");
  const { rcExpansion } = await import("../compiler/host/tslc.ts");
  const x = rcExpansion(createTslProgram(file), file);
  if (x === null || x.diags.length > 0)
    throw new Error(`${rel(file)}: no rc expansion: ${JSON.stringify(x?.diags)}`);
  const root = join(ROOT, "corpus");
  for (const [p, text] of x.texts) {
    const dst = join(outDir, "src", relative(root, p));
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, text);
  }
  return join(outDir, "src", relative(root, file));
}

export interface NativeAgreement {
  accel: Accel;
  programs: number;
  cases: number;
  agreed: number;
  skipped: boolean;
}

export interface NativeSuiteResult extends SuiteResult {
  agreement: NativeAgreement[];
  skippedPrograms: string[];
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** A declared tolerance, for what V8 itself leaves to the host (SPEC 3.10, divergence 7). */
function withinUlp(a: unknown, b: unknown, ulps: number): boolean {
  const bits = (v: unknown): string | undefined => (v as { value?: { n?: string } })?.value?.n;
  const x = bits(a);
  const y = bits(b);
  if (x === undefined || y === undefined) return JSON.stringify(a) === JSON.stringify(b);
  if (x === y) return true;
  if (x === "nan" || y === "nan") return false;
  const d = BigInt(`0x${x}`) - BigInt(`0x${y}`);
  return (d < 0n ? -d : d) <= BigInt(ulps);
}

function canonResults(stdout: string): unknown {
  return (JSON.parse(stdout) as CaseResult[]).map((c) => [c.fn, c.result, c.arrays]);
}

/** `tmk corpus --native`: positive, trap and lowered programs under QEMU, on each accelerator. */
export async function runNative(
  kind: NativeKind,
  accels: Accel[],
  jobs: number,
  filter: string | undefined,
  engines: Engines,
  memory?: "leak" | "manual" | "rc",
  rcTest?: { rc: Partial<RcOptionsLike>; harness: RcHarnessLike; suffix: string },
  onlyExc = false,
): Promise<NativeSuiteResult> {
  reapOrphans();
  // `exc`: only the exceptions and classes corpus (D49, D50), lowered as `lower` is.
  if (kind === "exc") {
    const r = await runNative("lower", accels, jobs, filter, engines, memory, rcTest, true);
    return { ...r, name: `corpus --native exc${memory !== undefined ? ` ${memory}` : ""}` };
  }
  const { parseModule } = await import("../compiler/tir/text.ts");
  const { buildTslImage, tslResults, buildDownImage, downResults, bulkFor } =
    await import("./native-exec.ts");
  // `memory`: TSL proper in packages with a memory mode, whose negative programs are under corpus/neg.
  const dir = kind === "lower" ? "corpus/lower/pos" : `corpus/${kind}`;
  // `rc` (D74): the reference is the expansion on V8 and JSC, and the source as written on V8 has to agree with it on
  // every case not marked `rcOnly` (one that reads counts or steps, which plain JS doesn't have)
  const outDir = buildPath(
    "corpus/native",
    memory !== undefined ? `${kind}-${memory}${rcTest?.suffix ?? ""}` : kind,
  );
  let files = onlyExc
    ? listPrograms(join(ROOT, "corpus/lower/exc"), filter)
    : [
        ...listPrograms(join(ROOT, dir), filter),
        ...(kind === "lower" ? listPrograms(join(ROOT, "corpus/native"), filter) : []),
        // A memory mode is run on every lowered program, and some only make sense in one (SPEC 4.5).
        ...(memory !== undefined ? listPrograms(join(ROOT, "corpus/lower/fallback"), filter) : []),
        ...(memory !== undefined ? listPrograms(join(ROOT, "corpus/lower/memory"), filter) : []),
        ...(memory === "rc" ? listPrograms(join(ROOT, "corpus/lower/rc"), filter) : []),
        // Exceptions and classes (D49, D50) need a memory mode: they're native and in every mode.
        ...(memory !== undefined ? listPrograms(join(ROOT, "corpus/lower/exc"), filter) : []),
        ...(kind === "mem" ? listPrograms(join(ROOT, "corpus/spec"), filter) : []),
      ].filter(
        (f) =>
          (kind !== "mem" && kind !== "memory" && kind !== "std" && kind !== "rc") ||
          existsSync(f.replace(/\.ts$/, ".cases.json")),
      );
  // A phase gate runs a quarter of the generated `finally` programs, a different quarter each day (D51).
  files = sliceGenerated(files);
  const failures: string[] = [];
  const builds =
    kind === "lower"
      ? await lowerBatch(files, outDir, jobs, engines.node, memory, rcTest?.rc)
      : await compileBatch(files, outDir, jobs, engines.node);
  const usable: string[] = [];
  const skippedPrograms: string[] = [];
  for (const b of builds) {
    if (b.crash !== undefined) failures.push(`${rel(b.file)}: compiler failed: ${b.crash}`);
    else if (b.diags.length > 0) failures.push(`${rel(b.file)}: ${JSON.stringify(b.diags)}`);
    else if (!existsSync(b.file.replace(/\.ts$/, ".cases.json")))
      failures.push(`${rel(b.file)}: no .cases.json`);
    else usable.push(b.file);
  }
  // The reference, where there is one: the source on V8. Trap programs pin their codes instead.
  const refs = new Map<string, unknown[]>();
  if (kind !== "trap") {
    await pool(usable, jobs, async (file) => {
      let program = file;
      const cyc =
        kind === "rc" || kind === "std" || kind === "mem" ? await hostCycles(file) : undefined;
      if (kind === "rc") {
        try {
          program = await writeRcExpanded(file, outDir);
        } catch (e) {
          failures.push(`${rel(file)}: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        const raw = configCommand("source-v8", file, outDir, engines);
        const rr = await guardedRun(raw.cmd, raw.args, {
          timeoutMs: CASE_TIMEOUT_MS,
          label: `${basename(file)} as written`,
          cwd: ROOT,
        });
        const exp = configCommand("source-v8", file, outDir, engines, program, cyc);
        const re = await guardedRun(exp.cmd, exp.args, {
          timeoutMs: CASE_TIMEOUT_MS,
          label: `${basename(file)} expanded`,
          cwd: ROOT,
        });
        if (!rr.ok || !re.ok) {
          failures.push(
            `${rel(file)}: failed on V8: ${rr.why} ${re.why} ${(rr.stderr + re.stderr).slice(0, 500)}`,
          );
          return;
        }
        const a = JSON.parse(rr.stdout) as CaseResult[];
        const b = JSON.parse(re.stdout) as CaseResult[];
        const specs = loadJson<{ rcOnly?: boolean }[]>(file.replace(/\.ts$/, ".cases.json"));
        b.forEach((x, i) => {
          if (x.pin !== null && x.pin !== "ok")
            failures.push(`${rel(file)}: ${x.fn}#${i} expanded on V8: ${x.pin}`);
          if (specs[i]?.rcOnly === true) return;
          if (JSON.stringify(a[i]?.result) !== JSON.stringify(x.result))
            failures.push(
              `${rel(file)}: ${x.fn}#${i}: as written ${JSON.stringify(a[i]?.result)}, expanded ${JSON.stringify(x.result)}`,
            );
        });
      }
      const { cmd, args } =
        kind === "lower"
          ? lowerCommand("source-v8", file, outDir, engines)
          : configCommand("source-v8", file, outDir, engines, program, cyc);
      const r = await guardedRun(cmd, args, {
        timeoutMs: CASE_TIMEOUT_MS,
        label: `${basename(file)} reference`,
        cwd: ROOT,
      });
      if (r.ok) refs.set(file, JSON.parse(r.stdout) as unknown[]);
      else
        failures.push(`${rel(file)}: reference failed on V8: ${r.why} ${r.stderr.slice(0, 500)}`);
      // @tsl/alloc is one source on every engine, so JSC has to agree with V8 too (M3's box).
      if (
        (kind === "mem" || kind === "memory" || kind === "std" || kind === "rc") &&
        engines.bun !== null &&
        r.ok
      ) {
        const j = configCommand("source-jsc", file, outDir, engines, program, cyc);
        const rj = await guardedRun(j.cmd, j.args, {
          timeoutMs: CASE_TIMEOUT_MS,
          label: `${basename(file)} on JSC`,
          cwd: ROOT,
        });
        if (!rj.ok)
          failures.push(`${rel(file)}: failed on JSC: ${rj.why} ${rj.stderr.slice(0, 500)}`);
        else if (
          JSON.stringify(canonResults(rj.stdout)) !== JSON.stringify(canonResults(r.stdout))
        ) {
          failures.push(`${rel(file)}: JSC and V8 disagree`);
        }
      }
    });
  }
  const tally = new Map<
    Accel,
    { programs: number; cases: number; agreed: number; skipped: boolean }
  >();
  for (const a of accels) tally.set(a, { programs: 0, cases: 0, agreed: 0, skipped: false });
  const tasks = usable.flatMap((file) => accels.map((accel) => ({ file, accel })));
  await pool(tasks, jobs, async ({ file, accel }) => {
    const base = join(outDir, basename(file, ".ts"));
    const name = `${kind}/${basename(file, ".ts")}`;
    const cases = loadJson<never[]>(file.replace(/\.ts$/, ".cases.json"));
    const tally1 = tally.get(accel)!;
    let compare: (serial: string[]) => { agreed: number; problems: string[] };
    let bytes: Uint8Array;
    let bulk: BulkLayout | undefined;
    let ranges: { name: string; from: number; to: number }[];
    try {
      const m = parseModule(readFileSync(`${base}.tir`, "utf8"));
      // The level isn't in the text (it's in no tirhash), so it comes beside it, for the backend's code shape (D75).
      const opt = Number(readFileSync(`${base}.opt`, "utf8"));
      if (opt === 1 || opt === 2) m.opt = opt;
      if (m.externs.length > 0) {
        if (!skippedPrograms.includes(rel(file))) skippedPrograms.push(rel(file));
        return;
      }
      if (kind === "lower") {
        const meta = loadJson<Parameters<typeof buildDownImage>[1]>(`${base}.meta.json`);
        const ok = cases.filter((c: { fn: string }) => meta.exports[c.fn]?.fallback !== true);
        if (ok.length !== cases.length) {
          if (!skippedPrograms.includes(rel(file))) skippedPrograms.push(rel(file));
          return;
        }
        const pages = /^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
        const stack = /^\/\/ rc-stack: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
        const built = buildDownImage(
          m,
          meta,
          cases,
          pages !== undefined ? Number(pages) : undefined,
          { ...rcTest?.harness, bulkBytes: bulkFor() },
          undefined,
          stack !== undefined ? Number(stack) : undefined,
        );
        bytes = built.image.bytes;
        bulk = built.image.bulk;
        ranges = built.image.ranges;
        compare = (serial) => {
          const { results, problems } = downResults(meta, cases, built.placements, serial);
          const ref = refs.get(file) as LowerCaseResult[] | undefined;
          let agreed = 0;
          results.forEach((x, i) => {
            const spec = cases[i]! as LowerCase;
            const r = ref?.[i];
            const wantTrap =
              spec.lowered_trap ?? (memory !== undefined ? spec.memory_trap?.[memory] : undefined);
            // R12: a program whose reference didn't finish (its failure is already said) isn't compared case by case with
            // nothing: "V8 gave undefined" for each case was a wrong answer only of how loaded the host was (box 21).
            if (wantTrap === undefined && ref === undefined) return;
            if (wantTrap !== undefined) {
              const t = (x.result as { trap?: number }).trap;
              if (t === wantTrap) agreed++;
              else
                problems.push(
                  `${x.fn}#${i}: expected trap ${wantTrap}, got ${JSON.stringify(x.result)}`,
                );
              return;
            }
            if (spec.native_ulp !== undefined) {
              const near = withinUlp(x.result, r?.result, spec.native_ulp);
              if (near) agreed++;
              else
                problems.push(
                  `${x.fn}#${i}: ${JSON.stringify(x.result)}, V8 gave ${JSON.stringify(r?.result)}`,
                );
              return;
            }
            const a = JSON.stringify(x.result);
            const b = JSON.stringify(r?.result);
            const aa = JSON.stringify(x.args);
            const bb = JSON.stringify(r?.args);
            if (a !== b) problems.push(`${x.fn}#${i}: ${a}, V8 gave ${b}`);
            else if (aa !== bb) problems.push(`${x.fn}#${i}: arguments ended ${aa}, on V8 ${bb}`);
            else agreed++;
          });
          return { agreed, problems };
        };
      } else {
        const meta = loadJson<Parameters<typeof buildTslImage>[1]>(`${base}.meta.json`);
        const pages = /^\/\/ memory-pages: (\d+|none)$/m.exec(readFileSync(file, "utf8"))?.[1];
        const image = buildTslImage(
          m,
          meta,
          cases,
          pages === "none" ? -1 : pages !== undefined ? Number(pages) : undefined,
          bulkFor(),
        );
        bytes = image.bytes;
        bulk = image.bulk;
        ranges = image.ranges;
        compare = (serial) => {
          const { results, problems } = tslResults(meta, cases, serial);
          const ref = refs.get(file) as CaseResult[] | undefined;
          let agreed = 0;
          results.forEach((c, i) => {
            if (kind === "trap") {
              const want = (cases[i]! as { trap?: number }).trap;
              const got = (c.result as { trap?: number } | null)?.trap;
              if (want === got) agreed++;
              else
                problems.push(
                  `${c.fn}#${i}: expected trap ${want}, got ${JSON.stringify(c.result)}`,
                );
              return;
            }
            const want = ref?.[i];
            // R12: as the lowered programs' above: no reference, no comparison with it case by case (its failure is said),
            // but a case's own pin, which needs no reference, is still checked.
            if (ref === undefined) {
              if (c.pin !== null && c.pin !== "ok") problems.push(`${c.fn}#${i}: ${c.pin}`);
              return;
            }
            // Allowed divergence 5 (SPEC 3.10): a stale local traps on the host and reads old data natively.
            // `diverge` pins a test of what native memory does where the host only simulates it.
            const spec = cases[i]! as {
              diverge5?: { native: unknown };
              diverge?: { native: unknown; v8: unknown };
            };
            if (spec.diverge5 !== undefined || spec.diverge !== undefined) {
              const v8 = JSON.stringify(want?.result);
              const n = JSON.stringify(c.result);
              const pinN = JSON.stringify(spec.diverge5?.native ?? spec.diverge?.native);
              const pinV = JSON.stringify(
                spec.diverge5 !== undefined ? { trap: 5 } : spec.diverge?.v8,
              );
              if (v8 === pinV && n === pinN) agreed++;
              else
                problems.push(`${c.fn}#${i}: native ${n} (want ${pinN}), V8 ${v8} (want ${pinV})`);
              return;
            }
            if (JSON.stringify(c.result) !== JSON.stringify(want?.result))
              problems.push(
                `${c.fn}#${i}: ${JSON.stringify(c.result)}, V8 gave ${JSON.stringify(want?.result)}`,
              );
            else if (JSON.stringify(c.arrays) !== JSON.stringify(want?.arrays))
              problems.push(`${c.fn}#${i}: typed-array output differs`);
            else if (c.pin !== null && c.pin !== "ok") problems.push(`${c.fn}#${i}: ${c.pin}`);
            else agreed++;
          });
          return { agreed, problems };
        };
      }
    } catch (e) {
      failures.push(
        `${rel(file)} on ${accel}: build failed: ${e instanceof Error ? (e.stack ?? e.message).slice(0, 900) : String(e)}`,
      );
      return;
    }
    // Kept for the encoder cross-check, which looks at exactly what ran.
    writeFileSync(`${base}.img`, bytes);
    writeFileSync(`${base}.ranges.json`, JSON.stringify(ranges));
    const r = await qemuRun({
      name,
      image: bytes,
      accel,
      timeoutMs: NATIVE_TIMEOUT_MS,
      ...(bulk !== undefined ? { bulk } : {}),
    });
    if (r.skipped) {
      tally1.skipped = true;
      return;
    }
    tally1.programs++;
    tally1.cases += cases.length;
    const { agreed, problems } = compare(r.lines);
    tally1.agreed += agreed;
    if (!r.ok) problems.push(`${r.status}: ${r.why.slice(0, 1500)}`);
    for (const p of problems) failures.push(`${rel(file)} on ${accel}: ${p}`);
  });
  const agreement = accels.map((accel) => ({ accel, ...tally.get(accel)! }));
  const text = agreement
    .map((a) =>
      a.skipped
        ? `${a.accel} SKIPPED (unavailable)`
        : `${a.accel} ${a.agreed}/${a.cases} cases in ${a.programs} programs`,
    )
    .join(", ");
  const skipNote =
    skippedPrograms.length > 0
      ? `; ${skippedPrograms.length} with a fallback left out: ${skippedPrograms.join(", ")}`
      : "";
  return {
    name: `corpus --native ${kind}`,
    ok:
      failures.length === 0 &&
      agreement.some((a) => a.programs > 0) &&
      agreement.every((a) => a.agreed === a.cases),
    summary: `${text}${skipNote}`,
    failures,
    count: agreement.reduce((n, a) => n + a.agreed, 0),
    agreement,
    skippedPrograms,
  };
}

function rel(file: string): string {
  return relative(ROOT, file);
}
