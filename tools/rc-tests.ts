// The tests of `rc` that a corpus comparison can't be (SPEC 8.1, M5 Phase D): counters across repeats, an injected fault,
// the freeing bound as a count of steps, rc-only programs with pinned results, and allocation latency during a drop.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { lowerFile } from "./lowering.ts";
import { lowerAndBuild } from "./compile-pool.ts";
import type { SlimLower } from "./compile-worker.ts";
import { assemble } from "../compiler/tir/asm.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { canonicalize, type Module } from "../compiler/tir/ir.ts";
import { optFromEnv, optimizeModule } from "../compiler/tir/passes/manager.ts";
import { cloneModule } from "../compiler/tir/passes/util.ts";
import { pool } from "./guarded-run.ts";
import { defaultEngines, listPrograms, lowerCommand, ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import type { LowerCase, LowerCaseResult } from "./lower-exec.ts";
import { bulkFor, downResults, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { Driver } from "./native-driver.ts";
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { hvfAvailable, qemuRun, type Accel } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";
import { firstInOrder } from "./stable.ts";

const RUN_TIMEOUT_MS = 180_000;
const pagesOf = (file: string): number | undefined => {
  const m = /^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return m !== undefined ? Number(m) : undefined;
};
const stackOf = (file: string): number | undefined => {
  const m = /^\/\/ rc-stack: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return m !== undefined ? Number(m) : undefined;
};
const casesOf = (file: string): LowerCase[] =>
  JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as LowerCase[];

/** The programs `rc` runs that have no fallback left. */
export function rcPrograms(filter?: string): string[] {
  const out = [
    ...listPrograms(join(ROOT, "corpus/lower/pos"), filter),
    ...listPrograms(join(ROOT, "corpus/native"), filter),
    ...listPrograms(join(ROOT, "corpus/lower/fallback"), filter),
    ...listPrograms(join(ROOT, "corpus/lower/memory"), filter),
    ...listPrograms(join(ROOT, "corpus/lower/rc"), filter),
    // The generated finally tests have their own suites (lang-a's box 3), and hold no counted object a frame could leak but
    // an Error: here they'd only multiply time and memory.
    ...listPrograms(join(ROOT, "corpus/lower/exc"), filter).filter((f) => !/gen_finally/.test(f)),
  ];
  return out.filter((f) => {
    const o = lowerFile(f, { memory: "rc" });
    const usable =
      o.tir !== null &&
      o.tir.externs.length === 0 &&
      Object.values(o.meta?.exports ?? {}).every((e) => e.fallback !== true);
    return usable;
  });
}

/**
 * rcPrograms, worked out in a child process (tools/rc-programs.ts, R16): the same list, with the lowering it takes given back
 * when the child ends, not left in this process's heap beside the compile workers (native-e box 3's peak memory).
 */
export async function rcProgramsApart(filter?: string): Promise<string[]> {
  const { guardedRun } = await import("./guarded-run.ts");
  const h = await guardedRun(
    process.execPath,
    [
      "--no-warnings",
      join(ROOT, "tools/rc-programs.ts"),
      ...(filter !== undefined ? [filter] : []),
    ],
    { timeoutMs: 900_000, label: "rc-programs.ts", cwd: ROOT },
  );
  if (!h.ok) throw new Error(`tools/rc-programs.ts: ${h.why.slice(0, 300)}`);
  return JSON.parse(h.stdout) as string[];
}

interface OneRun {
  ok: boolean;
  skipped: boolean;
  why: string;
  serial: string[];
  o: SlimLower;
  stats: Record<string, number>[];
  results: { fn: string; result: unknown }[];
  problems: string[];
}

async function runOne(
  file: string,
  cases: LowerCase[],
  accel: Accel,
  rc: Record<string, unknown>,
  harness: { stats?: boolean; collect?: boolean },
  pages = pagesOf(file),
): Promise<OneRun> {
  const { o, built } = await lowerAndBuild({
    file,
    lower: { memory: "rc", rc },
    cases,
    pages,
    harness: { ...harness, bulkBytes: bulkFor() },
    stackBytes: stackOf(file),
  });
  if (o.tir === null || built === null) throw new Error(`${file}: ${JSON.stringify(o.diags)}`);
  const r = await qemuRun({
    name: `rc/${basename(file, ".ts")}`,
    image: built.image.bytes,
    accel,
    timeoutMs: RUN_TIMEOUT_MS,
    ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
  });
  const res = r.skipped
    ? { results: [], problems: [] }
    : downResults(o.meta as DownMetaLike, cases, built.placements, r.lines);
  return {
    ok: r.ok,
    skipped: r.skipped,
    why: r.why,
    serial: r.lines,
    o,
    stats: rcStatLines(o.tir as Module, r.lines),
    results: res.results,
    problems: res.problems,
  };
}

// A lowered `throw` is the trap path too.
const isTrap = (r: unknown): boolean => {
  const o = r as { trap?: number; threw?: string };
  return o?.trap !== undefined || o?.threw !== undefined;
};

/** What these programs' own source says they keep: each repeat rightly holds more, or holds a real cycle. */
const KEEPS_STATE: Record<string, string> = {
  "corpus/lower/memory/globals_across_calls.ts": "pushes to a module array on each call",
  "corpus/lower/fallback/escape_global.ts": "grow() pushes to a module array on each call",
  "corpus/lower/memory/cycles.ts": "builds real cycles, which leak under rc, as stated",
};

/** The same, for one function: the rest of its program is still tested. */
const CASES_THAT_KEEP: Record<string, string[]> = {
  "corpus/lower/memory/class_list.ts": ["insertTree"], // adds to a module tree
  "corpus/lower/memory/exhaust.ts": ["fits", "tooMany"], // adds to a module list
  // Box's constructor stores a closure capturing `this` in a field of `this`: a real cycle, which leaks as stated.
  "corpus/lower/memory/closures_returned.ts": ["viaClassField"],
};

/** Left out of the no-leak test only because of a cycle, so the collector brings them in. */
const CYCLES_ONLY = new Set(["corpus/lower/memory/cycles.ts"]);
const CASES_ONLY_CYCLES = new Set(["viaClassField"]);

export interface LeakRow {
  program: string;
  repeats: number;
  liveObjects: number[];
  liveBytes: number[];
  grew: boolean;
  skipped?: string;
}

/**
 * A program's cases, repeated, with every result and argument released and every pending free run. A class that can
 * form a cycle isn't a program that makes one, so only programs that do are left out. What's still live must
 * not grow from one repeat to the next. The first repeat may: that's what a program keeps once, in module state.
 */
export async function leakTest(
  accel: Accel,
  jobs: number,
  // With the collector on, what only held a real cycle comes in (SPEC 3.5, D41).
  withCycles = false,
  // Other programs than rc's corpus: corpus/lower/maps, say (D47).
  files?: string[],
): Promise<{ rows: LeakRow[]; failures: string[]; skippedAccel: boolean }> {
  const REPEATS = 4;
  const failures: string[] = [];
  const rows: LeakRow[] = [];
  let skippedAccel = false;
  await pool(files ?? (await rcProgramsApart()), jobs, async (file) => {
    const name = file.slice(ROOT.length + 1);
    const row: LeakRow = {
      program: name,
      repeats: REPEATS,
      liveObjects: [],
      liveBytes: [],
      grew: false,
    };
    rows.push(row);
    const reason = withCycles && CYCLES_ONLY.has(name) ? undefined : KEEPS_STATE[name];
    if (reason !== undefined) {
      row.skipped = reason;
      return;
    }
    const all = casesOf(file);
    // A trap skips what the frames it unwinds still held, and that's a leak only domain death answers (SPEC 3.5).
    const first = await runOne(file, all, accel, { account: true }, { stats: true, collect: true });
    if (first.skipped) {
      skippedAccel = true;
      return;
    }
    const skip = (CASES_THAT_KEEP[name] ?? []).filter(
      (fn) => !(withCycles && CASES_ONLY_CYCLES.has(fn)),
    );
    // An exception that reaches the caller unwinds every frame, releasing as it goes, and the caller gives the thrown value
    // back (D49): only the trap path leaves counts held.
    const excModule = (first.o.meta as { exc?: unknown } | null)?.exc !== undefined;
    const keep = all.filter((c, i) => {
      const res = first.results[i]?.result as { trap?: number; threw?: string } | undefined;
      const trapped = excModule ? res?.trap !== undefined : isTrap(res);
      return !trapped && !skip.includes(c.fn);
    });
    if (keep.length === 0) {
      row.skipped = "every case traps";
      return;
    }
    const cases = Array.from({ length: REPEATS }, () => keep).flat();
    const r = await runOne(file, cases, accel, { account: true }, { stats: true, collect: true });
    if (!r.ok) {
      failures.push(`${name}: ${r.why.slice(0, 200)}`);
      return;
    }
    for (let k = 0; k < REPEATS; k++) {
      const s = r.stats[(k + 1) * keep.length - 1];
      if (s === undefined) continue;
      row.liveObjects.push(s.live_objects!);
      row.liveBytes.push(s.live_bytes!);
    }
    for (let k = 2; k < REPEATS; k++) {
      if (row.liveObjects[k]! > row.liveObjects[1]! || row.liveBytes[k]! > row.liveBytes[1]!) {
        row.grew = true;
      }
    }
    if (row.grew) {
      failures.push(
        `${name}: live objects ${row.liveObjects.join(" ")}, bytes ${row.liveBytes.join(" ")}`,
      );
    }
  });
  rows.sort((a, b) => (a.program < b.program ? -1 : 1));
  return { rows, failures, skippedAccel };
}

/** rc-only programs: no V8 to compare with, so each case pins its value or trap. Against the release and poison builds. */
export async function rcOnly(
  accel: Accel,
  jobs: number,
  // A test build with a mistake put in (`{ rtFault: "cast-unchecked" }`), to show these programs catch it.
  extra: Record<string, unknown> = {},
): Promise<{ cases: number; failures: string[]; skipped: boolean; drains: number }> {
  const files = listPrograms(join(ROOT, "corpus/lower/rc-only"));
  const failures: string[] = [];
  let cases = 0;
  let skipped = false;
  let drains = 0;
  const builds: {
    rc: Record<string, unknown>;
    h: { stats?: boolean; collect?: boolean };
    tag: string;
  }[] = [
    { rc: { ...extra }, h: {}, tag: "release" },
    { rc: { check: true, account: true, ...extra }, h: { stats: true }, tag: "poison" },
  ];
  await pool(
    files.flatMap((f) => builds.map((b) => ({ f, b }))),
    jobs,
    async ({ f, b }) => {
      const spec = casesOf(f) as (LowerCase & { value?: number; trap?: number })[];
      const r = await runOne(f, spec, accel, b.rc, b.h);
      if (r.skipped) {
        skipped = true;
        return;
      }
      const name = f.slice(ROOT.length + 1);
      if (!r.ok) failures.push(`${name} (${b.tag}): ${r.why.slice(0, 200)}`);
      for (const p of r.problems) failures.push(`${name} (${b.tag}): ${p}`);
      r.results.forEach((x, i) => {
        cases++;
        const c = spec[i]!;
        const got = x.result as { trap?: number; value?: { n?: string } | number };
        if (c.trap !== undefined) {
          if (got.trap !== c.trap)
            failures.push(
              `${name} ${x.fn}#${i} (${b.tag}): ${JSON.stringify(got)}, wanted trap ${c.trap}`,
            );
          return;
        }
        const n = (got.value as { n?: string })?.n;
        const v =
          n !== undefined
            ? new Float64Array(new BigUint64Array([BigInt(`0x${n}`)]).buffer)[0]
            : got.value;
        if (v !== c.value)
          failures.push(
            `${name} ${x.fn}#${i} (${b.tag}): ${JSON.stringify(got)} = ${String(v)}, wanted ${c.value}`,
          );
      });
      const last = r.stats[r.stats.length - 1];
      if (last !== undefined) drains += last.full_drains!;
    },
  );
  return { cases, failures, skipped, drains };
}

/**
 * Is the poisoning build vacuous? Leaves out each increment in turn, in the adversarial programs. Each one left out either
 * traps with code 16 or was redundant, and most must trap. And a decrement left out must show as a leak.
 */
export async function faultInjection(
  accel: Accel,
  jobs: number,
  rcBase: Record<string, unknown> = {},
): Promise<{
  injected: number;
  trapped16: number;
  otherFailures: number;
  silent: number;
  silentNeverRan: number;
  neverReached: number;
  reachedOnlyNull: number;
  notInTheCode: number;
  silentSites: string[];
  decLeaked: number;
  decTried: number;
  decNeverRan: number;
  decNeverReached: number;
  decReachedOnlyNull: number;
  decNotInTheCode: number;
  decImmortal: string[];
  decNeverReachedSites: string[];
  skipped: boolean;
}> {
  const files = listPrograms(join(ROOT, "corpus/lower/rc")).filter((f) =>
    /adv_(callee|self|closure|method|forof|temporaries|shared|control|array)/.test(f),
  );
  const out = {
    injected: 0,
    trapped16: 0,
    otherFailures: 0,
    silent: 0,
    silentNeverRan: 0,
    neverReached: 0,
    reachedOnlyNull: 0,
    notInTheCode: 0,
    silentSites: [] as string[],
    decLeaked: 0,
    decTried: 0,
    decNeverRan: 0,
    decNeverReached: 0,
    decReachedOnlyNull: 0,
    decNotInTheCode: 0,
    decImmortal: [] as string[],
    decNeverReachedSites: [] as string[],
    skipped: false,
  };
  const tasks: { file: string; omit: number; kind: "inc" | "dec" }[] = [];
  const correct = new Map<string, string>();
  for (const file of files) {
    const base = lowerFile(file, { memory: "rc", rc: { ...rcBase, check: true } });
    for (let i = 0; i < base.rc!.incSites; i++) tasks.push({ file, omit: i, kind: "inc" });
    for (let i = 0; i < base.rc!.decSites; i++) tasks.push({ file, omit: i, kind: "dec" });
    const ref = await runOne(
      file,
      casesOf(file),
      accel,
      { ...rcBase, check: true },
      { collect: true },
    );
    correct.set(file, JSON.stringify(ref.results.map((x) => x.result)));
  }
  const name = (f: string, n: number): string => `${basename(f)}#${n}`;
  /** A release worked out and then not used, such as for a local whose count moved out: there's no site to leave out. */
  const emitted = (file: string, rc: Record<string, unknown>): string =>
    lowerFile(file, { memory: "rc", rc: { ...rcBase, ...rc } }).tirHash;
  /** Is a site that made no difference reached at all, or only ever with a null? */
  const reached = async (file: string, rc: Record<string, unknown>): Promise<boolean> => {
    const p = await runOne(file, casesOf(file), accel, { ...rcBase, ...rc }, { collect: true });
    return p.results.some((x) => (x.result as { trap?: number }).trap === 999) || !p.ok;
  };
  const counted = async (
    file: string,
    rc: Record<string, unknown>,
  ): Promise<Record<string, number>> => {
    const c = await runOne(
      file,
      casesOf(file),
      accel,
      { ...rcBase, account: true, ...rc },
      { stats: true },
    );
    return c.stats.filter((x) => x !== undefined).at(-1) ?? {};
  };
  await pool(tasks, jobs, async ({ file, omit, kind }) => {
    if (kind === "inc") {
      const r = await runOne(
        file,
        casesOf(file),
        accel,
        { ...rcBase, check: true, omitInc: omit },
        { collect: true },
      );
      if (r.skipped) {
        out.skipped = true;
        return;
      }
      out.injected++;
      const t = r.results.map((x) => (x.result as { trap?: number }).trap);
      if (t.includes(16)) out.trapped16++;
      else if (
        !r.ok ||
        r.problems.length > 0 ||
        // A wrong answer is noticed too, however it comes out: one that only showed as a trap of another kind, or a
        // different value, used to count as going unnoticed here.
        JSON.stringify(r.results.map((x) => x.result)) !== correct.get(file)
      )
        out.otherFailures++;
      else {
        // Did that increment ever do anything? With counters on, the total says.
        out.silent++;
        if ((await counted(file, {})).incs === (await counted(file, { omitInc: omit })).incs) {
          out.silentNeverRan++;
          if (emitted(file, { omitInc: omit }) === emitted(file, {})) out.notInTheCode++;
          else if (await reached(file, { probeInc: omit })) out.reachedOnlyNull++;
          else out.neverReached++;
        } else out.silentSites.push(name(file, omit));
      }
      return;
    }
    const cases = casesOf(file);
    const all = Array.from({ length: 3 }, () => cases).flat();
    const r = await runOne(
      file,
      all,
      accel,
      { ...rcBase, account: true, omitDec: omit },
      { stats: true, collect: true },
    );
    if (r.skipped) {
      out.skipped = true;
      return;
    }
    out.decTried++;
    const at = (k: number): number => r.stats[(k + 1) * cases.length - 1]?.live_bytes ?? 0;
    if (at(2) > at(1) || !r.ok) {
      out.decLeaked++;
      return;
    }
    if ((await counted(file, {})).decs === (await counted(file, { omitDec: omit })).decs) {
      out.decNeverRan++;
      if (emitted(file, { omitDec: omit }) === emitted(file, {})) out.decNotInTheCode++;
      else if (await reached(file, { probeDec: omit })) out.decReachedOnlyNull++;
      else {
        out.decNeverReached++;
        out.decNeverReachedSites.push(name(file, omit));
      }
    } else out.decImmortal.push(name(file, omit));
  });
  return out;
}

/** The freeing bound as a count of steps, on what's dropped in adv_large_drop: never more than the budget, per allocation. */
export async function boundTest(
  accel: Accel,
  file = join(ROOT, "corpus/lower/rc/adv_large_drop.ts"),
): Promise<{
  budget: number;
  maxSteps: number;
  fullDrains: number;
  steps: number;
  allocs: number;
  ok: boolean;
  why: string;
  skipped: boolean;
}> {
  const r = await runOne(file, casesOf(file), accel, { account: true }, { stats: true });
  const { RC_BUDGET } = await import("../compiler/host/down-rt.ts");
  const last = r.stats[r.stats.length - 1] ?? {};
  return {
    budget: RC_BUDGET,
    maxSteps: last.max_steps ?? -1,
    fullDrains: last.full_drains ?? -1,
    steps: last.steps ?? -1,
    allocs: last.allocs ?? -1,
    ok: r.ok && r.problems.length === 0,
    why: r.why,
    skipped: r.skipped,
  };
}

/**
 * Static and dynamic counts of inc and dec, with and without borrow elision, over the same cases. Without it every
 * parameter and local is held as if nothing could be proved, so the difference is what the proofs removed.
 */
export async function elisionFigures(
  accel: Accel,
  jobs: number,
  programs?: string[],
): Promise<{
  programs: number;
  staticOn: number;
  staticOff: number;
  dynamicOn: number;
  dynamicOff: number;
  rows: { program: string; on: number; off: number }[];
  failures: string[];
}> {
  const list =
    programs ??
    (await rcProgramsApart()).filter(
      (f) => !f.includes("adv_large_drop") && !f.includes("math_values"),
    );
  const out = {
    programs: 0,
    staticOn: 0,
    staticOff: 0,
    dynamicOn: 0,
    dynamicOff: 0,
    rows: [] as { program: string; on: number; off: number }[],
    failures: [] as string[],
  };
  await pool(list, jobs, async (file) => {
    // Each gets its own copy: running a case writes back into the arguments it was given.
    const on = await runOne(file, casesOf(file), accel, { account: true }, { stats: true });
    const off = await runOne(
      file,
      casesOf(file),
      accel,
      { account: true, elide: false },
      { stats: true },
    );
    if (on.skipped || off.skipped) return;
    const sum = (r: OneRun): number => {
      const s = r.stats.filter((x) => x !== undefined).at(-1);
      return (s?.incs ?? 0) + (s?.decs ?? 0);
    };
    if (!on.ok || !off.ok) {
      out.failures.push(
        `${file.slice(ROOT.length + 1)}: ${on.why.slice(0, 120)} ${off.why.slice(0, 120)}`,
      );
      return;
    }
    const same = JSON.stringify(on.results) === JSON.stringify(off.results);
    if (!same) out.failures.push(`${file.slice(ROOT.length + 1)}: results differ with elision off`);
    out.programs++;
    out.staticOn += on.o.rc!.incSites + on.o.rc!.decSites;
    out.staticOff += off.o.rc!.incSites + off.o.rc!.decSites;
    out.dynamicOn += sum(on);
    out.dynamicOff += sum(off);
    out.rows.push({ program: file.slice(ROOT.length + 1), on: sum(on), off: sum(off) });
  });
  out.rows.sort((a, b) => b.off - a.off);
  return out;
}

export interface LatencyResult {
  skipped: string | null;
  frequency: number;
  phases: {
    name: string;
    n: number;
    medianTicks: number;
    p99Ticks: number;
    maxTicks: number;
    medianNs: number;
    p99Ns: number;
    maxNs: number;
  }[];
  dropped: number;
}

/**
 * Allocation time, including its bounded freeing work, by the counter, with and without a large drop pending. Under QEMU
 * this isn't a gate: a host can preempt the guest. The bound itself is `boundTest`, in steps.
 */
export async function latency(
  accel: Accel = "hvf",
  nodes = 1000000,
  samples = 200000,
): Promise<LatencyResult> {
  const out: LatencyResult = { skipped: null, frequency: 0, phases: [], dropped: nodes };
  if (accel === "hvf" && !hvfAvailable().ok) {
    out.skipped = "HVF is unavailable";
    return out;
  }
  const file = join(ROOT, "corpus/lower/rc/adv_large_drop.ts");
  // the direct route's runtime (`__rc_new`, `__rc_release`), which this measures: since R36 `auto` takes the program through
  // the TSL route
  const o = lowerFile(file, { memory: "rc", route: "direct" });
  const m = o.tir as Module;
  const drv = new Driver(m);
  drv.globals.push({ name: "__lat", size: samples * 8, align: 8, section: "data" });
  drv.pageRange();
  drv.arenaUse();
  const phase = (b: FuncBuilder, name: string): void => {
    const head = b.block(["i64"]);
    const inner = b.block();
    const done = b.block();
    b.br(head, [b.i64(0)]);
    b.at(head);
    const i = head.params[0]!;
    b.brif(b.op("icmp.ult.i64", [i, b.i64(samples)], "i32"), inner, done);
    b.at(inner);
    const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    const p = b.call("__rc_new", [b.ix(16), b.i32(0)], ["ptr"])[0]!;
    const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    b.call("__rc_release", [p]);
    b.store(
      "i64",
      b.gep(b.global("__lat"), b.op("bitcast.ix", [i], "ix"), 8, 0),
      b.op("sub.i64", [t1, t0], "i64"),
    );
    b.br(head, [b.op("add.i64", [i, b.i64(1)], "i64")]);
    b.at(done);
    drv.puts(b, `TMK:LAT ${name}`);
    const h2 = b.block(["i64"]);
    const in2 = b.block();
    const d2 = b.block();
    b.br(h2, [b.i64(0)]);
    b.at(h2);
    const j = h2.params[0]!;
    b.brif(b.op("icmp.ult.i64", [j, b.i64(samples)], "i32"), in2, d2);
    b.at(in2);
    b.call("__rt_sp", []);
    b.call("__rt_dec", [
      b.load("i64", b.gep(b.global("__lat"), b.op("bitcast.ix", [j], "ix"), 8, 0)),
    ]);
    b.br(h2, [b.op("add.i64", [j, b.i64(1)], "i64")]);
    b.at(d2);
    b.call("__rt_nl", []);
  };
  const main = new FuncBuilder("__tmk_main", [], []);
  drv.puts(main, "TMK:F ");
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  const mid = main.at0(base, 16 * 1024 * 1024);
  main.call("__arena_use", [base, mid]);
  drv.usePageRange(main, mid, limit);
  main.call("__init", []);
  phase(main, "idle");
  const f64 = (n: number): number =>
    main.fbits("f64", new BigUint64Array(new Float64Array([n]).buffer)[0]!);
  const sig = drv.sigOf("buildList");
  const nArg = sig.params[0] === "f64" ? f64(nodes) : main.i32(nodes);
  main.call("buildList", [nArg], sig.rets);
  const sigD = drv.sigOf("dropList");
  main.call("dropList", [], sigD.rets);
  phase(main, "after a 1M-node drop");
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(o.meta!.strings);
  const image = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 512 * 1024 * 1024,
  }).bytes;
  const r = await qemuRun({ name: "rc/latency", image, accel, timeoutMs: 300_000 });
  if (!r.ok) {
    out.skipped = `${r.status}: ${r.why.slice(0, 300)}`;
    return out;
  }
  const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))?.slice(6) ?? 0);
  out.frequency = freq;
  for (const l of r.lines) {
    if (!l.startsWith("TMK:LAT ")) continue;
    const m1 = /^TMK:LAT ([^0-9 ][^ ]*(?: [^0-9 ][^ ]*| 1M-node)*) (.*)$/.exec(l);
    const name = l.startsWith("TMK:LAT idle") ? "idle" : "after a 1M-node drop";
    void m1;
    const nums = l
      .slice(`TMK:LAT ${name}`.length)
      .trim()
      .split(" ")
      .map(Number)
      .sort((a, b) => a - b);
    const q = (p: number): number => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))]!;
    const toNs = (t: number): number => (t / freq) * 1e9;
    out.phases.push({
      name,
      n: nums.length,
      medianTicks: q(0.5),
      p99Ticks: q(0.99),
      maxTicks: nums[nums.length - 1]!,
      medianNs: toNs(q(0.5)),
      p99Ns: toNs(q(0.99)),
      maxNs: toNs(nums[nums.length - 1]!),
    });
  }
  return out;
}

// --- the cycle collector (SPEC 3.5, D41, M5 Phase E)

const INTERLEAVE = "corpus/lower/rc/cyc_interleave.ts";
/** R1e: a count reaching zero during a scan, at every phase: run beside INTERLEAVE at each budget. */
const GIVEUP = "corpus/lower/rc/cyc_giveup.ts";
const CHURN = "corpus/lower/rc/cyc_churn.ts";
const WEAK = "corpus/lower/rc-only/cyc_weak.ts";

/** What the source gives on V8, for a program with no WeakRef whose target can go. */
async function onV8(file: string, cases: LowerCase[]): Promise<LowerCaseResult[]> {
  const dir = buildPath("rc-cycles");
  mkdirSync(dir, { recursive: true });
  const c = lowerCommand("source-v8", file, dir, defaultEngines());
  const r = await guardedRun(c.cmd, c.args, { timeoutMs: 300_000, label: `V8 ${file}`, cwd: ROOT });
  if (!r.ok) throw new Error(`V8 on ${file}: ${r.why} ${r.stderr.slice(0, 300)}`);
  const got = JSON.parse(r.stdout) as LowerCaseResult[];
  if (got.length !== cases.length) throw new Error(`V8 on ${file}: ${got.length} results`);
  return got;
}

export interface ChurnRow {
  fn: string;
  offTrap: number | null;
  onSame: boolean;
  poisonSame: boolean;
  fullDrains: number;
  freed: number;
  maxSteps: number;
  why: string;
}

/**
 * Each kind of cycle alone, under one page limit: it traps 14 with the collector off, and completes with it on, in the release
 * build and the poisoning build, with V8's result.
 */
export async function cycleChurn(
  accel: Accel,
  jobs: number,
): Promise<{ rows: ChurnRow[]; failures: string[]; skipped: boolean }> {
  const file = join(ROOT, CHURN);
  const all = casesOf(file);
  const v8 = await onV8(file, all);
  const rows: ChurnRow[] = [];
  const failures: string[] = [];
  let skipped = false;
  await pool(
    all.map((c, i) => ({ c, i })),
    jobs,
    async ({ c, i }) => {
      const want = JSON.stringify(v8[i]!.result);
      const off = await runOne(file, [c], accel, { cycles: false }, {});
      const on = await runOne(file, [c], accel, { cycles: true }, {});
      const poison = await runOne(
        file,
        [c],
        accel,
        { cycles: true, check: true, account: true },
        { stats: true },
      );
      if (off.skipped || on.skipped || poison.skipped) {
        skipped = true;
        return;
      }
      const row: ChurnRow = {
        fn: c.fn,
        offTrap: (off.results[0]?.result as { trap?: number } | undefined)?.trap ?? null,
        onSame: JSON.stringify(on.results[0]?.result) === want,
        poisonSame: JSON.stringify(poison.results[0]?.result) === want,
        fullDrains: poison.stats[0]?.full_drains ?? -1,
        freed: poison.stats[0]?.cc_freed ?? -1,
        maxSteps: poison.stats[0]?.max_steps ?? -1,
        why: on.why,
      };
      rows.push(row);
      if (row.offTrap !== 14)
        failures.push(`${c.fn}: with the collector off: ${JSON.stringify(off.results[0]?.result)}`);
      if (!row.onSame)
        failures.push(
          `${c.fn}: on: ${JSON.stringify(on.results[0]?.result)}, V8 gave ${want}, ${on.why.slice(0, 200)}`,
        );
      if (!row.poisonSame)
        failures.push(
          `${c.fn}: poison: ${JSON.stringify(poison.results[0]?.result)}, V8 gave ${want}, ${poison.why.slice(0, 200)}`,
        );
    },
  );
  rows.sort((a, b) => (a.fn < b.fn ? -1 : 1));
  return { rows, failures, skipped };
}

export interface InterleaveResult {
  budgets: number[];
  images: number;
  cases: number;
  freed: number;
  touches: number;
  maxScan: number;
  failures: string[];
  skipped: boolean;
}

/**
 * User code between collector steps, at every budget (SPEC 3.5, D41): with no pacing, an allocation is exactly `budget` steps,
 * so at budget 1 a program changes things after every step there is. Every program is run in the poisoning build against V8,
 * and pinned rc-only for weak references.
 */
export async function interleave(
  accel: Accel,
  jobs: number,
  budgets: number[],
  extra: Record<string, unknown> = {},
  limit?: number,
): Promise<InterleaveResult> {
  const file = join(ROOT, INTERLEAVE);
  const weak = join(ROOT, WEAK);
  const cases = casesOf(file).map((c) =>
    limit !== undefined && c.args.length === 2
      ? { ...c, args: [c.args[0]!, Math.min(c.args[1] as number, limit)] }
      : c,
  ) as LowerCase[];
  const dir = buildPath("rc-cycles");
  mkdirSync(dir, { recursive: true });
  const trimmed = join(dir, "interleave.cases.json");
  writeFileSync(trimmed, JSON.stringify(cases));
  const v8 = await onV8Cases(file, cases);
  const giveUpFile = join(ROOT, GIVEUP);
  const giveUpCases = casesOf(giveUpFile).map((c) =>
    limit !== undefined && c.args.length === 2
      ? { ...c, args: [c.args[0]!, Math.min(c.args[1] as number, limit)] }
      : c,
  ) as LowerCase[];
  const giveUpV8 = await onV8Cases(giveUpFile, giveUpCases);
  const weakCases = casesOf(weak) as (LowerCase & { value?: number })[];
  const out: InterleaveResult = {
    budgets,
    images: 0,
    cases: 0,
    freed: 0,
    touches: 0,
    maxScan: 0,
    failures: [],
    skipped: false,
  };
  await pool(
    budgets.flatMap((budget) => [
      { budget, weak: false, giveUp: false },
      { budget, weak: true, giveUp: false },
      { budget, weak: false, giveUp: true },
    ]),
    jobs,
    async (t) => {
      const rc = {
        check: true,
        account: true,
        cycles: true,
        pace: false,
        budget: t.budget,
        ...extra,
      };
      const where = `${t.giveUp ? "giving up, " : ""}budget ${t.budget}`;
      if (!t.weak) {
        const prog = t.giveUp ? giveUpFile : file;
        const progCases = t.giveUp ? giveUpCases : cases;
        const want = t.giveUp ? giveUpV8 : v8;
        const r = await runOne(prog, progCases, accel, rc, { stats: true, collect: true });
        if (r.skipped) {
          out.skipped = true;
          return;
        }
        out.images++;
        if (!r.ok) out.failures.push(`${where}: ${r.why.slice(0, 200)}`);
        for (const p of r.problems) out.failures.push(`${where}: ${p}`);
        r.results.forEach((x, i) => {
          out.cases++;
          const a = JSON.stringify(x.result);
          const b = JSON.stringify(want[i]?.result);
          if (a !== b)
            out.failures.push(`${where} ${x.fn}: ${a.slice(0, 100)}, V8 gave ${b?.slice(0, 100)}`);
        });
        const last = r.stats.filter((x) => x !== undefined).at(-1);
        out.freed += last?.cc_freed ?? 0;
        out.touches += last?.cc_touches ?? 0;
        out.maxScan = Math.max(out.maxScan, last?.cc_max_scan ?? 0);
        if (last !== undefined && last.live_objects !== 0)
          out.failures.push(`${where}: ${last.live_objects} objects still live at the end`);
        return;
      }
      const r = await runOne(weak, weakCases, accel, rc, { stats: true });
      if (r.skipped) {
        out.skipped = true;
        return;
      }
      out.images++;
      if (!r.ok) out.failures.push(`weak ${where}: ${r.why.slice(0, 200)}`);
      r.results.forEach((x, i) => {
        out.cases++;
        const got = x.result as { trap?: number; value?: { n?: string } | number };
        const n = (got.value as { n?: string })?.n;
        const v =
          n !== undefined
            ? new Float64Array(new BigUint64Array([BigInt(`0x${n}`)]).buffer)[0]
            : got.value;
        if (v !== weakCases[i]!.value)
          out.failures.push(
            `weak ${where} ${x.fn}: ${JSON.stringify(got)}, wanted ${weakCases[i]!.value}`,
          );
      });
    },
  );
  return out;
}

/** V8 on a set of cases that isn't the program's file of them. */
async function onV8Cases(file: string, cases: LowerCase[]): Promise<LowerCaseResult[]> {
  const dir = buildPath("rc-cycles");
  const engines = defaultEngines();
  const casesPath = join(dir, `${basename(file, ".ts")}.v8cases.json`);
  writeFileSync(casesPath, JSON.stringify(cases));
  const r = await guardedRun(
    engines.node,
    [
      "--import",
      join(ROOT, "tools/ts-hook.mjs"),
      "--no-warnings",
      join(ROOT, "tools/lower-exec.ts"),
      JSON.stringify({ mode: "source", program: file, cases: casesPath }),
    ],
    { timeoutMs: 300_000, label: `V8 ${file}`, cwd: ROOT },
  );
  if (!r.ok) throw new Error(`V8 on ${file}: ${r.why} ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout) as LowerCaseResult[];
}

export const CC_FAULTS: { name: string; rc: Record<string, unknown> }[] = [
  { name: "the barrier on a count left out", rc: { ccFault: "no-touch" } },
  { name: "the barrier on a move left out", rc: { noMoveTouch: true } },
  { name: "a count not compared with the edges found", rc: { ccFault: "no-count-check" } },
  { name: "what's held not followed", rc: { ccFault: "no-trace" } },
  { name: "a touch not asking for another pass", rc: { ccFault: "no-rescan" } },
  { name: "deref not asking whether its target is decided", rc: { ccFault: "no-weak-gate" } },
  {
    name: "a scan deciding before what it gave up has been freed (R1e)",
    rc: { ccFault: "no-giveup-wait" },
  },
];

/** Are the tests above vacuous? Each mistake put into the collector has to show. */
export async function collectorFaults(
  accel: Accel,
  jobs: number,
): Promise<{ rows: { fault: string; failures: number; first: string }[]; skipped: boolean }> {
  const rows: { fault: string; failures: number; first: string }[] = [];
  let skipped = false;
  for (const f of CC_FAULTS) {
    const r = await interleave(accel, jobs, [1, 2, 3, 4, 5, 8], f.rc);
    if (r.skipped) skipped = true;
    rows.push({
      fault: f.name,
      failures: r.failures.length,
      first: firstInOrder(r.failures)?.slice(0, 160) ?? "",
    });
  }
  return { rows, skipped };
}

export interface CycleBound {
  ring: number;
  list: number;
  budget: number;
  maxSteps: number;
  fullDrains: number;
  steps: number;
  ccSteps: number;
  allocs: number;
  freed: number;
  scans: number;
  roots: number;
  retries: number;
  touches: number;
  evicted: number;
  walks: number;
  fruitless: number;
  maxPasses: number;
  maxScan: number;
  ok: boolean;
  why: string;
  skipped: boolean;
}

/** The collector's bound, as steps, in the build as it ships (paced), on a large ring and a large doubly linked list. */
export async function cycleBound(accel: Accel): Promise<CycleBound> {
  const file = join(ROOT, "corpus/lower/rc/cyc_large.ts");
  const cases = casesOf(file);
  const r = await runOne(file, cases, accel, { account: true, cycles: true }, { stats: true });
  const { RC_BUDGET } = await import("../compiler/host/down-rt.ts");
  const last = r.stats.filter((x) => x !== undefined).at(-1) ?? {};
  const ring = cases[0]!.args[0] as number;
  const list = cases[5]!.args[0] as number;
  return {
    ring,
    list,
    budget: RC_BUDGET,
    maxSteps: last.max_steps ?? -1,
    fullDrains: last.full_drains ?? -1,
    steps: last.steps ?? -1,
    ccSteps: last.cc_steps ?? -1,
    allocs: last.allocs ?? -1,
    freed: last.cc_freed ?? -1,
    scans: last.cc_scans ?? -1,
    roots: last.cc_roots ?? -1,
    retries: last.cc_retries ?? -1,
    touches: last.cc_touches ?? -1,
    evicted: last.cc_evicted ?? -1,
    walks: last.cc_walks ?? -1,
    fruitless: last.cc_fruitless ?? -1,
    maxPasses: last.cc_max_passes ?? -1,
    maxScan: last.cc_max_scan ?? -1,
    ok: r.ok && r.problems.length === 0,
    why: r.why,
    skipped: r.skipped,
  };
}

/** The shape that needs the most passes: the honest worst case of the marking phase, measured on one size after another. */
export async function zigzag(
  accel: Accel,
  sizes: number[],
): Promise<{ n: number; passes: number; steps: number; alive: boolean }[]> {
  const file = join(ROOT, "corpus/lower/rc/cyc_large.ts");
  const out: { n: number; passes: number; steps: number; alive: boolean }[] = [];
  for (const n of sizes) {
    const r = await runOne(
      file,
      [
        { fn: "buildZigzag", args: [n] },
        { fn: "ticks", args: [8] },
      ],
      accel,
      { account: true, cycles: true, pace: false, check: true },
      { stats: true, collect: true },
    );
    const s = r.stats.at(-1);
    out.push({ n, passes: s?.cc_max_passes ?? -1, steps: s?.cc_steps ?? -1, alive: r.ok });
  }
  return out;
}

/**
 * Allocation time during a large cycle's collection, by the counter, in a test build with no pacing, so that every allocation
 * really does its share. No gate: timing under QEMU isn't one.
 */
export async function cycleLatency(
  accel: Accel = "hvf",
  nodes = 500000,
  samples = 200000,
): Promise<LatencyResult & { collected: boolean }> {
  const out: LatencyResult & { collected: boolean } = {
    skipped: null,
    frequency: 0,
    phases: [],
    dropped: nodes,
    collected: false,
  };
  if (accel === "hvf" && !hvfAvailable().ok) {
    out.skipped = "HVF is unavailable";
    return out;
  }
  const file = join(ROOT, "corpus/lower/rc/cyc_large.ts");
  const o = lowerFile(file, { memory: "rc", rc: { cycles: true, pace: false } });
  const m = o.tir as Module;
  const drv = new Driver(m);
  drv.globals.push({ name: "__lat", size: samples * 8, align: 8, section: "data" });
  drv.pageRange();
  drv.arenaUse();
  const phase = (b: FuncBuilder, name: string): void => {
    const head = b.block(["i64"]);
    const inner = b.block();
    const done = b.block();
    b.br(head, [b.i64(0)]);
    b.at(head);
    const i = head.params[0]!;
    b.brif(b.op("icmp.ult.i64", [i, b.i64(samples)], "i32"), inner, done);
    b.at(inner);
    const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    const p = b.call("__rc_new", [b.ix(16), b.i32(0)], ["ptr"])[0]!;
    const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    b.call("__rc_release", [p]);
    b.store(
      "i64",
      b.gep(b.global("__lat"), b.op("bitcast.ix", [i], "ix"), 8, 0),
      b.op("sub.i64", [t1, t0], "i64"),
    );
    b.br(head, [b.op("add.i64", [i, b.i64(1)], "i64")]);
    b.at(done);
    drv.puts(b, `TMK:LAT ${name}`);
    const h2 = b.block(["i64"]);
    const in2 = b.block();
    const d2 = b.block();
    b.br(h2, [b.i64(0)]);
    b.at(h2);
    const j = h2.params[0]!;
    b.brif(b.op("icmp.ult.i64", [j, b.i64(samples)], "i32"), in2, d2);
    b.at(in2);
    b.call("__rt_sp", []);
    b.call("__rt_dec", [
      b.load("i64", b.gep(b.global("__lat"), b.op("bitcast.ix", [j], "ix"), 8, 0)),
    ]);
    b.br(h2, [b.op("add.i64", [j, b.i64(1)], "i64")]);
    b.at(d2);
    b.call("__rt_nl", []);
  };
  const main = new FuncBuilder("__tmk_main", [], []);
  drv.puts(main, "TMK:F ");
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  const mid = main.at0(base, 16 * 1024 * 1024);
  main.call("__arena_use", [base, mid]);
  drv.usePageRange(main, mid, limit);
  main.call("__init", []);
  phase(main, "idle");
  const call = (fn: string, ...args: number[]): void => {
    const sig = drv.sigOf(fn);
    const vals = args.map((a, i) =>
      sig.params[i] === "f64"
        ? main.fbits("f64", new BigUint64Array(new Float64Array([a]).buffer)[0]!)
        : main.i32(a),
    );
    main.call(fn, vals, sig.rets);
  };
  call("buildRing", nodes);
  phase(main, "ring-held");
  call("dropRing");
  phase(main, "ring");
  call("buildList", nodes);
  phase(main, "list-held");
  call("dropList");
  phase(main, "list");
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(o.meta!.strings);
  const image = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 512 * 1024 * 1024,
  }).bytes;
  const r = await qemuRun({ name: "rc/cycle-latency", image, accel, timeoutMs: 300_000 });
  if (!r.ok) {
    out.skipped = `${r.status}: ${r.why.slice(0, 300)}`;
    return out;
  }
  const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))?.slice(6) ?? 0);
  out.frequency = freq;
  const names: Record<string, string> = {
    idle: "nothing pending",
    "ring-held": "a ring, held, scanned over and over",
    ring: "a dropped ring being collected",
    "list-held": "a doubly linked list, held",
    list: "a dropped doubly linked list being collected",
  };
  for (const l of r.lines) {
    if (!l.startsWith("TMK:LAT ")) continue;
    const parts = l.split(" ");
    const name = names[parts[1]!] ?? parts[1]!;
    const nums = parts
      .slice(2)
      .map(Number)
      .sort((a, b) => a - b);
    const q = (p: number): number => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))]!;
    const toNs = (t: number): number => (t / freq) * 1e9;
    out.phases.push({
      name,
      n: nums.length,
      medianTicks: q(0.5),
      p99Ticks: q(0.99),
      maxTicks: nums[nums.length - 1]!,
      medianNs: toNs(q(0.5)),
      p99Ns: toNs(q(0.99)),
      maxNs: toNs(nums[nums.length - 1]!),
    });
  }
  return out;
}

export interface ListDiagnosis {
  rows: { what: string; iteration: number; ms: number; sequential: number; samePage: number }[];
  /**
   * R16: each variant over its last iterations, `tailFrom` to `tailTo`: the median time and the median share on one page,
   * which native-e box 9 compares (one sample each, at 199, before: a single scheduling hiccup could flip it).
   */
  tails: { what: string; n: number; medianMs: number; medianSamePage: number }[];
  tailFrom: number;
  tailTo: number;
}

/** The median of a list of numbers (the mean of the middle two where it's even). */
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Why the lowered list slows down as it's reused (SPEC M5 Phase E): each iteration's time, and how often the next node along
 * the list is the next block in memory, or in the same page. `blocks not reused` keeps all the counting and freeing, but gives
 * no block back, so what's left of the slowdown isn't the counts.
 */
export async function listDiagnosis(
  accel: Accel = "hvf",
  // R16: a bug put into the diagnosis, to show box 9 fails with it (tools/r16-tests.ts's BOX9_FAULTS): "ordered-free-list",
  // the reused variant's freed blocks never reused, as a free list keeping the list's order would make it; "short-work", the
  // reused variant timed over a tenth of the work
  fault?: string,
): Promise<ListDiagnosis> {
  const file = join(ROOT, "bench/memory/list_lowered.ts");
  const tailFrom = 180;
  const tailTo = 199;
  const out: ListDiagnosis = { rows: [], tails: [], tailFrom, tailTo };
  const variants: {
    what: string;
    memory: string;
    rc: Record<string, unknown>;
    noReuse?: boolean;
  }[] = [
    { what: "leak", memory: "leak", rc: {} },
    {
      what: "rc, collector off, budget 32 (16 frees an allocation)",
      memory: "rc",
      rc: { cycles: false },
    },
    {
      what: "rc, collector off, blocks not reused",
      memory: "rc",
      rc: { cycles: false },
      noReuse: true,
    },
    {
      what: "rc, collector off, budget 2 (1 free an allocation)",
      memory: "rc",
      rc: { cycles: false, budget: 2 },
    },
    { what: "rc, collector on", memory: "rc", rc: { cycles: true } },
  ];
  const iters = 200;
  for (const v of variants) {
    // Lowered at -O0 and changed there, then optimised at the level asked: at -O2 the function being replaced is
    // inlined into its callers, and replacing it afterwards would change nothing (SPEC D46).
    const o = lowerFile(file, { memory: v.memory, rc: v.rc, opt: 0 });
    let m = cloneModule(o.tir as Module);
    const reusedVariant = v.what.startsWith("rc, collector off, budget 32");
    if (v.noReuse === true || (fault === "ordered-free-list" && reusedVariant)) {
      const i = m.funcs.findIndex((f) => f.name === "__rc_block_free");
      m.funcs[i] = assemble("func @__rc_block_free(%p: ptr) -> () {\nbb_e:\n  ret\n}").funcs[0]!;
    }
    m = optimizeModule(canonicalize(m), optFromEnv()).module;
    const drv = new Driver(m);
    drv.pageRange();
    drv.arenaUse();
    const main = new FuncBuilder("__tmk_main", [], []);
    drv.puts(main, "TMK:F ");
    main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
    main.call("__rt_nl", []);
    const base = main.load("ptr", main.global("__mem_base"));
    const limit = main.load("ptr", main.global("__mem_limit"));
    const mid = main.at0(base, 16 * 1024 * 1024);
    main.call("__arena_use", [base, mid]);
    drv.usePageRange(main, mid, limit);
    main.call("__init", []);
    const sig = drv.sigOf("listWork");
    const work = fault === "short-work" && reusedVariant ? 2000 : 20000;
    const arg = main.fbits("f64", new BigUint64Array(new Float64Array([work]).buffer)[0]!);
    const head = main.block(["i64"]);
    const inner = main.block();
    const done = main.block();
    main.br(head, [main.i64(0)]);
    main.at(head);
    main.brif(main.op("icmp.ult.i64", [head.params[0]!, main.i64(iters)], "i32"), inner, done);
    main.at(inner);
    const t0 = main.intrinsic("native.counter", [], ["i64"])[0]!;
    main.call("listWork", [arg], sig.rets);
    const t1 = main.intrinsic("native.counter", [], ["i64"])[0]!;
    const h2 = main.block(["ptr", "i64", "i64", "i64"]);
    const in2 = main.block();
    const d2 = main.block();
    main.br(h2, [main.load("ptr", main.global("g.head")), main.i64(0), main.i64(0), main.i64(0)]);
    main.at(h2);
    const [p, seq, pg, cnt] = h2.params as [number, number, number, number];
    main.brif(
      main.op("icmp.ne.i64", [main.op("bitcast.i64", [p], "i64"), main.i64(0)], "i32"),
      in2,
      d2,
    );
    main.at(in2);
    const nx = main.load("ptr", p);
    const a = main.op("bitcast.i64", [p], "i64");
    const b = main.op("bitcast.i64", [nx], "i64");
    const adjacent = main.op(
      "icmp.eq.i64",
      [main.op("sub.i64", [a, b], "i64"), main.i64(32)],
      "i32",
    );
    const same = main.op(
      "icmp.eq.i64",
      [
        main.op("lshr.i64", [a, main.i64(12)], "i64"),
        main.op("lshr.i64", [b, main.i64(12)], "i64"),
      ],
      "i32",
    );
    main.br(h2, [
      nx,
      main.op("add.i64", [seq, main.op("zext.i64", [adjacent], "i64")], "i64"),
      main.op("add.i64", [pg, main.op("zext.i64", [same], "i64")], "i64"),
      main.op("add.i64", [cnt, main.i64(1)], "i64"),
    ]);
    main.at(d2);
    drv.puts(main, "TMK:L ");
    main.call("__rt_dec", [main.op("sub.i64", [t1, t0], "i64")]);
    main.call("__rt_sp", []);
    main.call("__rt_dec", [seq]);
    main.call("__rt_sp", []);
    main.call("__rt_dec", [pg]);
    main.call("__rt_sp", []);
    main.call("__rt_dec", [cnt]);
    main.call("__rt_nl", []);
    main.br(head, [main.op("add.i64", [head.params[0]!, main.i64(1)], "i64")]);
    main.at(done);
    main.ret();
    drv.funcs.push(main.finish());
    drv.trapMessages(o.meta!.strings);
    const image = buildImage({
      module: m,
      driverFuncs: drv.funcs,
      driverGlobals: drv.globals,
      ramBytes: 512 * 1024 * 1024,
    }).bytes;
    const r = await qemuRun({ name: "rc/list-diagnosis", image, accel, timeoutMs: 180_000 });
    if (!r.ok) throw new Error(`list diagnosis, ${v.what}: ${r.why.slice(0, 300)}`);
    const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))?.slice(6) ?? 0);
    const rows = r.lines
      .filter((l) => l.startsWith("TMK:L "))
      .map((l) => l.split(" ").slice(1).map(Number));
    for (const k of [1, 20, 60, 199]) {
      const x = rows[k]!;
      out.rows.push({
        what: v.what,
        iteration: k,
        ms: (x[0]! / freq) * 1000,
        sequential: x[1]! / x[3]!,
        samePage: x[2]! / x[3]!,
      });
    }
    // R16: iterations tailFrom to tailTo, each a row; a missing one leaves the tail short, which box 9 refuses
    const tail = rows.slice(tailFrom, tailTo + 1).filter((x) => x.length >= 4 && x[3]! > 0);
    out.tails.push({
      what: v.what,
      n: tail.length,
      medianMs: tail.length > 0 ? medianOf(tail.map((x) => (x[0]! / freq) * 1000)) : NaN,
      medianSamePage: tail.length > 0 ? medianOf(tail.map((x) => x[2]! / x[3]!)) : NaN,
    });
  }
  return out;
}

/** A candidate that doesn't fit in the table is forgotten, not lost: the exhaustion path walks the heap for it. */
export async function forgottenCandidates(accel: Accel): Promise<{
  value: unknown;
  evicted: number;
  walks: number;
  freed: number;
  drains: number;
  ok: boolean;
}> {
  const file = join(ROOT, "corpus/lower/rc-only/cyc_exhaust.ts");
  const r = await runOne(
    file,
    [{ fn: "forgotten", args: [40] }],
    accel,
    { account: true, check: true, cycles: true },
    { stats: true },
  );
  const s = r.stats[0] ?? {};
  return {
    value: r.results[0]?.result,
    evicted: s.cc_evicted ?? -1,
    walks: s.cc_walks ?? -1,
    freed: s.cc_freed ?? -1,
    drains: s.full_drains ?? -1,
    ok: r.ok,
  };
}

/**
 * The cycle collector's latency in TSL `rc` (R1c, D41), M5 Phase E's test ported: corpus/rc-latency/cyc_latency.ts
 * compiled by tslc, and a driver that times each of its `step` calls, one allocation with its freeing and collecting work,
 * by the counter, in four phases (nothing pending, a dropped ring, a dropped doubly linked list, a live ring scanned over
 * and over), with no pacing. Reports the median, p99 and maximum, and the most steps any allocation took, which is
 * deterministic. The timing isn't a gate.
 */
export async function tslCycleLatency(
  accel: Accel = "hvf",
  samples = 200000,
  size = 100000,
): Promise<LatencyResult & { maxSteps: number[]; freed: number[] }> {
  const out: LatencyResult & { maxSteps: number[]; freed: number[] } = {
    skipped: null,
    frequency: 0,
    phases: [],
    dropped: size,
    maxSteps: [],
    freed: [],
  };
  if (accel === "hvf" && !hvfAvailable().ok) {
    out.skipped = "HVF is unavailable";
    return out;
  }
  const { checkFile, compileTyped } = await import("./lowering.ts");
  const file = join(ROOT, "corpus/rc-latency/cyc_latency.ts");
  const c = checkFile(file);
  if (c.typed === null) throw new Error(`cyc_latency.ts: ${JSON.stringify(c.diags)}`);
  const o = compileTyped(c.typed);
  const m = o.tir;
  const drv = new Driver(m);
  drv.globals.push({ name: "__lat", size: samples * 8, align: 8, section: "data" });
  const names = ["idle", "ring", "doubly-linked", "live"];
  const list: { run: string; after: string }[] = [];
  names.forEach((name, p) => {
    const b = new FuncBuilder(`__case_${p}`, [], []);
    b.call("setup", [b.i32(p), b.i32(size)], drv.sigOf("setup").rets);
    const head = b.block(["i64"]);
    const inner = b.block();
    const done = b.block();
    b.br(head, [b.i64(0)]);
    b.at(head);
    const i = head.params[0]!;
    b.brif(b.op("icmp.ult.i64", [i, b.i64(samples)], "i32"), inner, done);
    b.at(inner);
    const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    b.call("step", [b.i32(p), b.op("trunc.i32", [i], "i32")], drv.sigOf("step").rets);
    const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
    b.store(
      "i64",
      b.gep(b.global("__lat"), b.op("bitcast.ix", [i], "ix"), 8, 0),
      b.op("sub.i64", [t1, t0], "i64"),
    );
    b.br(head, [b.op("add.i64", [i, b.i64(1)], "i64")]);
    b.at(done);
    drv.puts(b, `TMK:LAT ${name}`);
    const h2 = b.block(["i64"]);
    const in2 = b.block();
    const d2 = b.block();
    b.br(h2, [b.i64(0)]);
    b.at(h2);
    const j = h2.params[0]!;
    b.brif(b.op("icmp.ult.i64", [j, b.i64(samples)], "i32"), in2, d2);
    b.at(in2);
    b.call("__rt_sp", []);
    b.call("__rt_dec", [
      b.load("i64", b.gep(b.global("__lat"), b.op("bitcast.ix", [j], "ix"), 8, 0)),
    ]);
    b.br(h2, [b.op("add.i64", [j, b.i64(1)], "i64")]);
    b.at(d2);
    b.call("__rt_nl", []);
    const fr = b.call("freed", [], ["i32"])[0]!;
    drv.puts(b, "TMK:FREED ");
    b.call("__rt_dec", [b.op("zext.i64", [fr], "i64")]);
    b.call("__rt_nl", []);
    const ms = b.call("maxSteps", [], ["i32"])[0]!;
    drv.puts(b, "TMK:STEPS ");
    b.call("__rt_dec", [b.op("zext.i64", [ms], "i64")]);
    b.call("__rt_nl", []);
    b.ret();
    const after = new FuncBuilder(`__after_${p}`, [], []);
    after.ret();
    drv.funcs.push(b.finish(), after.finish());
    list.push({ run: `__case_${p}`, after: `__after_${p}` });
  });
  drv.pageRange();
  drv.main(list, (b) => {
    const base = b.load("ptr", b.global("__mem_base"));
    const limit = b.load("ptr", b.global("__mem_limit"));
    drv.usePageRange(b, b.at0(base, 16 * 1024 * 1024), limit);
    drv.puts(b, "TMK:F ");
    b.call("__rt_dec", [b.intrinsic("native.frequency", [], ["i64"])[0]!]);
    b.call("__rt_nl", []);
  });
  drv.trapMessages(o.meta.strings ?? []);
  const image = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 512 * 1024 * 1024,
  }).bytes;
  const r = await qemuRun({ name: "rc/tsl-cycle-latency", image, accel, timeoutMs: 600_000 });
  if (!r.ok) {
    out.skipped = `${r.status}: ${r.why.slice(0, 300)}`;
    return out;
  }
  const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))?.slice(6) ?? 0);
  out.frequency = freq;
  for (const l of r.lines) {
    if (l.startsWith("TMK:STEPS ")) out.maxSteps.push(Number(l.slice(10)));
    if (l.startsWith("TMK:FREED ")) out.freed.push(Number(l.slice(10)));
    if (!l.startsWith("TMK:LAT ")) continue;
    const rest = l.slice(8).trim().split(" ");
    const name = rest[0]!;
    const nums = rest
      .slice(1)
      .map(Number)
      .sort((a, b) => a - b);
    const q = (p: number): number => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))]!;
    const toNs = (t: number): number => (t / freq) * 1e9;
    out.phases.push({
      name,
      n: nums.length,
      medianTicks: q(0.5),
      p99Ticks: q(0.99),
      maxTicks: nums[nums.length - 1]!,
      medianNs: toNs(q(0.5)),
      p99Ns: toNs(q(0.99)),
      maxNs: toNs(nums[nums.length - 1]!),
    });
  }
  return out;
}

/**
 * R1c (D41): each churn case of corpus/rc/cyc_churn.ts on its own, with the collector off, has to trap 14 under the
 * program's page limit, so that its completing with the collector on (box 20) is the collector's doing. Each case is a
 * program of its own, so one case's leak can't be what another runs out on.
 */
export async function cycOffEach(
  accel: Accel,
): Promise<{ trapped: string[]; completed: string[]; skipped: boolean }> {
  const { checkFile, compileTyped } = await import("./lowering.ts");
  const { buildTslImage, tslResults } = await import("./native-exec.ts");
  const src = join(ROOT, "corpus/rc/cyc_churn.ts");
  const dir = buildPath("r1c-off");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsl.json"), '{ "memory": "rc" }\n');
  const all = casesOf(src);
  const out = { trapped: [] as string[], completed: [] as string[], skipped: false };
  const was = process.env.TMK_TEST_RC_CYCLES;
  process.env.TMK_TEST_RC_CYCLES = "off";
  try {
    for (const c of all) {
      const file = join(dir, `off_${c.fn}.ts`);
      writeFileSync(file, readFileSync(src, "utf8"));
      writeFileSync(file.replace(/\.ts$/, ".cases.json"), JSON.stringify([c]));
      const t = checkFile(file);
      if (t.typed === null) throw new Error(`${file}: ${JSON.stringify(t.diags).slice(0, 300)}`);
      const o = compileTyped(t.typed);
      const built = buildTslImage(o.tir, o.meta as never, [c] as never, pagesOf(src));
      const r = await qemuRun({
        name: `r1c-off/${c.fn}`,
        image: built.bytes,
        accel,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      if (r.skipped) {
        out.skipped = true;
        return out;
      }
      const res = tslResults(o.meta as never, [c] as never, r.lines).results[0]?.result as {
        trap?: number;
      };
      (res?.trap === 14 ? out.trapped : out.completed).push(c.fn);
    }
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_RC_CYCLES;
    else process.env.TMK_TEST_RC_CYCLES = was;
  }
  return out;
}

/**
 * R1c's claim that a program with no class that can be in a cycle pays nothing (D41): at -O1 and -O2 the functions its
 * exports reach are the same, instruction for instruction (trap numbers aside), with the collector on and off, and none
 * of the collector's own is among them. A cyclic program, for contrast, reaches the barrier.
 */
export async function paysNothing(
  files: string[],
  cyclic: string,
): Promise<{ rows: string[]; failures: string[] }> {
  const { checkFile, compileTyped } = await import("./lowering.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  const reach = (text: string): Map<string, string> => {
    const norm = text.replace(/\bt\d+\b/g, "t#");
    const fs = new Map<string, string>();
    for (const m of norm.matchAll(/^func @(\S+?)\((.*?)^\}/gms)) fs.set(m[1]!, m[0]);
    const roots = [...fs].filter(([, b]) => / export \{/.test(b.split("\n")[0]!)).map(([n]) => n);
    const seen = new Map<string, string>();
    const work = [...roots];
    while (work.length > 0) {
      const n = work.pop()!;
      if (seen.has(n) || !fs.has(n)) continue;
      const b = fs.get(n)!;
      seen.set(n, b);
      for (const c of b.matchAll(/(?:call|funcaddr) @([^\s,()]+)/g)) work.push(c[1]!);
    }
    return seen;
  };
  const cc =
    /^ex-gc-rc\.(cc[A-Z]\w*|touch|tablePush|tableOff|stepAll|collectAll|join|joinRoot|nextOf|setNext|clearScan|releaseCall|cutSlot)$/;
  const compile = (file: string, level: string, cycles: "on" | "off"): string => {
    const env = { opt: process.env.TMK_OPT, c: process.env.TMK_TEST_RC_CYCLES };
    process.env.TMK_OPT = level;
    process.env.TMK_TEST_RC_CYCLES = cycles;
    try {
      const t = checkFile(file);
      if (t.typed === null) throw new Error(`${file}: ${JSON.stringify(t.diags).slice(0, 300)}`);
      return compileTyped(t.typed).tirText;
    } finally {
      if (env.opt === undefined) delete process.env.TMK_OPT;
      else process.env.TMK_OPT = env.opt;
      if (env.c === undefined) delete process.env.TMK_TEST_RC_CYCLES;
      else process.env.TMK_TEST_RC_CYCLES = env.c;
    }
  };
  for (const level of ["1", "2"]) {
    for (const f of files) {
      const on = reach(compile(f, level, "on"));
      const off = reach(compile(f, level, "off"));
      const differ = [...on.keys()].filter((n) => off.get(n) !== on.get(n));
      const ccs = [...on.keys()].filter((n) => cc.test(n));
      rows.push(
        `${basename(f)} -O${level}: ${on.size} functions reached, ${differ.length} differ, ${ccs.length} of the collector's`,
      );
      if (differ.length > 0 || on.size !== off.size)
        failures.push(
          `${basename(f)} -O${level}: differs with the collector on: ${differ.slice(0, 5).join(", ")}`,
        );
      if (ccs.length > 0)
        failures.push(`${basename(f)} -O${level}: reaches ${ccs.slice(0, 5).join(", ")}`);
    }
    const on = reach(compile(cyclic, level, "on"));
    const ccs = [...on.keys()].filter((n) => cc.test(n));
    rows.push(
      `${basename(cyclic)} -O${level} (cyclic): ${ccs.length} of the collector's functions reached`,
    );
    if (!ccs.some((n) => /touch|stepAll/.test(n)))
      failures.push(`${basename(cyclic)} -O${level}: the collector isn't reached`);
  }
  return { rows, failures };
}
