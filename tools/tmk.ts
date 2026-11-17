#!/usr/bin/env node
// The project's one command (SPEC 9.3). Every child process goes through guarded-run.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildPath } from "./build-dir.ts";
import { defaultEngines, ROOT, type SuiteResult } from "./corpus.ts";
import {
  args,
  coverageRun,
  doctorChecks,
  flagValue,
  guardedRun,
  jobsFlag,
  json,
  needInstall,
  out,
  out as out_,
  repoChecks,
  runLower,
  runNegative,
  runPositive,
  runTrap,
  unitTests,
  writeJobRecord,
} from "./tmk-common.ts";
import { timedModule } from "./timing.ts";

// V8's bytecode for what every child loads, typescript.js above all: it can't change what any program does (SPEC 9.3, D45).
process.env.NODE_COMPILE_CACHE ??= join(ROOT, "build/cache/v8");

// The optimiser (SPEC 9.3, D44): -O0, -O1 or -O2 anywhere on the line is the level for this process and everything it
// runs, through TMK_OPT, and `--no-pass name`, any number of times, switches a pass off by name, for bisecting.
const levelFlag = args.find((a) => /^-O[012]$/.test(a));
if (levelFlag !== undefined) {
  process.env.TMK_OPT = levelFlag.slice(2);
  // The line fixes the level for this process and everything it starts: nothing below takes it from the caller's
  // environment, so there's nothing for a gate job's level trace to note (SPEC 8.3, D51).
  delete process.env.TMK_LEVEL_TRACE;
}
{
  const off: string[] = [];
  args.forEach((a, i) => {
    if (a === "--no-pass" && args[i + 1] !== undefined) off.push(args[i + 1]!);
  });
  if (off.length > 0) process.env.TMK_OPT_DISABLE = off.join(",");
}
// A test build checks the TIR after every pass (SPEC 4.3).
if (
  ["test", "milestone", "corpus", "ci", "job", "gate"].includes(
    args.find((a) => !a.startsWith("-")) ?? "",
  )
)
  process.env.TMK_OPT_VERIFY ??= "1";

function positional(from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (
        [
          "--target",
          "--emit",
          "--out",
          "--filter",
          "--jobs",
          "--profile",
          "--accel",
          "--order",
          "--only",
          "--no-pass",
          "--parallel",
          "--rotation",
          "--since",
          "--sample",
          "--manifest",
          "--seed",
          "--out",
          "--route",
          "--memory",
          "--cycles",
          "--n",
          "--calls",
          "--samples",
          "--top",
          "--focus",
          "--per",
          "--annotate",
          "--warm",
        ].includes(a)
      )
        i++;
      continue;
    }
    if (a === "-O0" || a === "-O1" || a === "-O2") continue;
    out.push(a);
  }
  return out;
}

// --- doctor

function doctor(): number {
  const checks = doctorChecks();
  const missing = checks.filter((c) => c.required && c.status === "missing");
  const lines = checks.map((c) => {
    const v = c.version ?? "-";
    return `${c.status.padEnd(8)} ${c.tool.padEnd(16)} ${v.padEnd(10)} expected ${c.expected.padEnd(9)} ${c.path ?? "(not found)"}`;
  });
  if (missing.length > 0) lines.push(`missing for M1: ${missing.map((m) => m.tool).join(", ")}`);
  out({ ok: missing.length === 0, checks }, lines.join("\n"));
  return missing.length === 0 ? 0 : 1;
}

// --- repo checks

// --- check, compile, tir

async function loadCompiler(): Promise<typeof import("../compiler/host/tslc.ts")> {
  needInstall();
  return import("./lowering.ts");
}

async function cmdCheck(): Promise<number> {
  const files = positional(1);
  const { checkFile } = await loadCompiler();
  const { formatDiag } = await import("../compiler/host/diag.ts");
  const all = files.flatMap((f) => checkFile(resolve(f)).diags);
  out({ ok: all.length === 0, diags: all }, all.length > 0 ? all.map(formatDiag).join("\n") : "ok");
  return all.length === 0 ? 0 : 1;
}

async function compileOne(
  file: string,
): Promise<import("../compiler/host/tslc.ts").CompileOutput | null> {
  const { checkFile, compileTyped } = await loadCompiler();
  const { formatDiag } = await import("../compiler/host/diag.ts");
  const { diags, typed } = checkFile(resolve(file));
  if (typed === null) {
    out({ ok: false, diags }, diags.map(formatDiag).join("\n"));
    return null;
  }
  return compileTyped(typed);
}

async function cmdCompile(): Promise<number> {
  const file = positional(1)[0];
  if (file === undefined) {
    console.error(
      "usage: tmk compile <file> --target wasm|macos-arm64 [-O0|-O1] [--emit tir|js-checked|tsl] [--out path]",
    );
    return 2;
  }
  const target = flagValue("--target") ?? "wasm";
  // macos-arm64 (D57): a native macOS executable that runs the program's cases (tools/macho.ts).
  if (target === "macos-arm64" && flagValue("--emit") === undefined) {
    const { compileForMacos } = await import("./macho.ts");
    const name = file.replace(/.*\//, "").replace(/\.ts$/, "");
    return compileForMacos(file, flagValue("--out"), buildPath("compile", name));
  }
  if (target !== "wasm") {
    console.error(`--target ${target} isn't built yet: c arrives at M3, aarch64 at M5.`);
    return 2;
  }
  const emit = flagValue("--emit");
  if (emit === "tsl") {
    // An `rc` package's module as tslc expands it onto @tsl/gc (SPEC 3.5, D74); any other module is what it says.
    const { createTslProgram } = await import("../compiler/host/program.ts");
    const { rcExpansion } = await import("../compiler/host/tslc.ts");
    const abs = resolve(file);
    const x = rcExpansion(createTslProgram(abs), abs);
    if (x !== null && x.diags.length > 0) {
      for (const d of x.diags) console.error(`${d.file}:${d.line}:${d.col}: ${d.code}: ${d.msg}`);
      return 1;
    }
    const text = x?.texts.get(abs) ?? readFileSync(abs, "utf8");
    // laid out by the repo's formatter for reading; what tslc compiles is the same code, unformatted
    const { spawnSync } = await import("node:child_process");
    const f = spawnSync(
      join(ROOT, "node_modules/.bin/oxfmt"),
      [`--stdin-filepath=${basename(abs)}`],
      {
        input: text,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    process.stdout.write(f.status === 0 && f.stdout !== "" ? f.stdout : text);
    return 0;
  }
  const o = await compileOne(file);
  if (o === null) return 1;
  if (emit === "tir") {
    process.stdout.write(o.tirText);
    return 0;
  }
  if (emit === "js-checked") {
    process.stdout.write(o.jsChecked);
    return 0;
  }
  const base =
    flagValue("--out") ?? buildPath("compile", file.replace(/.*\//, "").replace(/\.ts$/, ""));
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.wasm`, o.wasm);
  writeFileSync(`${base}.glue.mjs`, o.glue);
  out(
    { ok: true, wasm: `${base}.wasm`, tirhash: o.tirHash, bytes: o.wasm.length },
    `${base}.wasm ${o.wasm.length} bytes\ntirhash ${o.tirHash}`,
  );
  return 0;
}

async function cmdTir(): Promise<number> {
  const file = positional(1)[0];
  if (file === undefined) {
    console.error("usage: tmk tir <file>");
    return 2;
  }
  const o = await compileOne(file);
  if (o === null) return 1;
  if (json) out({ tir: o.tirText, tirhash: o.tirHash }, "");
  else process.stdout.write(`${o.tirText}tirhash ${o.tirHash}\n`);
  return 0;
}

// --- lower

/** `tmk lower`'s level when nothing says one: D44's default. */
const LOWER_DEFAULT_OPT = 2 as const;

let optRemarks: (r: import("../compiler/tir/passes/manager.ts").OptReport) => string[] = () => [];

function lowerTable(o: import("../compiler/host/tslc.ts").LowerOutput): string {
  const rows = o.rows.map((r) => {
    const hot = r.hot === undefined ? "" : r.hot ? " hot" : " cold";
    return `${r.outcome.padEnd(9)} ${r.fn.padEnd(30)} ${`${r.file.replace(/.*\//, "")}:${r.line}`.padEnd(18)} ${(r.blocker ?? "-").padEnd(22)}${r.note}${hot}`;
  });
  const lines = [
    `${"outcome".padEnd(9)} ${"function".padEnd(30)} ${"at".padEnd(18)} ${"root blocker".padEnd(22)}note`,
    ...rows,
  ];
  lines.push(
    `lowered ${o.counts.lowered}, fallback ${o.counts.fallback}, unreached ${o.counts.unreached}, total ${o.counts.total} (settled in ${o.rounds} rounds)`,
  );
  const stack = o.allocs.filter((a) => a.where === "stack").length;
  const long = o.allocs.filter((a) => a.where === "long").length;
  lines.push(
    `allocation sites: ${stack} on the stack, ${o.allocs.filter((a) => a.where === "arena").length} in the call arena${long > 0 ? `, ${long} in the mode's allocator` : ""}`,
  );
  if (o.rc !== undefined) {
    lines.push(
      `rc: ${o.rc.incSites} increment and ${o.rc.decSites} decrement sites; ${o.rc.argsBorrowed} arguments borrowed, ${o.rc.argsHeld} held; ${o.rc.localsBorrowed} locals borrowed, ${o.rc.localsCounted} counted; ${o.rc.overwriters} of ${o.rc.functions} functions can overwrite a counted slot`,
    );
    const cycles = o.cycles ?? [];
    if (cycles.length === 0) lines.push("cycles: no class here can form one");
    else {
      lines.push(
        `cycles: ${cycles.length} group${cycles.length === 1 ? "" : "s"} of classes can form one, and a cycle ${o.cycleCollector === true ? "is collected, with the collector on" : "leaks, with the collector off"}:`,
      );
      for (const c of cycles) {
        lines.push(
          `  ${c.classes.join(", ")}, allocated at: ${c.sites.join("; ") || "no site in this program"}`,
        );
      }
    }
  }
  if (o.math.length > 0) lines.push(`host Math functions used: ${o.math.join(", ")}`);
  if (o.opt !== undefined && o.opt.level > 0) lines.push(...optRemarks(o.opt));
  for (const d of o.fallbackDiags) {
    lines.push(
      `${d.code} ${d.file}:${d.line}:${d.col}: ${d.fn}: ${d.blocker}: ${d.detail}. Suggest: ${d.suggest}`,
    );
    if (d.blocked_callers.length > 0) lines.push(`  also blocks: ${d.blocked_callers.join(", ")}`);
  }
  for (const w of o.warnings)
    lines.push(`${w.code} ${w.file}:${w.line}:${w.col}: ${w.fn}: ${w.detail}`);
  return lines.join("\n");
}

async function cmdCoverage(): Promise<number> {
  const compiler = flagValue("--compiler") ?? ROOT;
  const r = await coverageRun({
    real: args.includes("--real"),
    compiler,
    budgetMs: Number(flagValue("--budget") ?? "120000"),
    jobs: jobsFlag(),
    label: flagValue("--label") ?? (compiler === ROOT ? "now" : "other"),
  });
  console.log(r.text);
  const t = r.rows.find((x) => x.name === "real projects, in total");
  if (t !== undefined) {
    const hidden = Object.entries(t.hidden)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(
      `unresolved imports: ${t.causes["unresolved-import"] ?? 0} fallbacks counted as unresolved-import, which would otherwise be ${hidden || "nothing"}; ${t.touchingUnresolved} functions touch one`,
    );
  }
  for (const f of r.failures) console.log(`FAILED ${f}`);
  return r.failures.length === 0 ? 0 : 1;
}

/** `tmk corpus-fetch`: the real projects in corpus/real/manifest.json, each at its pinned commit, into the cache. Nothing is run. */
async function cmdCorpusFetch(): Promise<number> {
  const C = await import("./coverage.ts");
  const m = C.manifest();
  const cache = C.cacheDir(m);
  mkdirSync(cache, { recursive: true });
  let bad = 0;
  for (const p of m.projects) {
    const dir = join(cache, p.dir);
    if (existsSync(join(dir, ".git"))) {
      const head = await guardedRun("git", ["-C", dir, "rev-parse", "HEAD"], {
        timeoutMs: 30_000,
        label: "git",
        cwd: ROOT,
      });
      if (head.stdout.trim() === p.commit) {
        console.log(`${p.dir}: at ${p.commit.slice(0, 12)}`);
        continue;
      }
    }
    mkdirSync(dir, { recursive: true });
    const steps: string[][] = [
      ["-C", dir, "init", "-q"],
      ["-C", dir, "fetch", "-q", "--depth", "1", p.url, p.commit],
      ["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"],
    ];
    for (const st of steps) {
      const r = await guardedRun("git", st, {
        timeoutMs: 600_000,
        label: `git ${st[2]}`,
        cwd: ROOT,
      });
      if (!r.ok) {
        console.log(`${p.dir}: ${r.why} ${r.stderr.slice(0, 200)}`);
        bad++;
        break;
      }
    }
    console.log(`${p.dir}: fetched ${p.commit.slice(0, 12)} (${p.license})`);
  }
  writeFileSync(
    join(cache, "manifest.jsonl"),
    m.projects.map((p) => JSON.stringify({ dir: p.dir, commit: p.commit })).join("\n") + "\n",
  );
  return bad === 0 ? 0 : 1;
}

async function cmdLower(): Promise<number> {
  const file = positional(1)[0];
  if (file === undefined) {
    console.error(
      "usage: tmk lower <file> [--memory leak|manual|rc] [--cycles on|off] [--target aarch64|macos-arm64] [--report] [--no-fallback] [--profile p.json] [--out base] [--emit tir|tsl] [--route auto|tsl|direct]",
    );
    return 2;
  }
  needInstall();
  const routeFlag = flagValue("--route");
  if (
    routeFlag !== undefined &&
    routeFlag !== "auto" &&
    routeFlag !== "tsl" &&
    routeFlag !== "direct"
  ) {
    console.error(`--route is auto, tsl or direct, not ${routeFlag}`);
    return 2;
  }
  const { lowerFile, fallbackModuleText } = timedModule("tslc", await import("./lowering.ts"));
  const { formatDiag } = await import("../compiler/host/diag.ts");
  optRemarks = (await import("../compiler/tir/passes/manager.ts")).remarksText;
  const profilePath = flagValue("--profile");
  const memory = flagValue("--memory");
  const cyclesFlag = flagValue("--cycles");
  if (cyclesFlag !== undefined && cyclesFlag !== "on" && cyclesFlag !== "off") {
    console.error(`--cycles is on or off, not ${cyclesFlag}`);
    return 2;
  }
  const opts = {
    ...(cyclesFlag !== undefined ? { cycles: cyclesFlag === "on" } : {}),
    ...(profilePath !== undefined
      ? { profile: JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, number> }
      : {}),
    ...(memory !== undefined ? { memory } : {}),
    // -O2 unless the line or the environment says otherwise (SPEC 9.3, D44).
    ...(process.env.TMK_OPT === undefined ? { opt: LOWER_DEFAULT_OPT } : {}),
    // The TSL route where it applies, the direct one elsewhere (SPEC 4.5, D62); --emit tsl needs the TSL route.
    ...(flagValue("--emit") === "tsl"
      ? { route: "tsl" as const }
      : routeFlag !== undefined
        ? { route: routeFlag as "auto" | "tsl" | "direct" }
        : {}),
  };
  // With no level in the environment the default is a choice the environment made: a gate job's trace notes it (D51).
  const trace = process.env.TMK_LEVEL_TRACE;
  if (process.env.TMK_OPT === undefined && trace !== undefined && trace !== "")
    appendFileSync(trace, `${process.pid} TMK_OPT=unset (tmk lower)\n`);
  const target = flagValue("--target");
  if (target !== undefined && target !== "aarch64" && target !== "macos-arm64") {
    console.error(
      `--target ${target}: tmk lower targets aarch64 or macos-arm64, or Wasm when it isn't given.`,
    );
    return 2;
  }
  let o: ReturnType<typeof lowerFile>;
  try {
    o = lowerFile(resolve(file), opts);
  } catch (e) {
    if (e instanceof Error && e.constructor.name === "EmitUnsupported") {
      console.error(`--emit tsl: the TSL route can't print this program yet: ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (o.diags.length > 0) {
    out({ ok: false, diags: o.diags }, o.diags.map(formatDiag).join("\n"));
    return 1;
  }
  const noFallback = args.includes("--no-fallback");
  const blocked = noFallback && o.fallbackDiags.length > 0;
  if (args.includes("--report") || blocked) {
    if (json) {
      out(
        {
          ok: !blocked,
          rows: o.rows,
          counts: o.counts,
          diags: o.fallbackDiags,
          warnings: o.warnings,
          allocs: o.allocs,
          tirhash: o.tirHash,
          rounds: o.rounds,
          math: o.math,
          ...(o.opt !== undefined ? { opt: o.opt } : {}),
          ...(o.rc !== undefined ? { rc: o.rc, cycles: o.cycles ?? [] } : {}),
        },
        "",
      );
    } else console.log(lowerTable(o));
  }
  if (blocked) {
    console.error(
      `--no-fallback: ${o.fallbackDiags.length} function(s) would stay JS, and there is no runtime for them.`,
    );
    return 1;
  }
  if (flagValue("--emit") === "tir") {
    process.stdout.write(o.tirText);
    return 0;
  }
  if (flagValue("--emit") === "tsl") {
    // The program as TSL (SPEC 4.5, D62): what tslc compiled, and where its package is.
    const out = flagValue("--out");
    // One TSL module per source module (D65): a directory with each, at its path relative to the package, and tsl.json.
    const mods = o.tsl!.modules ?? [{ path: o.tsl!.file.replace(/.*\//, ""), text: o.tsl!.text }];
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      for (const m of mods) {
        mkdirSync(dirname(join(out, m.path)), { recursive: true });
        writeFileSync(join(out, m.path), m.text);
      }
      // The package's directory: the root module's file, less its path in the package.
      const pkg = o.tsl!.file.slice(0, o.tsl!.file.length - mods[0]!.path.length);
      writeFileSync(join(out, "tsl.json"), readFileSync(join(pkg, "tsl.json")));
      out_(
        {
          ok: true,
          file: join(out, mods[0]!.path),
          modules: mods.map((m) => m.path),
          stats: o.tsl!.stats,
        },
        join(out, mods[0]!.path),
      );
    } else if (mods.length === 1) process.stdout.write(o.tsl!.text);
    else process.stdout.write(mods.map((m) => `// file: ${m.path}\n${m.text}`).join("\n"));
    return 0;
  }
  const base =
    flagValue("--out") ?? buildPath("lower", file.replace(/.*\//, "").replace(/\.ts$/, ""));
  mkdirSync(dirname(base), { recursive: true });
  if (o.wasm !== null) {
    writeFileSync(`${base}.wasm`, o.wasm);
    writeFileSync(`${base}.glue.mjs`, o.glue);
  }
  writeFileSync(`${base}.tir`, o.tirText);
  writeFileSync(`${base}.meta.json`, JSON.stringify(o.meta));
  let image: number | null = null;
  if (target === "aarch64") {
    // Links with no cases: a module, its runtime and a page source, and nothing else (SPEC 4.5).
    const { buildDownImage } = await import("./native-exec.ts");
    const built = buildDownImage(o.tir!, o.meta! as never, []);
    writeFileSync(`${base}.img`, built.image.bytes);
    image = built.image.bytes.length;
  }
  // macos-arm64 (D57): the executable at the base itself (tools/macho.ts).
  let macos: string | null = null;
  if (target === "macos-arm64") {
    const { linkLoweredForMacos } = await import("./macho.ts");
    const l = await linkLoweredForMacos(file, o.tir!, o.meta!, base);
    if (!l.ok) {
      console.error(l.message);
      return 1;
    }
    macos = `${base}: Mach-O arm64 executable, ad-hoc signed, ${l.cases} cases`;
  }
  if (o.meta!.fallbackFile !== null) {
    writeFileSync(
      join(dirname(base), o.meta!.fallbackFile),
      fallbackModuleText(resolve(file), o.meta!.fallbackNames),
    );
  }
  if (!args.includes("--report")) {
    out(
      { ok: true, wasm: `${base}.wasm`, tirhash: o.tirHash, counts: o.counts, image },
      `${o.wasm !== null ? `${base}.wasm ${o.wasm.length} bytes` : `${base}.tir, native only`}${image !== null ? `\n${base}.img ${image} bytes` : ""}${macos !== null ? `\n${macos}` : ""}\ntirhash ${o.tirHash}\nlowered ${o.counts.lowered}, fallback ${o.counts.fallback}`,
    );
  }
  return 0;
}

// --- corpus

function report(r: SuiteResult): void {
  if (json) return;
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.summary}`);
  const shown = args.includes("--all-failures") ? r.failures.length : 40;
  for (const f of r.failures.slice(0, shown)) console.log(`  ${f}`);
  if (r.failures.length > shown) console.log(`  ... and ${r.failures.length - shown} more`);
}

async function cmdCorpus(): Promise<number> {
  needInstall();
  const jobs = jobsFlag();
  const filter = flagValue("--filter");
  const engines = defaultEngines();
  const suites: SuiteResult[] = [];
  if (args.includes("--native")) {
    const { runNative } = timedModule("corpus", await import("./corpus.ts"));
    const a = flagValue("--accel") ?? "both";
    const accels: ("hvf" | "tcg")[] = a === "both" ? ["hvf", "tcg"] : [a as "hvf" | "tcg"];
    const memory = flagValue("--memory") as "leak" | "manual" | "rc" | undefined;
    const kinds: ("pos" | "trap" | "lower" | "mem" | "memory" | "std" | "rc")[] = args.includes(
      "--std",
    )
      ? ["std"]
      : args.includes("--rc")
        ? ["rc"]
        : args.includes("--modes")
          ? ["memory"]
          : args.includes("--mem")
            ? ["mem"]
            : args.includes("--lower")
              ? ["lower"]
              : args.includes("--trap")
                ? ["trap"]
                : args.includes("--all")
                  ? ["pos", "trap", "lower", "mem"]
                  : ["pos"];
    for (const k of kinds)
      suites.push(
        await runNative(k, accels, jobs, filter, engines, k === "lower" ? memory : undefined),
      );
  } else if (args.includes("--lower")) suites.push(await runLower(jobs, filter, engines));
  else if (args.includes("--neg")) suites.push(await runNegative(jobs, filter, engines));
  else if (args.includes("--trap")) suites.push(await runTrap(jobs, filter, engines));
  else {
    if (args.includes("--matrix") && !json) {
      console.log("--matrix: M1 has no optimisation passes, so -O0 and -O1 are one pipeline.");
    }
    suites.push(await runPositive(jobs, filter, engines));
  }
  for (const s of suites) report(s);
  if (json) out(suites, "");
  return suites.every((s) => s.ok) ? 0 : 1;
}

// --- benchmarks

/**
 * `tmk bench all`: every benchmark the milestones used to run inside their gates, at full counts, one at a time, at each
 * level they ran at (SPEC 8.4, D51). The milestones run a short one, which shows a benchmark still runs, and nothing more.
 */
async function cmdBenchAll(): Promise<number> {
  needInstall();
  const runs: { what: string; level: string }[] = [];
  for (const level of ["0", "2"])
    for (const what of ["jpeg", "native", "alloc", "memory", "strmap", "cow", "std", "maps"])
      runs.push({ what, level });
  runs.push({ what: "exc", level: "unset" });
  const rows: { what: string; level: string; ok: boolean; seconds: number; text: string }[] = [];
  for (const r of runs) {
    const env = { ...process.env };
    if (r.level === "unset") delete env.TMK_OPT;
    else env.TMK_OPT = r.level;
    const g = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        join(ROOT, "tools/tmk.ts"),
        "bench",
        r.what,
        ...(args.includes("--quick") ? ["--quick"] : []),
      ],
      { timeoutMs: 3_600_000, label: `bench ${r.what} -O${r.level}`, cwd: ROOT, env },
    );
    const row = { ...r, ok: g.ok, seconds: g.ms / 1000, text: g.stdout.trim() };
    rows.push(row);
    console.log(
      `${g.ok ? "PASS" : "FAIL"} ${row.seconds.toFixed(1).padStart(7)} s tmk bench ${r.what} ${r.level === "unset" ? "" : `-O${r.level}`}`,
    );
    if (!json) console.log(`     ${row.text.split("\n").join("\n     ")}`);
    if (!g.ok) console.log(`     ${g.why} ${g.stderr.slice(0, 600)}`);
  }
  mkdirSync(buildPath("bench"), { recursive: true });
  writeFileSync(
    buildPath("bench/all.json"),
    JSON.stringify({ at: new Date().toISOString(), rows }, null, 1),
  );
  return rows.every((r) => r.ok) ? 0 : 1;
}

async function cmdBench(): Promise<number> {
  const which = positional(1)[0];
  if (which === "all") return cmdBenchAll();
  if (which === "cow") {
    needInstall();
    const { benchCow } = timedModule("bench", await import("./bench-strmap.ts"));
    const r = await benchCow({ quick: args.includes("--quick") });
    out(r, JSON.stringify(r, null, 1));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "native") {
    needInstall();
    const { benchNative, nativeText } = timedModule("bench", await import("./bench-native.ts"));
    const r = await benchNative({ quick: args.includes("--quick") });
    out(r, nativeText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "alloc") {
    needInstall();
    const { benchAlloc, allocText } = timedModule("bench", await import("./bench-alloc.ts"));
    const r = await benchAlloc({ quick: args.includes("--quick") });
    out(r, allocText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "memory") {
    needInstall();
    const { benchMemory, memoryText } = timedModule("bench", await import("./bench-memory.ts"));
    const r = await benchMemory({
      quick: args.includes("--quick"),
      classes: args.includes("--classes"),
      strings: args.includes("--strings"),
      exceptions: args.includes("--exceptions"),
      maps: args.includes("--maps"),
      rcTsl: args.includes("--rc-tsl"),
      rc: args.includes("--rc"),
      boundary: args.includes("--boundary"),
      closures: args.includes("--closures"),
      typedArrays: args.includes("--typed-arrays"),
      strict: args.includes("--strict"),
      strictArrays: args.includes("--strict-arrays"),
      reshapes: args.includes("--reshapes"),
    });
    out(r, memoryText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "std") {
    needInstall();
    const { benchStd, stdText } = timedModule("bench", await import("./bench-std.ts"));
    const r = await benchStd({ quick: args.includes("--quick") });
    out(r, stdText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "maps") {
    needInstall();
    const { benchMaps, printMaps } = timedModule("bench", await import("./bench-maps.ts"));
    const r = await benchMaps({ quick: args.includes("--quick") });
    if (json) out(r, "");
    else printMaps(r);
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "strmap") {
    needInstall();
    const { benchStrmap, strmapText } = timedModule("bench", await import("./bench-strmap.ts"));
    const r = await benchStrmap({ quick: args.includes("--quick") });
    out(r, strmapText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which === "exc") {
    needInstall();
    const { benchExc, excText } = timedModule("bench", await import("./bench-exc.ts"));
    const r = await benchExc({ quick: args.includes("--quick") });
    out(r, excText(r));
    return r.errors.length > 0 ? 1 : 0;
  }
  if (which !== "jpeg") {
    console.error(
      "usage: tmk bench all|jpeg|native|alloc|memory|strmap|cow|std|exc [--quick] [--large-full]",
    );
    return 2;
  }
  needInstall();
  const { benchJpeg, benchText } = timedModule("bench", await import("./bench-jpeg.ts"));
  const r = await benchJpeg({
    quick: args.includes("--quick"),
    largeFull: args.includes("--large-full"),
  });
  out(r, benchText(r));
  return r.fail ? 1 : 0;
}

// --- the gate (SPEC 8.3, D51)

/** Jobs at once in the gate's pool: chosen by measurement, M5's test-speed record. */
const DEFAULT_PARALLEL = 4;

function parallelFlag(): number {
  const v = flagValue("--parallel");
  return v !== undefined ? Math.max(1, Number(v)) : DEFAULT_PARALLEL;
}

/** `--jobs`, as it always was, is how many each suite runs at once inside its job. */
function innerJobs(): { innerJobs?: number } {
  const v = flagValue("--jobs");
  return v !== undefined ? { innerJobs: Math.max(1, Number(v)) } : {};
}

function levelOfLine(): "unset" | "0" | "1" | "2" {
  const l = process.env.TMK_OPT;
  return l === "0" || l === "1" || l === "2" ? l : "unset";
}

/** One unit of a milestone, in this process: what `tmk gate` runs as a job. */
async function cmdJob(): Promise<number> {
  needInstall();
  const [m, unit] = positional(1);
  const outFile = flagValue("--out");
  if (m === undefined || unit === undefined || outFile === undefined) {
    console.error("usage: tmk job <milestone> <unit> --out file");
    return 2;
  }
  const { loadDef } = await import("./registry.ts");
  // Where a box's side files go (a bench's text, the optimiser's faults), as the milestones always made it.
  mkdirSync(buildPath("milestones"), { recursive: true });
  const def = await loadDef(m);
  const results = await def.run([unit]);
  writeJobRecord(outFile, def, results);
  return 0;
}

async function cmdGate(): Promise<number> {
  needInstall();
  const G = await import("./gate.ts");
  const sampleN = flagValue("--sample");
  if (sampleN !== undefined) {
    const file = flagValue("--manifest") ?? buildPath("gate/manifest.json");
    const seed = Number(flagValue("--seed") ?? Date.now() % 1_000_000);
    console.log(`sample of ${sampleN} jobs from ${file}, seed ${seed}`);
    const r = await G.sample(file, Number(sampleN), seed, parallelFlag());
    for (const x of r.problems) console.log(`MISMATCH ${x}`);
    for (const row of r.rows) {
      console.log(
        `${row.same ? "same" : "DIFFERS"} ${row.seconds.toFixed(1).padStart(7)} s ${row.key}`,
      );
      for (const d of row.differences.slice(0, 8)) console.log(`     ${d}`);
    }
    const ok = r.problems.length === 0 && r.rows.length > 0 && r.rows.every((x) => x.same);
    console.log(
      `${ok ? "PASS" : "FAIL"} tmk gate --sample ${sampleN}: ${r.rows.filter((x) => x.same).length}/${r.rows.length} the same as ${file}`,
    );
    return ok ? 0 : 1;
  }
  if (args.includes("--changed")) {
    const sel = await G.selectChanged(
      levelOfLine() === "unset" ? "unset" : levelOfLine(),
      flagValue("--since"),
    );
    printSelection(sel.selection);
    const r = await G.runGate({
      command: "gate --changed",
      tops: sel.tops,
      parallel: parallelFlag(),
      failFast: args.includes("--fail-fast"),
      quick: false,
      only: sel.only,
      selection: sel.selection,
      print: json ? "none" : "gate",
      ...innerJobs(),
    });
    return r.ok ? 0 : 1;
  }
  // A phase gate runs a rotating subset of the heavy sweeps; --full runs them all, as a milestone does (D51).
  const full = args.includes("--full");
  const sweepKey = flagValue("--rotation") ?? String(Math.floor(Date.now() / 86_400_000));
  const r = await G.runGate({
    command: full ? "gate --full" : "gate",
    ...(full ? {} : { sweepKey }),
    tops: await G.gateTops(),
    parallel: parallelFlag(),
    failFast: args.includes("--fail-fast"),
    quick: false,
    print: json ? "none" : "gate",
    ...innerJobs(),
  });
  if (r.ok) G.writeBaseline("tmk gate");
  return r.ok ? 0 : 1;
}

function printSelection(s: import("./gate.ts").Selection): void {
  console.log(
    `changed since ${s.baseline ?? "(no baseline)"}: ${s.changed.length} file${s.changed.length === 1 ? "" : "s"}${s.changed.length > 0 ? `: ${s.changed.slice(0, 12).join(", ")}${s.changed.length > 12 ? ", ..." : ""}` : ""}`,
  );
  if (s.uncovered.length > 0)
    console.log(`no quick step reads: ${s.uncovered.slice(0, 12).join(", ")}`);
  for (const x of s.picked) console.log(`  run ${x.key}: ${x.why}`);
}

/** `tmk test`: the quick tier, its steps in the gate's pool. `--changed` runs those a change can reach (D51). */
async function cmdTest(): Promise<number> {
  const G = await import("./gate.ts");
  const Q = await import("./quick.ts");
  const level = levelOfLine();
  const order = flagValue("--order");
  let only: Set<string> | undefined;
  let tops: import("./gate.ts").Instance[] = [{ milestone: "test", level }];
  let selection: import("./gate.ts").Selection | undefined;
  if (args.includes("--changed")) {
    const sel = await G.selectChanged(level, flagValue("--since"));
    printSelection(sel.selection);
    only = sel.only;
    tops = sel.tops;
    selection = sel.selection;
  }
  const r = await G.runGate({
    command: args.includes("--changed") ? "test --changed" : "test",
    tops,
    parallel: parallelFlag(),
    failFast: args.includes("--fail-fast"),
    quick: false,
    print: json ? "none" : only !== undefined ? "gate" : "test",
    ...(order !== undefined ? { order } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...innerJobs(),
  });
  const v = r.views.get(`test@${level}`);
  const ran = [...r.outcomes.values()].filter((j) => j.spec.milestone === "test");
  const rows = (v?.boxes ?? [])
    .filter((b) => ran.some((j) => j.spec.places.includes(b.place)))
    .map((b) => ({ name: b.box, ok: b.ok, seconds: b.seconds, detail: b.detail }));
  const seconds = [...r.outcomes.values()].reduce(
    (m, j) => Math.max(m, (j.ended - j.started) / 1000),
    0,
  );
  Q.writeTestJson({
    ok: r.ok,
    seconds,
    rows,
    failed: rows.filter((x) => !x.ok).map((x) => x.name),
  });
  if (!json) {
    console.log(`Left out of this tier: ${Q.LEFT_OUT.join("; ")}.`);
    console.log(
      `${r.ok ? "PASS" : "FAIL"} tmk test${only !== undefined ? " --changed" : ""} (${rows.filter((x) => x.ok).length}/${rows.length} steps${only !== undefined ? `, and ${r.outcomes.size - ran.length} gate jobs` : ""}). Not a verification: that's tmk clean, then a milestone.`,
    );
  }
  if (r.ok && only === undefined && !args.includes("--fail-fast")) G.writeBaseline("tmk test");
  return r.ok ? 0 : 1;
}

// `tmk profile <file> <fn>` (SPEC 9.3): where a native program's time (`--time`, HVF) or instructions (`--instructions`,
// TCG, exact) go, by function and by instruction. `--route tsl` compiles a TSL proper file; `--route direct` (the default)
// lowers ordinary TS, in `--memory` (rc) with `--cycles on|off`.
async function cmdProfile(): Promise<number> {
  needInstall();
  const [file, fn] = positional(1);
  if (file === undefined || fn === undefined) {
    console.error(
      "usage: tmk profile <file> <fn> [--time|--instructions] [--route direct|tsl|printed] [--memory rc] [--cycles on|off] [--n 20000] [--args a,b] [--calls k] [--warm k] [--samples k] [--top 30] [--focus regex] [--annotate regex] [--per ops]",
    );
    return 2;
  }
  const { profile, profileText } = await import("./profile.ts");
  const mode = args.includes("--instructions") ? "instructions" : "time";
  const num = (f: string, d: number): number => Number(flagValue(f) ?? d);
  const focus = flagValue("--focus");
  const per = num("--per", 1);
  const r = await profile({
    file,
    fn,
    route:
      flagValue("--route") === "tsl"
        ? "tsl"
        : flagValue("--route") === "printed"
          ? "printed"
          : "direct",
    memory: flagValue("--memory") ?? "rc",
    cycles: flagValue("--cycles") !== "off",
    n: num("--n", 20000),
    ...(flagValue("--args") !== undefined
      ? { args: flagValue("--args")!.split(",").map(Number) }
      : {}),
    calls: num("--calls", mode === "time" ? 20000 : 2),
    warm: num("--warm", mode === "time" ? 0 : 2),
    mode,
    samples: num("--samples", 5000),
    top: num("--top", 30),
    focus: focus !== undefined ? new RegExp(focus) : null,
    annotate: flagValue("--annotate") !== undefined ? new RegExp(flagValue("--annotate")!) : null,
    perOps: per,
  });
  out(r, profileText(r, per));
  return r.errors.length > 0 ? 1 : 0;
}

// --- dispatch

async function main(): Promise<number> {
  const cmd = positional(0)[0];
  switch (cmd) {
    case "doctor":
      return doctor();
    case "check":
      return cmdCheck();
    case "compile":
      return cmdCompile();
    case "tir":
      return cmdTir();
    case "corpus":
      return cmdCorpus();
    case "lower":
      return cmdLower();
    case "coverage":
      return cmdCoverage();
    case "corpus-fetch":
      return cmdCorpusFetch();
    case "bench":
      return cmdBench();
    case "profile":
      return cmdProfile();
    case "audit": {
      const { audit, auditText } = await import("./audit.ts");
      const a = audit();
      out(a, auditText(a));
      return a.modules.every((m) => m.listed) ? 0 : 1;
    }
    case "milestone": {
      const which = positional(1)[0];
      const { MILESTONES } = await import("./registry.ts");
      if (which === undefined || !MILESTONES.includes(which)) {
        console.error(
          `milestone ${which ?? "?"} doesn't exist yet: only ${MILESTONES.join(", ")}.`,
        );
        return 2;
      }
      needInstall();
      const { runGate } = await import("./gate.ts");
      const r = await runGate({
        command: `milestone ${which}`,
        tops: [{ milestone: which, level: levelOfLine() }],
        parallel: parallelFlag(),
        failFast: args.includes("--fail-fast"),
        quick: args.includes("--quick"),
        print: json ? "none" : "milestone",
        ...innerJobs(),
      });
      if (json) out({ ok: r.ok, manifest: r.manifestPath }, "");
      if (r.ok && !args.includes("--quick"))
        (await import("./gate.ts")).writeBaseline(`milestone ${which}`);
      return r.ok ? 0 : 1;
    }
    case "gate":
      return cmdGate();
    case "job":
      return cmdJob();
    case "verify-manifest": {
      const { verifyManifest } = await import("./gate.ts");
      const file = positional(1)[0] ?? buildPath("gate/manifest.json");
      const v = await verifyManifest(file);
      for (const n of v.notes) console.log(n);
      for (const x of v.problems) console.log(`MISMATCH ${x}`);
      console.log(
        v.problems.length === 0
          ? `MATCH ${file}: this tree, from tmk clean, every job the registry needs, all passing`
          : `NO MATCH ${file}: ${v.problems.length} problem${v.problems.length > 1 ? "s" : ""}`,
      );
      return v.problems.length === 0 ? 0 : 1;
    }
    case "baseline": {
      const { writeBaseline } = await import("./gate.ts");
      console.log(`baseline for --changed: ${writeBaseline("tmk baseline")}`);
      return 0;
    }
    case "test": {
      needInstall();
      const { catchRate } = await import("./quick.ts");
      if (args.includes("--catch-rate")) {
        return (await catchRate(jobsFlag(), flagValue("--only"))) ? 0 : 1;
      }
      return cmdTest();
    }
    case "ci": {
      needInstall();
      const engines = defaultEngines();
      const jobs = jobsFlag();
      const suites = [
        ...(await repoChecks()),
        await unitTests(),
        await runPositive(jobs, undefined, engines),
        await runNegative(jobs, undefined, engines),
        await runTrap(jobs, undefined, engines),
        await runLower(jobs, undefined, engines),
      ];
      for (const s of suites) report(s);
      if (json) out(suites, "");
      return suites.every((s) => s.ok) ? 0 : 1;
    }
    case "clean":
      rmSync(join(ROOT, "build"), { recursive: true, force: true });
      out({ ok: true }, "removed build/");
      return 0;
    default:
      console.error(
        "usage: tmk doctor|check|compile|tir|lower|bench [all]|corpus|audit|coverage|test [--changed] [--fail-fast] [--catch-rate]|gate [--changed] [--sample n]|verify-manifest [file]|baseline|milestone <name>|ci|clean [--json] [--parallel n]",
      );
      return 2;
  }
}

process.exit(await main());
