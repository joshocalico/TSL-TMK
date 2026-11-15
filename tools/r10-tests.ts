// R10's tests (SPEC M5's R10 record, 3.5, 4.5's ABI in `rc`, D39, D42): strings in `rc` through the TSL route, the
// program's own JsStr and JsStrBuf (compiler/host/emit-rcstr.ts), counted by tslc's `rc` expansion as its classes are.
// The dual route and the printed TSL on V8 and JSC check results; a native caller's counts check what's held after each
// case (only what module state keeps), each result's count, and D39's freeing bound once many strings are let go of at
// once; and each bug put into the strings' printing, their counting or their ABI is caught.
//
//   node tools/r10-tests.ts [--accel hvf|tcg] [--faults]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { buildDownImage, bulkFor, downResults } from "./native-exec.ts";
import { type Accel, qemuRun } from "./qemu-run.ts";

/**
 * R10's own program, and every program its strings brought onto the TSL route in `rc` (tools/route-blockers.ts, before and
 * after), each built through both routes by the differential and run on V8 and JSC by the third.
 */
export const R10_PROGRAMS = [
  "corpus/lower/pipe/rc_strings.ts", // R10's own
  "corpus/lower/pipe/strings.ts",
  "corpus/lower/pipe/strkeys.ts",
  "corpus/lower/pos/object_shape.ts",
  "corpus/lower/rc/adv_array_release.ts", // a constant length's scratch typed array, on the stack (number text)
  "corpus/lower/exc/class_init_order.ts",
  "corpus/lower/exc/class_shapes.ts",
  "corpus/lower/strmap/app_builder.ts", // a callback's dead `undefined` after it returned on every path (liveStmts)
  "corpus/lower/strmap/app_text.ts",
  "corpus/lower/strmap/case_all.ts",
  "corpus/lower/strmap/drop_bound.ts",
  "corpus/lower/strmap/frag.ts",
  "corpus/lower/strmap/gaps.ts",
  "corpus/lower/strmap/gaps_context.ts", // maps made as a call's arguments
  "corpus/lower/strmap/smoke.ts",
  "corpus/lower/strmap/str_methods.ts",
  "corpus/lower/strmap/rc_churn.ts", // RC_TSL_ROUTE_OOM until R11 (tools/r11-tests.ts): a set churn, not its strings
  "bench/maps/growth_lowered.ts",
  "bench/strmap/str_lowered.ts",
  "bench/strmap/strmap_lowered.ts",
];

const PROGRAM = join(ROOT, "corpus/lower/pipe/rc_strings.ts");

/**
 * What's live after each of rc_strings.ts's cases, once the caller has let go of its arguments and its result and
 * everything pending is collected, past what module state always keeps (its literals and `""`, the first case's figure):
 * the kept string (cases 20 and 21), the 500 strings and their array (24), and nothing else. A second round of the same
 * cases ends where the first did, so no case leaks a string a round.
 */
export const LIVE_PAST_BASE: Record<number, number> = { 20: 1, 21: 1, 24: 501 };

/**
 * Each string result's count as the caller holds it, before letting go: one, the caller's (D39), but where the result is
 * also held elsewhere: `echo` gives back the argument the caller still holds (two), `hello` and the second `readKept` a
 * literal module state holds (two), and the first `readKept` the string module state keeps (two).
 */
export const RESULT_COUNT: Record<number, number> = {
  0: 2,
  1: 2,
  2: 2,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 1,
  9: 1,
  10: 1,
  16: 1,
  17: 1,
  19: 1,
  21: 2,
  23: 2,
};

/** @tsl/gc's budget: an allocation does at most this many freeing steps (D39). */
const RC_BUDGET = 32;
const CASES = 28;

interface CountRun {
  problems: string[];
  live: number[];
  steps: number[];
  counts: Record<number, number>;
  results: string[];
}

/** rc_strings.ts through the TSL route at one level, its cases run `rounds` times in one image. */
export async function countRun(
  accel: Accel,
  level: 0 | 1 | 2,
  o: { collect: boolean; rounds: number; fault?: string },
): Promise<CountRun> {
  const P = await import("./pipe-tests.ts");
  const { built, p } = P.bothRoutes(PROGRAM, "rc", level as 0 | 2, o.fault);
  if (built === null)
    return {
      problems: [`not built through both routes: ${p.why ?? ""}`],
      live: [],
      steps: [],
      counts: {},
      results: [],
    };
  const cases = Array.from({ length: o.rounds }, () => built.cases).flat();
  const pages = Number(/^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(PROGRAM, "utf8"))![1]);
  const img = buildDownImage(built.tsl.tir, built.tsl.meta as never, cases, pages, {
    collect: o.collect,
    tslLive: true,
    tslResultCount: true,
    bulkBytes: bulkFor(),
  } as never);
  const q = await qemuRun({
    name: `r10/rc_strings-O${level}${o.collect ? "" : "-nocollect"}`,
    image: img.image.bytes,
    accel,
    timeoutMs: 60_000,
    ...(img.image.bulk !== undefined ? { bulk: img.image.bulk } : {}),
  });
  if (q.skipped) return { problems: ["skipped"], live: [], steps: [], counts: {}, results: [] };
  const problems: string[] = [];
  if (!q.ok) problems.push(`${q.status}: ${q.why.slice(0, 300)}`);
  const live: number[] = [];
  const steps: number[] = [];
  const counts: Record<number, number> = {};
  for (const l of q.lines) {
    const m = /TMK:RL (\d+) (\d+) (\d+)/.exec(l);
    if (m !== null) {
      live[Number(m[1])] = Number(m[2]);
      steps[Number(m[1])] = Number(m[3]);
    }
    const c = /TMK:RC (\d+) (\d+)/.exec(l);
    if (c !== null) counts[Number(c[1])] = Number(c[2]);
  }
  const { results } = downResults(built.tsl.meta as never, cases, img.placements, q.lines);
  return { problems, live, steps, counts, results: results.map((x) => JSON.stringify(x.result)) };
}

/**
 * What the counting gives, checked: after each case and its collection only what module state keeps is live, in both
 * rounds; each string result's count is the caller's one (or as RESULT_COUNT says); and with nothing collected between
 * cases, letting go of 500 strings at once frees none of them then, each allocation after it does at most its budget of
 * freeing steps, and the results are those of the collected run.
 */
export async function ownershipChecks(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 2],
  fault?: string,
): Promise<{ rows: string[]; failures: string[]; skipped: boolean }> {
  const rows: string[] = [];
  const failures: string[] = [];
  let skipped = false;
  for (const level of levels) {
    const a = await countRun(accel, level, {
      collect: true,
      rounds: 2,
      ...(fault !== undefined ? { fault } : {}),
    });
    if (a.problems.includes("skipped")) {
      skipped = true;
      continue;
    }
    failures.push(...a.problems.map((p) => `-O${level}: ${p}`));
    const base = a.live[0];
    if (base === undefined || base < 1)
      failures.push(`-O${level}: no live count after the first case`);
    let same = 0;
    for (let i = 0; i < 2 * CASES; i++) {
      const want = (base ?? 0) + (LIVE_PAST_BASE[i % CASES] ?? 0);
      if (a.live[i] === want) same++;
      else
        failures.push(
          `-O${level} case ${i}: ${a.live[i]} live after it, where module state keeps ${want}`,
        );
      const rc = RESULT_COUNT[i % CASES];
      if (rc !== undefined && a.counts[i] !== rc)
        failures.push(`-O${level} case ${i}: its result's count ${a.counts[i]}, where it's ${rc}`);
    }
    for (const k of Object.keys(a.counts).map(Number))
      if (RESULT_COUNT[k % CASES] === undefined)
        failures.push(`-O${level} case ${k}: a count read for a result that isn't a string`);
    rows.push(
      `-O${level}: ${same}/${2 * CASES} live counts as module state keeps (${base} always), ${Object.keys(a.counts).length} result counts as the caller's`,
    );
    // D39: letting go of many strings at once only queues them; then each allocation's steps stay within the budget
    const b = await countRun(accel, level, {
      collect: false,
      rounds: 1,
      ...(fault !== undefined ? { fault } : {}),
    });
    failures.push(...b.problems.map((p) => `-O${level}, nothing collected: ${p}`));
    const drop = 25;
    if (!(b.live[drop]! >= 500))
      failures.push(
        `-O${level}: letting go of 500 strings freed them at once (${b.live[drop]} live)`,
      );
    for (const i of [26, 27]) {
      const d = b.steps[i]! - b.steps[i - 1]!;
      if (!(d >= 0 && d <= RC_BUDGET))
        failures.push(`-O${level}: case ${i} took ${d} freeing steps, over ${RC_BUDGET}`);
    }
    if (b.results.join() !== a.results.slice(0, CASES).join())
      failures.push(`-O${level}: results with nothing collected aren't the same as with`);
    rows.push(
      `-O${level}, nothing collected: ${b.live[drop]} live after letting go of 500 strings, then ${b.steps[26]! - b.steps[25]!} and ${b.steps[27]! - b.steps[26]!} steps an allocation`,
    );
  }
  return { rows, failures, skipped };
}

function withEnv<X>(vars: Record<string, string | undefined>, f: () => Promise<X>): Promise<X> {
  const was: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    was[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return f().finally(() => {
    for (const k of Object.keys(was)) {
      if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    }
  });
}

/** A bug put into R10's strings: where it goes, and the programs whose dual route runs with it. */
export interface R10Fault {
  name: string;
  what: string;
  where: "printer" | "expansion";
  only: string; // the programs of corpus/lower/pipe whose path has this in it
  counts?: true; // caught by what's live after each case, not by a result: the counting checks run with it too
}

/** The bugs put into strings in `rc`: their counting, their runtime and their ABI, each to be caught. */
export const R10_FAULTS: R10Fault[] = [
  {
    name: "rcstr-lit-unretained",
    what: "a string read from module state (a literal's) handed on with no count of its own, so its holder's drop frees it",
    where: "expansion",
    only: "rc_strings",
  },
  {
    name: "rcstr-temp-leak",
    what: "a string temporary only read (an inner concatenation's result) never let go of",
    where: "expansion",
    only: "rc_strings",
    counts: true,
  },
  {
    name: "rcstr-field-twice",
    what: "a class's string field visited twice by its release function, so freeing the object drops the string twice",
    where: "expansion",
    only: "rc_strings",
  },
  {
    name: "rcstr-abi-len",
    what: "a string a native caller places (__str_place) made one unit short of the length it asked for",
    where: "printer",
    only: "rc_strings",
  },
  {
    name: "rcstr-layout-len",
    what: "the string layout published for a native caller with the length 4 bytes off where tslc laid it out",
    where: "printer",
    only: "rc_strings",
  },
  {
    name: "rcstr-append-shared",
    what: "an append in place to a buffer whatever view ends there, so two strings grown from one prefix share a tail",
    where: "printer",
    only: "rc_strings",
  },
];

/** One of R10's bugs put in: the dual route on rc_strings.ts at -O2, and for a leak the counting checks there. */
export async function r10FaultRun(
  f: R10Fault,
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  const env: Record<string, string | undefined> =
    f.where === "expansion" ? { TMK_TEST_RC_TSL: f.name } : {};
  return withEnv(env, async () => {
    const P = await import("./pipe-tests.ts");
    const failures: string[] = [];
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [2],
      accels: [accel],
      jobs,
      dirs: ["corpus/lower/pipe"],
      printed: false,
      classes: true,
      filter: (x) => x.includes(f.only),
      ...(f.where === "printer" ? { fault: f.name } : {}),
    });
    failures.push(...r.failures);
    // a leak gives every result right: what's live after each case shows it (the others show in results)
    if (f.counts === true) {
      const c = await ownershipChecks(accel, [2], f.where === "printer" ? f.name : undefined);
      failures.push(...c.failures);
    }
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (failures[0] ?? "").slice(0, 200),
      broken:
        failures.length > 0 &&
        failures.every((x) => /FAILED: tslc rejected|"code":"(TS|TSL)\d+"/.test(x)),
    };
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const c = await ownershipChecks(accel, [0, 1, 2]);
  for (const r of c.rows) console.log(r);
  for (const x of c.failures) console.log(`FAIL ${x}`);
  if (process.argv.includes("--faults"))
    for (const f of R10_FAULTS) {
      const x = await r10FaultRun(f, accel, 2);
      console.log(
        `${f.name}: caught ${x.caught} (answers ${x.answers})${x.broken ? " BROKEN" : ""} ${x.first}`,
      );
    }
  process.exitCode = c.failures.length > 0 ? 1 : 0;
}
