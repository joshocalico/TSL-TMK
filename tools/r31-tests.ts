// R31's tests (SPEC M5's R31 record, 3.5, 4.4, D39, D41, D80): the cold-call split's quick ways out, and @tsl/gc's chunks
// taken from the page source straight. Here:
//
// - what the split's change must do where it applies: r31_split.ts's `quick` and `quickF`, whose calls are past a block that
//   only returns a constant, have no cold call, where with R31 off (TMK_R31_OFF=split) each has one (coldCalls);
// - corpus/r31 natively at -O0, -O1 and -O2 against V8 and JSC, every answer and trap the same;
// - corpus/lower/r31 through the dual route with class printing forced, in `rc` with the collector linked, at -O0 and -O2:
//   @tsl/gc's chunks taken from the page source straight (chunkPages), every case agreeing with V8 natively and through
//   both routes, and the printed TSL on V8 and JSC with the source;
// - each of R31's bugs caught by wrong answers or traps (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure). Which calls are cold decides only what's saved where, never what's computed, so the quick-way-out rule has no
//   bug of its own a wrong answer could show; R30's split bugs (r30-tests.ts) cover the saves it decides.
//
//   node tools/r31-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R31_DIR = "corpus/r31";
export const R31_LOWER_DIR = "corpus/lower/r31";
const RC = "ex-gc-rc.ts";
const SPLIT = "corpus/r31/r31_split.ts";

/**
 * R31's bugs, each to be caught by a wrong answer or a trap against V8: in @tsl/gc by patch (TSL_TEST_PATCH, matched
 * exactly), over corpus/lower/r31 through the dual route at its levels.
 */
export const R31_FAULTS: {
  name: string;
  what: string;
  patch?: TestPatch;
  levels: (0 | 2)[];
  where: ("native" | "dual")[];
}[] = [
  {
    name: "r31-chunk-one-page",
    what: "chunkPages giving every chunk one page, whatever it spans, so a slot of several pages runs over the next chunk's pages",
    patch: {
      file: RC,
      from: "  return pages(toUsize(BigInt.asUintN(64, toU64(bytes) + toU64(PAGE - 1)) / toU64(PAGE)));",
      to: "  return pages(toUsize(BigInt.asUintN(64, toU64(PAGE) + toU64(PAGE - 1)) / toU64(PAGE)));",
    },
    levels: [2],
    where: ["dual"],
  },
];

function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const was: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return f().finally(() => {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** What R31's split change must do where it applies, and must not do where it's off. */
export async function r31Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { coldCalls } = await import("../compiler/backend-aarch64/regalloc.ts");
  const { typed } = checkFile(join(ROOT, SPLIT));
  if (typed === null) return { failures: ["r31_split.ts doesn't compile"], rows };
  for (const level of [1, 2] as const) {
    const m = await withEnv({ TMK_OPT: String(level) }, async () => compileTyped(typed).tir);
    const look = async (off: boolean): Promise<{ quick: number; quickF: number }> =>
      withEnv({ TMK_R31_OFF: off ? "split" : undefined }, async () => {
        const cold = (name: string): number => {
          const f = m.funcs.find((x) => x.name === name);
          return f === undefined ? -1 : [...coldCalls(f)].filter((i) => i.op === "call").length;
        };
        return { quick: cold("quick"), quickF: cold("quickF") };
      });
    const on = await look(false);
    const off = await look(true);
    rows.push(
      `-O${level}: cold calls in quick ${on.quick} (R31 off ${off.quick}), quickF ${on.quickF} (off ${off.quickF})`,
    );
    for (const k of ["quick", "quickF"] as const) {
      if (on[k] !== 0)
        failures.push(`-O${level}: ${k}'s call past a quick way out is cold (${on[k]})`);
      if (off[k] < 1)
        failures.push(
          `-O${level}: ${k} has no cold call with R31 off: the switch does nothing (${off[k]})`,
        );
    }
  }
  return { failures, rows };
}

/** corpus/r31 natively at each level, against V8 and JSC (runNative's `mem` rules, over this directory alone). */
export async function r31Native(
  accel: Accel,
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
): Promise<{ failures: string[]; cases: number; agreed: number; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  let cases = 0;
  let agreed = 0;
  const engines = defaultEngines();
  for (const level of levels) {
    const r = await withEnv({ TMK_OPT: String(level) }, () =>
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R31_DIR),
    );
    for (const a of r.agreement) {
      cases += a.cases;
      agreed += a.agreed;
      rows.push(`-O${level}: ${a.skipped ? "skipped" : `${a.agreed}/${a.cases}`}`);
    }
    failures.push(...r.failures.map((x) => `-O${level}: ${x}`));
  }
  return { failures, cases, agreed, rows };
}

/**
 * The dual route with class printing forced, over corpus/lower/r31, in `rc` (the collector linked: its programs have cycles):
 * every case agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source.
 */
export async function r31Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc"],
    levels,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R31_LOWER_DIR],
    v8: () => true,
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
  };
}

/** One of R31's bugs, put in: what caught it (wrong answers, and the first in a stable order). */
export async function r31Fault(
  f: (typeof R31_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => {
    const out: string[] = [];
    if (f.where.includes("native")) out.push(...(await r31Native(accel, jobs, f.levels)).failures);
    if (f.where.includes("dual"))
      out.push(...(await r31Dual([accel], jobs, f.levels, false)).failures);
    return out;
  };
  const failures = faultFailures(
    await (f.patch !== undefined ? withPatch(f.patch, run) : run()),
    f.name,
  );
  return {
    caught: failures.length,
    answers: wrongAnswers(failures),
    first: (firstInOrder(failures) ?? "").slice(0, 200),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const accel = (val("--accel") ?? "hvf") as Accel;
  const jobs = Number(val("--jobs") ?? 4);
  let bad = 0;
  if (!argv.includes("--faults-only")) {
    const s = await r31Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r31Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length;
      const d = await r31Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases}`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R31_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r31Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
