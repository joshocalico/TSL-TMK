// The dual-route differential (SPEC 4.5, 8.3, D62, `tmk milestone pipe-a`): every program the TSL route can take is compiled
// both ways, straight from the lowered tree to TIR (the reference) and printed as TSL that tslc compiles, and both images run
// natively on the same cases. Every case has to give the same result, the same arguments after, and the same trap code. The
// TIR is compared too: identical TIR is identical machine code, which is what makes the switch-over's speed a fact.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { defaultEngines, listPrograms, lowerCommand, ROOT } from "./corpus.ts";
import { afterExhaustion } from "./r9-tests.ts";
import { buildPath } from "./build-dir.ts";
import { guardedRun, pool } from "./guarded-run.ts";
import { bothRoutesOnWorker } from "./compile-pool.ts";
import { bothRoutes, type BuiltImages } from "./dual-build.ts";
import type { LowerCase } from "./lower-exec.ts";
import { bulkFor, downResults } from "./native-exec.ts";

// Where they were: r8-tests.ts, r10-tests.ts and r11-tests.ts call it on their own programs.
export { bothRoutes };
import { qemuRun, reapOrphans, type Accel } from "./qemu-run.ts";

export type PipeMode = "strict" | "leak" | "manual" | "rc";

/** Every directory of lowered programs with cases, in the order the other suites run them. */
export const PIPE_DIRS = [
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

/** The faults `TMK_TEST_EMIT` puts in the printer (compiler/host/emit-tsl.ts), each one the dual route has to catch. */
export const EMIT_FAULTS: { name: string; what: string }[] = [
  {
    name: "switch-arm",
    what: "a switch whose first two arms' keys are swapped: the wrong class-id arm of a dispatch",
  },
  {
    name: "hoist-late",
    what: "a statement-expression whose statements run after the part of the expression before it",
  },
  { name: "field-offset", what: "a load from the wrong field of an object" },
  {
    name: "wrap-checked",
    what: "JS's wrapping arithmetic under a bit operation printed as checked arithmetic",
  },
];

/** The faults put in class printing (phase 2, EmitOptions.classes), each one the dual route has to catch there. */
export const CLASS_FAULTS: { name: string; what: string }[] = [
  {
    name: "switch-arm",
    what: "the wrong class-id arm of a dispatch, as a switch on the class's `cid` field",
  },
  {
    name: "class-field",
    what: "two fields of one type in a class swapped, as a printer naming the wrong field would",
  },
  {
    name: "this-copy-any",
    what: "a local set to `this` once, and to something else after, printed as `this` wherever a field is read or written through it (pipe-h)",
  },
];

export interface PipeProgram {
  file: string;
  mode: PipeMode;
  level: 0 | 2;
  handled: boolean; // the TSL route took it
  why?: string; // why not
  sameTir?: boolean;
  ms?: { direct: number; tsl: number };
  tslLines?: number;
  intrinsics?: number;
  memoryOps?: number;
  restructured?: number;
}

export interface PipeRow {
  file: string;
  mode: PipeMode;
  level: 0 | 2;
  accel: Accel;
  cases: number;
  agreed: number;
  // R9: cases that differ only as AFTER_EXHAUSTION allows (tools/r9-tests.ts): one route out of memory where the other
  // gives the case's answer, after both ran memory out earlier in the run. Never counted as agreeing
  allowed?: number;
  skipped: boolean;
  sameTir: boolean;
}

/** Runs one route's image and gives each case's result as JSON, the arguments after it included. */
async function runRoute(
  b: BuiltImages,
  route: "direct" | "tsl",
  accel: Accel,
): Promise<{ skipped: boolean; results: string[]; problems: string[]; outOfTime?: boolean }> {
  const file = join(ROOT, b.p.file);
  const r = b[route];
  const q = await qemuRun({
    name: `pipe/${basename(file, ".ts")}-${b.p.mode}-O${b.p.level}-${route}`,
    image: r.image.bytes,
    accel,
    timeoutMs: 60_000,
    ...(r.image.bulk !== undefined ? { bulk: r.image.bulk } : {}),
  });
  if (q.skipped) return { skipped: true, results: [], problems: [] };
  const { results, problems } = downResults(r.meta as never, b.cases, r.placements, q.lines);
  if (!q.ok) problems.push(`${route}: ${q.status}: ${q.why.slice(0, 400)}`);
  return {
    skipped: false,
    results: results.map((x) => JSON.stringify({ result: x.result, args: x.args })),
    problems,
    outOfTime: q.status === "timeout",
  };
}

/**
 * A case the two routes don't agree on (R12): where one route's run ran out of time and so gave nothing for it, the line
 * says so, and an injected bug's run counts it with the cases that ran out of time (corpus.ts's ranOutOfTime), not as a
 * wrong answer: how many cases a run that's out of time never reaches depends on the host's load.
 */
export function disagreement(
  where: string,
  c: { fn: string },
  i: number,
  x: string | undefined,
  y: string | undefined,
  out: { direct: boolean; tsl: boolean },
): string {
  const late =
    (x === undefined && out.direct) || (y === undefined && out.tsl)
      ? " (its run ran out of time)"
      : "";
  return `${where}: ${c.fn}#${i}: direct ${x ?? "nothing"}, TSL ${y ?? "nothing"}${late}`;
}

/** Builds kept ahead of the programs running: the compile workers' number (compile-pool.ts), so none waits for work. */
const COMPILE_AHEAD = 4;

/**
 * Item i's build, asked for in order: each ask starts the builds up to `window` items on, and none further, so at most that
 * many are held. A build that fails before it's asked for is kept as failed, for its asker.
 */
export function compileAhead<T, R>(
  items: T[],
  window: number,
  make: (item: T) => Promise<R>,
): (i: number) => Promise<R> {
  const started = new Map<number, Promise<R>>();
  let next = 0;
  return (i: number): Promise<R> => {
    while (next < items.length && next < i + window) {
      const p = make(items[next]!);
      p.catch(() => {}); // its asker sees it
      started.set(next++, p);
    }
    const p = started.get(i) ?? make(items[i]!);
    started.delete(i);
    return p;
  };
}

export interface PipeRun {
  programs: PipeProgram[];
  rows: PipeRow[];
  failures: string[];
  allowed: string[]; // R9: each case AFTER_EXHAUSTION allows to differ, as a failure would read
  hvfSkipped: boolean;
  printed: PrintedTally;
}

/**
 * The third route (SPEC 3.10, 4.5, D71): each printed program run unchanged on V8 and on JSC, against native and against the
 * source on V8. What differs only by an allowed divergence is counted under it, by its number in 3.10's list.
 */
export interface PrintedTally {
  programs: number; // printed builds run on V8
  cases: number; // cases compared with native
  same: number; // the same result, arguments after and trap code as native
  divergences: Record<string, number>; // "1 (traps)": n
  jsc: number; // printed builds run on JSC too, with V8's results
  jscSkipped: boolean;
}

const PRINTED_EXEC = join(ROOT, "tools/printed-exec.ts");
const HOOK = join(ROOT, "tools/ts-hook.mjs");

/** A printed package's cases on one engine: node with the hook (V8), or Bun (JSC). */
async function runPrinted(
  file: string,
  meta: unknown,
  cases: string,
  engine: "v8" | "jsc",
): Promise<{ results: string[] | null; why: string }> {
  const dir = buildPath("pipe-v8");
  mkdirSync(dir, { recursive: true });
  const metaFile = join(dir, `${basename(file, ".ts")}-${basename(join(file, ".."))}.meta.json`);
  writeFileSync(metaFile, JSON.stringify(meta));
  const job = JSON.stringify({ program: file, cases, meta: metaFile });
  const { node, bun } = defaultEngines();
  const r =
    engine === "v8"
      ? await guardedRun(node, ["--import", HOOK, "--no-warnings", PRINTED_EXEC, job], {
          timeoutMs: 120_000,
          label: `${relative(ROOT, file)} printed, on V8`,
          cwd: ROOT,
        })
      : await guardedRun(bun, [PRINTED_EXEC, job], {
          timeoutMs: 120_000,
          label: `${relative(ROOT, file)} printed, on JSC`,
          cwd: ROOT,
          // JSC sizes its heap by the machine's RAM and collects late, so a program that keeps much (the host's memory is
          // the host's, divergence 4) went past the 3 GiB watchdog on garbage: told it has 1 GiB, it collects sooner.
          // Nothing it computes changes (strkeys: drop_bound.ts printed with JsMap, 2.1 GB where it was killed).
          env: { ...process.env, BUN_JSC_forceRAMSize: String(1 << 30) },
        });
  if (!r.ok) return { results: null, why: `${r.why} ${r.stderr.slice(0, 600)}` };
  try {
    const got = JSON.parse(r.stdout) as { result: unknown; args: unknown }[];
    return { results: got.map((x) => JSON.stringify({ result: x.result, args: x.args })), why: "" };
  } catch (e) {
    return { results: null, why: `unreadable output: ${String(e)} ${r.stdout.slice(0, 300)}` };
  }
}

/** Whether two results are the same but for the numbers in them. */
export function onlyNumbersDiffer(a: string, b: string): boolean {
  const blank = (x: string): string => x.replace(/\{"n":"[0-9a-f]+"\}|\{"n":"nan"\}/g, "N");
  return blank(a) === blank(b);
}

/** Whether both engines ran out of stack (3.10, divergence 14), which they each say in their own words. */
export function bothTooDeep(a: string, b: string): boolean {
  const deep = (x: string): boolean => {
    const r = (JSON.parse(x) as { result: { threw?: string; message?: string } }).result;
    return (
      r.threw === "RangeError" && r.message?.startsWith("Maximum call stack size exceeded") === true
    );
  };
  return deep(a) && deep(b);
}

/**
 * R13: whether both engines threw JS's TypeError for a property read of null or undefined, which they each say in their own
 * words (V8 "Cannot read properties of null", JSC "null is not an object"): where native traps 6 on a `!` the printing keeps
 * as TSL's own, each engine throws JS's exception instead (3.10, divergence 1), as the source does on it. Same arguments.
 */
export function bothNullRead(a: string, b: string): boolean {
  const read = (x: string): boolean => {
    const r = (JSON.parse(x) as { result: { threw?: string; message?: string } }).result;
    return (
      r.threw === "TypeError" &&
      /^(Cannot read properties of (null|undefined)|(null|undefined) is not an object)/.test(
        r.message ?? "",
      )
    );
  };
  return (
    read(a) &&
    read(b) &&
    JSON.stringify((JSON.parse(a) as { args: unknown }).args) ===
      JSON.stringify((JSON.parse(b) as { args: unknown }).args)
  );
}

/**
 * Whether two results differ only in a double's last bit, the one place V8 and JSC are allowed to (3.10, divergence 7: their
 * `sin`, `cos`, `exp`, `log` and `atan2` are different functions).
 */
export function lastBitOnly(a: string, b: string): boolean {
  const ra = (JSON.parse(a) as { result: { value?: { n?: string } } }).result.value?.n;
  const rb = (JSON.parse(b) as { result: { value?: { n?: string } } }).result.value?.n;
  if (ra === undefined || rb === undefined || ra === "nan" || rb === "nan") return false;
  const d = BigInt(`0x${ra}`) - BigInt(`0x${rb}`);
  return (
    (d === 1n || d === -1n) &&
    JSON.stringify((JSON.parse(a) as { args: unknown }).args) ===
      JSON.stringify((JSON.parse(b) as { args: unknown }).args)
  );
}

/**
 * Whether the printed program on V8 (p) differs from native (n) only by one of 3.10's allowed divergences, and which:
 * where native traps, V8 goes on as the source does, with an out-of-range value, or throws JS's exception (1); where either
 * runs out of the memory it has, native its image's pages and the host its simulation's bound (4); and recursion too deep,
 * where V8's own stack gives out first and its RangeError isn't the program's to catch (14). Anything else is a difference.
 */
export function printedDivergence(
  n: string,
  p: string,
  src: string | undefined,
  c: LowerCase,
  mode: PipeMode,
): string | null {
  const nr = (JSON.parse(n) as { result: { trap?: number } }).result;
  const pr = (JSON.parse(p) as { result: { trap?: number; threw?: string; message?: string } })
    .result;
  if (pr.threw === "RangeError" && pr.message === "Maximum call stack size exceeded")
    return "14 (recursion too deep)";
  // A case that declares a last-bit tolerance natively (Math.pow, 3.10 divergence 7) has it here too.
  if (c.native_ulp !== undefined && lastBitOnly(n, p)) return "7 (Math.pow's last bit)";
  // The host's simulation ran out: nothing to compare. Native ran out: what V8 gives instead is the source's.
  if (pr.trap === 14) return "4 (memory)";
  if (nr.trap === 14 || (mode !== "strict" && c.memory_trap?.[mode] !== undefined))
    return src === undefined || src === p ? "4 (memory)" : null;
  if (nr.trap !== undefined && nr.trap < 100000) {
    if (src === p || pr.threw !== undefined || pr.trap === undefined) return "1 (traps)";
  }
  return null;
}

/**
 * The differential over every lowered program with cases, in these modes, at these levels, on these accelerators. A fault
 * name puts that bug in the printer, and then a run that finds nothing is the failure.
 */
export async function dualRoute(o: {
  modes: PipeMode[];
  levels: (0 | 2)[];
  accels: Accel[];
  jobs: number;
  fault?: string;
  filter?: (file: string) => boolean;
  dirs?: string[];
  v8?: (file: string) => boolean; // which programs' direct results are checked against V8 as well: the new ones
  classes?: boolean; // phase 2: objects printed as TSL classes (EmitOptions.classes)
  generated?: boolean; // the generated programs too: the exceptions corpus's every way out through `finally` (exc-gen.ts)
  printed?: boolean; // the third route (D71): on unless false, and off where a fault is put in the printer
  auto?: boolean; // R14: the TSL side is `auto`'s build, a program taken only where `auto` took the TSL route reshaped
}): Promise<PipeRun> {
  reapOrphans();
  const files = (o.dirs ?? PIPE_DIRS)
    .flatMap((d) => (existsSync(join(ROOT, d)) ? listPrograms(join(ROOT, d)) : []))
    .filter((f) => o.generated === true || !/\/gen_/.test(f))
    .filter((f) => o.filter === undefined || o.filter(f));
  const programs: PipeProgram[] = [];
  const failures: string[] = [];
  const allowed: string[] = [];
  // Not where a fault is put in the printer, or in a library's source by TSL_TEST_PATCH, which tslc reads and V8 doesn't.
  const printedOn =
    o.printed !== false &&
    o.fault === undefined &&
    process.env.TSL_TEST_PATCH === undefined &&
    o.accels.length > 0;
  const tally: PrintedTally = {
    programs: 0,
    cases: 0,
    same: 0,
    divergences: {},
    jsc: 0,
    jscSkipped: false,
  };
  // The source on V8 for every program, for the third route: where native traps, what JS does instead.
  const source = new Map<string, string[]>();
  if (printedOn)
    await pool(
      files.map((f) => relative(ROOT, f)),
      o.jobs,
      async (rel) => {
        const { cmd, args } = lowerCommand(
          "source-v8",
          join(ROOT, rel),
          buildPath("pipe"),
          defaultEngines(),
        );
        const r = await guardedRun(cmd, args, {
          timeoutMs: 60_000,
          label: `${rel} on V8`,
          cwd: ROOT,
        });
        if (!r.ok) return;
        try {
          const got = JSON.parse(r.stdout) as { result: unknown; args: unknown }[];
          source.set(
            rel,
            got.map((x) => JSON.stringify({ result: x.result, args: x.args })),
          );
        } catch {
          // a program V8 can't run has no source results: the third route compares with native alone
        }
      },
    );
  // One run of each printed package per engine, whatever level and accelerator native ran it at: its text is the same.
  const printedRuns = new Map<string, Promise<{ v8: string[] | null; jsc: string[] | null }>>();
  const printedOf = (b: BuiltImages): Promise<{ v8: string[] | null; jsc: string[] | null }> => {
    const key = b.printed!;
    let hit = printedRuns.get(key);
    if (hit === undefined) {
      hit = (async () => {
        const casesFile = join(ROOT, b.p.file).replace(/\.ts$/, ".cases.json");
        const v8r = await runPrinted(key, b.tsl.meta, casesFile, "v8");
        tally.programs++;
        if (v8r.results === null)
          failures.push(`${b.p.file} ${b.p.mode}: the printed TSL failed on V8: ${v8r.why}`);
        const jscr = await runPrinted(key, b.tsl.meta, casesFile, "jsc");
        // V8's and JSC's `sin`, `cos`, `tan`, `exp`, `log`, `atan2` and `pow` are different functions (3.10, divergence 7):
        // a program calling one is held to V8 alone on the numbers they give, as the corpora's JSC runs are.
        const usesHostMath = /Math\.(sin|cos|tan|exp|log|atan2|pow)\b|\*\*/.test(
          readFileSync(join(ROOT, b.p.file), "utf8"),
        );
        if (jscr.results === null && /ENOENT|not found|spawn/.test(jscr.why))
          tally.jscSkipped = true;
        else if (jscr.results === null)
          failures.push(`${b.p.file} ${b.p.mode}: the printed TSL failed on JSC: ${jscr.why}`);
        else {
          tally.jsc++;
          if (v8r.results !== null)
            jscr.results.forEach((x, i) => {
              if (x === v8r.results![i]) return;
              if (bothTooDeep(x, v8r.results![i]!)) {
                const k = "14 (recursion too deep)";
                tally.divergences[k] = (tally.divergences[k] ?? 0) + 1;
                return;
              }
              if (bothNullRead(x, v8r.results![i]!)) {
                const k = "1 (a read of null, V8 against JSC, each in its own words)";
                tally.divergences[k] = (tally.divergences[k] ?? 0) + 1;
                return;
              }
              if (
                lastBitOnly(x, v8r.results![i]!) ||
                (usesHostMath && onlyNumbersDiffer(x, v8r.results![i]!))
              ) {
                const k = "7 (a Math function's result, V8 against JSC)";
                tally.divergences[k] = (tally.divergences[k] ?? 0) + 1;
                return;
              }
              if (x !== v8r.results![i])
                failures.push(
                  `${b.p.file} ${b.p.mode}: ${b.cases[i]?.fn}#${i}: printed TSL on V8 ${v8r.results![i]}, on JSC ${x}`,
                );
            });
        }
        return { v8: v8r.results, jsc: jscr.results };
      })();
      printedRuns.set(key, hit);
    }
    return hit;
  };
  // V8's results for the programs this work added: the routes agreeing proves nothing if both are wrong.
  const v8 = new Map<string, string[]>();
  const v8Files =
    o.accels.length === 0
      ? []
      : files.map((f) => relative(ROOT, f)).filter((f) => o.v8?.(f) === true);
  await pool(v8Files, o.jobs, async (rel) => {
    const { cmd, args } = lowerCommand(
      "source-v8",
      join(ROOT, rel),
      buildPath("pipe"),
      defaultEngines(),
    );
    const r = await guardedRun(cmd, args, { timeoutMs: 60_000, label: `${rel} on V8`, cwd: ROOT });
    if (!r.ok) {
      failures.push(`${rel}: V8 failed: ${r.why} ${r.stderr.slice(0, 300)}`);
      return;
    }
    const got = JSON.parse(r.stdout) as { result: unknown; args: unknown }[];
    v8.set(
      rel,
      got.map((x) => JSON.stringify({ result: x.result, args: x.args })),
    );
  });
  // One program build at a time per job, compiled, run and let go: holding every build's TIR at once ran a gate job past
  // its 3 GiB watchdog (MEASURED, 400 builds). What's kept is the summary.
  const items = o.modes.flatMap((mode) =>
    o.levels.flatMap((level) => files.map((f) => ({ f, mode, level }))),
  );
  const rows: PipeRow[] = [];
  let hvfSkipped = false;
  // Compiled on the compile workers (T2), with this process's environment: the test process's thread stays free to see its
  // QEMU runs and reference engines finish (a compile on it held their results back, past a 60 s limit under a gate's load),
  // and the next programs compile while these run. As many run at once as before; a few more are built ahead.
  const lanes = o.accels.length === 0 ? 1 : o.jobs;
  const built = compileAhead(items, lanes + COMPILE_AHEAD, ({ f, mode, level }) =>
    bothRoutesOnWorker({
      file: f,
      mode,
      level,
      fault: o.fault,
      classes: o.classes === true,
      bulkBytes: bulkFor(),
      ...(o.auto === true ? { auto: true } : {}),
    }),
  );
  await pool(
    items.map((_, i) => i),
    lanes,
    async (i) => {
      const r = await built(i);
      programs.push(r.p);
      if (r.p.why?.startsWith("FAILED") === true)
        failures.push(`${r.p.file} ${r.p.mode} -O${r.p.level}: ${r.p.why}`);
      const b = r.built;
      if (b === null || b.cases.length === 0) return;
      for (const accel of o.accels) {
        const [d, t] = await Promise.all([runRoute(b, "direct", accel), runRoute(b, "tsl", accel)]);
        const row: PipeRow = {
          file: b.p.file,
          mode: b.p.mode,
          level: b.p.level,
          accel,
          cases: b.cases.length,
          agreed: 0,
          skipped: d.skipped || t.skipped,
          sameTir: b.p.sameTir === true,
        };
        rows.push(row);
        if (row.skipped) {
          if (accel === "hvf") hvfSkipped = true;
          continue;
        }
        const where = `${b.p.file} ${b.p.mode} -O${b.p.level} ${accel}`;
        for (const p of [...d.problems, ...t.problems]) failures.push(`${where}: ${p}`);
        const ref = v8.get(b.p.file);
        const printed = printedOn && b.printed !== null ? (await printedOf(b)).v8 : null;
        const src = source.get(b.p.file);
        b.cases.forEach((c, i) => {
          const x = d.results[i];
          const y = t.results[i];
          if (x !== undefined && x === y) row.agreed++;
          else {
            const line = disagreement(where, c, i, x, y, {
              direct: d.outOfTime === true,
              tsl: t.outOfTime === true,
            });
            if (afterExhaustion(line)) {
              row.allowed = (row.allowed ?? 0) + 1;
              allowed.push(line);
            } else failures.push(line);
          }
          if (ref !== undefined && ref[i] !== x)
            failures.push(
              `${where}: ${c.fn}#${i}: native ${x ?? "nothing"}, V8 ${ref[i] ?? "nothing"}${x === undefined && d.outOfTime === true ? " (its run ran out of time)" : ""}`,
            );
          if (printed === null || x === undefined) return;
          const p = printed[i];
          tally.cases++;
          if (p === x) {
            tally.same++;
            return;
          }
          const why = p === undefined ? null : printedDivergence(x, p, src?.[i], c, b.p.mode);
          if (why !== null) tally.divergences[why] = (tally.divergences[why] ?? 0) + 1;
          else
            failures.push(
              `${where}: ${c.fn}#${i}: native ${x}, the printed TSL on V8 ${p ?? "nothing"}`,
            );
        });
      }
    },
  );
  return { programs, rows, failures, allowed, hvfSkipped, printed: tally };
}

/** Coverage: of each corpus, how much the TSL route takes, in each mode. */
export function coverageOf(programs: PipeProgram[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const byDir = new Map<string, PipeProgram[]>();
  for (const p of programs) {
    const d = p.file.replace(/\/[^/]+$/, "");
    byDir.set(d, [...(byDir.get(d) ?? []), p]);
  }
  for (const [d, ps] of byDir) {
    out[d] = {};
    for (const mode of ["strict", "leak", "manual", "rc"]) {
      const m = ps.filter((p) => p.mode === mode);
      if (m.length === 0) continue;
      const files = new Set(m.map((p) => p.file));
      const lowered = new Set(
        m
          .filter((p) => p.why !== "the direct route has a fallback" && p.why !== "doesn't compile")
          .map((p) => p.file),
      );
      const handled = new Set(m.filter((p) => p.handled).map((p) => p.file));
      out[d]![mode] =
        `${handled.size}/${lowered.size} of what the direct route lowers (${files.size} programs)`;
    }
  }
  return out;
}

// `node tools/pipe-tests.ts [--fault name] [--modes strict,leak] [--levels 0,2] [--accel hvf|tcg|both] [--filter s]
// [--classes] [--generated] [--dirs a,b]`
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const accel = val("--accel") ?? "hvf";
  const r = await dualRoute({
    modes: (val("--modes") ?? "strict,leak,manual").split(",") as PipeMode[],
    levels: (val("--levels") ?? "0,2").split(",").map(Number) as (0 | 2)[],
    accels: accel === "both" ? ["hvf", "tcg"] : [accel as Accel],
    jobs: Number(val("--jobs") ?? 4),
    ...(val("--fault") !== undefined ? { fault: val("--fault")! } : {}),
    ...(val("--filter") !== undefined
      ? { filter: (f: string) => f.includes(val("--filter")!) }
      : {}),
    v8: (f) => f.startsWith("corpus/lower/pipe/"),
    ...(argv.includes("--classes") ? { classes: true } : {}),
    ...(argv.includes("--generated") ? { generated: true } : {}),
    ...(val("--dirs") !== undefined ? { dirs: val("--dirs")!.split(",") } : {}),
    ...(argv.includes("--no-printed") ? { printed: false } : {}),
  });
  const cases = r.rows.reduce((n, x) => n + x.cases, 0);
  const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
  const handled = r.programs.filter((p) => p.handled);
  console.log(
    JSON.stringify({
      rows: r.rows.length,
      cases,
      agreed,
      handled: handled.length,
      sameTir: handled.filter((p) => p.sameTir).length,
      printed: r.printed,
      failures: r.failures.length,
      hvfSkipped: r.hvfSkipped,
      coverage: coverageOf(r.programs),
    }),
  );
  for (const f of r.failures.slice(0, 40)) console.log(`  ${f}`);
  process.exitCode = r.failures.length > 0 ? 1 : 0;
}
