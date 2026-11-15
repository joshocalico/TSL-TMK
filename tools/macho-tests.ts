// The macos-arm64 target's tests (D57): corpus programs built as native macOS executables (hosted.ts's Mach-O object, the
// system linker), run directly on this Mac with a timeout, and their output read back by the same parsers the QEMU route
// uses (native-exec.ts's tslResults and downResults), then held to what the corpus holds the QEMU route to: the pinned
// results and trap codes in each .cases.json, and V8 running the source. Also the fault paths, on small TIR programs: R7's
// null-check table, a non-null reference that faults, the stack guard, and a trap outside any case, with exit statuses.
// No QEMU runs here, and nothing in the bare-metal build is touched (tools/macho-bare-check.ts checks that).
//
//   node tools/macho-tests.ts [--only faults,pos,trap,mem,std,rc,lower,abi] [--memory leak,manual,rc] [--filter name]
//                             [--jobs n] [--keep] [--all]
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { buildHostedObject, type HostedOutput } from "../compiler/backend-aarch64/hosted.ts";
import type { ImageInput } from "../compiler/backend-aarch64/image.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { canonicalize, type Func, type Module } from "../compiler/tir/ir.ts";
import { optFromEnv, optimizeModule } from "../compiler/tir/passes/manager.ts";
import { parseModule, printModule } from "../compiler/tir/text.ts";
import { casesFor, linkObject, pagesOf, stackOf } from "./macho.ts";
import { Driver } from "./native-driver.ts";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = new Set((flag("--only") ?? "faults,pos,trap,mem,std,rc,lower,abi").split(","));
const filter = flag("--filter");
const JOBS = Math.max(1, Number(flag("--jobs") ?? 4));
const RUN_TIMEOUT_MS = 30_000;
const OUT = join(ROOT, "build/macho-tests");
mkdirSync(OUT, { recursive: true });

// --- running

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  overflow: boolean; // more output than the RAM channel would have held
  ms: number;
}

/**
 * Runs a command with a timeout; on timeout it kills only the child it started, by PID. Its output goes to a file, not a
 * pipe: this process compiles in between, and a pipe it isn't draining would stall a program with a lot to say.
 */
let runs = 0;
function run(
  cmd: string,
  args: string[],
  timeoutMs = RUN_TIMEOUT_MS,
  encoding: "latin1" | "utf8" = "latin1",
): Promise<Run> {
  return new Promise((done) => {
    const t0 = Date.now();
    const outPath = join(OUT, `run-${process.pid}-${runs++}.out`);
    const fd = openSync(outPath, "w");
    const child = spawn(cmd, args, { stdio: ["ignore", fd, "pipe"] });
    closeSync(fd);
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 1 << 20) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }, timeoutMs);
    // As much as the QEMU route's RAM channel holds (native-exec.ts's BULK_BYTES); past that it's a failure of its own.
    // A program's output is serial bytes, as the QEMU route reads them; a V8 reference's is UTF-8 JSON.
    const finish = (status: number | null, signal: string | null, err?: string): void => {
      clearTimeout(timer);
      const size = statSync(outPath).size;
      const overflow = size > 512 << 20;
      const stdout = overflow ? "" : readFileSync(outPath).toString(encoding);
      rmSync(outPath, { force: true });
      done({
        stdout,
        stderr: err ?? stderr,
        status,
        signal,
        timedOut,
        overflow,
        ms: Date.now() - t0,
      });
    };
    child.on("close", (status, signal) => finish(status, signal));
    child.on("error", (e) => finish(null, null, String(e)));
  });
}

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await f(items[next++]!);
    }),
  );
}

/** Each executable built, with the byte ranges of its text that are instructions (not constant pools). */
const builtExes: { path: string; ranges: { from: number; to: number }[] }[] = [];

/** Builds and links an executable named `name`; a string is why it couldn't be. */
function executable(
  name: string,
  link: () => HostedOutput,
): { path: string; img: HostedOutput } | string {
  let img: HostedOutput;
  try {
    img = link();
  } catch (e) {
    return `build: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
  const path = join(OUT, name);
  writeFileSync(`${path}.o`, img.bytes);
  const l = linkObject(`${path}.o`, path);
  if (!l.ok) return `link: ${l.message.slice(0, 300)}`;
  if (!argv.includes("--keep")) rmSync(`${path}.o`);
  builtExes.push({ path, ranges: img.ranges });
  return { path, img };
}

// --- results

interface Row {
  category: string;
  name: string;
  cases: number;
  agreed: number;
  cause: string | null; // null: passed
  detail: string;
}
const rows: Row[] = [];
const linesOf = (s: string): string[] => s.split("\n").map((l) => l.replace(/\r$/, ""));

/** Why a corpus program's run went wrong as a whole, if it did. */
function runCause(r: Run): string | null {
  if (r.timedOut) return "timeout";
  if (r.overflow) return "output over 512 MiB";
  if (r.signal !== null) return `killed by ${r.signal}`;
  const lines = linesOf(r.stdout);
  if (lines.some((l) => l.startsWith("TMK:FATAL"))) return "fatal report";
  if (lines.some((l) => l.startsWith("TMK:PANIC"))) return "panic outside a case";
  if (!lines.includes("TMK:DONE")) return "no TMK:DONE";
  if (r.status !== 0) return `exit status ${r.status}`;
  return null;
}

// --- V8 references, as the corpus computes them

const HOOK = join(ROOT, "tools/ts-hook.mjs");
async function v8Reference(
  file: string,
  metaPath: string | null,
  lowered: boolean,
  cycles?: Record<string, number>,
  program = file, // `rc` (D74): the expansion onto @tsl/gc, as the corpus's reference is
): Promise<unknown[] | string> {
  const cases = file.replace(/\.ts$/, ".cases.json");
  const job = lowered
    ? { mode: "source", program: file, cases }
    : {
        mode: "source",
        program,
        cases,
        meta: metaPath,
        ...(cycles !== undefined ? { cycles } : {}),
      };
  const exec = join(ROOT, lowered ? "tools/lower-exec.ts" : "tools/corpus-exec.ts");
  const r = await run(
    process.execPath,
    ["--import", HOOK, "--no-warnings", exec, JSON.stringify(job)],
    120_000,
    "utf8",
  );
  if (r.status !== 0) return `V8 reference failed: ${r.stderr.slice(0, 200)}`;
  return JSON.parse(r.stdout) as unknown[];
}

// --- TSL proper: corpus/pos, trap, mem, std

function listCorpus(dir: string): string[] {
  const d = join(ROOT, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".ts") && existsSync(join(d, f.replace(/\.ts$/, ".cases.json"))))
    .filter((f) => filter === undefined || f.includes(filter))
    .sort()
    .map((f) => join(d, f));
}

const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
const { buildTslImage, tslResults, buildDownImage, downResults } = await import("./native-exec.ts");
const { hostCycles, writeRcExpanded } = await import("./corpus.ts");

async function tslCategory(kind: "pos" | "trap" | "mem" | "std" | "rc"): Promise<void> {
  // As the corpus's native route: `mem` takes corpus/spec's programs too.
  const files = [
    ...listCorpus(`corpus/${kind}`),
    ...(kind === "mem" ? listCorpus("corpus/spec") : []),
  ];
  const levels: (0 | 2)[] = [0, 2];
  const jobs: { file: string; level: 0 | 2 }[] = files.flatMap((file) =>
    levels.map((level) => ({ file, level })),
  );
  const refs = new Map<string, Promise<unknown[] | string>>();
  await pool(jobs, JOBS, async ({ file, level }) => {
    const name = `${kind}/${basename(file, ".ts")} -O${level}`;
    const push = (r: Omit<Row, "category" | "name">): void => {
      rows.push({ category: kind, name, ...r });
    };
    let o: ReturnType<typeof compileTyped>;
    try {
      const { typed, diags } = checkFile(file);
      if (typed === null)
        return push({
          cases: 0,
          agreed: 0,
          cause: "compile diagnostics",
          detail: JSON.stringify(diags).slice(0, 200),
        });
      o = compileTyped(typed, { opt: level });
    } catch (e) {
      return push({
        cases: 0,
        agreed: 0,
        cause: "compiler failed",
        detail: String(e).slice(0, 200),
      });
    }
    const cases = casesFor(file, o.meta.exports as never);
    if (typeof cases === "string")
      return push({ cases: 0, agreed: 0, cause: "no cases", detail: cases });
    // As the corpus does: the TIR through its text, with the level beside it for the backend's shape.
    const m = parseModule(printModule(o.tir));
    if (o.tir.opt === 1 || o.tir.opt === 2) m.opt = o.tir.opt;
    if (m.externs.length > 0)
      return push({
        cases: cases.length,
        agreed: 0,
        cause: "externs (skipped by the QEMU route too)",
        detail: "",
      });
    const base = join(OUT, `${kind}-${basename(file, ".ts")}-O${level}`);
    const metaPath = `${base}.meta.json`;
    writeFileSync(metaPath, JSON.stringify(o.meta));
    const exe = executable(
      basename(base),
      () =>
        buildTslImage(
          m,
          o.meta as never,
          cases as never,
          pagesOf(file, true),
          0,
          buildHostedObject as (i: ImageInput) => HostedOutput,
        ) as HostedOutput,
    );
    if (typeof exe === "string")
      return push({ cases: cases.length, agreed: 0, cause: exe.split(":")[0]!, detail: exe });
    const r = await run(exe.path, []);
    const whole = runCause(r);
    const { results, problems } = tslResults(o.meta as never, cases as never, linesOf(r.stdout));
    if (kind !== "trap" && !refs.has(file)) {
      const cyc =
        kind === "std" || kind === "mem" || kind === "rc" ? await hostCycles(file) : undefined;
      let program = file;
      if (kind === "rc") {
        try {
          program = await writeRcExpanded(file, join(OUT, "rc-src"));
        } catch (e) {
          refs.set(file, Promise.resolve(`no rc expansion: ${String(e).slice(0, 200)}`));
        }
      }
      if (!refs.has(file)) refs.set(file, v8Reference(file, metaPath, false, cyc, program));
    }
    const ref = kind === "trap" ? [] : await refs.get(file)!;
    if (typeof ref === "string")
      return push({ cases: cases.length, agreed: 0, cause: "V8 reference failed", detail: ref });
    let agreed = 0;
    results.forEach((c, i) => {
      const spec = cases[i] as {
        trap?: number;
        diverge5?: { native: unknown };
        diverge?: { native: unknown; v8: unknown };
      };
      if (kind === "trap") {
        const got = (c.result as { trap?: number } | null)?.trap;
        if (spec.trap === got) agreed++;
        else
          problems.push(
            `${c.fn}#${i}: expected trap ${spec.trap}, got ${JSON.stringify(c.result)}`,
          );
        return;
      }
      const want = (ref as { result: unknown; arrays: unknown }[])[i];
      if (spec.diverge5 !== undefined || spec.diverge !== undefined) {
        const n = JSON.stringify(c.result);
        const pinN = JSON.stringify(spec.diverge5?.native ?? spec.diverge?.native);
        if (n === pinN) agreed++;
        else problems.push(`${c.fn}#${i}: native ${n} (want ${pinN})`);
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
    const ok = whole === null && agreed === cases.length && problems.length === 0;
    push({
      cases: cases.length,
      agreed,
      cause: ok ? null : (whole ?? "wrong results"),
      detail: ok
        ? `${r.ms} ms`
        : [
            ...problems.slice(0, 3),
            r.stderr.slice(0, 200),
            linesOf(r.stdout)
              .filter((l) => /^TMK:(PANIC|FATAL)/.test(l))
              .join(" "),
          ]
            .filter((x) => x !== "")
            .join("; "),
    });
  });
}

// --- lowered ordinary TS: corpus/lower/pos in leak and rc

async function lowerCategory(): Promise<void> {
  const { lowerFile } = await import("./lowering.ts");
  const modes = (flag("--memory") ?? "leak,manual,rc").split(",");
  // As the corpus's native route lists them for a memory mode.
  const filesFor = (memory: string): string[] => [
    ...listCorpus("corpus/lower/pos"),
    ...listCorpus("corpus/native"),
    ...listCorpus("corpus/lower/fallback"),
    ...listCorpus("corpus/lower/memory"),
    ...(memory === "rc" ? listCorpus("corpus/lower/rc") : []),
    ...listCorpus("corpus/lower/exc"),
  ];
  const jobs = modes.flatMap((memory) => filesFor(memory).map((file) => ({ file, memory })));
  const refs = new Map<string, Promise<unknown[] | string>>();
  await pool(jobs, JOBS, async ({ file, memory }) => {
    const name = `${relative(join(ROOT, "corpus"), file).replace(/\.ts$/, "")} ${memory}`;
    const push = (r: Omit<Row, "category" | "name">): void => {
      rows.push({ category: `lower ${memory}`, name, ...r });
    };
    let o: ReturnType<typeof lowerFile>;
    try {
      o = lowerFile(file, { memory, opt: 2 });
    } catch (e) {
      return push({
        cases: 0,
        agreed: 0,
        cause: "compiler failed",
        detail: String(e).slice(0, 200),
      });
    }
    if (o.diags.length > 0 || o.tir === null || o.tir === undefined)
      return push({
        cases: 0,
        agreed: 0,
        cause: "lowering diagnostics",
        detail: JSON.stringify(o.diags).slice(0, 200),
      });
    const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as {
      fn: string;
      lowered_trap?: number;
      memory_trap?: Record<string, number>;
      native_ulp?: number;
    }[];
    const meta = o.meta as unknown as Parameters<typeof buildDownImage>[1] & {
      exports: Record<string, { fallback?: boolean }>;
    };
    const m = parseModule(o.tirText);
    if (o.tir.opt === 1 || o.tir.opt === 2) m.opt = o.tir.opt;
    // The QEMU route skips these too: a program with externs or a case on a fallback function needs the host.
    if (m.externs.length > 0 || cases.some((c) => meta.exports[c.fn]?.fallback === true))
      return push({
        cases: cases.length,
        agreed: 0,
        cause: "needs the host (skipped by the QEMU route too)",
        detail: "",
      });
    const base = join(OUT, `lower-${basename(file, ".ts")}-${memory}`);
    let built: ReturnType<typeof buildDownImage> | undefined;
    const exe = executable(basename(base), () => {
      built = buildDownImage(
        m,
        meta,
        cases as never,
        pagesOf(file, false),
        { bulkBytes: 0 },
        undefined,
        stackOf(file),
        buildHostedObject as (i: ImageInput) => HostedOutput,
      );
      return built.image as HostedOutput;
    });
    if (typeof exe === "string")
      return push({ cases: cases.length, agreed: 0, cause: exe.split(":")[0]!, detail: exe });
    const r = await run(exe.path, []);
    const whole = runCause(r);
    const { results, problems } = downResults(
      meta,
      cases as never,
      built!.placements,
      linesOf(r.stdout),
      true,
    );
    if (!refs.has(file)) refs.set(file, v8Reference(file, null, true));
    const ref = await refs.get(file)!;
    if (typeof ref === "string")
      return push({ cases: cases.length, agreed: 0, cause: "V8 reference failed", detail: ref });
    let agreed = 0;
    results.forEach((x, i) => {
      const spec = cases[i]!;
      const rr = (ref as { result: unknown; args: unknown }[])[i];
      const wantTrap = spec.lowered_trap ?? spec.memory_trap?.[memory];
      if (wantTrap !== undefined) {
        const t = (x.result as { trap?: number }).trap;
        if (t === wantTrap) agreed++;
        else
          problems.push(`${x.fn}#${i}: expected trap ${wantTrap}, got ${JSON.stringify(x.result)}`);
        return;
      }
      if (spec.native_ulp !== undefined) {
        if (withinUlp(x.result, rr?.result, spec.native_ulp)) agreed++;
        else
          problems.push(
            `${x.fn}#${i}: ${JSON.stringify(x.result)}, V8 gave ${JSON.stringify(rr?.result)}`,
          );
        return;
      }
      if (JSON.stringify(x.result) !== JSON.stringify(rr?.result))
        problems.push(
          `${x.fn}#${i}: ${JSON.stringify(x.result)}, V8 gave ${JSON.stringify(rr?.result)}`,
        );
      else if (JSON.stringify(x.args) !== JSON.stringify(rr?.args))
        problems.push(`${x.fn}#${i}: arguments ended differently`);
      else agreed++;
    });
    const ok = whole === null && agreed === cases.length && problems.length === 0;
    push({
      cases: cases.length,
      agreed,
      cause: ok ? null : (whole ?? "wrong results"),
      detail: ok
        ? `${r.ms} ms`
        : [
            ...problems.slice(0, 3),
            r.stderr.slice(0, 200),
            linesOf(r.stdout)
              .filter((l) => /^TMK:(PANIC|FATAL)/.test(l))
              .join(" "),
          ]
            .filter((x) => x !== "")
            .join("; "),
    });
  });
}

/** corpus.ts's comparison for a case marked `native_ulp`: the f64 bits within that many units in the last place. */
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

// --- the fault paths, on small TIR programs (R7's, and the guard's)

const NULL_TRAP = { id: 1, kind: "null", code: 6, loc: "macho:1:1" };
const PANIC_TRAP = { id: 2, kind: "panic", code: 10, loc: "macho:2:1" };

function nullRead(name: string, storeFirst: boolean): Func {
  const b = new FuncBuilder(name, ["ptr"], ["i32"]);
  const p = b.params[0]!;
  const bad = b.block();
  const ok = b.block();
  b.brif(b.op("icmp.eq.ptr", [p, b.iconst("ptr", 0)], "i32"), bad, ok);
  b.at(bad);
  b.term({ k: "trap", id: NULL_TRAP.id });
  b.at(ok);
  if (storeFirst) b.store("i32", b.global("seen"), b.i32(7));
  const v = b.load("i32", b.gep(p, b.ix(0), 1, 8));
  b.ret([v]);
  return b.finish();
}

/** A recursion with no end in sight: each frame keeps its argument across the call. */
function deep(): Func {
  const b = new FuncBuilder("deep", ["i64"], ["i64"]);
  const n = b.params[0]!;
  const stop = b.block();
  const more = b.block();
  b.brif(b.op("icmp.eq.i64", [n, b.i64(0)], "i32"), stop, more);
  b.at(stop);
  b.ret([b.i64(0)]);
  b.at(more);
  const r = b.call("deep", [b.op("sub.i64", [n, b.i64(1)], "i64")], ["i64"])[0]!;
  b.ret([b.op("add.i64", [r, n], "i64")]);
  return b.finish();
}

function faultModule(level: 0 | 1 | 2): Module {
  const cases: Func[] = [];
  for (const [name, callee] of [
    ["case_read", "nullread"],
    ["case_store", "storeread"],
  ] as const) {
    const b = new FuncBuilder(name, [], []);
    b.call(callee, [b.load("ptr", b.global("np"))], ["i32"]);
    b.ret();
    cases.push(b.finish());
  }
  {
    const b = new FuncBuilder("case_deep", [], []);
    b.call("deep", [b.load("i64", b.global("big"))], ["i64"]);
    b.ret();
    cases.push(b.finish());
  }
  {
    const b = new FuncBuilder("case_panic", [], []);
    b.term({ k: "trap", id: PANIC_TRAP.id });
    cases.push(b.finish());
  }
  const big = new Uint8Array(8);
  new DataView(big.buffer).setBigUint64(0, 1n << 40n, true);
  const m = canonicalize({
    sigs: [],
    globals: [
      { name: "seen", size: 8, align: 8, section: "data" },
      { name: "np", size: 8, align: 8, section: "data" },
      { name: "big", size: 8, align: 8, section: "data", bytes: big },
    ],
    funcs: [nullRead("nullread", false), nullRead("storeread", true), deep(), ...cases],
    traps: [NULL_TRAP, PANIC_TRAP],
    externs: [],
  });
  return level === 0 ? m : optimizeModule(m, { ...optFromEnv(level), verifyEach: true }).module;
}

function faultImage(m: Module, main: (drv: Driver) => void): ImageInput {
  const drv = new Driver(m);
  main(drv);
  drv.trapMessages({});
  return {
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 256 * 1024 * 1024,
  };
}

async function faultCategory(): Promise<void> {
  const check = async (
    name: string,
    inp: ImageInput,
    want: (r: Run, img: HostedOutput) => string | null,
  ): Promise<void> => {
    const exe = executable(`fault-${name.replace(/[^A-Za-z0-9-]+/g, "_")}`, () =>
      buildHostedObject(inp),
    );
    if (typeof exe === "string") {
      rows.push({
        category: "faults",
        name,
        cases: 1,
        agreed: 0,
        cause: exe.split(":")[0]!,
        detail: exe,
      });
      return;
    }
    const r = await run(exe.path, [], 20_000);
    const why = want(r, exe.img);
    const report = linesOf(r.stdout)
      .filter((l) => /^TMK:(PANIC|FATAL|C )/.test(l))
      .join(" | ");
    rows.push({
      category: "faults",
      name,
      cases: 1,
      agreed: why === null ? 1 : 0,
      cause: why,
      detail: `exit ${r.status}${r.signal !== null ? ` ${r.signal}` : ""}: ${report}`.slice(0, 300),
    });
  };
  const outside =
    (call: (b: FuncBuilder) => void) =>
    (drv: Driver): void => {
      const b = new FuncBuilder("__tmk_main", [], []);
      call(b);
      b.ret();
      drv.funcs.push(b.finish());
    };
  const lineIs = (r: Run, re: RegExp): boolean => linesOf(r.stdout).some((l) => re.test(l));
  const caseLines: Record<number, string> = {};
  for (const level of [0, 1, 2] as const) {
    const m = faultModule(level);
    await check(
      `-O${level}: null outside a case is TMK:PANIC trap 6, exit 1`,
      faultImage(
        m,
        outside((b) => {
          b.call("nullread", [b.iconst("ptr", 0)], ["i32"]);
        }),
      ),
      (r, img) => {
        if (!lineIs(r, /^TMK:PANIC trap 6\b/)) return "no TMK:PANIC trap 6";
        if (r.status !== 1) return `exit status ${r.status}`;
        if (level > 0 && img.nullListed < 1)
          return "the check wasn't left to the load (nothing listed)";
        if (level === 0 && img.nullListed !== 0) return "a load listed at -O0";
        return null;
      },
    );
    await check(
      `-O${level}: a non-null reference that faults is TMK:FATAL far=0x10, exit 1`,
      faultImage(
        m,
        outside((b) => {
          b.call("nullread", [b.iconst("ptr", 8)], ["i32"]);
        }),
      ),
      (r) => {
        if (!lineIs(r, /^TMK:FATAL .*far=0000000000000010$/)) return "no TMK:FATAL with far=0x10";
        if (r.status !== 1) return `exit status ${r.status}`;
        return null;
      },
    );
    // Inside cases: trap 6 for both reads, `seen` untouched after the store's case, and the run goes on to TMK:DONE.
    await check(
      `-O${level}: null inside cases is TMK:C n T 6 and the run goes on`,
      faultImage(m, (drv) => {
        const after = new FuncBuilder("__macho_after", [], []);
        const v = after.load("i32", after.global("seen"));
        after.call("__rt_udec", [after.op("zext.i64", [v], "i64")]);
        after.call("__rt_nl", []);
        after.ret();
        drv.funcs.push(after.finish());
        drv.main(
          [
            { run: "case_read", after: "__macho_after" },
            { run: "case_store", after: "__macho_after" },
            { run: "case_deep", after: "__macho_after" },
            { run: "case_panic", after: "__macho_after" },
          ],
          () => undefined,
        );
      }),
      (r) => {
        const got = linesOf(r.stdout).filter((l) => /^TMK:C \d+ T|^\d+$/.test(l));
        caseLines[level] = got.join("|");
        const want = [
          "TMK:C 0 T 6 ",
          "0",
          "TMK:C 1 T 6 ",
          "0",
          "TMK:C 2 T 14 ",
          "0",
          "TMK:C 3 T 10 ",
          "0",
        ];
        if (got.join("|") !== want.join("|")) return `case lines ${JSON.stringify(got)}`;
        if (!lineIs(r, /^TMK:DONE$/) || r.status !== 0) return `no TMK:DONE / exit ${r.status}`;
        return null;
      },
    );
  }
  const m0 = faultModule(0);
  await check(
    "the stack guard outside a case is TMK:PANIC trap 14, exit 1",
    faultImage(
      m0,
      outside((b) => {
        b.call("deep", [b.load("i64", b.global("big"))], ["i64"]);
      }),
    ),
    (r) =>
      !lineIs(r, /^TMK:PANIC trap 14\b/)
        ? "no TMK:PANIC trap 14"
        : r.status !== 1
          ? `exit status ${r.status}`
          : null,
  );
  await check(
    "a trap outside a case is TMK:PANIC trap 10, exit 1",
    faultImage(
      m0,
      outside((b) => {
        b.call("case_panic", []);
      }),
    ),
    (r) =>
      !lineIs(r, /^TMK:PANIC trap 10\b/)
        ? "no TMK:PANIC trap 10"
        : r.status !== 1
          ? `exit status ${r.status}`
          : null,
  );
  await check(
    "a program that finishes prints TMK:READY then TMK:DONE, exit 0",
    faultImage(
      m0,
      outside(() => undefined),
    ),
    (r) =>
      r.stdout !== "TMK:READY\nTMK:DONE\n"
        ? `output ${JSON.stringify(r.stdout)}`
        : r.status !== 0
          ? `exit status ${r.status}`
          : null,
  );
}

// --- the Apple arm64 rules, checked on the linked code (D56, D57)

/**
 * Every executable this run built, disassembled by the system's otool: no instruction names x18 (the platform's), SP moves
 * only in multiples of 16, and every function that calls with `bl` and returns starts with a frame record (stp x29, x30,
 * [sp, #-n]! then mov x29, sp). A `bl` that never returns (to __rt_trap, __rt_off or exit) needs no frame.
 */
async function abiCategory(): Promise<void> {
  const noReturn = /\bbl\s+(_tsl\$__rt_trap|_tsl\$__rt_off|0x[0-9a-f]+ ; symbol stub for: _exit)$/;
  await pool(builtExes, JOBS, async ({ path: exe, ranges }) => {
    const r = await run("otool", ["-tV", exe], 60_000, "utf8");
    // The text starts with __tmk_text at offset 0; only words in an instruction range are instructions.
    let textBase = -1;
    const isCode = (addr: number): boolean => {
      const off = addr - textBase;
      return ranges.some((x) => off >= x.from && off < x.to);
    };
    const problems: string[] = [];
    let fn = "";
    let body: string[] = [];
    let functions = 0;
    const finish = (): void => {
      if (fn === "") return;
      functions++;
      const calls = body.some((l) => /\bbl\s/.test(l) && !noReturn.test(l));
      if (
        calls &&
        !(
          /^stp\s+x29, x30, \[sp, #-0x[0-9a-f]+\]!$/.test(body[0] ?? "") &&
          /^mov\s+x29, sp$/.test(body[1] ?? "")
        )
      )
        problems.push(`${fn} calls but has no frame record first (${body[0]} / ${body[1]})`);
    };
    for (const line of r.stdout.split("\n")) {
      const label = /^(\S+):$/.exec(line);
      if (label !== null && !line.includes("(__TEXT")) {
        finish();
        fn = label[1]!;
        body = [];
        continue;
      }
      const m = /^([0-9a-f]{16})\s+(.*)$/.exec(line);
      if (m === null) continue;
      const addr = Number.parseInt(m[1]!, 16);
      if (textBase < 0) textBase = addr;
      if (!isCode(addr)) continue;
      const ins = m[2]!.replace(/\t/g, " ").replace(/ +/g, " ").trim();
      body.push(ins);
      if (/\b[xw]18\b/.test(ins)) problems.push(`${fn}: ${ins}`);
      const spMove = /^(sub|add) sp, sp, #(0x[0-9a-f]+|\d+)(, lsl #12)?$/.exec(ins);
      if (spMove !== null && (Number(spMove[2]) * (spMove[3] !== undefined ? 4096 : 1)) % 16 !== 0)
        problems.push(`${fn}: ${ins}`);
      const pre = /\[sp, #-(0x[0-9a-f]+|\d+)\]!$/.exec(ins);
      if (pre !== null && Number(pre[1]) % 16 !== 0) problems.push(`${fn}: ${ins}`);
    }
    finish();
    rows.push({
      category: "abi (x18, SP alignment, frame records)",
      name: basename(exe),
      cases: 1,
      agreed: problems.length === 0 && functions > 0 ? 1 : 0,
      cause:
        r.status !== 0
          ? "otool failed"
          : functions === 0
            ? "no functions found"
            : problems.length > 0
              ? "rule broken"
              : null,
      detail: problems.slice(0, 3).join("; "),
    });
  });
}

// --- main

const t0 = Date.now();
if (only.has("faults")) await faultCategory();
for (const k of ["pos", "trap", "mem", "std", "rc"] as const) if (only.has(k)) await tslCategory(k);
if (only.has("lower")) await lowerCategory();
if (only.has("abi")) await abiCategory();

const cats = [...new Set(rows.map((r) => r.category))];
const SKIP = "(skipped by the QEMU route too)";
let allOk = true;
for (const c of cats) {
  const all = rows.filter((r) => r.category === c).sort((a, b) => (a.name < b.name ? -1 : 1));
  const skipped = all.filter((r) => r.cause?.endsWith(SKIP) === true);
  const rs = all.filter((r) => !skipped.includes(r));
  const pass = rs.filter((r) => r.cause === null);
  const cases = rs.reduce((n, r) => n + r.cases, 0);
  const agreed = rs.reduce((n, r) => n + r.agreed, 0);
  console.log(
    `${pass.length === rs.length ? "PASS" : "FAIL"} ${c}: ${pass.length} of ${rs.length} programs, ${agreed} of ${cases} cases${skipped.length > 0 ? `; ${skipped.length} skipped, as the QEMU route skips them` : ""}`,
  );
  const byCause = new Map<string, Row[]>();
  for (const r of rs)
    if (r.cause !== null) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
  for (const [cause, list] of byCause) {
    console.log(`  ${cause}: ${list.length}`);
    for (const r of list.slice(0, argv.includes("--all") ? list.length : 8))
      console.log(`    ${r.name}: ${r.detail}`);
  }
  if (pass.length !== rs.length) allOk = false;
}
console.log(`${rows.length} programs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 1));
process.exit(allOk ? 0 : 1);
