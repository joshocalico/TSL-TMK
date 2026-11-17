// R11's tests (SPEC M5's R11 record, 3.5, D39, D72): maps and sets in `rc` through the TSL route, whose tables are @tsl/std's,
// now made at the counted heap's pace. Each table a map a counted object holds makes takes the freeing steps an allocation of
// the counted heap takes (@tsl/gc's `rcAllocSteps`), and where @tsl/std has nothing left, the counted heap frees all it has
// waiting (`rcCollect`) before @tsl/std is asked again (JsMap's `tablesIn`). Sets and maps churned past the memory there is
// agree through both routes, and `auto` takes them; a table's steps are read off a native caller's counters; a program
// whose garbage still holds tables when @tsl/std runs out fits; and each bug put in is caught.
//
//   node tools/r11-tests.ts [--accel hvf|tcg] [--faults]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures, patchEnv } from "./faults.ts";
import { buildDownImage, bulkFor, downResults } from "./native-exec.ts";
import { type Accel, qemuRun } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

/** R11's churn programs, each built through both routes in `rc` by the differential, and through `auto`. */
export const R11_PROGRAMS = [
  "corpus/lower/rc-tsl/r11_set_churn.ts", // sets of numbers alone: the probe that ran out within its first 1,000 sets
  "corpus/lower/rc-tsl/r11_map_churn.ts", // maps alone, of numbers and of objects
  "corpus/lower/strmap/rc_churn.ts", // out of RC_TSL_ROUTE_OOM since R11
];

/** @tsl/gc's budget: an allocation does at most this many freeing steps (D39). */
const RC_BUDGET = 32;

interface TslRun {
  problems: string[];
  live: number[];
  steps: number[];
  results: string[];
}

/** A program of corpus/lower/r11 through the TSL route in `rc` at one level, natively, with a native caller's counters. */
export async function tslRun(
  rel: string,
  accel: Accel,
  level: 0 | 1 | 2,
  o: { collect: boolean; fault?: string; rounds?: number },
): Promise<TslRun> {
  const P = await import("./pipe-tests.ts");
  const file = join(ROOT, rel);
  const { built, p } = P.bothRoutes(file, "rc", level as 0 | 2, o.fault);
  if (built === null)
    return {
      problems: [`not built through the TSL route: ${p.why ?? ""}`],
      live: [],
      steps: [],
      results: [],
    };
  const pages = Number(/^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))![1]);
  const cases = Array.from({ length: o.rounds ?? 1 }, () => built.cases).flat();
  const img = buildDownImage(built.tsl.tir, built.tsl.meta as never, cases, pages, {
    collect: o.collect,
    tslLive: true,
    bulkBytes: bulkFor(),
  } as never);
  const q = await qemuRun({
    name: `r11/${rel.replace(/.*\//, "")}-O${level}${o.collect ? "" : "-nocollect"}`,
    image: img.image.bytes,
    accel,
    timeoutMs: 60_000,
    ...(img.image.bulk !== undefined ? { bulk: img.image.bulk } : {}),
  });
  if (q.skipped) return { problems: ["skipped"], live: [], steps: [], results: [] };
  const problems: string[] = [];
  if (!q.ok) problems.push(`${q.status}: ${q.why.slice(0, 300)}`);
  const live: number[] = [];
  const steps: number[] = [];
  for (const l of q.lines) {
    const m = /TMK:RL (\d+) (\d+) (\d+)/.exec(l);
    if (m !== null) {
      live[Number(m[1])] = Number(m[2]);
      steps[Number(m[1])] = Number(m[3]);
    }
  }
  const { results } = downResults(built.tsl.meta as never, cases, img.placements, q.lines);
  // each case's result against what V8 gives the source, where the cases file has it
  cases.forEach((c, i) => {
    if ((c as { value?: number }).value === undefined) return;
    const got = results[i]?.result as { value?: unknown; trap?: number } | undefined;
    const want = (c as { value?: number }).value;
    const v = got?.value as { n?: string } | number | undefined;
    const n =
      typeof v === "object" && v !== null && v.n !== undefined
        ? new Float64Array(new BigUint64Array([BigInt(`0x${v.n}`)]).buffer)[0]
        : v;
    if (n !== want) problems.push(`${c.fn}#${i}: ${JSON.stringify(got)}, where V8 gives ${want}`);
  });
  return { problems, live, steps, results: results.map((x) => JSON.stringify(x.result)) };
}

/**
 * What the pacing and the drain give, checked natively at each level: r11_paced.ts's `grow`, one set grown to 5,000 numbers
 * after a list of 2,000 objects is let go of, with nothing collected between cases, takes freeing steps for its tables (more
 * than its counted allocations' budgets, which are two) and frees some of the list, within the budget for each allocation
 * it made, counted or a table; and r11_drain.ts's `refill`, whose garbage still holds three big sets' tables when @tsl/std
 * runs out, fits.
 */
export async function pacingChecks(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 2],
  fault?: string,
): Promise<{ rows: string[]; failures: string[]; skipped: boolean }> {
  const rows: string[] = [];
  const failures: string[] = [];
  let skipped = false;
  for (const level of levels) {
    const a = await tslRun("corpus/lower/r11/r11_paced.ts", accel, level, {
      collect: false,
      ...(fault !== undefined ? { fault } : {}),
    });
    if (a.problems.includes("skipped")) {
      skipped = true;
      continue;
    }
    failures.push(...a.problems.map((p) => `-O${level} r11_paced.ts: ${p}`));
    const d = (a.steps[1] ?? 0) - (a.steps[0] ?? 0);
    // one set of 5,000: 11 growths, each making 3 arrays (a set keeps no values), plus the set's holder and the module's
    // one scratch word: 40 allocations at most, each at most the budget
    const most = 40 * RC_BUDGET;
    if (!(d > 2 * RC_BUDGET))
      failures.push(
        `-O${level}: growing a set took ${d} freeing steps, no more than its counted allocations' budgets`,
      );
    if (d > most) failures.push(`-O${level}: growing a set took ${d} freeing steps, over ${most}`);
    if (!((a.live[1] ?? 1e9) < 2000))
      failures.push(
        `-O${level}: growing a set freed none of the list let go of (${a.live[1]} live)`,
      );
    rows.push(
      `-O${level}: growing a set took ${d} freeing steps for its tables, ${a.live[1]} live after`,
    );
    const b = await tslRun("corpus/lower/r11/r11_drain.ts", accel, level, {
      collect: false,
      ...(fault !== undefined ? { fault } : {}),
    });
    failures.push(...b.problems.map((p) => `-O${level} r11_drain.ts: ${p}`));
    rows.push(`-O${level}: refill with three sets' tables waiting: ${b.results[1] ?? "none"}`);
  }
  return { rows, failures, skipped };
}

/**
 * What's live after each of r11_exc_counts.ts's cases, everything pending collected, past what module state always keeps
 * (the first case's figure): the four objects of the chain `keepCaught` keeps (case 12) until `dropKept` lets it go.
 */
export const EXC_LIVE_PAST_BASE: Record<number, number> = { 12: 4 };
const EXC_CASES = 15;

/**
 * R21: the one-unit strings below 256 come from a table in module state, as the direct route's static one (emit-rcstr.ts,
 * tools/r10-tests.ts's UNIT_TABLE_LIVE), kept from their first use and never freed. The first that are made here are case
 * 11's, `escapes(6)`: its exception reaches the native caller, whose description (`tmkExcDescribe`) quotes the class name
 * "Failure", the name "Error" and the message "boom" a unit at a time (`charAt`), so F, a, i, l, u, r, e, E, o, b and m,
 * 11 strings, and the table's holder: 12 more live from case 11 on, in both rounds (no case before it reaches the native
 * caller with a throw, and no later case makes a unit the table hasn't got).
 */
export const EXC_UNIT_TABLE = { from: 11, live: 12 };

function excUnitTableLive(i: number): number {
  return i >= EXC_UNIT_TABLE.from ? EXC_UNIT_TABLE.live : 0;
}

/**
 * Exceptions in `rc` counted by the expansion, checked natively at each level: after each of r11_exc_counts.ts's cases,
 * in two rounds, only what module state keeps is live, so nothing a throw, a catch, a rethrow, a `finally` or the native
 * caller's taking left behind leaks or is released twice; and the results are the direct route's.
 */
export async function excCountChecks(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 2],
  fault?: string,
): Promise<{ rows: string[]; failures: string[]; skipped: boolean }> {
  const P = await import("./pipe-tests.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  let skipped = false;
  for (const level of levels) {
    const a = await tslRun("corpus/lower/r11/r11_exc_counts.ts", accel, level, {
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
    if (base === undefined) failures.push(`-O${level}: no live count after the first case`);
    let same = 0;
    for (let i = 0; i < 2 * EXC_CASES; i++) {
      const want = (base ?? 0) + (EXC_LIVE_PAST_BASE[i % EXC_CASES] ?? 0) + excUnitTableLive(i);
      if (a.live[i] === want) same++;
      else
        failures.push(
          `-O${level} case ${i}: ${a.live[i]} live after it, where module state keeps ${want}`,
        );
    }
    // the results, against the direct route's own run of the same cases
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [level as 0 | 2],
      accels: [accel],
      jobs: 1,
      dirs: ["corpus/lower/r11"],
      printed: false,
      classes: true,
      filter: (x) => x.endsWith("r11_exc_counts.ts"),
      ...(fault !== undefined ? { fault } : {}),
    });
    failures.push(...r.failures);
    rows.push(
      `-O${level}: ${same}/${2 * EXC_CASES} live counts as module state keeps (${base} always)`,
    );
  }
  return { rows, failures, skipped };
}

/** `auto`'s choice for R11's programs in `rc`: the TSL route, the build the differential forces. */
export async function autoChecks(level: 0 | 2): Promise<string[]> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const failures: string[] = [];
  for (const rel of R11_PROGRAMS.slice(0, 2)) {
    const file = join(ROOT, rel);
    const a = lowerFile(file, { memory: "rc", opt: level, route: "auto" });
    const t = lowerFile(file, { memory: "rc", opt: level, route: "tsl", classes: true });
    if (a.tsl === undefined || a.tsl === null || a.tslSkipped !== undefined)
      failures.push(
        `${rel}: auto doesn't take the TSL route in rc at -O${level} (${a.tslSkipped ?? ""})`,
      );
    else if (a.tirHash !== t.tirHash)
      failures.push(`${rel}: auto's build in rc at -O${level} isn't the TSL route's`);
  }
  return failures;
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

/** A bug put into R11's maps: where it goes, and what catches it. */
export interface R11Fault {
  name: string;
  what: string;
  // printer: TMK_TEST_EMIT; patch: TSL_TEST_PATCH into a library's source
  where: "printer" | "patch";
  patch?: { file: string; from: string; to: string };
}

/** The bugs put into R11's tables, each to be caught. */
export const R11_FAULTS: R11Fault[] = [
  {
    name: "r11-tables-unpaced",
    what: "a map's holder printed as before R11 (`freesTables`): its tables take no freeing steps, and @tsl/std running out frees nothing waiting",
    where: "printer",
  },
  {
    name: "r11-growth-no-steps",
    what: "a table made with no freeing steps taken first (JsMap's resize skips `steps`)",
    where: "patch",
    patch: {
      file: "packages/tsl-jsrt/ex-jsrt-map.ts",
      from: "      const steps = tables.steps;\n      steps();\n",
      to: "",
    },
  },
  {
    name: "r11-no-drain",
    what: "@tsl/std running out while a table is made, with nothing waiting freed first (JsMap's resize skips `drain`)",
    where: "patch",
    patch: {
      file: "packages/tsl-jsrt/ex-jsrt-map.ts",
      from: "        const drain = tables.drain;\n        drain();\n",
      to: "",
    },
  },
  {
    name: "r11-table-kept",
    what: "a map freed with its holder keeping its tables (JsMap's trim gives back no new table's buffers)",
    where: "patch",
    patch: {
      file: "packages/tsl-jsrt/ex-jsrt-map.ts",
      from: "    if (this.keys.trim()) any = true;",
      to: "    if (this.keys.capacity > 0) any = true;",
    },
  },
  {
    name: "r11-steps-over",
    what: "a table's steps twice an allocation's budget (rcAllocSteps runs freeing's whole budget again after its share)",
    where: "patch",
    patch: {
      file: "packages/tsl-gc/ex-gc-rc.ts",
      from: "    if (rest !== 0) restIfWork();\n  } else if (waiting !== 0n || cur !== 0n) runSteps(budget);",
      to: "    runSteps(budget);\n    if (rest !== 0) restIfWork();\n  } else if (waiting !== 0n || cur !== 0n) runSteps(budget);",
    },
  },
];

/** The bugs put into exceptions in `rc`, each to be caught by the counts after each case or the dual route. */
export const R11_EXC_FAULTS: { name: string; what: string; where: "printer" | "expansion" }[] = [
  {
    name: "r11-catch-kept",
    what: "a caught exception left in module state as well (the catch doesn't clear __exc_val), so it's never released",
    where: "printer",
  },
  {
    name: "r11-rethrow-unshared",
    what: "an exception held across a finally thrown again with no count of its own, so it's released twice",
    where: "expansion",
  },
  {
    name: "r11-global-narrowed",
    what: "module state typed as tsc narrows it, so the exception value read after a call that threw is taken for null and not counted",
    where: "expansion",
  },
  {
    name: "r11-dyn-unset",
    what: "an unknown's field another class it can hold leaves unset freed as if it were set (a null dropped)",
    where: "expansion",
  },
];

/** One of R11's exception bugs put in: the counts and the dual route on r11_exc_counts.ts at -O2, and the dual route on corpus/lower/exc's dyn_truthy.ts and app_using.ts. */
export async function r11ExcFaultRun(
  f: (typeof R11_EXC_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  const env: Record<string, string | undefined> =
    f.where === "expansion" ? { TMK_TEST_RC_TSL: f.name } : {};
  return withEnv(env, async () => {
    const P = await import("./pipe-tests.ts");
    const failures: string[] = [];
    const c = await excCountChecks(accel, [2], f.where === "printer" ? f.name : undefined);
    failures.push(...c.failures);
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [2],
      accels: [accel],
      jobs,
      dirs: ["corpus/lower/exc"],
      printed: false,
      classes: true,
      filter: (x) => /\/(dyn_truthy|app_using)\.ts$/.test(x),
      ...(f.where === "printer" ? { fault: f.name } : {}),
    });
    failures.push(...r.failures);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
      broken:
        failures.length > 0 &&
        failures.every((x) => /FAILED: tslc rejected|"code":"(TS|TSL)\d+"/.test(x)),
    };
  });
}

/** One of R11's bugs put in: the dual route on R11's programs at -O2, and the pacing and drain checks there. */
export async function r11FaultRun(
  f: R11Fault,
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  const env: Record<string, string | undefined> =
    f.where === "patch" ? { TSL_TEST_PATCH: patchEnv(f.patch!) } : {}; // checked first (SPEC 8.3)
  return withEnv(env, async () => {
    const P = await import("./pipe-tests.ts");
    const failures: string[] = [];
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [2],
      accels: [accel],
      jobs,
      dirs: ["corpus/lower/rc-tsl", "corpus/lower/strmap"],
      printed: false,
      classes: true,
      filter: (x) => R11_PROGRAMS.some((p) => x.endsWith(p)),
      ...(f.where === "printer" ? { fault: f.name } : {}),
    });
    failures.push(...r.failures);
    const c = await pacingChecks(accel, [2], f.where === "printer" ? f.name : undefined);
    failures.push(...c.failures);
    faultFailures(failures, f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
      broken:
        failures.length > 0 &&
        failures.every((x) => /FAILED: tslc rejected|"code":"(TS|TSL)\d+"/.test(x)),
    };
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const c = await pacingChecks(accel, [0, 1, 2]);
  for (const r of c.rows) console.log(r);
  for (const x of c.failures) console.log(`FAIL ${x}`);
  for (const x of [...(await autoChecks(0)), ...(await autoChecks(2))]) console.log(`FAIL ${x}`);
  if (process.argv.includes("--exc")) {
    const e = await excCountChecks(accel, [0, 1, 2]);
    for (const r of e.rows) console.log(r);
    for (const x of e.failures) console.log(`FAIL ${x}`);
    if (process.argv.includes("--faults"))
      for (const f of R11_EXC_FAULTS) {
        const x = await r11ExcFaultRun(f, accel, 2);
        console.log(
          `${f.name}: caught ${x.caught} (answers ${x.answers})${x.broken ? " BROKEN" : ""} ${x.first}`,
        );
      }
  }
  if (process.argv.includes("--faults") && !process.argv.includes("--exc"))
    for (const f of R11_FAULTS) {
      const x = await r11FaultRun(f, accel, 2);
      console.log(
        `${f.name}: caught ${x.caught} (answers ${x.answers})${x.broken ? " BROKEN" : ""} ${x.first}`,
      );
    }
  process.exitCode = c.failures.length > 0 ? 1 : 0;
}
