// One program from `corpus/lower/strmap`, natively against V8, in one memory mode and build: `node tools/strmap-run.ts <file>
// [--mode rc|leak|manual] [--check] [--accel tcg] [--budget n] [--no-pace] [--pages n]`. A debugging aid, and what tools/strmap-tests.ts uses.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { lowerAndBuild } from "./compile-pool.ts";
import type { SlimLower } from "./compile-worker.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { defaultEngines, lowerCommand, ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import type { LowerCase, LowerCaseResult } from "./lower-exec.ts";
import {
  bulkFor,
  downResults,
  rcStatLines,
  type DownMetaLike,
  type RcHarness,
} from "./native-exec.ts";
import { qemuRun, type Accel } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

export interface StrmapOptions {
  memory?: "leak" | "manual" | "rc";
  rc?: Record<string, unknown>;
  accel?: Accel;
  harness?: RcHarness;
  pages?: number;
  stackBytes?: number;
  timeoutMs?: number;
}

export interface StrmapRun {
  skipped: boolean;
  status: string;
  why: string;
  serial: string[];
  results: { fn: string; result: unknown }[];
  problems: string[];
  stats: Record<string, number>[];
  o: SlimLower;
}

export const pagesIn = (file: string): number | undefined => {
  const m = /^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return m !== undefined ? Number(m) : undefined;
};

/** The source on V8, through the same canonical form the native results are read into. */
export async function referenceOnV8(file: string, cases: LowerCase[]): Promise<LowerCaseResult[]> {
  const dir = buildPath("strmap/ref");
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `${basename(file, ".ts")}.${process.pid}.${Math.random().toString(36).slice(2)}.cases.json`,
  );
  writeFileSync(tmp, JSON.stringify(cases));
  const { cmd, args } = lowerCommand("source-v8", file, dir, defaultEngines());
  const job = JSON.parse(args[args.length - 1]!) as { cases: string };
  job.cases = tmp;
  args[args.length - 1] = JSON.stringify(job);
  const r = await guardedRun(cmd, args, {
    timeoutMs: 280_000,
    label: `${basename(file)} on V8`,
    cwd: ROOT,
  });
  if (!r.ok) throw new Error(`${file} on V8: ${r.why} ${r.stderr.slice(0, 500)}`);
  return JSON.parse(r.stdout) as LowerCaseResult[];
}

export async function runNativeOne(
  file: string,
  cases: LowerCase[],
  opt: StrmapOptions,
): Promise<StrmapRun> {
  const memory = opt.memory ?? "rc";
  const { o, built } = await lowerAndBuild({
    file,
    lower: { memory, ...(opt.rc !== undefined ? { rc: opt.rc } : {}) },
    cases,
    pages: opt.pages ?? pagesIn(file),
    harness: { ...opt.harness, bulkBytes: bulkFor() },
    stackBytes: opt.stackBytes,
    noFallback: true,
  });
  if (o.tir === null) throw new Error(`${file}: ${JSON.stringify(o.diags)}`);
  if (o.fallbackDiags.length > 0 || built === null) {
    throw new Error(
      `${file}: fallback: ${o.fallbackDiags.map((d) => `${d.fn} ${d.blocker} ${d.detail} at ${d.file}:${d.line}`).join("; ")}`,
    );
  }
  const r = await qemuRun({
    name: `strmap/${basename(file, ".ts")}`,
    image: built.image.bytes,
    accel: opt.accel ?? "hvf",
    timeoutMs: opt.timeoutMs ?? 280_000,
    ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
  });
  const res = r.skipped
    ? { results: [], problems: [] }
    : downResults(o.meta as DownMetaLike, cases, built.placements, r.lines);
  const problems = [...res.problems];
  if (!r.ok && !r.skipped) {
    let where = "";
    const elr = /elr=([0-9a-f]+)/.exec(r.why)?.[1];
    if (elr !== undefined) {
      const at = Number.parseInt(elr, 16) - 0x40200000;
      for (const x of built.image.ranges)
        if (at >= x.from && at < x.to) where = ` in ${x.name}+0x${(at - x.from).toString(16)}`;
    }
    problems.push(`${r.status}: ${r.why.slice(0, 800)}${where}`);
  }
  return {
    skipped: r.skipped,
    status: r.status,
    why: r.why,
    serial: r.lines,
    results: res.results,
    problems,
    stats: rcStatLines(o.tir as Module, r.lines),
    o,
  };
}

/** Each case against V8, as native-a's corpus compares them. A case can pin a trap instead, per mode. */
export function compareResults(
  got: { fn: string; result: unknown }[],
  want: LowerCaseResult[],
  cases: LowerCase[],
  memory: string,
): string[] {
  const problems: string[] = [];
  got.forEach((x, i) => {
    const spec = cases[i]!;
    const pinned =
      spec.lowered_trap ?? (spec.memory_trap as Record<string, number> | undefined)?.[memory];
    if (pinned !== undefined) {
      const t = (x.result as { trap?: number }).trap;
      if (t !== pinned)
        problems.push(`${x.fn}#${i}: expected trap ${pinned}, got ${JSON.stringify(x.result)}`);
      return;
    }
    const a = JSON.stringify(x.result);
    const b = JSON.stringify(want[i]?.result);
    if (a !== b)
      problems.push(
        `${x.fn}#${i} ${JSON.stringify(cases[i]!.args).slice(0, 100)}: ${a?.slice(0, 300)}, V8 gave ${b?.slice(0, 300)}`,
      );
  });
  return problems;
}

if (process.argv[1]?.endsWith("strmap-run.ts") === true) {
  const argv = process.argv.slice(2);
  const file = argv[0]!;
  const val = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i < 0 ? undefined : argv[i + 1];
  };
  const cases = JSON.parse(
    readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"),
  ) as LowerCase[];
  const check = argv.includes("--check");
  const memory = (val("--mode") ?? "rc") as "rc";
  const rc: Record<string, unknown> = {
    ...(check ? { check: true, account: true } : {}),
    ...(val("--budget") !== undefined ? { budget: Number(val("--budget")) } : {}),
    ...(argv.includes("--no-pace") ? { pace: false } : {}),
  };
  const run = await runNativeOne(file, cases, {
    memory,
    ...(memory === "rc" ? { rc } : {}),
    accel: (val("--accel") ?? "hvf") as Accel,
    harness: check ? { stats: true, collect: true } : {},
    ...(val("--pages") !== undefined ? { pages: Number(val("--pages")) } : {}),
  });
  const want = await referenceOnV8(file, cases);
  const problems = [...run.problems, ...compareResults(run.results, want, cases, memory)];
  console.log(
    `${run.results.length}/${cases.length} ran, status ${run.status}, ${problems.length} problems, ${run.results.length} results`,
  );
  for (const p of problems.slice(0, 40)) console.log(p);
  if (argv.includes("--show"))
    run.results.forEach((x, i) => {
      console.log(i, x.fn, JSON.stringify(x.result).slice(0, 200));
    });
  if (check && run.stats.length > 0) console.log(JSON.stringify(run.stats[run.stats.length - 1]));
  process.exitCode = problems.length > 0 ? 1 : 0;
}
