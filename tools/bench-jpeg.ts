// `tmk bench jpeg` (SPEC 8.4, M2): each configuration in fresh processes, warm-up discarded, median of
// at least 101 iterations, repeated over 5 processes, with engine versions and load in the JSON.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { fallbackModuleText, lowerFile } from "./lowering.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { buildPath } from "./build-dir.ts";

export const VENDOR = join(ROOT, "bench/jpeg/vendor/jpeg.ts");
export const FIXTURES = join(ROOT, "bench/jpeg/fixtures");
const HOOK = join(ROOT, "tools/ts-hook.mjs");
const RUN = join(ROOT, "bench/jpeg/run.ts");
const OUT = buildPath("bench/jpeg");
const WASM_OPT = "/opt/homebrew/bin/wasm-opt";
export const LARGE = join(OUT, "large/generated-4000x3000.jpg");

/** SPEC M2's table. The six the gate is measured on, and their pinned RGBA hashes. */
export const PINNED: Record<string, string> = {
  "tower-portrait.jpg": "f29a22231a13be9e",
  "lisbon-tram.jpg": "fe68ef33d906cdc0",
  "garden-gate.jpg": "6375c845b4f377be",
  "harbour.jpg": "a1e37bfc22e2ca6f",
  "progressive.jpg": "55a3642578e62761",
  "baseline-420.jpg": "5396dd592441fadf",
};

export interface Built {
  wasm: string;
  glue: string;
  opt: string | null;
  tirHash: string;
}

export function buildJpeg(): Built {
  mkdirSync(OUT, { recursive: true });
  const o = lowerFile(VENDOR);
  if (o.wasm === null) throw new Error(`jpeg.ts doesn't compile: ${JSON.stringify(o.diags)}`);
  const base = join(OUT, "jpeg");
  writeFileSync(`${base}.wasm`, o.wasm);
  writeFileSync(`${base}.glue.mjs`, o.glue);
  writeFileSync(`${base}.tir`, o.tirText);
  if (o.meta!.fallbackFile !== null) {
    writeFileSync(
      join(OUT, o.meta!.fallbackFile),
      fallbackModuleText(VENDOR, o.meta!.fallbackNames),
    );
  }
  let opt: string | null = null;
  if (existsSync(WASM_OPT)) {
    opt = `${base}.opt.wasm`;
    execFileSync(
      WASM_OPT,
      [
        "-O3",
        "--enable-bulk-memory",
        "--enable-multivalue",
        "--enable-nontrapping-float-to-int",
        "--enable-sign-ext",
        "--enable-mutable-globals",
        `${base}.wasm`,
        "-o",
        opt,
      ],
      { timeout: 120_000 },
    );
  }
  return { wasm: `${base}.wasm`, glue: `${base}.glue.mjs`, opt, tirHash: o.tirHash };
}

/** The 4000×3000 fixture, from a checked-in fixture through sips, if this host has it (SPEC M2). */
export function makeLarge(): string | null {
  if (existsSync(LARGE)) return LARGE;
  if (!existsSync("/usr/bin/sips")) return null;
  mkdirSync(join(OUT, "large"), { recursive: true });
  execFileSync(
    "/usr/bin/sips",
    [
      "-z",
      "3000",
      "4000",
      "-s",
      "format",
      "jpeg",
      join(FIXTURES, "tower-portrait.jpg"),
      "--out",
      LARGE,
    ],
    { stdio: "ignore", timeout: 120_000 },
  );
  return LARGE;
}

interface ConfigDef {
  name: string;
  cmd: string;
  args: string[];
  job: { source: string; glue?: string; wasm?: string };
}

function configs(b: Built, bun: string): ConfigDef[] {
  const source = VENDOR;
  const node = process.execPath;
  const list: ConfigDef[] = [
    { name: "v8", cmd: node, args: ["--import", HOOK, "--no-warnings", RUN], job: { source } },
    { name: "jsc", cmd: bun, args: [RUN], job: { source } },
    {
      name: "wasm-v8",
      cmd: node,
      args: ["--no-warnings", RUN],
      job: { source, glue: b.glue, wasm: b.wasm },
    },
  ];
  if (b.opt !== null) {
    list.push({
      name: "wasm-opt-v8",
      cmd: node,
      args: ["--no-warnings", RUN],
      job: { source, glue: b.glue, wasm: b.opt },
    });
  }
  list.push({
    name: "wasm-jsc",
    cmd: bun,
    args: [RUN],
    job: { source, glue: b.glue, wasm: b.wasm },
  });
  return list;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

export interface BenchResult {
  host: {
    load: number[];
    cpus: number;
    loadWarning: string | null;
    git: string;
    node: string;
    bun: string;
  };
  params: { warm: number; iter: number; processes: number };
  fixtures: Record<
    string,
    Record<string, { median: number; spreadLow: number; spreadHigh: number }>
  >;
  cold: Record<string, { median: number; compileMedian: number }>;
  memory: Record<string, { rssBytes: number }>;
  gate: {
    perFixture: Record<string, number>;
    geomean: number;
    worst: number;
    sumRatio: number;
    optGeomean: number | null;
    verdict: string;
  };
  large: Record<string, { median: number; warm: number; iter: number; processes: number }> | null;
  errors: string[];
  fail: boolean;
}

export async function benchJpeg(
  opts: { quick?: boolean; largeFull?: boolean } = {},
): Promise<BenchResult> {
  const b = buildJpeg();
  const bun = process.env.TMK_BUN ?? "bun";
  const list = configs(b, bun);
  const processes = opts.quick === true ? 1 : 5;
  const warm = opts.quick === true ? 20 : 200;
  const iter = opts.quick === true ? 21 : 101;
  const names = Object.keys(PINNED);
  const fixtures = names.map((name) => ({ name, path: join(FIXTURES, name), warm, iter }));
  const errors: string[] = [];
  const perFixture: BenchResult["fixtures"] = {};
  const memory: BenchResult["memory"] = {};
  const load0 = loadavg();
  for (const c of list) {
    const medians: Record<string, number[]> = {};
    let rss = 0;
    for (let p = 0; p < processes; p++) {
      const r = await guardedRun(c.cmd, [...c.args, JSON.stringify({ ...c.job, fixtures })], {
        timeoutMs: 300_000,
        label: `bench ${c.name} #${p}`,
        cwd: ROOT,
      });
      if (!r.ok) {
        errors.push(`${c.name} #${p}: ${r.why} ${r.stderr.slice(0, 400)}`);
        continue;
      }
      const o = JSON.parse(r.stdout) as {
        fixtures: Record<string, { median: number }>;
        rssBytes: number;
      };
      rss = Math.max(rss, o.rssBytes);
      for (const [name, x] of Object.entries(o.fixtures)) (medians[name] ??= []).push(x.median);
    }
    memory[c.name] = { rssBytes: rss };
    for (const [name, ms] of Object.entries(medians)) {
      (perFixture[name] ??= {})[c.name] = {
        median: median(ms),
        spreadLow: Math.min(...ms),
        spreadHigh: Math.max(...ms),
      };
    }
  }
  const cold: BenchResult["cold"] = {};
  const first = [
    { name: "tower-portrait.jpg", path: join(FIXTURES, "tower-portrait.jpg"), warm: 0, iter: 0 },
  ];
  for (const c of list) {
    const times: number[] = [];
    const compile: number[] = [];
    for (let p = 0; p < 5; p++) {
      const r = await guardedRun(
        c.cmd,
        [...c.args, JSON.stringify({ ...c.job, fixtures: first, coldOnly: true })],
        {
          timeoutMs: 60_000,
          label: `cold ${c.name} #${p}`,
          cwd: ROOT,
        },
      );
      if (!r.ok) {
        errors.push(`cold ${c.name} #${p}: ${r.why}`);
        continue;
      }
      const o = JSON.parse(r.stdout) as { coldMs: number; compileMs?: number };
      times.push(o.coldMs);
      compile.push(o.compileMs ?? 0);
    }
    if (times.length > 0) cold[c.name] = { median: median(times), compileMedian: median(compile) };
  }
  // At the counts in 8.4 the large fixture takes about half an hour, so by default it gets fewer and
  // says so. It isn't one of the fixtures the gate is measured on.
  let largeOut: BenchResult["large"] = null;
  const large = makeLarge();
  if (large !== null && opts.quick !== true) {
    largeOut = {};
    const full = opts.largeFull === true;
    const lw = full ? 200 : 10;
    const li = full ? 101 : 21;
    const lp = full ? 5 : 1;
    const jobFix = [{ name: "large", path: large, warm: lw, iter: li }];
    for (const c of list) {
      const ms: number[] = [];
      for (let p = 0; p < lp; p++) {
        const r = await guardedRun(
          c.cmd,
          [...c.args, JSON.stringify({ ...c.job, fixtures: jobFix })],
          {
            timeoutMs: full ? 1_800_000 : 600_000,
            label: `large ${c.name} #${p}`,
            cwd: ROOT,
          },
        );
        if (!r.ok) {
          errors.push(`large ${c.name} #${p}: ${r.why} ${r.stderr.slice(0, 300)}`);
          continue;
        }
        const o = JSON.parse(r.stdout) as {
          fixtures: Record<string, { median: number }>;
          rssBytes: number;
        };
        ms.push(o.fixtures.large!.median);
        memory[`${c.name}-large`] = { rssBytes: o.rssBytes };
      }
      if (ms.length > 0)
        largeOut[c.name] = { median: median(ms), warm: lw, iter: li, processes: ms.length };
    }
  }
  const gateFixtures: Record<string, number> = {};
  let logSum = 0;
  let optLog = 0;
  let wasmSum = 0;
  let v8Sum = 0;
  let worst = 0;
  let n = 0;
  let optSeen = 0;
  for (const name of names) {
    const row = perFixture[name];
    const v = row?.v8?.median;
    const w = row?.["wasm-v8"]?.median;
    if (v === undefined || w === undefined) continue;
    const ratio = w / v;
    gateFixtures[name] = ratio;
    logSum += Math.log(ratio);
    wasmSum += w;
    v8Sum += v;
    worst = Math.max(worst, ratio);
    n++;
    const o = row?.["wasm-opt-v8"]?.median;
    if (o !== undefined) {
      optLog += Math.log(o / v);
      optSeen++;
    }
  }
  const geomean = n > 0 ? Math.exp(logSum / n) : Infinity;
  const verdict =
    geomean <= 1.25
      ? "<= 1.25x: proceed"
      : geomean <= 2
        ? "1.25x to 2x: one fix pass, then proceed"
        : "> 2x: stop and report";
  const load = loadavg();
  const nCpus = cpus().length;
  const busy = Math.max(load0[0]!, load[0]!) > nCpus * 0.5;
  const version = (cmd: string): string => {
    try {
      return execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      return "?";
    }
  };
  let git = "no commits yet";
  try {
    git = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: ROOT,
    }).trim();
  } catch {
    // This repo has no commits yet, and that's reported as it is.
  }
  const result: BenchResult = {
    host: {
      load: [...load0, ...load],
      cpus: nCpus,
      loadWarning: busy
        ? `load ${Math.max(load0[0]!, load[0]!).toFixed(1)} on ${nCpus} CPUs: these numbers are rough`
        : null,
      git,
      node: version(process.execPath),
      bun: version(bun),
    },
    params: { warm, iter, processes },
    fixtures: perFixture,
    cold,
    memory,
    gate: {
      perFixture: gateFixtures,
      geomean,
      worst,
      sumRatio: v8Sum > 0 ? wasmSum / v8Sum : Infinity,
      optGeomean: optSeen > 0 ? Math.exp(optLog / optSeen) : null,
      verdict,
    },
    large: largeOut,
    errors,
    fail: errors.length > 0 || n < names.length,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

export function benchText(r: BenchResult): string {
  const lines: string[] = [];
  lines.push(
    `host: ${r.host.node}, bun ${r.host.bun}, git ${r.host.git}, ${r.host.cpus} CPUs, load start ${r.host.load
      .slice(0, 3)
      .map((x) => x.toFixed(1))
      .join(" ")}, end ${r.host.load
      .slice(3)
      .map((x) => x.toFixed(1))
      .join(" ")}`,
  );
  if (r.host.loadWarning !== null) lines.push(`WARNING: ${r.host.loadWarning}`);
  lines.push(
    `${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}; ms, median of process medians [low..high]`,
  );
  for (const [name, row] of Object.entries(r.fixtures)) {
    const parts = Object.entries(row).map(
      ([c, x]) =>
        `${c} ${x.median.toFixed(3)} [${x.spreadLow.toFixed(3)}..${x.spreadHigh.toFixed(3)}]`,
    );
    lines.push(
      `${name.padEnd(22)} ${parts.join("  ")}  ratio ${(r.gate.perFixture[name] ?? 0).toFixed(3)}x`,
    );
  }
  lines.push(
    `G1: Wasm on V8 against V8: geomean ${r.gate.geomean.toFixed(3)}x, worst fixture ${r.gate.worst.toFixed(3)}x, total time ${r.gate.sumRatio.toFixed(3)}x; with wasm-opt ${r.gate.optGeomean?.toFixed(3) ?? "?"}x: ${r.gate.verdict}`,
  );
  lines.push(
    `cold start, first decode of tower-portrait including Wasm compile: ${Object.entries(r.cold)
      .map(
        ([c, x]) =>
          `${c} ${x.median.toFixed(2)} ms${x.compileMedian > 0 ? ` (compile ${x.compileMedian.toFixed(2)})` : ""}`,
      )
      .join(", ")}`,
  );
  lines.push(
    `peak RSS: ${Object.entries(r.memory)
      .map(([c, x]) => `${c} ${(x.rssBytes / 1048576).toFixed(0)} MiB`)
      .join(", ")}`,
  );
  if (r.large !== null)
    lines.push(
      `4000x3000 (warm-up and count reduced unless --large-full): ${Object.entries(r.large)
        .map(
          ([c, x]) =>
            `${c} ${x.median.toFixed(1)} ms (${x.warm}+${x.iter}, ${x.processes} process${x.processes === 1 ? "" : "es"})`,
        )
        .join(", ")}`,
    );
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}
