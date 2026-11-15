// What `tmk` and the milestones share (SPEC 9.3): the command line, the timed suites, the repo checks, and how a milestone
// declares its boxes so that `tmk gate` can run each one as a job of its own (SPEC 8.3, D51). Every child process goes
// through guarded-run.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { buildPath } from "./build-dir.ts";
import * as corpusAll from "./corpus.ts";
import { listPrograms, ROOT, type SuiteResult } from "./corpus.ts";
import { guardedRun as guardedRunRaw, pool } from "./guarded-run.ts";
import { LANG_A_MOVED } from "./lang-a-pins.ts";
import { mapsMoved } from "./maps-pins.ts";
import { liveCount } from "./qemu-run.ts";
import { startMilestone, suite, timedFn, type MilestoneTiming } from "./timing.ts";

export { ROOT };

export const args = process.argv.slice(2);
export const json = args.includes("--json");
export const DEFAULT_JOBS = 4;
export const TOOL_TIMEOUT_MS = 90_000;

export function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function jobsFlag(): number {
  const v = flagValue("--jobs");
  return v !== undefined ? Math.max(1, Number(v)) : DEFAULT_JOBS;
}

export function bin(name: string): string {
  return join(ROOT, "node_modules/.bin", name);
}

export function needInstall(): void {
  if (!existsSync(join(ROOT, "node_modules/typescript"))) {
    console.error("node_modules is missing: run `pnpm install` first.");
    process.exit(2);
  }
}

export function out(value: unknown, text: string): void {
  console.log(json ? JSON.stringify(value) : text);
}

export const compileBatch = timedFn("corpus.compileBatch", corpusAll.compileBatch);
export const runLower = timedFn("corpus.runLower", corpusAll.runLower);
export const runNegative = timedFn("corpus.runNegative", corpusAll.runNegative);
export const runNoBuild = timedFn("corpus.runNoBuild", corpusAll.runNoBuild);
export const runPositive = timedFn("corpus.runPositive", corpusAll.runPositive);
export const runTrap = timedFn("corpus.runTrap", corpusAll.runTrap);

/** A child of a milestone, timed as a suite. */
export const guardedRun: typeof guardedRunRaw = (cmd, cargs, opts) =>
  suite(`run ${opts.label}`, () => guardedRunRaw(cmd, cargs, opts));

// --- doctor

export interface ToolCheck {
  tool: string;
  path: string | null;
  version: string | null;
  expected: string;
  required: boolean;
  status: "ok" | "differs" | "missing";
}

export function versionOf(
  cmd: string,
  versionArgs: string[],
): { path: string | null; version: string | null } {
  let path: string | null = cmd;
  if (!cmd.includes("/")) {
    try {
      path = execFileSync("/usr/bin/which", [cmd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return { path: null, version: null };
    }
  } else if (!existsSync(cmd)) return { path: null, version: null };
  try {
    const text = execFileSync(cmd, versionArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    const m = /(\d+(?:\.\d+)*)/.exec(text);
    return { path, version: m?.[1] ?? text.trim().split("\n")[0] ?? null };
  } catch {
    return { path, version: null };
  }
}

export function doctorChecks(): ToolCheck[] {
  // Expected versions are Appendix B's. Each row: name, command, args, expected, required for M1.
  const rows: [string, string, string[], string, boolean][] = [
    ["node", "node", ["--version"], "26.13.0", true],
    ["node (homebrew)", "/opt/homebrew/bin/node", ["--version"], "25.8.1", false],
    ["bun", "bun", ["--version"], "1.3.11", true],
    ["pnpm", "pnpm", ["--version"], "11.2.2", false],
    ["tsc", bin("tsc"), ["--version"], "5.9.3", true],
    ["oxlint", bin("oxlint"), ["--version"], "1.80.0", true],
    ["oxfmt", bin("oxfmt"), ["--version"], "0.65.0", true],
    ["qemu", "/opt/homebrew/bin/qemu-system-aarch64", ["--version"], "10.1.2", true],
    ["clang", "/opt/homebrew/opt/llvm/bin/clang", ["--version"], "21.1.4", false],
    ["ld.lld", "/opt/homebrew/opt/lld@22/bin/ld.lld", ["--version"], "22.1.8", false],
    ["wasm-opt", "/opt/homebrew/bin/wasm-opt", ["--version"], "133", false],
  ];
  return rows.map(([tool, cmd, vArgs, expected, required]) => {
    const { path, version } = versionOf(cmd, vArgs);
    const status: ToolCheck["status"] =
      path === null || version === null ? "missing" : version === expected ? "ok" : "differs";
    return { tool, path, version, expected, required, status };
  });
}

// --- repo checks

export async function toolRun(label: string, cmd: string, cmdArgs: string[]): Promise<SuiteResult> {
  const r = await guardedRun(cmd, cmdArgs, { timeoutMs: TOOL_TIMEOUT_MS, label, cwd: ROOT });
  return {
    name: label,
    ok: r.ok,
    summary: r.ok ? `clean (${r.ms} ms)` : r.why,
    failures: r.ok ? [] : [`${r.stdout}${r.stderr}`.slice(0, 6000)],
    count: r.ok ? 1 : 0,
  };
}

export async function repoChecks(): Promise<SuiteResult[]> {
  const nodeBin = process.execPath;
  const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
  return Promise.all([
    toolRun("tsc", nodeBin, [tsc, "-p", "tsconfig.json"]),
    toolRun("tsc (host)", nodeBin, [tsc, "-p", "tsconfig.host.json"]),
    toolRun("oxlint", bin("oxlint"), ["--deny-warnings"]),
    toolRun("oxfmt --check", bin("oxfmt"), ["--check"]),
  ]);
}

export async function unitTests(): Promise<SuiteResult> {
  const tests = [
    ...listPrograms(join(ROOT, "compiler")),
    ...listPrograms(join(ROOT, "tools")),
  ].filter((f) => f.endsWith(".test.ts"));
  return toolRun("unit tests", process.execPath, [
    "--test",
    "--test-timeout=30000",
    "--no-warnings",
    ...tests,
  ]);
}

// --- what milestones share

export interface Item {
  box: string;
  ok: boolean;
  detail: string;
  failures: string[];
}

export function suiteItem(box: string, ...suites: SuiteResult[]): Item {
  return {
    box,
    ok: suites.every((s) => s.ok),
    detail: suites.map((s) => `${s.name}: ${s.summary}`).join("; "),
    failures: suites.flatMap((s) => s.failures.map((f) => `${s.name}: ${f}`)),
  };
}

/** Programs whose module uses Map, Set or strings: they were fallbacks for that in a mode, and now lower. Strict isn't among these. */
export const USE_STRMAP = [
  "corpus/lower/fallback/callee_blocked.ts",
  "corpus/lower/fallback/init_blocked.ts",
  "corpus/lower/fallback/map_set.ts",
  "corpus/lower/fallback/string_use.ts",
];

/**
 * A gate job runs under the 3 GiB watchdog, as a nested milestone did, and V8 lets garbage grow toward a heap limit it isn't
 * near: a bounded heap for its main thread, and its workers' (tools/compile-pool.ts), keeps the process to what it uses (lang-a).
 */
export const MILESTONE_NODE = ["--no-warnings", "--max-old-space-size=1536"];

/** Moved by language phase A or by the maps phase, each listed with why (tools/lang-a-pins.ts, tools/maps-pins.ts). */
export const langAMoved = (k: string): boolean =>
  (!k.includes("@strict") && Object.keys(LANG_A_MOVED).some((p) => k.startsWith(`${p}@`))) ||
  mapsMoved(k);

export async function tmkOut(
  _tmk: string,
  tool: string,
): Promise<Awaited<ReturnType<typeof guardedRun>>> {
  return guardedRun(process.execPath, ["--no-warnings", join(ROOT, tool)], {
    timeoutMs: 120_000,
    label: tool,
    cwd: ROOT,
  });
}

/** Other people's QEMUs and UTM on this host, read and never touched: the owner runs VMs here. */
export function otherVms(): string[] {
  const text = spawnSync("/bin/ps", ["-axo", "pid,comm"], { encoding: "utf8", timeout: 5000 });
  return (text.stdout ?? "")
    .split("\n")
    .filter((l) => /\/UTM|QEMULauncher|QEMUHelper/.test(l))
    .map((l) => l.trim());
}

export function listTs(dir: string): string[] {
  const res: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) res.push(...listTs(p));
    else if (n.endsWith(".ts")) res.push(p);
  }
  return res;
}

/** A value computed once, when the first box that needs it runs. */
export function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}

/**
 * `tmk coverage [--real] [--compiler DIR] [--budget ms] [--label name]` (D48): the fraction of functions that lower natively in
 * `rc`, by root cause, over the local corpora, and with --real over the pinned real projects. Each corpus is its own process,
 * under the RSS watchdog, with a time budget.
 */
export async function coverageRun(opts: {
  real: boolean;
  compiler: string;
  budgetMs: number;
  jobs: number;
  label: string;
  only?: string[];
}): Promise<{ rows: import("./coverage.ts").Coverage[]; failures: string[]; text: string }> {
  const C = await import("./coverage.ts");
  const m = C.manifest();
  const names = ["local", "local-before"];
  if (opts.real) {
    for (const p of m.projects) {
      if (opts.only !== undefined && !opts.only.includes(p.dir)) continue;
      if (!existsSync(join(C.cacheDir(m), p.dir))) continue;
      names.push(p.dir);
    }
  }
  const failures: string[] = [];
  const rows: import("./coverage.ts").Coverage[] = [];
  await pool(names, opts.jobs, async (name) => {
    const r = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        join(ROOT, "tools/coverage.ts"),
        "--project",
        name,
        "--compiler",
        opts.compiler,
        "--budget",
        String(opts.budgetMs),
      ],
      { timeoutMs: opts.budgetMs + 240_000, label: `coverage ${name}`, cwd: ROOT },
    );
    if (!r.ok) {
      failures.push(`${name}: ${r.why} ${r.stderr.slice(0, 300)}`);
      return;
    }
    rows.push(JSON.parse(r.stdout) as import("./coverage.ts").Coverage);
  });
  const order = (n: string): number => names.indexOf(n);
  rows.sort((a, b) => order(a.name) - order(b.name));
  const real = rows.filter(
    (r) => r.name !== "local" && r.name !== "local-before" && r.name !== "tc39_test262",
  );
  const all = opts.real ? [...rows, C.total("real projects, in total", real)] : rows;
  const text = C.table(all);
  mkdirSync(buildPath("coverage"), { recursive: true });
  writeFileSync(
    buildPath(`coverage/summary-${opts.label}.json`),
    JSON.stringify({ label: opts.label, compiler: opts.compiler, rows: all }, null, 1),
  );
  return { rows: all, failures, text };
}

// --- a milestone's boxes, as units a gate job runs (SPEC 8.3, D51)

/**
 * One or more of a milestone's boxes that share what they compute, run by one job, in order. Its id names the boxes by their
 * place in the milestone, "3" or "2,5-7", and it reports them in that order.
 */
export interface UnitSlot {
  kind: "unit";
  id: string;
  places: number[];
  run: () => Promise<void>;
}

/** "2,5-7" is boxes 2, 5, 6 and 7. */
export function placesOf(id: string): number[] {
  const res: number[] = [];
  for (const part of id.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) throw new Error(`a unit's id is box places, like 3 or 2,5-7: ${id}`);
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) res.push(i);
  }
  return res;
}

/** A box that says another milestone passes: the view's, from that milestone's jobs, at its level or the one given. */
export interface NestedSlot {
  kind: "nested";
  id: string;
  box: string;
  milestone: string;
  level?: "0" | "1" | "2";
}

/** opt-a's box 9: the quick tier, at a level. */
export interface TierSlot {
  kind: "tier";
  id: string;
  box: string;
  level: "0" | "1" | "2";
}

/** The last box: no QEMU of this milestone's jobs is left; with `observed`, the owner's VMs were only looked at. */
export interface VmsSlot {
  kind: "vms";
  id: string;
  box: string;
  observed: boolean;
}

export type Slot = UnitSlot | NestedSlot | TierSlot | VmsSlot;

export class MilestoneDef {
  readonly name: string;
  readonly slots: Slot[] = [];
  /** What a box measured beyond its line, kept in the milestone's JSON as it always was: a bench's rows, an audit. */
  readonly extras: Record<string, unknown> = {};
  private sink: ((i: Item) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  unit(id: string, run: () => Promise<void>): void {
    this.slots.push({ kind: "unit", id, places: placesOf(id), run });
  }

  nested(id: string, box: string, milestone: string, level?: "0" | "1" | "2"): void {
    this.slots.push({
      kind: "nested",
      id,
      box,
      milestone,
      ...(level !== undefined ? { level } : {}),
    });
  }

  tier(id: string, box: string, level: "0" | "1" | "2"): void {
    this.slots.push({ kind: "tier", id, box, level });
  }

  vms(id: string, box: string, observed: boolean): void {
    this.slots.push({ kind: "vms", id, box, observed });
  }

  keep(name: string, value: unknown): void {
    this.extras[name] = value;
  }

  /** A box's result, as it's known. */
  report = (i: Item): void => {
    if (this.sink === null)
      throw new Error(`${this.name}: a box reported outside a unit: ${i.box}`);
    this.sink(i);
    if (!json) {
      console.log(`${i.ok ? "PASS" : "FAIL"} ${i.box}\n     ${i.detail}`);
      for (const f of i.failures.slice(0, 20)) console.log(`     ${f.slice(0, 600)}`);
    }
  };

  units(): UnitSlot[] {
    return this.slots.filter((s): s is UnitSlot => s.kind === "unit");
  }

  /** Runs these units, in the order declared, each reporting into the job's record. */
  async run(ids: string[]): Promise<JobUnitResult[]> {
    const want = new Set(ids);
    const missing = ids.filter((id) => !this.units().some((u) => u.id === id));
    if (missing.length > 0) throw new Error(`${this.name} has no unit ${missing.join(", ")}`);
    const rec = startMilestone(this.name, loadavg(), cpus().length);
    const results: JobUnitResult[] = [];
    for (const u of this.units()) {
      if (!want.has(u.id)) continue;
      const items: Item[] = [];
      const t0 = performance.now();
      this.sink = (i) => {
        items.push(i);
        rec.closeBox(i.box);
      };
      let error: string | null = null;
      try {
        await u.run();
      } catch (e) {
        error = e instanceof Error ? (e.stack ?? e.message) : String(e);
      }
      this.sink = null;
      if (error === null && items.length !== u.places.length)
        error = `unit ${u.id} reported ${items.length} boxes, and declares ${u.places.length}`;
      results.push({ id: u.id, items, error, seconds: (performance.now() - t0) / 1000 });
    }
    lastTiming = rec.finish();
    return results;
  }
}

export interface JobUnitResult {
  id: string;
  items: Item[];
  error: string | null;
  seconds: number;
}

let lastTiming: MilestoneTiming | null = null;

/** What one job leaves for the gate, in its own build directory. */
export interface JobRecord {
  milestone: string;
  units: JobUnitResult[];
  extras: Record<string, unknown>;
  timing: MilestoneTiming | null;
  liveQemu: number;
  level: string;
  at: number;
}

export function writeJobRecord(file: string, def: MilestoneDef, units: JobUnitResult[]): void {
  const rec: JobRecord = {
    milestone: def.name,
    units,
    extras: def.extras,
    timing: lastTiming,
    liveQemu: liveCount(),
    level: process.env.TMK_OPT ?? "unset",
    at: Date.now(),
  };
  writeFileSync(file, JSON.stringify(rec));
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
