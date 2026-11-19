// R27's tests (SPEC M5's R27 record, 3.5, 4.3, D44, D73, D77): fresh-allocation separation. tslc proves a class's field
// holds only blocks no object can be in (compiler/host/separate.ts), and the optimiser takes a store into such a block as
// unable to change any object's field, and a call that writes only such blocks as one that writes no field
// (compiler/tir/passes/memory.ts). Here:
//
// - what tslc separates and refuses: r27_sep.ts's Buf and r27_sep_neg.ts's Arr separated; Escapes (its block's address given
//   to code outside), Kept (stored in another object's field) and Ref (a word set from outside) refused; @tsl/jsrt's
//   JsArray separated in a lowered `rc` and `leak` map program;
// - where it must not apply, it doesn't: each of r27_sep_neg.ts's functions is the same TIR, its trap numbers aside, with
//   the separation on and off (TMK_R27_OFF=sep), at -O1 and -O2, so every check it had stays; and where it applies it does
//   (r27_sep.ts's fills, and JsMap's growth, `steps` and `link`, at -O2);
// - corpus/r27 natively at -O0, -O1 and -O2 against V8 and JSC, every answer and trap the same;
// - corpus/lower/r27 (maps grown while moving, arrays filled while one grows or is cut) through both routes with class
//   printing forced in `rc` and `leak` at -O0, -O1 and -O2, against V8, and the printed TSL on V8 and JSC;
// - each of R27's bugs caught by wrong answers (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r27-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R27_DIR = "corpus/r27";
export const R27_LOWER_DIR = "corpus/lower/r27";
const SEP = "corpus/r27/r27_sep.ts";
const NEG = "corpus/r27/r27_sep_neg.ts";

/** What tslc's rule must find in each of R27's TSL programs: the fields it separates, and the classes it refuses. */
export const R27_EXPECT: { file: string; fields: string[]; refused: string[] }[] = [
  { file: SEP, fields: ["Buf.data"], refused: [] },
  { file: NEG, fields: ["Arr.data"], refused: ["Escapes", "Kept", "Ref"] },
];

/** r27_sep_neg.ts's functions: the separation mustn't change them. */
export const R27_NEG_FNS = [
  "escapeView",
  "escapeBound",
  "storedAndReadBack",
  "callWrites",
  "rawThroughField",
];
/** r27_sep.ts's functions the separation must change at -O2: a length kept across a store into a block, or a call. */
export const R27_POS_FNS = ["copyAll", "fillThroughCall", "adoptMidFill", "readPast"];

/**
 * R27's bugs, each to be caught by a wrong answer against V8: in the optimiser by name (TMK_OPT_FAULT, memory.ts; also in
 * `OPT_FAULTS`, so opt-a box 12 runs them) and in tslc's rule by name (TMK_TEST_TSL, separate.ts). Each runs over
 * corpus/r27 natively at its levels.
 */
export const R27_FAULTS: {
  name: string;
  what: string;
  optFault?: string;
  tslEnv?: string;
  levels: (1 | 2)[];
}[] = [
  {
    name: "r27-summary-miss",
    what: "a call's write summary missing a write: a store anywhere but the callee's own frame taken as one into a block, so a call that cuts a length keeps the length read before it, and get's check after the call goes",
    optFault: "r27-summary-miss",
    levels: [1, 2],
  },
  {
    name: "r27-alias-any",
    what: "an alias the separation misses: every 64-bit word loaded taken as a separated field's block, so a raw store through an address read from a field doesn't change the view's word read after it",
    optFault: "r27-alias-any",
    levels: [1, 2],
  },
  {
    name: "r27-sep-escape",
    what: "a check removed where a reference escapes: tslc's rule letting a block's address leave its class (given to code outside, or stored in another object's field), so a view's store into the block isn't seen by the element read after it, and a bound kept in the block is read stale",
    tslEnv: "r27-sep-escape",
    levels: [1, 2],
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

/** corpus/r27 natively at each level, against V8 and JSC (runNative's `mem` rules, over this directory alone). */
export async function r27Native(
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
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R27_DIR),
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

/** One function's TIR from a build's text, its trap numbers taken out (a module numbers its traps as a whole). */
function fnText(tir: string, name: string): string {
  const at = tir.indexOf(`func @${name}(`);
  if (at < 0) return "";
  return tir.slice(at, tir.indexOf("\n}", at) + 2).replace(/\bt\d+\b/g, "t?");
}

/**
 * Compile-only (seconds): what tslc separates and refuses; r27_sep_neg.ts's functions the same with the separation on and
 * off at -O1 and -O2; r27_sep.ts's fills and JsMap's growth changed by it at -O2.
 */
export async function r27Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const { markSeparatedFields } = await import("../compiler/host/separate.ts");
  const failures: string[] = [];
  const rows: string[] = [];
  const build = (file: string, opt: 1 | 2, off: boolean): string =>
    (() => {
      const was = process.env.TMK_R27_OFF;
      if (off) process.env.TMK_R27_OFF = "sep";
      else delete process.env.TMK_R27_OFF;
      try {
        const c = checkFile(join(ROOT, file));
        if (c.typed === null) throw new Error(`${file}: ${JSON.stringify(c.diags).slice(0, 300)}`);
        return compileTyped(c.typed, { opt }).tirText;
      } finally {
        if (was === undefined) delete process.env.TMK_R27_OFF;
        else process.env.TMK_R27_OFF = was;
      }
    })();
  for (const e of R27_EXPECT) {
    const c = checkFile(join(ROOT, e.file));
    if (c.typed === null) {
      failures.push(`${e.file} doesn't check: ${JSON.stringify(c.diags).slice(0, 300)}`);
      continue;
    }
    const r = markSeparatedFields(c.typed);
    const refused = Object.keys(r.refused)
      .filter((k) => k !== "Heap")
      .sort();
    rows.push(`${e.file}: separated ${r.fields.join(", ")}; refused ${refused.join(", ")}`);
    if (JSON.stringify(r.fields) !== JSON.stringify(e.fields))
      failures.push(
        `${e.file}: separated ${JSON.stringify(r.fields)}, not ${JSON.stringify(e.fields)}`,
      );
    if (JSON.stringify(refused) !== JSON.stringify(e.refused))
      failures.push(
        `${e.file}: refused ${JSON.stringify(refused)}, not ${JSON.stringify(e.refused)}`,
      );
  }
  let same = 0;
  for (const opt of [1, 2] as const) {
    const on = build(NEG, opt, false);
    const off = build(NEG, opt, true);
    for (const f of R27_NEG_FNS) {
      const a = fnText(on, f);
      if (a === "") failures.push(`${NEG}: no @${f} at -O${opt}`);
      else if (a !== fnText(off, f))
        failures.push(`${NEG}: @${f} at -O${opt} isn't the same with the separation on and off`);
      else same++;
    }
  }
  rows.push(`r27_sep_neg.ts: ${same} of ${R27_NEG_FNS.length * 2} functions the same on and off`);
  let changed = 0;
  {
    const on = build(SEP, 2, false);
    const off = build(SEP, 2, true);
    for (const f of R27_POS_FNS) {
      if (fnText(on, f) === fnText(off, f))
        failures.push(`${SEP}: @${f} at -O2 is the same with the separation on and off`);
      else changed++;
    }
  }
  rows.push(`r27_sep.ts: ${changed} of ${R27_POS_FNS.length} fills changed by it at -O2`);
  // @tsl/jsrt's JsArray in a lowered map program, rc and leak: separated, and JsMap's growth changed by it
  const map = join(ROOT, "corpus/lower/memory/map_grow_oom.ts");
  for (const memory of ["rc", "leak"] as const) {
    const lower = (off: boolean): string => {
      const was = process.env.TMK_R27_OFF;
      if (off) process.env.TMK_R27_OFF = "sep";
      else delete process.env.TMK_R27_OFF;
      try {
        return lowerFile(map, { memory, opt: 2, route: "tsl", classes: true }).tirText;
      } finally {
        if (was === undefined) delete process.env.TMK_R27_OFF;
        else process.env.TMK_R27_OFF = was;
      }
    };
    const on = lower(false);
    const off = lower(true);
    for (const f of ["steps", "link"]) {
      const name = new RegExp(`func @(ex-jsrt-map\\.JsMap<[^>]*>\\.${f}~[0-9a-f]+)\\(`).exec(
        on,
      )?.[1];
      if (name === undefined) failures.push(`map_grow_oom ${memory}: no JsMap ${f}`);
      else if (fnText(on, name) === fnText(off, name))
        failures.push(
          `map_grow_oom ${memory}: JsMap's ${f} at -O2 is the same with the separation on and off`,
        );
      else rows.push(`map_grow_oom ${memory}: JsMap's ${f} changed`);
    }
  }
  return { failures, rows };
}

/**
 * corpus/lower/r27 (and other directories) through the dual route with class printing forced, in `rc` and `leak`: every
 * case agrees with V8 natively and with the TSL route, and the printed TSL on V8 and JSC with the source.
 */
export async function r27Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  dirs: string[] = [R27_LOWER_DIR],
): Promise<{ failures: string[]; cases: number; agreed: number; printed: string[] }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc", "leak"],
    levels: levels as never,
    accels,
    jobs,
    classes: true,
    printed,
    dirs,
    v8: () => true,
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    printed: r.programs
      .filter((p) => p.handled && relative(ROOT, p.file) !== "")
      .map((p) => `${p.file}@${p.mode}`)
      .sort(),
  };
}

/** One of R27's bugs, put in: what caught it over corpus/r27 natively at its levels (wrong answers, and the first). */
export async function r27Fault(
  f: (typeof R27_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => (await r27Native(accel, jobs, f.levels)).failures;
  const failures = faultFailures(
    await withEnv(
      {
        ...(f.optFault !== undefined ? { TMK_OPT_FAULT: f.optFault } : {}),
        ...(f.tslEnv !== undefined ? { TMK_TEST_TSL: f.tslEnv } : {}),
      },
      run,
    ),
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
    const s = await r27Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r27Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      const d = await r27Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases; printed ${d.printed.join(", ")}`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length + d.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R27_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r27Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.answers === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
