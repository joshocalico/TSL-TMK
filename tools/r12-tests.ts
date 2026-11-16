// R12's tests (SPEC M5's R12 record, D62, pile item 7): objects printed as TSL classes in `strict`. What escapes its function
// goes in the call arena the direct route uses, placed there by tslc and reset by the caller (D36); what doesn't stays on
// the stack; nothing else of phase 2 prints in `strict` (no JsArray, JsString, JsMap, environment class or Dyn, which are
// runtimes `strict` code doesn't have). Every program class printing takes in `strict` agrees with the direct route through
// the dual route natively, runs on V8 as printed (the third route, D71), and as Wasm on V8 and JSC agrees with the source,
// as every `strict` build is Wasm too; and each bug put in is caught.
//
//   node tools/r12-tests.ts [--accel hvf|tcg] [--faults]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  defaultEngines,
  listPrograms,
  lowerCommand,
  ROOT,
  wrongAnswers,
  type Engines,
} from "./corpus.ts";
import { buildPath } from "./build-dir.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import type { Accel } from "./qemu-run.ts";

/** The programs that show R12's placing: helpers' results in the call arena, objects held by others, and the stack. */
export const R12_PROGRAMS = [
  "corpus/lower/pipe/strict_objects.ts",
  "bench/memory/strict_lowered.ts",
];

/** The differential's directories, as R5 counts them, and R12's benchmark. */
function strictFiles(): string[] {
  const dirs = [
    "corpus/lower/pos",
    "corpus/native",
    "corpus/lower/fallback",
    "corpus/lower/memory",
    "corpus/lower/rc",
    "corpus/lower/exc",
    "corpus/lower/maps",
    "corpus/lower/strmap",
    "corpus/lower/rc-only",
    "corpus/lower/pipe",
  ];
  return [
    ...dirs.flatMap((d) => listPrograms(join(ROOT, d))),
    join(ROOT, "bench/memory/strict_lowered.ts"),
  ].filter((f) => !f.endsWith(".cases.ts") && !/\/gen_/.test(f));
}

/**
 * The dual route in `strict` with class printing forced, at -O0 and -O2, every program the direct route builds with no
 * fallback: those the printing takes agree with the direct route on every case, and run on V8 as printed.
 */
export async function strictDual(
  accels: Accel[],
  jobs: number,
  fault?: string,
): Promise<{
  failures: string[];
  printed: string[];
  refused: Record<string, number>;
  cases: number;
  agreed: number;
  printedCases: number;
  printedSame: number;
}> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["strict"],
    levels: [0, 2],
    accels,
    jobs,
    classes: true,
    ...(fault !== undefined ? { fault } : {}),
    dirs: [...P.PIPE_DIRS, "bench/memory"],
    filter: (f) => strictFiles().includes(f),
  });
  const printed = [...new Set(r.programs.filter((p) => p.handled).map((p) => p.file))].sort();
  const refused: Record<string, number> = {};
  for (const p of r.programs) {
    if (p.handled || p.why === undefined || !p.why.startsWith("not printable yet")) continue;
    const k = p.why
      .replace(/^not printable yet: /, "")
      .replace(/ \(.*$/, "")
      .slice(0, 90);
    refused[k] = (refused[k] ?? 0) + 1;
  }
  return {
    failures: r.failures,
    printed,
    refused,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    printedCases: r.printed.cases,
    printedSame: r.printed.same,
  };
}

/**
 * Each program class printing takes in `strict`, built through the TSL route with classes forced, as Wasm, run on V8 and
 * JSC against the source on V8 (R12: a `strict` build is Wasm too, and a class's reference is the backend's i64).
 */
export async function strictWasm(
  jobs: number,
  engines: Engines = defaultEngines(),
  fault?: string,
): Promise<{ failures: string[]; programs: string[]; cases: number }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const outDir = buildPath("r12-wasm");
  mkdirSync(outDir, { recursive: true });
  const programs: string[] = [];
  const failures: string[] = [];
  const builds: { file: string; level: 0 | 2; dir: string }[] = [];
  const was = process.env.TMK_TEST_TSL;
  if (fault !== undefined) process.env.TMK_TEST_TSL = fault;
  try {
    for (const file of strictFiles()) {
      if (!readFileSyncSafe(file.replace(/\.ts$/, ".cases.json"))) continue;
      const a = lowerFile(file, { memory: "strict", opt: 2, route: "direct" });
      if (a.diags.length > 0 || a.tir === null || a.fallbackDiags.length > 0) continue;
      for (const level of [0, 2] as const) {
        let o: ReturnType<typeof lowerFile>;
        try {
          o = lowerFile(file, { memory: "strict", opt: level, route: "tsl", classes: true });
        } catch (e) {
          if (e instanceof Error && e.constructor.name === "EmitUnsupported") continue;
          failures.push(
            `${relative(ROOT, file)} -O${level}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
          );
          continue;
        }
        // Only what prints a class: the rest is phase 1's printing, which the corpus's own Wasm runs cover. R13: or the
        // arena array, which is a class of @tsl/jsrt's.
        const texts = o.tsl?.modules?.map((m) => m.text) ?? [o.tsl?.text ?? ""];
        if (
          !texts.some((t) => /^(export )?class /m.test(t) || /\bJsArenaArray\b/.test(t)) ||
          o.wasm === null
        )
          continue;
        const dir = join(outDir, `O${level}`);
        mkdirSync(dir, { recursive: true });
        const base = join(dir, basename(file, ".ts"));
        writeFileSync(`${base}.wasm`, o.wasm);
        writeFileSync(`${base}.glue.mjs`, o.glue);
        builds.push({ file, level, dir });
        if (!programs.includes(relative(ROOT, file))) programs.push(relative(ROOT, file));
      }
    }
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = was;
  }
  let cases = 0;
  const refs = new Map<string, { result: unknown; args: unknown }[] | null>();
  await pool([...new Set(builds.map((b) => b.file))], jobs, async (file) => {
    const { cmd, args } = lowerCommand("source-v8", file, outDir, engines);
    const r = await guardedRun(cmd, args, {
      timeoutMs: 30_000,
      label: `${basename(file)} on V8`,
      cwd: ROOT,
    });
    if (!r.ok) failures.push(`${relative(ROOT, file)}: the source on V8 failed: ${r.why}`);
    refs.set(file, r.ok ? (JSON.parse(r.stdout) as { result: unknown; args: unknown }[]) : null);
  });
  const tasks = builds.flatMap((b) => (["wasm-v8", "wasm-jsc"] as const).map((c) => ({ ...b, c })));
  await pool(tasks, jobs, async ({ file, level, dir, c }) => {
    const ref = refs.get(file);
    if (ref === null || ref === undefined) return;
    const { cmd, args } = lowerCommand(c, file, dir, engines);
    const r = await guardedRun(cmd, args, {
      timeoutMs: 30_000,
      label: `${basename(file)} -O${level} on ${c}`,
      cwd: ROOT,
    });
    const where = `${relative(ROOT, file)} -O${level} on ${c}`;
    if (!r.ok) {
      failures.push(`${where}: ${r.why} ${r.stderr.slice(0, 300)}`);
      return;
    }
    const got = JSON.parse(r.stdout) as { fn: string; result: unknown; args: unknown }[];
    cases += got.length;
    // R13: a case that declares where lowered code traps and JS doesn't (`lowered_trap`, 3.10 divergence 1) must trap
    // with that code, as the corpus's own Wasm runs check it (corpus.ts)
    const specs = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as {
      lowered_trap?: number;
    }[];
    got.forEach((x, i) => {
      const want = specs[i]?.lowered_trap;
      if (want !== undefined) {
        const t = (x.result as { trap?: number }).trap;
        if (t !== want)
          failures.push(
            `${where}: ${x.fn}#${i}: expected trap ${want}, got ${JSON.stringify(x.result)}`,
          );
        return;
      }
      const a = JSON.stringify({ result: x.result, args: x.args });
      const b = JSON.stringify({ result: ref[i]?.result, args: ref[i]?.args });
      if (a !== b) failures.push(`${where}: ${x.fn}#${i}: ${a}, V8 gave ${b}`);
    });
  });
  return { failures, programs: programs.sort(), cases };
}

function readFileSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The bugs put into R12's printing and placing, each to be caught. */
export const R12_FAULTS: { name: string; what: string; env: string; by: "dual" | "wasm" }[] = [
  {
    name: "strict-stack-escape",
    what: "an object that escapes its function in strict left on its stack, not put in the call arena",
    env: "strict-stack-escape",
    by: "dual",
  },
  {
    name: "region-short",
    what: "an object in the call arena given 8 bytes fewer than it takes, so the next one overlaps it",
    env: "region-short",
    by: "dual",
  },
  {
    name: "wasm-ref-shifted",
    what: "a reference's pointer taken from the wrong bits in Wasm (the high half of its low 48)",
    env: "wasm-ref-shifted",
    by: "wasm",
  },
];

/** One of R12's bugs: how many cases caught it, by a wrong answer, and in all. */
export async function r12FaultRun(
  f: (typeof R12_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  let failures: string[];
  if (f.by === "wasm") failures = (await strictWasm(jobs, defaultEngines(), f.env)).failures;
  else {
    const was = process.env.TMK_TEST_TSL;
    process.env.TMK_TEST_TSL = f.env;
    try {
      // the injected bug is in tslc and the backend, which the compile workers take with TMK_TEST_TSL (jobEnv)
      failures = (await strictDual([accel], jobs)).failures;
    } finally {
      if (was === undefined) delete process.env.TMK_TEST_TSL;
      else process.env.TMK_TEST_TSL = was;
    }
  }
  return {
    caught: failures.length,
    answers: wrongAnswers(failures),
    first: (failures[0] ?? "").slice(0, 200),
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const jobs = Number(flag("--jobs") ?? "4");
  if (process.argv.includes("--faults")) {
    for (const f of R12_FAULTS) {
      const r = await r12FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  } else {
    const d = await strictDual([accel], jobs);
    console.log(
      `dual: ${d.agreed}/${d.cases} cases; printed ${d.printed.length}: ${d.printed.join(", ")}; third route ${d.printedSame}/${d.printedCases}; refused ${JSON.stringify(d.refused)}`,
    );
    for (const x of d.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
    const w = await strictWasm(jobs);
    console.log(
      `wasm: ${w.cases} cases in ${w.programs.length} programs: ${w.programs.join(", ")}`,
    );
    for (const x of w.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
  }
  process.exit(0);
}
