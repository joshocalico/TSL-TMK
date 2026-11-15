// R8's tests (SPEC M5's R8 record, D36, D39, 4.5's ABI in `rc`): counted objects crossing an export through the TSL route.
// A native caller places what it passes with the module's own `__rc_place_<id>`, retains what it stores into a counted
// object with `__rc_retain_<id>`, and gives back what it placed and every result with `__rc_release_<id>`; the module's
// counts after each case, its results' counts, and D39's freeing bound are checked against what that ownership gives, and
// each bug put into the three exports is caught.
//
//   node tools/r8-tests.ts [--accel hvf|tcg]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { buildDownImage, bulkFor, downResults } from "./native-exec.ts";
import { type Accel, qemuRun } from "./qemu-run.ts";
import type { R2Fault } from "./r2-tests.ts";

/** R8's own program, and every program its change brought onto the TSL route in `rc` (route-blockers.ts). */
export const R8_PROGRAMS = [
  "corpus/lower/pipe/rc_boundary.ts",
  "corpus/lower/pipe/boundary.ts",
  "corpus/lower/pipe/region.ts",
  "corpus/lower/memory/cycles.ts",
  "corpus/lower/pos/control_flow.ts",
  "corpus/lower/pos/destructure_spread.ts",
  "corpus/lower/pos/nullable_field_order.ts",
  "corpus/lower/pos/throw_trap.ts",
  "corpus/lower/pos/wrap_forms.ts",
  "bench/memory/boundary_lowered.ts",
];

/**
 * Through the TSL route in `rc`, a program that runs out of memory where the direct route doesn't, and why (box 33 takes a
 * trap 14 there through the TSL route alone, and nothing else). region.ts's `grow` runs out of memory by design, in both
 * routes; the direct route made its objects in the call arena (its class isn't `long`), which the next case's arena reset
 * gives back, where the TSL route counts every object and a trap leaves what its frames held (4.5): `churn` and what
 * follows it then run out through the TSL route alone. `rc` has no per-call region (R6's is `leak`'s and `manual`'s).
 */
export const RC_TSL_ROUTE_OOM = [
  "corpus/lower/pipe/region.ts",
  // R10 added corpus/lower/strmap/rc_churn.ts, whose 40,000 sets of numbers ran out through the TSL route alone; R11 took
  // it out: a set of numbers is freed in one step, not one a position, and each table a map in `rc` makes takes the counted
  // heap's freeing steps, with @tsl/std running out freeing what the counted heap has waiting first (tools/r11-tests.ts).
];

const PROGRAM = join(ROOT, "corpus/lower/pipe/rc_boundary.ts");

/**
 * What the counts are after each of rc_boundary.ts's cases, once the caller has let go of everything it placed and its
 * result and everything pending is collected: the objects module state keeps (a kept list of 2, a ring of 6, a list of 1),
 * and nothing else. Twice over: a second round of the same cases ends where the first did, so nothing leaks a round.
 */
export const LIVE_AFTER = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 0, 6, 6, 0, 1, 1, 1, 1, 1, 1, 0,
];

/**
 * Each result's count as the caller holds it, before letting go: one, the caller's (D39), but for `same`, which gives back
 * the argument the caller still holds (two), and `cycle`, whose head the ring's last object also holds (two). A null result
 * has none to read.
 */
export const RESULT_COUNT: Record<number, number> = {
  0: 1,
  3: 1,
  4: 1,
  7: 2,
  9: 1,
  13: 1,
  17: 2,
  25: 1,
  28: 1,
};

/** @tsl/gc's budget: an allocation does at most this many freeing steps (D39). */
const RC_BUDGET = 32;

interface CountRun {
  ok: boolean;
  problems: string[];
  live: number[];
  steps: number[];
  counts: Record<number, number>;
  results: string[];
}

/** rc_boundary.ts through the TSL route at one level, its cases run `rounds` times in one image. */
export async function countRun(
  accel: Accel,
  level: 0 | 1 | 2,
  o: { collect: boolean; rounds: number },
): Promise<CountRun> {
  const P = await import("./pipe-tests.ts");
  const { built } = P.bothRoutes(PROGRAM, "rc", level as 0 | 2);
  if (built === null)
    return {
      ok: false,
      problems: ["not built through both routes"],
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
    name: `r8/rc_boundary-O${level}${o.collect ? "" : "-nocollect"}`,
    image: img.image.bytes,
    accel,
    timeoutMs: 60_000,
    ...(img.image.bulk !== undefined ? { bulk: img.image.bulk } : {}),
  });
  const problems: string[] = [];
  if (q.skipped)
    return { ok: true, problems: ["skipped"], live: [], steps: [], counts: {}, results: [] };
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
  return {
    ok: problems.length === 0,
    problems,
    live,
    steps,
    counts,
    results: results.map((x) => JSON.stringify(x.result)),
  };
}

/**
 * What R8's ownership gives, checked: after each case and its collection, only what module state keeps is live, in every
 * round; each result's count is the caller's one (or as RESULT_COUNT says); and with nothing collected between cases, the
 * caller's release of a 400-node list's last count frees nothing at once, each allocation after it takes at most its
 * budget of freeing steps, and the list goes once collected.
 */
export async function ownershipChecks(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 2],
): Promise<{ rows: string[]; failures: string[]; skipped: boolean }> {
  const rows: string[] = [];
  const failures: string[] = [];
  let skipped = false;
  const n = LIVE_AFTER.length;
  for (const level of levels) {
    const a = await countRun(accel, level, { collect: true, rounds: 2 });
    if (a.problems.includes("skipped")) {
      skipped = true;
      continue;
    }
    failures.push(...a.problems.map((p) => `-O${level}: ${p}`));
    for (let i = 0; i < 2 * n; i++) {
      if (a.live[i] !== LIVE_AFTER[i % n])
        failures.push(
          `-O${level} case ${i}: ${a.live[i]} live after it, where ${LIVE_AFTER[i % n]} are kept`,
        );
      const want = RESULT_COUNT[i % n];
      if (want !== undefined && a.counts[i] !== want)
        failures.push(
          `-O${level} case ${i}: its result's count ${a.counts[i]}, where the caller's is ${want}`,
        );
    }
    for (const k of Object.keys(a.counts).map(Number))
      if (RESULT_COUNT[k % n] === undefined)
        failures.push(`-O${level} case ${k}: a count read for a null result`);
    rows.push(
      `-O${level}: ${a.live.filter((x, i) => x === LIVE_AFTER[i % n]).length}/${2 * n} live counts and ${Object.keys(a.counts).length} result counts as the ownership gives`,
    );
    // D39: the release of the list's last count only queues it; then each allocation's steps stay within the budget
    const b = await countRun(accel, level, { collect: false, rounds: 1 });
    failures.push(...b.problems.map((p) => `-O${level}, nothing collected: ${p}`));
    const list = 25;
    if (!(b.live[list]! >= 400))
      failures.push(`-O${level}: the list's release freed it at once (${b.live[list]} live)`);
    for (const i of [26, 27]) {
      const d = b.steps[i]! - b.steps[i - 1]!;
      if (!(d >= 0 && d <= RC_BUDGET))
        failures.push(`-O${level}: case ${i} took ${d} freeing steps, over ${RC_BUDGET}`);
    }
    if (b.results.join() !== a.results.slice(0, n).join())
      failures.push(`-O${level}: results with nothing collected aren't the same as with`);
    rows.push(
      `-O${level}, nothing collected: ${b.live[list]} live after the list's release, then ${b.steps[26]! - b.steps[25]!} and ${b.steps[27]! - b.steps[26]!} steps an allocation`,
    );
  }
  return { rows, failures, skipped };
}

/** The bugs put into the three exports a native caller counts with, each to be caught. */
export const R8_FAULTS: (R2Fault & { counts: true })[] = [
  {
    name: "r8-retain-borrowed",
    what: "retain gives its argument back borrowed, so the count a caller adds for an object it stores is never taken",
    transform: "the retain export (__rc_retain_<id>), expanded by tslc's rc expansion",
    where: "expansion",
    dirs: ["corpus/lower/pipe"],
    only: "boundary",
    counts: true,
  },
  {
    name: "r8-release-twice",
    what: "release drops the count it takes over twice",
    transform: "the release export (__rc_release_<id>), its @tsl.moves parameter owned",
    where: "expansion",
    dirs: ["corpus/lower/pipe"],
    only: "boundary",
    counts: true,
  },
  {
    name: "r8-result-zero",
    what: "a placed object given to the caller at a count of none, dropped as it's returned",
    transform: "the placing export (__rc_place_<id>)",
    where: "expansion",
    dirs: ["corpus/lower/pipe"],
    only: "boundary",
    counts: true,
  },
];

/** One of R8's bugs put in: the dual route on its programs, and the ownership checks, at -O2. */
export async function r8FaultRun(
  f: R2Fault,
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string; broken: boolean }> {
  const was = process.env.TMK_TEST_RC_TSL;
  process.env.TMK_TEST_RC_TSL = f.name;
  try {
    const P = await import("./pipe-tests.ts");
    const failures: string[] = [];
    const r = await P.dualRoute({
      modes: ["rc"],
      levels: [2],
      accels: [accel],
      jobs,
      dirs: f.dirs,
      printed: false,
      filter: (x) => x.includes(f.only!),
    });
    failures.push(...r.failures);
    const c = await ownershipChecks(accel, [2]);
    failures.push(...c.failures);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (failures[0] ?? "").slice(0, 200),
      broken:
        failures.length > 0 &&
        failures.every((x) => /FAILED: tslc rejected|"code":"(TS|TSL)\d+"/.test(x)),
    };
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_RC_TSL;
    else process.env.TMK_TEST_RC_TSL = was;
  }
}

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const c = await ownershipChecks(accel, [0, 1, 2]);
  for (const r of c.rows) console.log(r);
  for (const x of c.failures) console.log(`FAIL ${x}`);
  if (process.argv.includes("--faults"))
    for (const f of R8_FAULTS) {
      const x = await r8FaultRun(f, accel, 2);
      console.log(
        `${f.name}: caught ${x.caught} (answers ${x.answers})${x.broken ? " BROKEN" : ""} ${x.first}`,
      );
    }
  process.exitCode = c.failures.length > 0 ? 1 : 0;
}
