// The QEMU route against the native macOS lane (decisions.md, 2026-12-14; D57a): the same programs, compiled once, built as
// a bare-metal image and run under QEMU (HVF), and built as a hosted executable and run directly, each output read by the same
// parsers (native-exec.ts), then compared case by case. Raw addresses are the one expected difference (guest memory below
// 4 GiB, a macOS heap above it): a case whose results are the same once every number of 2^20 or more is taken as an address
// counts as "addresses only". Anything else is a difference, and listed. Also how long each lane took, built and run apart, so
// neither is timed while the other compiles. It moves nothing: which suites could move is for the owner (the decision's order).
// `node tools/lane-diff.ts [--filter s] [--jobs n] [--json file]`
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
import { checkFile, compileTyped } from "../compiler/host/tslc.ts";
import { parseModule, printModule } from "../compiler/tir/text.ts";
// tslc's, not the test process's memo of six: every build here is made once and let go.
import { lowerFile } from "../compiler/host/tslc.ts";
import { casesFor, linkObject, pagesOf, stackOf } from "./macho.ts";
import { bulkFor, buildDownImage, buildTslImage, downResults, tslResults } from "./native-exec.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined =>
  argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined;
const filter = flag("--filter");
const JOBS = Math.max(1, Number(flag("--jobs") ?? 4));
const RUN_TIMEOUT_MS = 60_000;
const OUT = join(process.env.TMK_BUILD_DIR ?? join(ROOT, "build"), "lane-diff");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface Build {
  name: string;
  kind: "tsl" | "lower";
  read: (lines: string[], wide: boolean) => { results: unknown[] };
  qemuImage: string;
  bulk: { ramBytes: number; offset: number; bytes: number } | undefined;
  exe: string;
  cases: number;
  buildMs: { qemu: number; native: number };
}

function listCorpus(dir: string): string[] {
  const d = join(ROOT, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".ts") && existsSync(join(d, f.replace(/\.ts$/, ".cases.json"))))
    .filter((f) => filter === undefined || f.includes(filter))
    .sort()
    .map((f) => join(d, f));
}

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await f(items[next++]!);
    }),
  );
}

/** A native executable's run: its output to a file (nothing here is busy compiling, but a pipe can still stall it). */
let runs = 0;
function runNative(
  path: string,
): Promise<{ stdout: string; ms: number; status: number | null; timedOut: boolean }> {
  return new Promise((done) => {
    const t0 = performance.now();
    const outPath = join(OUT, `run-${runs++}.out`);
    const fd = openSync(outPath, "w");
    const child = spawn(path, [], { stdio: ["ignore", fd, "ignore"] });
    closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }, RUN_TIMEOUT_MS);
    const finish = (status: number | null): void => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      const stdout =
        statSync(outPath).size > 512 << 20 ? "" : readFileSync(outPath).toString("latin1");
      rmSync(outPath, { force: true });
      done({ stdout, ms, status, timedOut });
    };
    child.on("close", (s) => finish(s));
    child.on("error", () => finish(null));
  });
}

const linesOf = (s: string): string[] => s.split("\n").map((l) => l.replace(/\r$/, ""));

function link(name: string, img: HostedOutput): string | null {
  const path = join(OUT, name);
  writeFileSync(`${path}.o`, img.bytes);
  const l = linkObject(`${path}.o`, path);
  rmSync(`${path}.o`, { force: true });
  return l.ok ? path : null;
}

const builds: Build[] = [];
const skipped: { name: string; why: string }[] = [];
const compileMs = { total: 0 };

function buildTsl(kind: string, file: string, level: 0 | 2): void {
  const name = `${kind}/${basename(file, ".ts")} -O${level}`;
  const t0 = performance.now();
  const { typed } = checkFile(file);
  if (typed === null) return void skipped.push({ name, why: "compile diagnostics" });
  const o = compileTyped(typed, { opt: level });
  const cases = casesFor(file, o.meta.exports as never);
  if (typeof cases === "string") return void skipped.push({ name, why: "no cases" });
  const m = parseModule(printModule(o.tir));
  if (o.tir.opt === 1 || o.tir.opt === 2) m.opt = o.tir.opt;
  compileMs.total += performance.now() - t0;
  if (m.externs.length > 0)
    return void skipped.push({ name, why: "externs (the QEMU route skips it)" });
  const base = `${kind}-${basename(file, ".ts")}-O${level}`;
  const t1 = performance.now();
  const q = buildTslImage(m, o.meta as never, cases as never, pagesOf(file, true), bulkFor());
  const qPath = join(OUT, `${base}.img`);
  writeFileSync(qPath, q.bytes);
  const t2 = performance.now();
  const h = buildTslImage(
    m,
    o.meta as never,
    cases as never,
    pagesOf(file, true),
    0,
    buildHostedObject as (i: ImageInput) => HostedOutput,
  ) as HostedOutput;
  const exe = link(base, h);
  const t3 = performance.now();
  if (exe === null) return void skipped.push({ name, why: "link failed" });
  // Only what reading needs: not the compile's TIR or either image (holding them ran this process out of memory).
  const tslMeta = o.meta;
  builds.push({
    name,
    kind: "tsl",
    read: (lines) => {
      const r = tslResults(tslMeta as never, cases as never, lines);
      return {
        results: r.results.map((c) => ({ result: c.result, arrays: c.arrays, pin: c.pin })),
      };
    },
    qemuImage: qPath,
    bulk: q.bulk,
    exe,
    cases: cases.length,
    buildMs: { qemu: t2 - t1, native: t3 - t2 },
  });
}

function buildLower(file: string, memory: string): void {
  const name = `${relative(join(ROOT, "corpus"), file).replace(/\.ts$/, "")} ${memory}`;
  const t0 = performance.now();
  let o: ReturnType<typeof lowerFile>;
  try {
    o = lowerFile(file, { memory, opt: 2 });
  } catch (e) {
    return void skipped.push({ name, why: `compiler failed: ${String(e).slice(0, 100)}` });
  }
  if (o.diags.length > 0 || o.tir === null) return void skipped.push({ name, why: "diagnostics" });
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as unknown[];
  const meta = o.meta as unknown as Parameters<typeof buildDownImage>[1] & {
    exports: Record<string, { fallback?: boolean }>;
  };
  const m = parseModule(o.tirText);
  if (o.tir.opt === 1 || o.tir.opt === 2) m.opt = o.tir.opt;
  compileMs.total += performance.now() - t0;
  if (
    m.externs.length > 0 ||
    (cases as { fn: string }[]).some((c) => meta.exports[c.fn]?.fallback === true)
  )
    return void skipped.push({ name, why: "needs the host (the QEMU route skips it)" });
  const base = `lower-${basename(file, ".ts")}-${memory}`;
  const t1 = performance.now();
  const q = buildDownImage(
    m,
    meta,
    cases as never,
    pagesOf(file, false),
    { bulkBytes: bulkFor() },
    undefined,
    stackOf(file),
  );
  const qPath = join(OUT, `${base}.img`);
  writeFileSync(qPath, q.image.bytes);
  const t2 = performance.now();
  const h = buildDownImage(
    m,
    meta,
    cases as never,
    pagesOf(file, false),
    { bulkBytes: 0 },
    undefined,
    stackOf(file),
    buildHostedObject as (i: ImageInput) => HostedOutput,
  );
  const exe = link(base, h.image as HostedOutput);
  const t3 = performance.now();
  if (exe === null) return void skipped.push({ name, why: "link failed" });
  const qPlacements = q.placements;
  const hPlacements = h.placements;
  const qBulk = q.image.bulk;
  builds.push({
    name,
    kind: "lower",
    read: (lines, wide) => {
      const placements = wide ? hPlacements : qPlacements;
      const r = downResults(meta, cases as never, placements, lines, wide);
      return { results: r.results.map((x) => ({ result: x.result, args: x.args })) };
    },
    qemuImage: qPath,
    bulk: qBulk,
    exe,
    cases: cases.length,
    buildMs: { qemu: t2 - t1, native: t3 - t2 },
  });
}

/** Every number of 2^20 or more, as an address: what's left is what has to be the same. */
const noAddresses = (s: string): string =>
  s.replace(/-?\d{7,}/g, (d) => (Math.abs(Number(d)) >= 1 << 20 ? "#addr" : d));

if (!hvfAvailable().ok) {
  console.log(`SKIP: HVF unavailable (${hvfAvailable().why}): no comparison made`);
  process.exit(1);
}
const t0 = performance.now();
for (const kind of ["pos", "trap", "mem", "std", "rc"] as const) {
  const files = [
    ...listCorpus(`corpus/${kind}`),
    ...(kind === "mem" ? listCorpus("corpus/spec") : []),
  ];
  for (const f of files)
    for (const level of [0, 2] as const) {
      try {
        buildTsl(kind, f, level);
      } catch (e) {
        skipped.push({
          name: `${kind}/${basename(f)} -O${level}`,
          why: `build: ${String(e).slice(0, 100)}`,
        });
      }
    }
}
for (const memory of ["leak", "manual", "rc"]) {
  const files = [
    ...listCorpus("corpus/lower/pos"),
    ...listCorpus("corpus/native"),
    ...listCorpus("corpus/lower/fallback"),
    ...listCorpus("corpus/lower/memory"),
    ...(memory === "rc" ? listCorpus("corpus/lower/rc") : []),
    ...listCorpus("corpus/lower/exc"),
  ];
  for (const f of files)
    try {
      buildLower(f, memory);
    } catch (e) {
      skipped.push({ name: `${basename(f)} ${memory}`, why: `build: ${String(e).slice(0, 100)}` });
    }
}
const buildWall = performance.now() - t0;

// Each lane run apart, the same number at once, nothing compiling meanwhile. Each run's results are read as it ends and only
// they are kept: a run's lines hold its RAM channel, and keeping every run's ran this process past its 3 GiB watchdog.
const perCase = (b: Build, lines: string[], wide: boolean): string[] =>
  b.read(lines, wide).results.map((x) => JSON.stringify(x));
const qemuOut = new Map<string, { results: string[]; ms: number; ok: boolean; why: string }>();
const t1 = performance.now();
await pool(builds, JOBS, async (b) => {
  const r = await qemuRun({
    name: `lane/${b.name.replace(/[^\w.-]+/g, "_")}`,
    image: b.qemuImage,
    accel: "hvf",
    timeoutMs: RUN_TIMEOUT_MS,
    logDir: join(OUT, "logs"),
    ...(b.bulk !== undefined ? { bulk: b.bulk } : {}),
  });
  qemuOut.set(b.name, {
    results: perCase(b, r.lines, false),
    ms: r.ms,
    ok: r.ok,
    why: r.ok ? "" : `${r.status}`,
  });
  rmSync(r.log, { force: true });
});
const qemuWall = performance.now() - t1;
const nativeOut = new Map<string, { results: string[]; ms: number; ok: boolean }>();
const t2 = performance.now();
await pool(builds, JOBS, async (b) => {
  const r = await runNative(b.exe);
  nativeOut.set(b.name, {
    results: perCase(b, linesOf(r.stdout), true),
    ms: r.ms,
    ok: !r.timedOut && r.status === 0,
  });
});
const nativeWall = performance.now() - t2;

let same = 0;
let addressOnly = 0;
let casesTotal = 0;
const differ: string[] = [];
const byCategory: Record<
  string,
  { programs: number; same: number; addressOnly: number; differ: number }
> = {};
for (const b of builds) {
  const cat = b.kind === "tsl" ? b.name.split("/")[0]! : `lower ${b.name.split(" ").at(-1)}`;
  const c = (byCategory[cat] ??= { programs: 0, same: 0, addressOnly: 0, differ: 0 });
  c.programs++;
  const q = qemuOut.get(b.name)!;
  const n = nativeOut.get(b.name)!;
  const qr = q.results;
  const nr = n.results;
  let progDiffer = false;
  for (let i = 0; i < Math.max(qr.length, nr.length); i++) {
    casesTotal++;
    const a = qr[i];
    const z = nr[i];
    if (a === z) same++;
    else if (a !== undefined && z !== undefined && noAddresses(a) === noAddresses(z)) addressOnly++;
    else {
      progDiffer = true;
      differ.push(`${b.name} case ${i}: QEMU ${a?.slice(0, 160)}, native ${z?.slice(0, 160)}`);
    }
  }
  if (q.ok !== n.ok) {
    progDiffer = true;
    differ.push(
      `${b.name}: QEMU ${q.ok ? "finished" : `didn't (${q.why})`}, native ${n.ok ? "finished" : "didn't"}`,
    );
  }
  if (progDiffer) c.differ++;
  else c.same++;
}
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const report = {
  programs: builds.length,
  skipped: skipped.length,
  cases: casesTotal,
  same,
  addressOnly,
  differences: differ.length,
  byCategory,
  seconds: {
    compile: compileMs.total / 1000,
    buildWall: buildWall / 1000,
    qemuImageBuild: sum(builds.map((b) => b.buildMs.qemu)) / 1000,
    nativeBuildAndLink: sum(builds.map((b) => b.buildMs.native)) / 1000,
    qemuRunWall: qemuWall / 1000,
    nativeRunWall: nativeWall / 1000,
    qemuRunSum: sum([...qemuOut.values()].map((x) => x.ms)) / 1000,
    nativeRunSum: sum([...nativeOut.values()].map((x) => x.ms)) / 1000,
  },
  jobs: JOBS,
  differ: differ.slice(0, 200),
  skippedList: skipped,
};
if (flag("--json") !== undefined) writeFileSync(flag("--json")!, JSON.stringify(report, null, 2));
const s = report.seconds;
for (const [k, v] of Object.entries(byCategory))
  console.log(
    `${v.differ === 0 ? "SAME  " : "DIFFER"} ${k}: ${v.programs} programs, ${v.same} the same (addresses aside), ${v.differ} differ`,
  );
console.log(
  `${builds.length} programs (${skipped.length} skipped, as the QEMU route skips them or they don't build), ${casesTotal} cases: ${same} identical, ${addressOnly} differing only by raw addresses, ${differ.length} other differences`,
);
console.log(
  `time: compile ${s.compile.toFixed(1)} s (shared); building: QEMU images ${s.qemuImageBuild.toFixed(1)} s, native objects and links ${s.nativeBuildAndLink.toFixed(1)} s; running, ${JOBS} at once: QEMU ${s.qemuRunWall.toFixed(1)} s (sum ${s.qemuRunSum.toFixed(1)} s), native ${s.nativeRunWall.toFixed(1)} s (sum ${s.nativeRunSum.toFixed(1)} s)`,
);
for (const d of differ.slice(0, 30)) console.log(`  ${d}`);
process.exit(differ.length === 0 ? 0 : 1);
