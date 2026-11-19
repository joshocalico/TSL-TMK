// R29's tests (SPEC M5's R29 record, 3.5, 4.3, D44, D73, D79): the table-links proof. tslc proves a class's claim that each
// link its tables hold names a position below its arrays' lengths (compiler/host/links.ts), and marks each JsArray read
// whose index it then knows is in bounds; the inliner takes that call's copy of the leading bounds check out. Here:
//
// - what tslc proves and refuses: r29_links.ts's Table and r29_links_neg.ts's Reent proved; BadStore (a link stored past
//   its key), BadShrink (the keys cut with links left), BadSwap (two tables swapped by halves) and Outside (its keys cut
//   from outside the class) refused; @tsl/jsrt's JsMap proved in a lowered map program in rc and leak;
// - where it must not apply, it doesn't: r29_links_neg.ts builds the same with the proof on and off (TMK_R29_OFF=links) at
//   -O1 and -O2, so every check stays; and where it applies it does: Table's lookups, and JsMap's `seek`, with no bounds
//   check left at -O2, where the build with it off has them;
// - corpus/r29 natively at -O0, -O1 and -O2 against V8 and JSC, every answer and trap the same;
// - each of R29's bugs caught by wrong answers or traps (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r29-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R29_DIR = "corpus/r29";
const POS = "corpus/r29/r29_links.ts";
const NEG = "corpus/r29/r29_links_neg.ts";

/** What tslc's rule must find in each of R29's TSL programs: the groups it proves, and the classes it refuses. */
export const R29_EXPECT: { file: string; groups: string[]; refused: string[] }[] = [
  { file: POS, groups: ["Table: @tsl.links heads chain < keys chain"], refused: [] },
  {
    file: NEG,
    groups: ["Reent: @tsl.links heads < keys"],
    refused: ["BadShrink", "BadStore", "BadSwap", "Outside"],
  },
];

/** r29_links.ts's exports whose lookups (Table's find and steps, inlined) the proof must take bounds checks out of at -O2. */
export const R29_POS_FNS = ["build", "longChains"];

/**
 * R29's bugs, each to be caught by a wrong answer or a trap against V8: in tslc's rule by name (TMK_TEST_TSL, links.ts),
 * and in the inliner by name (TMK_OPT_FAULT, inline.ts; also in `OPT_FAULTS`, so opt-a box 12 runs it). Each runs over
 * corpus/r29 natively at its levels.
 */
export const R29_FAULTS: {
  name: string;
  what: string;
  optFault?: string;
  tslEnv?: string;
  levels: (1 | 2)[];
}[] = [
  {
    name: "r29-links-store",
    what: "a write that stores a link past a bound let through: tslc's rule taking any value stored into a link field as one that keeps the claim, so BadStore's link to the slot past its key is proved, and the read through it loses its check",
    tslEnv: "r29-links-store",
    levels: [1, 2],
  },
  {
    name: "r29-links-shrink",
    what: "a resize that doesn't keep the claim let through: tslc's rule missing a bound array getting shorter (setLength, trim, adopt) and a swap of half a table, so BadShrink's keys cut with its links left, and BadSwap's heads swapped without their keys, are proved, and the reads through them lose their checks",
    tslEnv: "r29-links-shrink",
    levels: [1, 2],
  },
  {
    name: "r29-links-outside",
    what: "a field written from outside the class let through: tslc's rule missing a claimed field named outside its class's methods, so Outside's keys cut from outside are missed, and its lookup loses its check",
    tslEnv: "r29-links-outside",
    levels: [1, 2],
  },
  {
    name: "r29-inb-any",
    what: "the inliner taking a JsArray read's leading bounds check out of every call, not only the calls tslc proved in bounds, so every lookup past the keys reads a number where it trapped 2",
    optFault: "r29-inb-any",
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

function withOff<T>(off: boolean, f: () => T): T {
  const was = process.env.TMK_R29_OFF;
  if (off) process.env.TMK_R29_OFF = "links";
  else delete process.env.TMK_R29_OFF;
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env.TMK_R29_OFF;
    else process.env.TMK_R29_OFF = was;
  }
}

/** corpus/r29 natively at each level, against V8 and JSC (runNative's `mem` rules, over this directory alone). */
export async function r29Native(
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
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R29_DIR),
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

/** The name of the first function in a build whose name matches. */
function fnName(tir: string, re: RegExp): string | undefined {
  for (const m of tir.matchAll(/func @([^(]+)\(/g)) if (re.test(m[1]!)) return m[1]!;
  return undefined;
}

/** How many blocks of a function end in a trap. */
function traps(text: string): number {
  return (text.match(/^\s+trap t\?/gm) ?? []).length;
}

/**
 * Compile-only (seconds): what tslc proves and refuses; r29_links_neg.ts the same with the proof on and off at -O1 and -O2;
 * r29_links.ts's lookups and JsMap's `seek` with no bounds check at -O2, where the build with the proof off has them.
 */
export async function r29Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const { markLinkedChecks } = await import("../compiler/host/links.ts");
  const failures: string[] = [];
  const rows: string[] = [];
  const build = (file: string, opt: 1 | 2, off: boolean): string =>
    withOff(off, () => {
      const c = checkFile(join(ROOT, file));
      if (c.typed === null) throw new Error(`${file}: ${JSON.stringify(c.diags).slice(0, 300)}`);
      return compileTyped(c.typed, { opt }).tirText;
    });
  for (const e of R29_EXPECT) {
    const c = checkFile(join(ROOT, e.file));
    if (c.typed === null) {
      failures.push(`${e.file} doesn't check: ${JSON.stringify(c.diags).slice(0, 300)}`);
      continue;
    }
    // checkFile ran the rule; running it again on the same module gives the same report
    const r = markLinkedChecks(c.typed);
    const refused = Object.keys(r.refused).sort();
    rows.push(`${e.file}: proved ${r.groups.join(", ")}; refused ${refused.join(", ")}`);
    if (JSON.stringify(r.groups) !== JSON.stringify(e.groups))
      failures.push(
        `${e.file}: proved ${JSON.stringify(r.groups)}, not ${JSON.stringify(e.groups)}`,
      );
    if (JSON.stringify(refused) !== JSON.stringify(e.refused))
      failures.push(
        `${e.file}: refused ${JSON.stringify(refused)}, not ${JSON.stringify(e.refused)}`,
      );
  }
  let same = 0;
  for (const opt of [1, 2] as const) {
    if (
      build(NEG, opt, false).replace(/\bt\d+\b/g, "t?") !==
      build(NEG, opt, true).replace(/\bt\d+\b/g, "t?")
    )
      failures.push(`${NEG} at -O${opt} isn't the same build with the proof on and off`);
    else same++;
  }
  rows.push(`r29_links_neg.ts: the same build on and off at ${same} of 2 levels`);
  {
    const on = build(POS, 2, false);
    const off = build(POS, 2, true);
    for (const f of R29_POS_FNS) {
      const name = fnName(on, new RegExp(`^${f}$`));
      if (name === undefined) {
        failures.push(`${POS}: no ${f} at -O2`);
        continue;
      }
      const a = traps(fnText(on, name));
      const b = traps(fnText(off, name));
      rows.push(`r29_links.ts ${f} at -O2: ${b} traps off, ${a} on`);
      if (!(a < b))
        failures.push(
          `${POS}: ${f} at -O2 keeps its bounds checks with the proof on (${a} traps, ${b} off)`,
        );
    }
  }
  // @tsl/jsrt's JsMap in a lowered map program, rc and leak: proved, and seek's chain steps with no check at -O2
  const map = join(ROOT, "corpus/lower/memory/map_grow_oom.ts");
  for (const memory of ["rc", "leak"] as const) {
    const lower = (off: boolean): string =>
      withOff(off, () => lowerFile(map, { memory, opt: 2, route: "tsl", classes: true }).tirText);
    const on = lower(false);
    const off = lower(true);
    const name = fnName(on, /^ex-jsrt-map\.seek</);
    if (name === undefined) {
      failures.push(`map_grow_oom ${memory}: no seek`);
      continue;
    }
    const a = traps(fnText(on, name));
    const b = traps(fnText(off, name));
    rows.push(`map_grow_oom ${memory}: seek at -O2 ${b} traps off, ${a} on`);
    if (a !== 0 || b === 0)
      failures.push(
        `map_grow_oom ${memory}: seek at -O2 has ${a} traps with the proof on, ${b} off`,
      );
  }
  return { failures, rows };
}

/** One of R29's bugs, put in: what caught it over corpus/r29 natively at its levels (wrong answers, and the first). */
export async function r29Fault(
  f: (typeof R29_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => (await r29Native(accel, jobs, f.levels)).failures;
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
    const s = await r29Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r29Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R29_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r29Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
