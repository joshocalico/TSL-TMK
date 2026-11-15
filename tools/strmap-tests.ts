// The tests of `Map`, `Set` and run-time strings that a corpus comparison alone can't be (SPEC 8.1, M5 Phase F), each natively
// under QEMU against V8: the differential number-text run, iteration under mutation, the matrix of strange strings through
// every method and across the ABI, repeats without leaking, cycles through a Map, the freeing bound, and fragmentation.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { lowerFile } from "./lowering.ts";
import { listPrograms, ROOT } from "./corpus.ts";
import { pool } from "./guarded-run.ts";
import type { LowerCase, LowerCaseResult } from "./lower-exec.ts";
import type { Accel } from "./qemu-run.ts";
import {
  compareResults,
  referenceOnV8,
  runNativeOne,
  type StrmapOptions,
  type StrmapRun,
} from "./strmap-run.ts";

export const STRMAP_DIR = join(ROOT, "corpus/lower/strmap");
export const strmapFile = (n: string): string => join(STRMAP_DIR, `${n}.ts`);
export const strmapPrograms = (): string[] => listPrograms(STRMAP_DIR);
const casesOf = (file: string): LowerCase[] =>
  JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as LowerCase[];
const rel = (f: string): string => f.replace(`${ROOT}/`, "");
const stackIn = (file: string): number | undefined => {
  const m = /^\/\/ rc-stack: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return m !== undefined ? Number(m) : undefined;
};

export interface Tally {
  programs: number;
  cases: number;
  agreed: number;
  skipped: boolean;
  failures: string[];
}
const tallyNew = (): Tally => ({ programs: 0, cases: 0, agreed: 0, skipped: false, failures: [] });

const refMemo = new Map<string, Promise<LowerCaseResult[]>>();
function ref(file: string, cases: LowerCase[], key = ""): Promise<LowerCaseResult[]> {
  const k = `${file}#${key}`;
  let p = refMemo.get(k);
  if (p === undefined) {
    p = referenceOnV8(file, cases);
    refMemo.set(k, p);
  }
  return p;
}

async function oneProgram(
  file: string,
  cases: LowerCase[],
  opt: StrmapOptions,
  t: Tally,
  label: string,
  key = "",
): Promise<StrmapRun | null> {
  const memory = opt.memory ?? "rc";
  const want = await ref(file, cases, key);
  let run: StrmapRun;
  try {
    run = await runNativeOne(file, cases, {
      ...opt,
      ...(stackIn(file) !== undefined ? { stackBytes: stackIn(file)! } : {}),
    });
  } catch (e) {
    t.failures.push(`${rel(file)} ${label}: ${String(e).slice(0, 500)}`);
    return null;
  }
  if (run.skipped) {
    t.skipped = true;
    return run;
  }
  t.programs++;
  t.cases += cases.length;
  const problems = [...run.problems, ...compareResults(run.results, want, cases, memory)];
  t.agreed += run.results.length - problems.filter((p) => /#\d+/.test(p)).length;
  for (const p of problems.slice(0, 6))
    t.failures.push(`${rel(file)} ${label}: ${p.slice(0, 500)}`);
  return run;
}

/** Box 1: every program in corpus/lower/strmap, in each of rc, its poisoning build, leak and manual. */
export async function corpusRun(accel: Accel, jobs: number): Promise<Record<string, Tally>> {
  const configs: { label: string; opt: StrmapOptions }[] = [
    { label: "rc", opt: { memory: "rc" } },
    {
      label: "rc+poison",
      opt: {
        memory: "rc",
        rc: { check: true, account: true },
        harness: { collect: true, stats: true },
      },
    },
    { label: "leak", opt: { memory: "leak" } },
    { label: "manual", opt: { memory: "manual" } },
  ];
  const out: Record<string, Tally> = {};
  for (const c of configs) out[c.label] = tallyNew();
  // These allocate many times what memory there is, as a test of freeing, and only `rc` frees.
  const onlyRc = /\/(frag|drop_bound)\.ts$/;
  const tasks = strmapPrograms()
    .flatMap((file) => configs.map((c) => ({ file, c })))
    .filter(({ file, c }) => !onlyRc.test(file) || c.label.startsWith("rc"));
  await pool(tasks, jobs, async ({ file, c }) => {
    await oneProgram(
      file,
      casesOf(file),
      { ...c.opt, accel, harness: { ...c.opt.harness, noDump: true } },
      out[c.label]!,
      `${c.label} on ${accel}`,
    );
  });
  return out;
}

export const MAPS_DIR = join(ROOT, "corpus/lower/maps");

/**
 * corpus/lower/maps (SPEC 3.5, D47): iteration and lookups across the incremental move, against V8, in rc, its poisoning build,
 * leak and manual. `rc` adds options to every build, such as `rtFault`, a mistake put into compiler/rt, when only rc's two
 * builds run. Cases go in groups, so no one image is the whole sweep.
 */
export async function mapsCorpusRun(
  accel: Accel,
  jobs: number,
  rc: Record<string, unknown> = {},
  // Only these builds: TCG runs `rc` alone, as the sweep there is many times slower.
  only?: string[],
): Promise<Record<string, Tally>> {
  const faulty = Object.keys(rc).length > 0;
  const configs: { label: string; opt: StrmapOptions }[] = [
    { label: "rc", opt: { memory: "rc", rc } },
    {
      label: "rc+poison",
      opt: {
        memory: "rc",
        rc: { ...rc, check: true, account: true },
        harness: { collect: true, stats: true },
      },
    },
    ...(faulty
      ? []
      : [
          { label: "leak", opt: { memory: "leak" as const } },
          { label: "manual", opt: { memory: "manual" as const } },
        ]),
  ];
  if (only !== undefined)
    configs.splice(0, configs.length, ...configs.filter((c) => only.includes(c.label)));
  const out: Record<string, Tally> = {};
  for (const c of configs) out[c.label] = tallyNew();
  const GROUP = 1200;
  const tasks = listPrograms(MAPS_DIR).flatMap((file) => {
    const all = casesOf(file);
    const groups: LowerCase[][] = [];
    for (let i = 0; i < all.length; i += GROUP) groups.push(all.slice(i, i + GROUP));
    return configs.flatMap((c) => groups.map((g, i) => ({ file, c, g, i })));
  });
  await pool(tasks, jobs, async ({ file, c, g, i }) => {
    await oneProgram(
      file,
      g,
      {
        ...c.opt,
        accel,
        timeoutMs: 290_000,
        harness: { ...c.opt.harness, noDump: !/move_ops/.test(file) },
      },
      out[c.label]!,
      `${c.label} on ${accel}`,
      `maps${i}`,
    );
  });
  return out;
}

/** One program in one mode, against V8. */
export async function oneInMode(
  accel: Accel,
  name: string,
  memory: "rc" | "leak" | "manual",
): Promise<Tally> {
  const t = tallyNew();
  const file = strmapFile(name);
  await oneProgram(
    file,
    casesOf(file),
    { memory, accel, harness: { noDump: true } },
    t,
    `${memory} on ${accel}`,
  );
  return t;
}

/** Iteration is insertion order and never hash order: other keys, and every result the same. */
export async function hashKeyIndependence(accel: Accel, jobs: number): Promise<Tally> {
  const t = tallyNew();
  const files = strmapPrograms().filter(
    (f) => !/num_text|case_all|drop_bound|rc_churn|frag/.test(f),
  );
  const keys: [number, number][] = [
    [0, 0],
    [1, -1],
    [0x12345678, 0x7654321],
  ];
  const tasks = files.flatMap((file) => keys.map((key, i) => ({ file, key, i })));
  await pool(tasks, jobs, async ({ file, key, i }) => {
    await oneProgram(
      file,
      casesOf(file),
      { memory: "rc", accel, harness: { hashKey: key, noDump: true } },
      t,
      `key ${i} on ${accel}`,
    );
  });
  return t;
}

/** Box 2: chunks of digests over random doubles, the text and the way back, so one wrong digit shows. */
export async function numberDifferential(
  accel: Accel,
  jobs: number,
  perKind: number,
): Promise<Tally & { doubles: number; roundTrips: number; others: number }> {
  const file = strmapFile("num_text");
  const CHUNK = 1000;
  const groups: LowerCase[][] = [];
  let doubles = 0;
  let roundTrips = 0;
  let others = 0;
  let seed = 1000;
  for (let kind = 0; kind < 5; kind++) {
    const g: LowerCase[] = [];
    const h: LowerCase[] = [];
    for (let done = 0; done < perKind; done += CHUNK) {
      g.push({ fn: "digestToString", args: [seed++, CHUNK, kind] });
      doubles += CHUNK;
      h.push({ fn: "digestRoundTrip", args: [seed++, CHUNK, kind] });
      roundTrips += CHUNK;
    }
    for (let i = 0; i < g.length; i += 5) groups.push(g.slice(i, i + 5));
    for (let i = 0; i < h.length; i += 5) groups.push(h.slice(i, i + 5));
  }
  for (const fn of ["digestDecimal", "digestFixed", "digestRadix", "digestParseInt"]) {
    const g: LowerCase[] = [];
    for (let i = 0; i < perKind / 2; i += CHUNK) {
      g.push({ fn, args: [seed++, CHUNK] });
      others += CHUNK;
    }
    for (let i = 0; i < g.length; i += 5) groups.push(g.slice(i, i + 5));
  }
  const t = tallyNew();
  await pool(
    groups.map((g, i) => ({ g, i })),
    jobs,
    async ({ g, i }) => {
      await oneProgram(
        file,
        g,
        { memory: "rc", accel, timeoutMs: 290_000 },
        t,
        `differential ${i} on ${accel}`,
        `diff${i}`,
      );
    },
  );
  return { ...t, doubles, roundTrips, others };
}

/** Every operation at every position of every form of iterator, over small maps and sets. */
export function iterationCases(): LowerCase[] {
  const out: LowerCase[] = [];
  const usesA = new Set([1, 2, 3, 5, 8]);
  for (let n = 0; n <= 4; n++) {
    for (let op = 0; op <= 11; op++) {
      const args = usesA.has(op) ? Array.from({ length: n + 2 }, (_, a) => a) : [0];
      for (const a of args) {
        for (let pos = 0; pos <= n + 1; pos++) {
          for (let form = 0; form <= 9; form++)
            out.push({ fn: "digestMap", args: [n, form, op, a, pos] });
          for (let form = 0; form <= 5; form++)
            out.push({ fn: "digestSet", args: [n, form, op, a, pos] });
        }
      }
    }
  }
  for (let n = 0; n <= 6; n++) {
    for (let op = 0; op <= 4; op++) {
      for (let pos = 0; pos <= n; pos++) out.push({ fn: "digestCounted", args: [n, op, pos] });
    }
  }
  return out;
}

export async function iterationExhaustive(
  accel: Accel,
  jobs: number,
  rc: Record<string, unknown>,
  label: string,
  stride = 1,
  offset = 0,
): Promise<Tally> {
  const file = strmapFile("iter_mutation");
  const all = iterationCases().filter((_, i) => i % stride === offset);
  const CHUNK = 2500;
  const groups: LowerCase[][] = [];
  for (let i = 0; i < all.length; i += CHUNK) groups.push(all.slice(i, i + CHUNK));
  const t = tallyNew();
  await pool(
    groups.map((g, i) => ({ g, i })),
    jobs,
    async ({ g, i }) => {
      await oneProgram(
        file,
        g,
        { memory: "rc", rc, accel, timeoutMs: 290_000 },
        t,
        `${label} chunk ${i} on ${accel}`,
        `iter${stride}.${i}`,
      );
    },
  );
  return t;
}

/** Box 7: strange strings through every method, and across the ABI both ways. */
export const STRANGE = [
  "",
  "a",
  "abc",
  "é",
  "日本語",
  "😀",
  "a😀b",
  "\ud800",
  "\udc00",
  "\ud800x",
  "x\udc00",
  "\udc00\ud800",
  "  é  ",
  "﻿x ",
  "ÀÉÎ 😀 Σς ﬁ ß",
  "abcabcabc".repeat(12),
  "😀é\ud800".repeat(20),
];
export function strangeCases(): LowerCase[] {
  const c: LowerCase[] = [];
  const nums = [0, 1, -1, 2, 5, 100, 1.5, -2.5];
  const S = STRANGE;
  for (const s of S) {
    c.push(
      { fn: "length", args: [s] },
      { fn: "truthy", args: [s] },
      { fn: "trim", args: [s] },
      { fn: "trimStart", args: [s] },
      { fn: "trimEnd", args: [s] },
    );
    c.push(
      { fn: "forOf", args: [s] },
      { fn: "spread", args: [s] },
      { fn: "arrayFrom", args: [s] },
      { fn: "parseI", args: [s] },
      { fn: "parseF", args: [s] },
      { fn: "num", args: [s] },
      { fn: "sw", args: [s] },
      { fn: "maybe", args: [s] },
      { fn: "nullable", args: [s] },
    );
    for (const i of nums) {
      for (const fn of [
        "charCodeAt",
        "codePointAt",
        "index",
        "charAt",
        "at",
        "slice1",
        "substring1",
        "repeat2",
        "padStart1",
      ]) {
        if (fn === "repeat2") {
          if (i >= 0 && i < 6) c.push({ fn: "repeat", args: [s, i] });
          continue;
        }
        c.push({ fn, args: [s, i] });
      }
      for (const j of [0, 3, -1]) {
        c.push({ fn: "slice", args: [s, i, j] }, { fn: "substring", args: [s, i, j] });
      }
    }
    for (const p of S) {
      c.push(
        { fn: "eq", args: [s, p] },
        { fn: "lt", args: [s, p] },
        { fn: "ge", args: [s, p] },
        { fn: "concat", args: [s, p] },
      );
      c.push(
        { fn: "indexOf1", args: [s, p] },
        { fn: "lastIndexOf1", args: [s, p] },
        { fn: "includes", args: [s, p, 0] },
        { fn: "startsWith", args: [s, p, 0] },
        { fn: "endsWith", args: [s, p, s.length] },
      );
      c.push({ fn: "indexOf", args: [s, p, 1] }, { fn: "lastIndexOf", args: [s, p, 1] });
      if (p.length < 8)
        c.push(
          { fn: "split", args: [s, p] },
          { fn: "splitLim", args: [s, p, 2] },
          { fn: "padStart", args: [s, 12, p] },
          { fn: "padEnd", args: [s, 12, p] },
          { fn: "replace", args: [s, p, "[$&]"] },
          { fn: "replaceAll", args: [s, p, "_"] },
        );
      c.push(
        { fn: "concat3", args: [p, s, p] },
        { fn: "tpl", args: [s, 1.5, true] },
        { fn: "orElse", args: [s, p] },
      );
    }
    c.push({ fn: "join", args: [[s, "", s, "x"], s] });
  }
  return c;
}

export async function strangeMatrix(
  accel: Accel,
  jobs: number,
  memory: "rc" | "leak" | "manual",
  rc: Record<string, unknown>,
  label: string,
): Promise<Tally> {
  const file = strmapFile("str_methods");
  const all = strangeCases();
  const CHUNK = 250;
  const groups: LowerCase[][] = [];
  for (let i = 0; i < all.length; i += CHUNK) groups.push(all.slice(i, i + CHUNK));
  const t = tallyNew();
  await pool(
    groups.map((g, i) => ({ g, i })),
    jobs,
    async ({ g, i }) => {
      await oneProgram(
        file,
        g,
        {
          memory,
          ...(memory === "rc" ? { rc } : {}),
          accel,
          harness: memory === "rc" && rc.check === true ? { collect: true } : {},
          timeoutMs: 290_000,
        },
        t,
        `${label} chunk ${i} on ${accel}`,
        `strange.${i}`,
      );
    },
  );
  return t;
}

/** Box 5, first half: everything that passes in `rc` passes when the collector runs at every allocation, at small budgets. */
export async function underInterleaving(
  accel: Accel,
  jobs: number,
  budgets: number[],
): Promise<Tally & { freed: number; touches: number }> {
  const t = tallyNew();
  let freed = 0;
  let touches = 0;
  const files = strmapPrograms().filter(
    (f) => !/num_text|case_all|drop_bound|rc_churn|frag/.test(f),
  );
  const tasks = files.flatMap((file) => budgets.map((budget) => ({ file, budget })));
  await pool(tasks, jobs, async ({ file, budget }) => {
    const run = await oneProgram(
      file,
      casesOf(file),
      {
        memory: "rc",
        accel,
        rc: { check: true, account: true, pace: false, budget },
        harness: { collect: true, stats: true },
      },
      t,
      `budget ${budget} on ${accel}`,
    );
    const last = run?.stats.filter((x) => x !== undefined).at(-1);
    freed += last?.cc_freed ?? 0;
    touches += last?.cc_touches ?? 0;
  });
  return { ...t, freed, touches };
}

/** What these programs keep on purpose, in module state or by trapping, so repeats rightly differ. */
const KEEPS: Record<string, string[]> = {
  rc_borrow: [
    "getThenCalleeDeletes",
    "getThenClear",
    "getThenOverwrite",
    "argFromGet",
    "keyHeldAcrossDelete",
    "selfAssign",
    "stringFromMapThenCleared",
  ],
  drop_bound: [],
};

/** Box 5, second half: repeats hold steady in live objects and bytes. */
export async function noLeak(
  accel: Accel,
  jobs: number,
): Promise<{ programs: number; failures: string[]; skipped: boolean; rows: string[] }> {
  const out = { programs: 0, failures: [] as string[], skipped: false, rows: [] as string[] };
  const files = strmapPrograms().filter(
    (f) => !/num_text|case_all|drop_bound|rc_churn|frag|gaps/.test(f),
  );
  await pool(files, jobs, async (file) => {
    const name = /([^/]+)\.ts$/.exec(file)![1]!;
    const skip = new Set(KEEPS[name] ?? []);
    const want = await ref(file, casesOf(file));
    const cases = casesOf(file).filter((c, i) => {
      const w = want[i]?.result as { threw?: string; trap?: number } | undefined;
      // A case that fills memory makes every later case's dump of it that large, across 4 repeats. rc_churn covers those sizes.
      const large = c.args.some((x) => typeof x === "number" && x >= 1000);
      return (
        !large &&
        !skip.has(c.fn) &&
        w?.threw === undefined &&
        w?.trap === undefined &&
        c.lowered_trap === undefined
      );
    });
    if (cases.length === 0) return;
    const all = Array.from({ length: 4 }, () => cases).flat();
    const run = await runNativeOne(file, all, {
      memory: "rc",
      accel,
      rc: { check: true, account: true },
      harness: { collect: true, stats: true },
      timeoutMs: 290_000,
    });
    if (run.skipped) {
      out.skipped = true;
      return;
    }
    out.programs++;
    const at = (k: number): { o: number; b: number } => {
      const r = run.stats[(k + 1) * cases.length - 1];
      return { o: r?.live_objects ?? -1, b: r?.live_bytes ?? -1 };
    };
    const a = at(1);
    const b = at(2);
    const c = at(3);
    out.rows.push(`${name}: ${a.o}/${b.o}/${c.o} objects`);
    if (run.problems.length > 0) out.failures.push(`${name}: ${run.problems[0]!.slice(0, 300)}`);
    if (c.o > b.o || c.b > b.b || b.o > a.o || b.b > a.b) {
      out.failures.push(
        `${name}: live grew across repeats: ${a.o}, ${b.o}, ${c.o} objects, ${a.b}, ${b.b}, ${c.b} bytes`,
      );
    }
  });
  return out;
}

/** Cycles through a Map or a Set are freed with the collector on, and with it off they leak, so the test isn't vacuous. */
export async function mapCycles(accel: Accel): Promise<{
  onLive: number;
  offLive: number;
  freed: number;
  ok: boolean;
  why: string;
  skipped: boolean;
}> {
  const file = strmapFile("rc_cycles");
  const cases = casesOf(file);
  const on = await runNativeOne(file, cases, {
    memory: "rc",
    accel,
    rc: { check: true, account: true },
    harness: { collect: true, stats: true },
  });
  if (on.skipped)
    return { onLive: 0, offLive: 0, freed: 0, ok: false, why: "skipped", skipped: true };
  const off = await runNativeOne(file, cases, {
    memory: "rc",
    accel,
    rc: { check: true, account: true, cycles: false },
    harness: { collect: true, stats: true },
  });
  const lastOn = on.stats.filter((x) => x !== undefined).at(-1)!;
  const lastOff = off.stats.filter((x) => x !== undefined).at(-1)!;
  const want = await ref(file, cases);
  const p = [...on.problems, ...compareResults(on.results, want, cases, "rc"), ...off.problems];
  return {
    onLive: lastOn.live_objects ?? -1,
    offLive: lastOff.live_objects ?? -1,
    freed: lastOn.cc_freed ?? 0,
    ok:
      p.length === 0 &&
      lastOn.live_objects === 0 &&
      (lastOn.cc_freed ?? 0) > 0 &&
      (lastOff.live_objects ?? 0) > 1000,
    why: p.slice(0, 3).join("; "),
    skipped: false,
  };
}

/** Box 6, deterministically, in the build as it ships with counters: a huge map, set, array of strings and nest of maps. */
export async function dropBound(accel: Accel): Promise<{
  maxSteps: number;
  fullDrains: number;
  steps: number;
  allocs: number;
  frees: number;
  ok: boolean;
  why: string;
  skipped: boolean;
}> {
  const file = strmapFile("drop_bound");
  const cases = casesOf(file);
  const run = await runNativeOne(file, cases, {
    memory: "rc",
    accel,
    rc: { account: true },
    harness: { stats: true },
    stackBytes: 65536,
    timeoutMs: 290_000,
  });
  if (run.skipped)
    return {
      maxSteps: 0,
      fullDrains: 0,
      steps: 0,
      allocs: 0,
      frees: 0,
      ok: false,
      why: "skipped",
      skipped: true,
    };
  const want = await ref(file, cases);
  const p = [...run.problems, ...compareResults(run.results, want, cases, "rc")];
  const last = run.stats.filter((x) => x !== undefined).at(-1)!;
  return {
    maxSteps: last.max_steps ?? -1,
    fullDrains: last.full_drains ?? -1,
    steps: last.steps ?? -1,
    allocs: last.allocs ?? -1,
    frees: last.frees ?? -1,
    ok: p.length === 0,
    why: p.slice(0, 3).join("; "),
    skipped: false,
  };
}

/** The whole space of code points through both case mappings, in blocks. */
export async function caseMappingAll(accel: Accel, jobs: number): Promise<Tally> {
  const file = strmapFile("case_all");
  const step = 0x8000;
  const groups: LowerCase[][] = [];
  let g: LowerCase[] = [];
  for (let lo = 0; lo < 0x110000; lo += step) {
    g.push({ fn: "block", args: [lo, Math.min(0x110000, lo + step)] });
    if (g.length === 6) {
      groups.push(g);
      g = [];
    }
  }
  if (g.length > 0) groups.push(g);
  const t = tallyNew();
  await pool(
    groups.map((x, i) => ({ x, i })),
    jobs,
    async ({ x, i }) => {
      await oneProgram(
        file,
        x,
        { memory: "rc", accel, timeoutMs: 290_000 },
        t,
        `case block ${i} on ${accel}`,
        `case${i}`,
      );
    },
  );
  return t;
}

/** How little memory the varied-length churn runs in: whether trap 14 comes while free memory is the wrong shape. */
export async function fragmentation(accel: Accel): Promise<{
  rows: { fn: string; pages: number; trapped: boolean; live: string }[];
  failures: string[];
  skipped: boolean;
}> {
  const file = strmapFile("frag");
  const cases = casesOf(file);
  const rows: { fn: string; pages: number; trapped: boolean; live: string }[] = [];
  const failures: string[] = [];
  let skipped = false;
  const want = await ref(file, cases);
  // At the program's stated limit it must complete.
  const full = await runNativeOne(file, cases, {
    memory: "rc",
    accel,
    rc: { account: true },
    harness: { stats: true },
    timeoutMs: 290_000,
  });
  if (full.skipped) return { rows, failures, skipped: true };
  failures.push(...full.problems, ...compareResults(full.results, want, cases, "rc"));
  // Then the smallest limit each shape runs in, by halving: what's left above the live size is what fragmentation costs.
  await pool(
    cases.map((c, i) => ({ c, i })),
    4,
    async ({ c }) => {
      let lo = 8;
      let hi = 512;
      for (let g = 0; g < 7 && hi - lo > 8; g++) {
        const mid = (lo + hi) >> 1;
        const r = await runNativeOne(file, [c], {
          memory: "rc",
          accel,
          pages: mid,
          timeoutMs: 120_000,
        });
        if (r.skipped) {
          skipped = true;
          return;
        }
        const t = (r.results[0]?.result as { trap?: number } | undefined)?.trap;
        if (t === 14) lo = mid;
        else hi = mid;
      }
      rows.push({ fn: `${c.fn}(${c.args.join(",")})`, pages: hi, trapped: false, live: "" });
    },
  );
  return { rows, failures, skipped };
}

/** Box 8: what lowers in `rc`, with no fallback, and what still blocks the rest. */
export function loweringCounts(): {
  total: number;
  fallbackDir: number;
  lowered: number;
  loweredInFallbackDir: number;
  blockers: { program: string; causes: string[] }[];
} {
  const dirs = [
    "corpus/lower/pos",
    "corpus/native",
    "corpus/lower/fallback",
    "corpus/lower/memory",
    "corpus/lower/rc",
  ];
  const blockers: { program: string; causes: string[] }[] = [];
  let total = 0;
  let lowered = 0;
  let fallbackDir = 0;
  let loweredInFallbackDir = 0;
  for (const d of dirs) {
    for (const f of listPrograms(join(ROOT, d))) {
      const inFallback = d === "corpus/lower/fallback";
      total++;
      if (inFallback) fallbackDir++;
      const o = lowerFile(f, { memory: "rc" });
      const clean = o.tir !== null && o.fallbackDiags.length === 0 && o.tir.externs.length === 0;
      if (clean) {
        lowered++;
        if (inFallback) loweredInFallbackDir++;
      } else {
        blockers.push({
          program: rel(f),
          causes: [
            ...new Set(
              o.fallbackDiags
                .filter((x) => x.blocker !== "callee")
                .map((x) => `${x.fn}: ${x.blocker}`),
            ),
          ],
        });
      }
    }
  }
  return { total, fallbackDir, lowered, loweredInFallbackDir, blockers };
}
