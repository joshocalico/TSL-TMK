// The registry of everything the gate runs (SPEC 8.3, D51): every milestone's boxes as units, the quick tier's steps, what
// each one reads, which ones can't depend on the optimiser's level, and which ones measure. A milestone is a view over it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ROOT } from "./corpus.ts";
import { defineLangA } from "./milestones/lang-a.ts";
import { defineM1 } from "./milestones/m1.ts";
import { defineMaps } from "./milestones/maps.ts";
import { defineM2 } from "./milestones/m2.ts";
import { defineNativeA } from "./milestones/native-a.ts";
import { defineNativeB } from "./milestones/native-b.ts";
import { defineNativeC } from "./milestones/native-c.ts";
import { defineNativeD } from "./milestones/native-d.ts";
import { defineNativeE } from "./milestones/native-e.ts";
import { defineNativeF } from "./milestones/native-f.ts";
import { defineNativeG } from "./milestones/native-g.ts";
import { defineOptA } from "./milestones/opt-a.ts";
import { definePipeA } from "./milestones/pipe-a.ts";
import { definePipeB } from "./milestones/pipe-b.ts";
import { definePipeC } from "./milestones/pipe-c.ts";
import { definePipeD } from "./milestones/pipe-d.ts";
import { defineQuick, steps } from "./quick.ts";
import { doctorChecks, MilestoneDef, type UnitSlot } from "./tmk-common.ts";
import { analysable, jobRoots, moduleInfo, nodeHashes, reach, resetDeps, WHOLE } from "./deps.ts";

export type LevelKey = "unset" | "0" | "1" | "2";

/** The quick tier's view is "test". */
export const DEFINE: Record<string, (M: MilestoneDef) => Promise<void>> = {
  m1: defineM1,
  m2: defineM2,
  "native-a": defineNativeA,
  "native-b": defineNativeB,
  "native-c": defineNativeC,
  "native-d": defineNativeD,
  "native-e": defineNativeE,
  "native-f": defineNativeF,
  "native-g": defineNativeG,
  "opt-a": defineOptA,
  "lang-a": defineLangA,
  maps: defineMaps,
  "pipe-a": definePipeA,
  "pipe-b": definePipeB,
  "pipe-c": definePipeC,
  "pipe-d": definePipeD,
  test: defineQuick,
};

export const MILESTONES = Object.keys(DEFINE).filter((m) => m !== "test");

export async function loadDef(name: string): Promise<MilestoneDef> {
  const define = DEFINE[name];
  if (define === undefined) throw new Error(`no milestone ${name}`);
  const M = new MilestoneDef(name);
  await define(M);
  return M;
}

// --- what each unit is

export interface UnitMeta {
  /**
   * Proved unable to depend on the optimiser's level: in a gate run at -O0 and at -O2 nothing it compiled took the level from
   * the environment, in its process, its workers or its children (TMK_LEVEL_TRACE, D51). It runs once, under the trace, and a
   * run that takes a level from the environment fails, so the proof is checked every time.
   */
  free?: true;
  /** It measures, and its verdict is a gate on a measurement: it runs in the quiet phase, with nothing but other such units. */
  quiet?: true;
  /**
   * Its detail reports measurements, times or latencies, beside its verdict: `tmk gate --sample` compares that detail with every
   * number taken out, and still compares its verdict and its suites' counts. Every `quiet` unit is one too.
   */
  measures?: true;
  /**
   * Its detail quotes a tool's own output, which carries the job's build path and is cut to a length, so where it's cut moves
   * with the path's length: `tmk gate --sample` compares its verdict, the counts in its detail (each `n/m`) and its suites'
   * counts, not its words (native-c box 1, which quotes `tmk lower --memory rc`).
   */
  quotesTool?: true;
  /**
   * A speed box whose detail is its measurement, with lines that come and go with the load (pipe-d box 26 measures a cell
   * again in full when a quick run of it is over 1.00x): `tmk gate --sample` compares its verdict, its suites' counts and
   * these decisions it asserts, each match in order, not the measurement around them.
   */
  decisions?: RegExp;
  /**
   * It times compiles, so it runs without the build store (tools/store.ts), as every quiet and measuring unit does: a reused
   * build would make its figure the reuse's.
   */
  noStore?: true;
  /**
   * It assumes the host is otherwise still: the harness's own tests count every other QEMU on the host, and the unit tests'
   * check that a killed group's grandchild is gone at once fails when other processes are being made and reaped around it
   * (MEASURED: 0 of 10 alone, 2 of 6 with six at once). It runs first, alone, one at a time.
   */
  solo?: true;
  /**
   * Suites at once inside this job (`--jobs`), where four put the job near the 3 GiB watchdog: fewer, not a higher limit.
   */
  jobs?: number;
  /** Seconds, for longest first, from the gate runs recorded (build/gate/durations.json overrides these). */
  est?: number;
  timeoutMs?: number;
}

/**
 * Units by "milestone/unit". `free` comes from the trace of the gate runs recorded in SPEC M5's record (D51), and nothing is
 * free that compiled at a level the environment gave it. `quiet` is every box whose verdict is a gate on a time.
 */
export const META: Record<string, UnitMeta> = {
  // Gates on times: G1, G2 and S4, -O1's compile time, and the list's slowdown measured apart.
  "m2/12-13": { quiet: true },
  // Box 14's text gains a line when the load is high, which the sample takes as a measurement (opt-b).
  "native-a/14-15": { quiet: true, measures: true },
  "native-e/9": { quiet: true },
  "opt-a/6": { quiet: true },
  "maps/4": { quiet: true },
  "pipe-b/9": { quiet: true },
  // R2's speed table: measured in the quiet phase, its verdict on what auto does with the figures, not the figures.
  // Box 8 reports compile times straight to TIR and through TSL, per build (no gate on them): made, never reused.
  "pipe-a/8": { noStore: true },
  "pipe-d/26": { quiet: true, measures: true, decisions: /\bAUTO_RC (?:on|off)\b/g },
  // Report measurements in their detail, with no gate on them: a sample compares their verdicts and counts, not the figures.
  "native-d/9": { measures: true },
  // The collector's latency and strmap's quick benchmark (pipe-h): `tmk gate --sample` flagged their times as differences.
  "native-e/7": { measures: true },
  "native-f/12": { measures: true },
  // Quotes `tmk lower`'s output, a path in its job's directory and a cut at 120 characters (the clsid step's sample fix).
  "native-c/1": { quotesTool: true },
  // Level-free: no level taken from the environment in the gate runs of 2026-11-07 at -O0 and -O2, in any process, worker
  // or child; and in the run from before this work, the same results at -O0 and -O2. Checked again by every run.
  "native-g/2": { free: true },
  "native-g/3": { free: true },
  "native-g/5": { free: true },
  "native-g/9": { free: true },
  "native-f/13": { free: true },
  "native-e/11": { free: true },
  "native-d/10": { free: true },
  "native-d/15": { free: true },
  "native-c/10": { free: true },
  "native-c/11": { free: true },
  // Near the watchdog: 2.6 to 2.9 GiB in a gate, where it failed 2 runs of 8. MEASURED alone at -O2: 2.46 GiB with 4 suites at
  // once, 2.16 GiB of it the job's own process with its 4 compile workers, and 2.45 GiB with 2 workers, so not them; 2.01 GiB with 2
  // suites at once, in 200 s rather than 80.
  "native-d/4": { jobs: 2 },
  // The same, MEASURED in the pipeline's gate of 2026-11-08: killed above 3 GiB at -O0 and -O2 with 4 suites at once, where
  // alone it peaks at 2.06 GiB (-O0) and 2.35 GiB (-O2), its rc leak test now holding three more programs (the falsy unknown's).
  "native-e/3": { jobs: 2 },
  // R8: the same leak test, with exceptions' programs: 2.61 GiB in R7's gate and 2.78 GiB alone, where a default-width gate
  // put it over the watchdog. MEASURED alone (2026-11-15, load 7 to 13): 2.21 GiB in 99 s with 4 suites at once, all of it the
  // job's own process and its compile workers; 1.86 GiB in 137 s with 2. Fewer at once, not a higher limit, as above.
  "lang-a/5": { jobs: 2 },
  // R12: the counters of corpus/lower/exc at -O0 and -O2, 2.59 GiB in T2's gate. MEASURED alone (2026-11-16, load 3 to 16):
  // 2.54 GiB in 360 s with 4 suites at once, 1.68 GiB in 486 s with 2. Fewer at once, not a higher limit, as above.
  "lang-a/10": { jobs: 2 },
  // The host has to be still: the harness's tests, and the unit tests with them.
  "native-a/10-11": { solo: true, free: true },
  "native-a/1-4": { solo: true },
  "m1/1-9": { solo: true },
  "m2/1-4": { solo: true },
  "test/1": { solo: true },
};

/**
 * Seconds per job, "milestone/unit@level", from the run of every milestone before this work (its boxes' own seconds), for
 * longest first from clean.
 * After a run, build/gate/durations.json has the last run's, which come first.
 */
export const EST: Record<string, number> = {
  "pipe-a/2@unset": 300,
  "pipe-a/3@unset": 900,
  "pipe-a/4@unset": 400,
  "pipe-a/5@unset": 900,
  "pipe-a/6@unset": 300,
  "pipe-a/7@unset": 900,
  "pipe-a/8@unset": 120,
  "pipe-a/9@unset": 5,
  "pipe-b/2@unset": 120,
  "pipe-b/3@unset": 30,
  "pipe-b/4@unset": 180,
  "pipe-b/5@unset": 1,
  "pipe-b/6@unset": 5,
  "pipe-b/7@unset": 900,
  "pipe-b/8@unset": 120,
  "pipe-b/9@unset": 300,
  "pipe-b/11@unset": 10,
  "pipe-c/2@unset": 240,
  "pipe-c/3@unset": 20,
  "pipe-c/4@unset": 240,
  "pipe-c/5@unset": 300,
  "pipe-d/2@unset": 120,
  "pipe-d/3@unset": 900,
  "pipe-d/4@unset": 400,
  "pipe-d/5@unset": 10,
  "pipe-d/12@unset": 900,
  "pipe-d/13@unset": 400,
  "pipe-d/14@unset": 10,
  "pipe-d/15@unset": 150,
  "pipe-d/20@unset": 300,
  "pipe-d/21@unset": 400,
  "pipe-d/22@unset": 900,
  "pipe-d/23@unset": 300,
  "pipe-d/24@unset": 900,
  "pipe-d/25@unset": 1200,
  "pipe-d/26@unset": 600,
  "pipe-d/27@unset": 1800,
  "pipe-d/28@unset": 900,
  "pipe-d/30@unset": 900,
  "pipe-d/31@unset": 1500,
  "pipe-d/32@unset": 900,
  "pipe-d/33@unset": 900,
  "pipe-d/34@unset": 1200,
  "pipe-d/35@unset": 900,
  "pipe-d/36@unset": 300,
  "pipe-d/37@unset": 600,
  "pipe-d/38@unset": 300,
  "pipe-d/39@unset": 600,
  "pipe-d/40@unset": 1500,
  "pipe-d/41@unset": 200,
  "pipe-d/42@unset": 600,
  "pipe-d/43@unset": 120,
  "pipe-d/44@unset": 300,
  "pipe-d/45@unset": 600,
  "pipe-d/46@unset": 600,
  "pipe-d/47@unset": 900,
  "pipe-d/48@unset": 900,
  "pipe-d/49@unset": 300,
  "pipe-d/50@unset": 300,
  "pipe-d/51@unset": 400,
  "pipe-d/52@unset": 600,
  "pipe-d/53@unset": 300,
  "pipe-d/54@unset": 300,
  "pipe-d/55@unset": 300,
  "pipe-d/56@unset": 400,
  "pipe-d/57@unset": 300,
  "pipe-d/58@unset": 500,
  "pipe-d/59@unset": 300,
  "pipe-d/60@unset": 300,
  "pipe-d/61@unset": 300,
  "pipe-d/62@unset": 300,
  "pipe-d/63@unset": 300,
  "pipe-d/64@unset": 500,
  "maps/2@unset": 700,
  "maps/3@unset": 150,
  "maps/4@unset": 90,
  "maps/5@unset": 60,
  "maps/6@unset": 400,
  "maps/7@unset": 600,
  "maps/8@unset": 200,
  "maps/9@unset": 300,
  "maps/10@unset": 5,
  "maps/11@unset": 5,
  "lang-a/10@unset": 464,
  "lang-a/11@unset": 50,
  "lang-a/12@unset": 262,
  "lang-a/13@unset": 333,
  "lang-a/14@unset": 0,
  "lang-a/2@unset": 749,
  "lang-a/3@unset": 144,
  "lang-a/4@unset": 108,
  "lang-a/5@unset": 74,
  "lang-a/6@unset": 2,
  "lang-a/7@unset": 0,
  "lang-a/8@unset": 27,
  "lang-a/9@unset": 301,
  "m1/1-9@0": 14,
  "m1/1-9@2": 14,
  "m2/1-4@0": 10,
  "m2/1-4@2": 10,
  "m2/11@0": 1,
  "m2/11@2": 1,
  "m2/12-13@0": 168,
  "m2/12-13@2": 167,
  "m2/5-10@0": 10,
  "m2/5-10@2": 11,
  "native-a/1-4@0": 10,
  "native-a/1-4@2": 10,
  "native-a/10-11@0": 9,
  "native-a/10-11@2": 9,
  "native-a/12-13@0": 82,
  "native-a/12-13@2": 57,
  "native-a/14-15@0": 257,
  "native-a/14-15@2": 256,
  "native-a/5-9@0": 16,
  "native-a/5-9@2": 16,
  "native-b/1-11@0": 17,
  "native-b/1-11@2": 17,
  "native-c/10@0": 0,
  "native-c/10@2": 0,
  "native-c/11@0": 0,
  "native-c/11@2": 0,
  "native-c/12@0": 7,
  "native-c/12@2": 7,
  "native-c/13@0": 5,
  "native-c/13@2": 5,
  "native-c/1@0": 2,
  "native-c/1@2": 2,
  "native-c/2@0": 2,
  "native-c/2@2": 2,
  "native-c/3-5@0": 56,
  "native-c/3-5@2": 66,
  "native-c/6@0": 1,
  "native-c/6@2": 2,
  "native-c/7@0": 2,
  "native-c/7@2": 3,
  "native-c/8@0": 2,
  "native-c/8@2": 2,
  "native-c/9@0": 0,
  "native-c/9@2": 0,
  "native-d/10@0": 4,
  "native-d/10@2": 4,
  "native-d/11@0": 0,
  "native-d/11@2": 0,
  "native-d/12@0": 1,
  "native-d/12@2": 1,
  "native-d/13@0": 31,
  "native-d/13@2": 43,
  "native-d/14@0": 17,
  "native-d/14@2": 32,
  "native-d/15@0": 0,
  "native-d/15@2": 0,
  "native-d/1@0": 3,
  "native-d/1@2": 3,
  "native-d/2,5-7@0": 168,
  "native-d/2,5-7@2": 411,
  "native-d/3@0": 6,
  "native-d/3@2": 4,
  "native-d/4@0": 61,
  "native-d/4@2": 66,
  "native-d/8@0": 2,
  "native-d/8@2": 1,
  "native-d/9@0": 1,
  "native-d/9@2": 1,
  "native-e/10@0": 7,
  "native-e/10@2": 7,
  "native-e/11@0": 0,
  "native-e/11@2": 0,
  "native-e/1@0": 1,
  "native-e/1@2": 1,
  "native-e/2@0": 6,
  "native-e/2@2": 5,
  "native-e/3@0": 57,
  "native-e/3@2": 75,
  "native-e/4@0": 51,
  "native-e/4@2": 69,
  "native-e/5@0": 3,
  "native-e/5@2": 2,
  "native-e/6@0": 2,
  "native-e/6@2": 2,
  "native-e/7@0": 4,
  "native-e/7@2": 4,
  "native-e/8@0": 134,
  "native-e/8@2": 373,
  "native-e/9@0": 34,
  "native-e/9@2": 51,
  "native-f/10@0": 133,
  "native-f/10@2": 293,
  "native-f/11@0": 1,
  "native-f/11@2": 1,
  "native-f/12@0": 43,
  "native-f/12@2": 41,
  "native-f/13@0": 0,
  "native-f/13@2": 0,
  "native-f/1@0": 34,
  "native-f/1@2": 34,
  "native-f/2@0": 5,
  "native-f/2@2": 8,
  "native-f/3@0": 30,
  "native-f/3@2": 28,
  "native-f/4@0": 7,
  "native-f/4@2": 9,
  "native-f/5@0": 74,
  "native-f/5@2": 164,
  "native-f/6@0": 23,
  "native-f/6@2": 43,
  "native-f/7@0": 3,
  "native-f/7@2": 4,
  "native-f/8@0": 10,
  "native-f/8@2": 10,
  "native-f/9@0": 2,
  "native-f/9@2": 5,
  "native-g/10@0": 20,
  "native-g/10@2": 22,
  "native-g/1@0": 8,
  "native-g/1@2": 8,
  "native-g/2@0": 0,
  "native-g/2@2": 0,
  "native-g/3@0": 2,
  "native-g/3@2": 2,
  "native-g/4@0": 7,
  "native-g/4@2": 5,
  "native-g/5@0": 21,
  "native-g/5@2": 21,
  "native-g/6@0": 176,
  "native-g/6@2": 182,
  "native-g/7@0": 2,
  "native-g/7@2": 3,
  "native-g/8@0": 46,
  "native-g/8@2": 44,
  "native-g/9@0": 0,
  "native-g/9@2": 0,
  "opt-a/11@unset": 25,
  "opt-a/12@unset": 1400,
  "opt-a/13@unset": 179,
  "opt-a/14@unset": 19,
  "opt-a/15@unset": 38,
  "opt-a/16@unset": 0,
  "opt-a/1@unset": 3,
  "opt-a/2@unset": 4,
  "opt-a/3@unset": 1,
  "opt-a/4-5,10@unset": 23,
  "opt-a/6@unset": 57,
  "test/10@1": 2,
  "test/11@1": 6,
  "test/12@1": 3,
  "test/13@1": 21,
  "test/14@1": 21,
  "test/15@1": 40,
  "test/16@1": 25,
  "test/17@1": 2,
  "test/18@1": 6,
  "test/19@1": 1,
  "test/1@1": 5,
  "test/20@1": 1,
  "test/21@1": 6,
  "test/22@1": 2,
  "test/23@1": 15,
  "test/24@1": 5,
  "test/25@1": 9,
  "test/26@1": 1,
  "test/27@1": 1,
  "test/28@1": 4,
  "test/29@1": 10,
  "test/2@1": 1,
  "test/30@1": 25,
  "test/31@1": 3,
  "test/32@1": 0,
  "test/33@1": 2,
  "test/34@1": 6,
  "test/35@1": 24,
  "test/36@1": 154,
  "test/37@1": 6,
  "test/38@1": 17,
  "test/39@1": 1,
  "test/3@1": 3,
  "test/40@1": 2,
  "test/41@1": 1,
  "test/42@1": 3,
  "test/43@1": 20,
  "test/4@1": 0,
  "test/5@1": 5,
  "test/6@1": 21,
  "test/7@1": 3,
  "test/8@1": 0,
  "test/9@1": 2,
};

export function metaOf(milestone: string, unit: string): UnitMeta {
  return META[`${milestone}/${unit}`] ?? {};
}

/** Whether a job's box details are measurements (`measures` or `quiet`), from its key, "milestone/unit@level". */
export function measuresByKey(key: string): boolean {
  const m = /^([^/]+)\/(.+)@[^@]+$/.exec(key);
  if (m === null) return false;
  const meta = metaOf(m[1]!, m[2]!);
  return meta.measures === true || meta.quiet === true;
}

/** The decisions a speed box's detail asserts, by its key, or null: what `tmk gate --sample` compares of it. */
export function decisionsByKey(key: string): RegExp | null {
  const m = /^([^/]+)\/(.+)@[^@]+$/.exec(key);
  if (m === null) return null;
  return metaOf(m[1]!, m[2]!).decisions ?? null;
}

/** Whether a job's box details quote a tool's output (`quotesTool`), from its key, "milestone/unit@level". */
export function quotesToolByKey(key: string): boolean {
  const m = /^([^/]+)\/(.+)@[^@]+$/.exec(key);
  if (m === null) return false;
  return metaOf(m[1]!, m[2]!).quotesTool === true;
}

// --- inputs: what a run's result can depend on

const INPUT_DIRS = ["compiler", "tools", "packages", "corpus", "bench"];
const INPUT_ROOT_FILES = [
  "SPEC.md",
  "README.md",
  "THIRD_PARTY",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.host.json",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".gitignore",
];

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir).sort()) {
    if (n === "node_modules" || n === ".DS_Store") continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
}

/** Every file in the repo a test can read: the compiler, tools, packages, corpora, benchmarks, the spec and its backups. */
export function inputFiles(): string[] {
  const out: string[] = [];
  for (const d of INPUT_DIRS) walk(join(ROOT, d), out);
  for (const f of INPUT_ROOT_FILES) if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  for (const n of readdirSync(ROOT).sort())
    if (n.startsWith("SPEC.md.bak-")) out.push(join(ROOT, n));
  return out.map((f) => relative(ROOT, f)).sort();
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Content hashes of every input, by path. */
export function hashInputs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of inputFiles()) out[f] = sha256(readFileSync(join(ROOT, f)));
  return out;
}

/** The hash of a set of hashes: what one tree is. */
export function treeHash(h: Record<string, string>): string {
  return sha256(
    Object.keys(h)
      .sort()
      .map((k) => `${k}\0${h[k]}\n`)
      .join(""),
  );
}

/** What's outside the repo and still an input: tool versions, and the pinned real corpus's manifest. */
export function externalInputs(): Record<string, string> {
  const out: Record<string, string> = { node: process.version };
  for (const c of doctorChecks()) out[c.tool] = `${c.version ?? "missing"} at ${c.path ?? "-"}`;
  const real = join(homedir(), ".cache/ts-microkernel/real-corpus/manifest.jsonl");
  out["real-corpus manifest"] = existsSync(real) ? sha256(readFileSync(real)) : "absent";
  out.platform = `${process.platform} ${process.arch}`;
  return out;
}

/** Paths in `now` that differ from `base`, or are new, or are gone. */
export function changedPaths(base: Record<string, string>, now: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(now)) if (base[k] !== v) out.add(k);
  for (const k of Object.keys(base)) if (!(k in now)) out.add(k);
  return [...out].sort();
}

// --- what a unit can reach: the import graph, with every path a module names, and the data it names

const LITERAL = /["'`]((?:\.\.?\/|[\w@][\w@.-]*\/)[\w@./-]*|SPEC\.md[\w.-]*)["'`]/g;

/** Files and directories a piece of source names, resolved from its own directory and from the repo root. */
export function namedPaths(text: string, fromDir: string): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const m of text.matchAll(LITERAL)) {
    const lit = m[1]!;
    const tries = lit.startsWith(".") ? [resolve(fromDir, lit)] : [join(ROOT, lit)];
    if (lit.startsWith("@tsl/")) tries.push(join(ROOT, "packages", `tsl-${lit.slice(5)}`));
    for (const t of tries) {
      if (!t.startsWith(ROOT) || !existsSync(t)) continue;
      const st = statSync(t);
      const rel = relative(ROOT, t);
      if (
        rel === "" ||
        rel.startsWith("..") ||
        rel.startsWith("build") ||
        rel.startsWith("node_modules")
      )
        continue;
      if (st.isDirectory()) dirs.add(rel);
      else files.add(rel);
    }
  }
  return { files: [...files], dirs: [...dirs] };
}

/**
 * Each `M.unit("id", ...)` call's source in a milestone's module, by id: from the call to the next of the define function's
 * own statements that declares a box (`M.unit`, `M.nested`, `M.tier`, `M.vms`, at its indentation). What's outside every
 * unit is the module's shared code.
 */
export function unitBlocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  const starts: { line: number; id: string | null }[] = [];
  lines.forEach((l, i) => {
    const m = /^ {2}M\.(unit|nested|tier|vms)\(\s*(?:"([^"]+)")?/.exec(l);
    if (m !== null)
      starts.push({
        line: i,
        id: m[1] === "unit" ? (m[2] ?? lines[i + 1]?.trim().replace(/^"|",?$/g, "") ?? null) : null,
      });
  });
  starts.forEach((st, k) => {
    if (st.id === null) return;
    const end = k + 1 < starts.length ? starts[k + 1]!.line : lines.length - 1;
    out.set(st.id, lines.slice(st.line, end).join("\n"));
  });
  return out;
}

/** The modules a file imports statically, not those it loads on demand. */
export function staticImports(file: string): string[] {
  const abs = join(ROOT, file);
  const text = readFileSync(abs, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gms)) {
    const t = resolve(dirname(abs), m[1]!);
    if (existsSync(t)) out.push(relative(ROOT, t));
  }
  return out;
}

/** The harness itself: a change here can change any result, so it selects everything. */
export const HARNESS = ["tools/tmk.ts", "tools/gate.ts", "tools/registry.ts", "tools/build-dir.ts"];

const graphMemo = new Map<string, { files: string[]; dirs: string[] }>();

function edgesOf(file: string): { files: string[]; dirs: string[] } {
  let e = graphMemo.get(file);
  if (e === undefined) {
    const abs = join(ROOT, file);
    e =
      /\.(m?ts|m?js|json)$/.test(file) && existsSync(abs)
        ? namedPaths(readFileSync(abs, "utf8"), dirname(abs))
        : { files: [], dirs: [] };
    graphMemo.set(file, e);
  }
  return e;
}

/** Every module a set of modules can load or start, by import or by naming its path, and every directory they name. */
export function closure(entries: string[]): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const todo = [...entries];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    if (HARNESS.includes(f)) continue;
    const e = edgesOf(f);
    for (const d of e.dirs) dirs.add(d);
    // The harness's own modules (tmk.ts and what it loads) are where every unit is listed: a change to them selects
    // everything by itself, so they're not followed, or every unit would reach every other's code.
    for (const g of e.files)
      if (/\.(m?ts|m?js)$/.test(g) && !files.has(g) && !HARNESS.includes(g)) todo.push(g);
      else files.add(g);
  }
  return { files, dirs };
}

/** Always there for code that compiles: the packages programs import and the runtime lowering adds (D42). */
const COMPILED = ["packages", "compiler/rt"];

export interface Deps {
  files: Set<string>;
  /** Paths under which any change counts: directories and files, "*" for everything. */
  data: string[];
}

function pathHits(path: string, data: string[]): boolean {
  return data.some((d) => d === "*" || path === d || path.startsWith(`${d}/`));
}

/** Does a change to any of these paths reach this unit? */
export function reaches(deps: Deps, changed: string[]): string[] {
  return changed.filter((p) => HARNESS.includes(p) || deps.files.has(p) || pathHits(p, deps.data));
}

/**
 * A milestone unit's dependencies: its module, everything that can load or start, the paths its own code and the module's
 * shared code name (not those only other units name), the paths every module it reaches names, and what compiled code reads.
 */
export function unitDeps(def: MilestoneDef, unit: UnitSlot): Deps {
  const file = def.name === "test" ? "tools/quick.ts" : `tools/milestones/${def.name}.ts`;
  const abs = join(ROOT, file);
  const text = readFileSync(abs, "utf8");
  const blocks = unitBlocks(text);
  const mine = blocks.get(unit.id) ?? text;
  const own = namedPaths(mine, dirname(abs));
  // What the module shares: everything but the other units' own code.
  let shared = text;
  for (const [id, b] of blocks) if (id !== unit.id) shared = shared.replace(b, "");
  const pre = namedPaths(shared, dirname(abs));
  // Not the module's own edges: it names every unit's modules, and a unit reaches only its own and the shared ones.
  const entries = [...staticImports(file), ...own.files, ...pre.files].filter((f) =>
    /\.(m?ts|m?js)$/.test(f),
  );
  const c = closure(entries);
  const data = [...new Set([...c.dirs, ...own.dirs, ...pre.dirs, ...COMPILED])];
  const files = new Set([file, ...c.files, ...own.files, ...pre.files]);
  if (def.name === "test") {
    // A step says what it reads (its `data`) and which test modules it loads (`mods`): over quick.ts's own static imports,
    // what the step's code names, and everything those reach. Its data is what it declares.
    const st = steps(4)[Number(unit.id) - 1]!;
    const named = namedPaths(st.run.toString(), dirname(abs));
    // Not quick.ts's own edges: it names every step's modules, and a step reaches only its own.
    const c2 = closure([
      ...staticImports(file),
      ...(st.mods ?? []),
      ...named.files.filter((f) => /\.(m?ts|m?js)$/.test(f)),
    ]);
    const mine = new Set([...c2.files, file]);
    return { files: mine, data: [...new Set([...(st.data ?? []), ...named.dirs])] };
  }
  return { files, data };
}

// --- declaration by declaration (tools/deps.ts): what a gate job's process can run, and what a change touches

export interface FineDeps {
  /** Nodes of tools/ modules the job can run, "file#name" ("file#*" for one reached whole). */
  nodes: Set<string>;
  /** Files reached whole: everything outside tools/, a script by its path and all it loads, files read. */
  files: Set<string>;
  data: string[];
}

const fineMemo = new Map<string, FineDeps>();

/**
 * A unit's dependencies, node by node: what `tmk job <milestone> <unit>` can run (deps.ts's jobRoots), the files it reaches
 * whole, and its data: the directories its nodes name, everything a file it reaches whole names, every directory named anywhere
 * in a module it runs code of (so a path built from pieces in a module isn't lost), what compiled code reads, and, for a quick
 * step, the data and modules it declares.
 */
export function fineUnitDeps(def: MilestoneDef, unit: UnitSlot): FineDeps {
  const key = `${def.name}/${unit.id}`;
  const hit = fineMemo.get(key);
  if (hit !== undefined) return hit;
  const { roots, prune } = jobRoots(def.name, unit.id);
  const r = reach(roots, closure, prune);
  const files = new Set(r.files);
  const ran = new Set([...r.nodes].map((n) => n.slice(0, n.lastIndexOf("#"))));
  for (const f of ran)
    for (const g of edgesOf(f).files) if (!/\.(m?ts|m?js)$/.test(g)) files.add(g);
  let data: Set<string>;
  if (def.name === "test") {
    // A step's data is what it declares (SPEC 9.3, D51), and the paths its own code names, as before.
    const st = steps(4)[Number(unit.id) - 1]!;
    const own = moduleInfo("tools/quick.ts")?.nodes.get(`step:${unit.id}`);
    data = new Set([...(st.data ?? []), ...(own?.dirs ?? [])]);
    const c = closure(st.mods ?? []);
    for (const f of c.files) files.add(f);
  } else {
    data = new Set<string>([...r.dirs, ...COMPILED]);
    // Every directory any module it runs code of names, so a path built from pieces in a module isn't lost.
    for (const f of ran) for (const d of edgesOf(f).dirs) data.add(d);
  }
  const out = { nodes: r.nodes, files, data: [...data] };
  fineMemo.set(key, out);
  return out;
}

/** What changed since a baseline: paths, and for a tools/ module both sides cut into nodes, which nodes. */
export interface Changes {
  paths: string[];
  nodes: Map<string, Set<string>>;
}

export function changesSince(
  base: { files: Record<string, string>; nodes?: Record<string, Record<string, string>> },
  now: Record<string, string>,
): Changes {
  const paths = changedPaths(base.files, now);
  const nodes = new Map<string, Set<string>>();
  const nowNodes = nodeHashes(paths.filter((p) => p in now && analysable(p)));
  for (const p of paths) {
    const was = base.nodes?.[p];
    const is = nowNodes[p];
    // A module new or gone, or a baseline from before nodes were kept: the file as a whole.
    if (was === undefined || is === undefined) continue;
    const names = new Set<string>();
    for (const n of new Set([...Object.keys(was), ...Object.keys(is)]))
      if (was[n] !== is[n]) names.add(n);
    nodes.set(p, names);
  }
  return { paths, nodes };
}

/** Which changes reach a unit, node by node where both sides of a module are known, and by file otherwise. */
export function fineReaches(deps: FineDeps, ch: Changes): string[] {
  const out: string[] = [];
  for (const p of ch.paths) {
    if (HARNESS.includes(p) || deps.files.has(p) || pathHits(p, deps.data)) {
      out.push(p);
      continue;
    }
    if (!analysable(p)) continue;
    const names = ch.nodes.get(p);
    if (deps.nodes.has(`${p}#${WHOLE}`)) {
      if (names === undefined || names.size > 0) out.push(p);
      continue;
    }
    if (names === undefined) {
      // The file as a whole: any of its nodes run.
      if ([...deps.nodes].some((n) => n.startsWith(`${p}#`))) out.push(p);
      continue;
    }
    const hit = [...names].filter((n) => deps.nodes.has(`${p}#${n}`));
    if (hit.length > 0) out.push(`${p} (${hit.slice(0, 3).join(", ")})`);
  }
  return out;
}

/** The node hashes a baseline keeps: every tools/ module's. */
export function baselineNodes(
  files: Record<string, string>,
): Record<string, Record<string, string>> {
  return nodeHashes(Object.keys(files).filter(analysable));
}

/** Forget every parse and closure: for a selection over a tree that changed in this process (tools/select-probe.ts). */
export function resetGraphs(): void {
  fineMemo.clear();
  graphMemo.clear();
  resetDeps();
}
