// R13's tests (SPEC M5's R13 record, D62, D66, pile item 7): arrays in `strict` lowered code, printed as @tsl/jsrt's arena
// array (`JsArenaArray`, its buffers only from the call arena the caller resets, D36), with typed arrays made in functions as
// R9's layout classes and tails, arrays of typed arrays, closure values and exports taking or giving objects, each placed by
// tslc in the call arena; module state is what `__init` makes before it commits the arena, and a program that could put
// something made later where module state reaches is refused. The JPEG decoder prints so, and through the TSL route agrees
// with V8 natively and as Wasm on V8 and JSC; each bug put in is caught.
//
//   node tools/r13-tests.ts [--accel hvf|tcg] [--faults] [--jpeg-native]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { defaultEngines, ROOT, wrongAnswers, type Engines } from "./corpus.ts";
import { buildPath } from "./build-dir.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import type { Accel } from "./qemu-run.ts";

/** The program that shows R13's printing: growth, holes, arrays of objects, of arrays and of typed arrays, module state. */
export const R13_PROGRAMS = ["corpus/lower/pipe/strict_arrays.ts"];

/** The programs R13's bugs are looked for in: R13's own, and the corpus's with arrays that print in `strict`. */
const FAULT_PROGRAMS = [
  ...R13_PROGRAMS,
  "corpus/lower/pos/array_vec.ts",
  "corpus/lower/pos/array_methods.ts",
  "corpus/lower/pos/typed_array.ts",
  "bench/memory/vec_lowered.ts",
];

/**
 * The dual route in `strict` with class printing forced, at -O0 and -O2, over `files` (each a path relative to the repo):
 * every case agrees with the direct route natively, and the printed TSL on V8 and JSC with the source (the third route).
 */
export async function strictArraysDual(
  accels: Accel[],
  jobs: number,
  files: string[],
  fault?: string,
): Promise<{ failures: string[]; printed: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["strict"],
    levels: [0, 2],
    accels,
    jobs,
    classes: true,
    ...(fault !== undefined ? { fault } : {}),
    dirs: [...new Set(files.map((f) => dirname(f)))],
    filter: (f) => files.includes(relative(ROOT, f)),
  });
  return {
    failures: r.failures,
    printed: [...new Set(r.programs.filter((p) => p.handled).map((p) => p.file))].sort(),
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
  };
}

/** What the JPEG decoder through the TSL route gave natively: fixtures and cases agreeing with V8, and corrupt inputs. */
export interface JpegNative {
  accel: string;
  skipped: boolean;
  cases: number;
  agreed: number;
  pinned: number;
  corrupt: { total: number; matched: number; trapped: number; mismatched: number; crashed: number };
  restructured: number;
  failures: string[];
}

/**
 * The JPEG decoder through the TSL route with classes forced, in a process of its own (the decoder's build is cached per
 * process): every fixture and maxEdge case natively against V8's decode, its six pins, and the 200 corrupt inputs (each
 * matches V8 or traps, none crashes).
 */
export async function jpegNative(accel: Accel): Promise<JpegNative> {
  const r = await guardedRun(
    process.execPath,
    [join(ROOT, "tools/r13-tests.ts"), "--jpeg-native", "--accel", accel],
    {
      timeoutMs: 1_200_000,
      label: "the JPEG decoder through the TSL route, natively",
      cwd: ROOT,
      env: { ...process.env, TMK_ROUTE: "tsl", TMK_EMIT_CLASSES: "1" },
    },
  );
  if (!r.ok) throw new Error(`the JPEG decoder natively: ${r.why} ${r.stderr.slice(0, 1500)}`);
  const at = r.stdout.lastIndexOf("@@R13@@");
  return JSON.parse(r.stdout.slice(at + 7)) as JpegNative;
}

async function jpegNativeChild(accel: Accel): Promise<JpegNative> {
  const J = await import("./native-jpeg.ts");
  const { lowerFile } = await import("./lowering.ts");
  const { VENDOR } = await import("./bench-jpeg.ts");
  // the build the check runs, through the TSL route (TMK_ROUTE and TMK_EMIT_CLASSES, set by the parent)
  const o = lowerFile(VENDOR);
  const refs = await J.referenceHashes();
  const c = await J.checkNative(accel, refs, accel === "tcg" ? 500_000 : 200_000);
  const k = await J.corruptNative(accel);
  return {
    accel,
    skipped: c.run.skipped,
    cases: c.cases,
    agreed: c.agreed,
    pinned: c.pinned,
    corrupt: {
      total: k.total,
      matched: k.matched,
      trapped: k.trapped,
      mismatched: k.mismatched.length,
      crashed: k.crashed.length,
    },
    restructured: o.tsl?.stats.restructured ?? -1,
    failures: [...c.failures, ...k.mismatched, ...k.crashed],
  };
}

/**
 * The JPEG decoder through the TSL route with classes forced, as Wasm, at -O0 and -O2: every fixture on V8 and JSC gives
 * byte-identical RGBA to the source on the same engine (bench/jpeg/correct.ts, M2's check), and the six pinned hashes.
 */
export async function jpegWasm(
  engines: Engines = defaultEngines(),
): Promise<{ failures: string[]; fixtures: number; checks: number }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { FIXTURES, PINNED, VENDOR } = await import("./bench-jpeg.ts");
  const failures: string[] = [];
  let fixtures = 0;
  let checks = 0;
  for (const level of [0, 2] as const) {
    const o = lowerFile(VENDOR, { route: "tsl", classes: true, opt: level });
    if (o.wasm === null) {
      failures.push(`-O${level}: no Wasm: ${JSON.stringify(o.diags).slice(0, 300)}`);
      continue;
    }
    const dir = buildPath(`r13-jpeg/O${level}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jpeg.wasm"), o.wasm);
    writeFileSync(join(dir, "jpeg.glue.mjs"), o.glue);
    const job = JSON.stringify({
      source: VENDOR,
      glue: join(dir, "jpeg.glue.mjs"),
      wasm: join(dir, "jpeg.wasm"),
      dirs: [FIXTURES],
    });
    const correct = join(ROOT, "bench/jpeg/correct.ts");
    const runs = await pool(
      [
        {
          name: "V8",
          cmd: engines.node,
          cargs: ["--import", join(ROOT, "tools/ts-hook.mjs"), "--no-warnings", correct, job],
        },
        { name: "JSC", cmd: engines.bun, cargs: [correct, job] },
      ],
      2,
      async (x) => ({
        name: x.name,
        run: await guardedRun(x.cmd, x.cargs, {
          timeoutMs: 300_000,
          label: `the JPEG decoder's Wasm -O${level} on ${x.name}`,
          cwd: ROOT,
        }),
      }),
    );
    for (const { name, run } of runs) {
      if (!run.ok) {
        failures.push(`-O${level} on ${name}: ${run.why} ${run.stderr.slice(0, 600)}`);
        continue;
      }
      const results = JSON.parse(run.stdout) as {
        fixture: string;
        rgba: string;
        checks: string[];
        fails: string[];
      }[];
      fixtures = Math.max(fixtures, results.length);
      for (const x of results) {
        checks += x.checks.length;
        for (const f of x.fails) failures.push(`-O${level} ${x.fixture} on ${name}: ${f}`);
        const pin = PINNED[x.fixture];
        if (pin !== undefined && x.rgba !== pin)
          failures.push(`-O${level} ${x.fixture} on ${name}: RGBA ${x.rgba}, M2 pins ${pin}`);
      }
    }
  }
  return { failures, fixtures, checks };
}

/**
 * Hand-written lowered `strict` packages that tslc must refuse (TSL3001), each an array that could outlive the export call
 * in the call arena, and one it must take: what only `__init` puts in module state. The lowering never prints the first
 * kind (its own analysis keeps such a program on the direct route), so tslc's check is the second line, and this is its test.
 */
export const KEPT_CASES: { name: string; refuse: boolean; body: string }[] = [
  {
    name: "set-after-init",
    refuse: true,
    body: `let kept: JsArenaArray<f64> | null = null;
export function __init(): void {
  rt<void>("__arena_start");
  rt<void>("__arena_commit");
}
export function keep(n: f64): f64 {
  const a = new JsArenaArray(f64, 0);
  a.push(n);
  kept = a;
  return 1;
}
export function read(): f64 {
  const k = kept;
  return k !== null ? k.get(0) : -1;
}`,
  },
  {
    name: "grown-after-init",
    refuse: true,
    body: `let kept: JsArenaArray<f64> | null = null;
export function __init(): void {
  rt<void>("__arena_start");
  kept = new JsArenaArray(f64, 0);
  rt<void>("__arena_commit");
}
export function add(n: f64): f64 {
  const k = kept;
  if (k === null) return -1;
  k.push(n);
  return toF64(k.length);
}`,
  },
  {
    name: "element-after-init",
    refuse: true,
    body: `class Cell {
  v: f64 = 0;
}
let kept: JsArenaArray<Cell | null> | null = null;
export function __init(): void {
  rt<void>("__arena_start");
  const a = new JsArenaArray(ref<Cell | null>(), 4);
  kept = a;
  rt<void>("__arena_commit");
}
export function put(n: f64): f64 {
  const k = kept;
  if (k === null) return -1;
  const c = new Cell();
  c.v = n;
  k.set(0, c);
  return n;
}`,
  },
  {
    name: "made-in-init",
    refuse: false,
    body: `let kept: JsArenaArray<f64> | null = null;
export function __init(): void {
  rt<void>("__arena_start");
  const a = new JsArenaArray(f64, 0);
  a.push(1.5);
  a.push(2.5);
  kept = a;
  rt<void>("__arena_commit");
}
export function read(i: f64): f64 {
  const k = kept;
  const local = new JsArenaArray(f64, 0);
  local.push(i);
  return k !== null ? k.get(0) + local.get(0) : -1;
}`,
  },
];

/** Each KEPT_CASES package checked by tslc: whether it refused it, and with what. */
export async function keptRefused(): Promise<{ failures: string[]; rows: string[] }> {
  const { checkFile } = await import("../compiler/host/tslc.ts");
  const failures: string[] = [];
  const rows: string[] = [];
  const base = buildPath("r13-kept");
  rmSync(base, { recursive: true, force: true });
  for (const c of KEPT_CASES) {
    const dir = join(base, c.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsl.json"), `${JSON.stringify({ lowered: { memory: "strict" } })}\n`);
    const header = [
      `import { f64, toF64 } from "@tsl/core";`,
      `import { JsArenaArray, ref } from "@tsl/jsrt/arena";`,
      `import { rt } from "@tsl/lowered";`,
      "",
    ];
    writeFileSync(join(dir, "main.ts"), `${[...header, c.body].join("\n")}\n`);
    const r = checkFile(join(dir, "main.ts"));
    const codes = r.diags.map((d) => d.code);
    const refused = codes.includes("TSL3001");
    const other = r.diags.filter((d) => d.code !== "TSL3001");
    rows.push(`${c.name}: ${refused ? "refused" : "taken"}`);
    if (other.length > 0)
      failures.push(
        `${c.name}: ${other.map((d) => `${d.code} ${d.line}:${d.col} ${d.msg}`).join("; ")}`,
      );
    else if (refused !== c.refuse)
      failures.push(
        `${c.name}: tslc ${refused ? "refused" : "took"} it, where it ${c.refuse ? "must refuse" : "must take"} it`,
      );
  }
  return { failures, rows };
}

/** The bugs put into R13's printing, placing and library, each to be caught, and by what. */
export const R13_FAULTS: {
  name: string;
  what: string;
  env: string;
  by: "dual" | "kept";
  printer?: true;
}[] = [
  {
    name: "arena-short",
    what: "an arena array made one element shorter than asked for",
    env: "arena-short",
    by: "dual",
    printer: true,
  },
  {
    name: "arena-grow-short",
    what: "growth given half the bytes it asked of the call arena, so elements past half its room overlap what comes next",
    env: "arena-grow-short",
    by: "dual",
  },
  {
    name: "arena-elem-size",
    what: "the arena array's element size taken as half what it is",
    env: "arena-elem-size",
    by: "dual",
  },
  {
    name: "arr-elem-len",
    what: "a typed array an array holds kept one element shorter than it is",
    env: "arr-elem-len",
    by: "dual",
    printer: true,
  },
  {
    name: "arena-state-unchecked",
    what: "an array made after __init left in the call arena where module state reaches it, not refused",
    env: "arena-state-unchecked",
    by: "kept",
  },
];

/** One of R13's bugs: how many cases (or packages) caught it, by a wrong answer, and in all. */
export async function r13FaultRun(
  f: (typeof R13_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  let failures: string[];
  if (f.printer === true)
    // a bug in the printer, which the dual route puts in each TSL route's build itself (TMK_TEST_EMIT)
    failures = (await strictArraysDual([accel], jobs, FAULT_PROGRAMS, f.env)).failures;
  else {
    const was = process.env.TMK_TEST_TSL;
    process.env.TMK_TEST_TSL = f.env;
    try {
      // the injected bug is in tslc, which the compile workers take with the environment (jobEnv)
      failures =
        f.by === "kept"
          ? (await keptRefused()).failures
          : (await strictArraysDual([accel], jobs, FAULT_PROGRAMS)).failures;
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
  if (process.argv.includes("--jpeg-native")) {
    const r = await jpegNativeChild(accel);
    process.stdout.write(`\n@@R13@@${JSON.stringify(r)}\n`);
  } else if (process.argv.includes("--faults")) {
    for (const f of R13_FAULTS) {
      const r = await r13FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  } else {
    const k = await keptRefused();
    console.log(`kept: ${k.rows.join(", ")}`);
    for (const x of k.failures) console.log(`  FAIL ${x}`);
    const d = await strictArraysDual([accel], jobs, FAULT_PROGRAMS);
    console.log(`dual: ${d.agreed}/${d.cases}; printed ${d.printed.join(", ")}`);
    for (const x of d.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
    const w = await jpegWasm();
    console.log(`jpeg wasm: ${w.fixtures} fixtures, ${w.checks} checks`);
    for (const x of w.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
    const n = await jpegNative(accel);
    console.log(`jpeg native: ${JSON.stringify(n)}`);
  }
  process.exit(0);
}
