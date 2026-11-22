// R38's tests (SPEC M5's R38 record, 4.4, 4.5, 8.3, D49, D62): exceptions and two loop reshapes trusted in `rc`. What must
// hold:
//
// - `auto` takes, in `rc`, a program with exceptions printed reshaped only by the kinds it trusts there (tslc.ts's
//   TRUSTED_EXC_IN `rc`), and a program reshaped by a loop whose step or condition has statements of its own (the kinds
//   TRUSTED_RESHAPES_IN names for `rc`'s class printing); with the switches off (TMK_R38_OFF=exc, kinds) it takes neither,
//   as before R38;
// - every such program of corpus/lower/exc (its 63 generated ones included) and of R14's directories agrees with the direct
//   route through `auto`'s own build in `rc` at -O0 and -O2, natively, and as printed on V8 and JSC with the source;
// - the backend's coldness (R30, R38): a call on every turn of its loop that doesn't throw is hot, so the printed
//   `strConcat`'s inlined RangeError no longer makes every call after it cold (gen_finally_catch_finally_breakOuter), and
//   with TMK_R38_OFF=cold it is as before; a function with no throw is untouched;
// - a timing image (R14) dumps memory after its first pass alone, so adv_exc_drop's direct route timing image, whose
//   frameDrop dumps 88 MB a pass, runs to its end without filling the RAM channel;
// - each of R38's bugs, put into a trusted loop kind's printing or into rc's one-unit string answers, is caught by that
//   differential (SPEC 8.3's fault rule).
//
//   node tools/r38-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults-only]
//
// pipe-d box 95 is the shapes, the coldness and the timing image; 96 the bugs; 97 the differential over corpus/lower/exc; 98
// the differential over R14's directories (one box each, so each is within a gate job's 30 minutes).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listPrograms, ROOT, wrongAnswers } from "./corpus.ts";
import type { Accel } from "./qemu-run.ts";
import type { PipeMode } from "./pipe-tests.ts";
import { firstInOrder } from "./stable.ts";

/** The loop kinds R38 trusts in `rc`'s class printing: tslc.ts's TRUSTED_RESHAPES_IN, checked against it by r38Shapes. */
export const R38_KINDS = [
  "a for step with statements",
  "a loop condition with statements",
  "a loop condition with statements (do-while)",
];

/** R38's bugs, each put into the printing by name (TMK_TEST_EMIT), caught by `auto`'s own builds in rc. */
export const R38_FAULTS: { name: string; what: string; kind: string }[] = [
  {
    name: "r38-step-first",
    what: "a for loop's step (its statements and its own value) runs before the body on each turn, not after it",
    kind: "a for step with statements",
  },
  {
    name: "r38-cond-once",
    what: "a while loop's condition's statements run once, before the loop, not on every turn",
    kind: "a loop condition with statements",
  },
  {
    name: "r38-do-cond-first",
    what: "a do-while loop's condition's statements run at the start of each turn, before the body, not after it",
    kind: "a loop condition with statements (do-while)",
  },
  {
    name: "r38-compare-one",
    what: "rc's JsStr.compare of two strings of one unit each gives the second's unit less the first's, so the order is reversed",
    kind: "(the one-unit answers, not a kind)",
  },
];

function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const was: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return f();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** R14's programs, the generated exception programs included: what R38 looks at. */
async function r38Files(): Promise<string[]> {
  const { PIPE_DIRS } = await import("./pipe-tests.ts");
  const { R14_DIRS } = await import("./r14-tests.ts");
  return R14_DIRS(PIPE_DIRS).flatMap((d) =>
    existsSync(join(ROOT, d)) ? listPrograms(join(ROOT, d)) : [],
  );
}

/** How many of a function's calls the allocator takes as hot and as cold (regalloc.ts's coldCalls). */
async function heat(
  file: string,
  fn: string,
  route: "auto" | "direct",
): Promise<{ hot: number; cold: number }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { coldCalls } = await import("../compiler/backend-aarch64/regalloc.ts");
  const o = lowerFile(file, { memory: "rc", opt: 2, route });
  const f = o.tir?.funcs.find((x) => x.name === fn);
  if (f === undefined) return { hot: -1, cold: -1 };
  const cold = coldCalls(f);
  let hot = 0;
  for (const b of f.blocks)
    for (const ins of b.instrs) if (ins.op.startsWith("call") && !cold.has(ins)) hot++;
  return { hot, cold: cold.size };
}

/**
 * Compiled only: what `auto` takes in `rc` with R38's trust, and without it; and the backend's coldness on R37's example.
 */
export async function r38Shapes(): Promise<{
  failures: string[];
  rows: string[];
  exc: number;
  kinds: number;
}> {
  const { lowerFile, TRUSTED_EXC_IN, TRUSTED_RESHAPES_IN } =
    await import("../compiler/host/tslc.ts");
  const failures: string[] = [];
  if (TRUSTED_EXC_IN.rc !== true) failures.push("TRUSTED_EXC_IN doesn't trust rc");
  for (const k of R38_KINDS)
    if (!(TRUSTED_RESHAPES_IN.rc?.classes ?? []).includes(k))
      failures.push(`TRUSTED_RESHAPES_IN doesn't trust "${k}" in rc's class printing`);
  const files = await r38Files();
  const taken = (f: string): { t: boolean; exc: boolean; kinds: string[] } => {
    try {
      // -O0: the route is decided before the optimiser, so what's taken is the same at every level, and -O0 compiles fastest
      const a = lowerFile(f, { memory: "rc", opt: 0, route: "auto" });
      const t = a.tsl !== undefined && a.tsl.file !== "" && a.tir !== null;
      const kinds = Object.keys(a.tsl?.stats.reshapedWhy ?? {});
      return { t, exc: a.tsl?.stats.rcExc === true, kinds };
    } catch {
      return { t: false, exc: false, kinds: [] }; // the direct route can't build it either
    }
  };
  let exc = 0;
  let kinds = 0;
  const touched: string[] = [];
  for (const f of files) {
    const a = taken(f);
    if (!a.t) continue;
    const loop = a.kinds.some((k) => R38_KINDS.includes(k));
    if (a.exc) exc++;
    if (loop) kinds++;
    if (a.exc || loop) touched.push(f);
  }
  // the switches are what take them: off, none of these is taken with exceptions or a loop kind
  let offTaken = 0;
  withEnv({ TMK_R38_OFF: "exc,kinds" }, () => {
    for (const f of touched) {
      const a = taken(f);
      if (a.t && (a.exc || a.kinds.some((k) => R38_KINDS.includes(k)))) offTaken++;
    }
  });
  if (offTaken > 0)
    failures.push(`with TMK_R38_OFF=exc,kinds, auto still took ${offTaken} such programs in rc`);
  if (exc < 74) failures.push(`auto takes ${exc} programs with exceptions in rc, fewer than 74`);
  if (kinds < 4) failures.push(`auto takes ${kinds} programs with a loop kind in rc, fewer than 4`);
  // the backend: R37's example, its calls on every turn that doesn't throw hot, as the direct route's
  const bo = join(ROOT, "corpus/lower/exc/gen_finally_catch_finally_breakOuter.ts");
  const fn = "f_catch_finally_breakOuter_try_return$x";
  const on = await heat(bo, fn, "auto");
  const direct = await heat(bo, fn, "direct");
  // with the rule off (set for the whole compile: heat is asynchronous, so not withEnv's)
  const was = process.env.TMK_R38_OFF;
  process.env.TMK_R38_OFF = "cold";
  let off: { hot: number; cold: number };
  try {
    off = await heat(bo, fn, "auto");
  } finally {
    if (was === undefined) delete process.env.TMK_R38_OFF;
    else process.env.TMK_R38_OFF = was;
  }
  if (on.hot < direct.hot)
    failures.push(
      `${fn}: ${on.hot} hot calls through auto, fewer than the direct route's ${direct.hot}`,
    );
  if (off.hot !== 0)
    failures.push(`${fn} with TMK_R38_OFF=cold: ${off.hot} hot calls, not R37's 0`);
  // a function with no throw: the same calls cold with the rule off and on
  const plain = join(ROOT, "corpus/lower/rc/adv_large_drop.ts");
  {
    const { lowerFile: lf } = await import("../compiler/host/tslc.ts");
    const { coldCalls } = await import("../compiler/backend-aarch64/regalloc.ts");
    const o = lf(plain, { memory: "rc", opt: 2, route: "auto" });
    const count = (): number => o.tir!.funcs.reduce((n, f) => n + coldCalls(f).size, 0);
    const a = count();
    const b = withEnv({ TMK_R38_OFF: "cold" }, count);
    if (a !== b)
      failures.push(`adv_large_drop.ts, with no throw: ${a} cold calls, ${b} with the rule off`);
  }
  return {
    failures,
    exc,
    kinds,
    rows: [
      `taken in rc (at -O0, as at every level): ${exc} with exceptions, ${kinds} with a loop kind; with the switches off ${offTaken}`,
      `${fn}: hot calls auto ${on.hot} (cold ${on.cold}), direct ${direct.hot}, with TMK_R38_OFF=cold ${off.hot}`,
    ],
  };
}

/**
 * adv_exc_drop's timing image through the direct route at -O1, 8 passes: it ran to its end, where before R38 every later
 * pass's dump of the arena filled the RAM channel.
 */
export async function r38Timing(
  accel: Accel,
): Promise<{ failures: string[]; row: string; skipped: boolean }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { bulkFor, buildDownImage } = await import("./native-exec.ts");
  const { pinsOf } = await import("./dual-build.ts");
  const { qemuRun } = await import("./qemu-run.ts");
  const file = join(ROOT, "corpus/lower/exc/adv_exc_drop.ts");
  const r = lowerFile(file, { memory: "rc", opt: 1, route: "direct" });
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"));
  const { pages, stack } = pinsOf(file);
  const img = buildDownImage(
    r.tir!,
    r.meta as never,
    cases,
    pages,
    { bulkBytes: bulkFor(), timePasses: 8, noDump: true },
    undefined,
    stack,
  ).image;
  const q = await qemuRun({
    name: "r38-timing/adv_exc_drop",
    image: img.bytes,
    accel,
    timeoutMs: 600_000,
    ...(img.bulk !== undefined ? { bulk: img.bulk } : {}),
  });
  if (q.skipped)
    return { failures: [], row: "HVF unavailable: skipped, not passed", skipped: true };
  const tp = q.lines.filter((l) => l.startsWith("TMK:TP ")).length;
  const failures: string[] = [];
  if (!q.ok) failures.push(`adv_exc_drop's timing image: ${q.status} ${q.why.slice(0, 160)}`);
  if (tp !== 8) failures.push(`adv_exc_drop's timing image gave ${tp} passes, not 8`);
  return {
    failures,
    row: `adv_exc_drop's direct timing image: ${q.status}, ${tp} passes`,
    skipped: false,
  };
}

/** The differential on `auto`'s own builds in rc over corpus/lower/exc, its generated programs included (box 97). */
export async function r38DualExc(accel: Accel, jobs: number) {
  const R37 = await import("./r37-tests.ts");
  return R37.r37Dual(accel, jobs, undefined, [0, 2], ["rc"]);
}

/** The differential on `auto`'s own builds in rc over R14's directories (box 98). */
export async function r38DualKinds(accel: Accel, jobs: number) {
  const R14 = await import("./r14-tests.ts");
  return R14.autoReshapedDual([accel], jobs, ["rc"]);
}

/** Both of the differentials above, for this file's own command line. */
export async function r38Dual(
  accel: Accel,
  jobs: number,
  fault?: string,
  levels: (0 | 2)[] = [0, 2],
): Promise<{
  failures: string[];
  taken: number;
  generated: number;
  cases: number;
  agreed: number;
  printedCases: number;
  printedSame: number;
  divergences: Record<string, number>;
}> {
  const R37 = await import("./r37-tests.ts");
  const R14 = await import("./r14-tests.ts");
  const e = await R37.r37Dual(accel, jobs, fault, levels, ["rc"]);
  const k = await R14.autoReshapedDual([accel], jobs, ["rc"], fault, levels);
  const div: Record<string, number> = { ...e.divergences };
  for (const [x, n] of Object.entries(k.divergences)) div[x] = (div[x] ?? 0) + n;
  return {
    failures: [...e.failures, ...k.failures],
    taken: e.taken.length + k.taken.length,
    generated: e.generated,
    cases: e.cases + k.cases,
    agreed: e.agreed + k.agreed,
    printedCases: e.printedCases + k.printedCases,
    printedSame: e.printedSame + k.printedSame,
    divergences: div,
  };
}

/** One of R38's bugs, on `auto`'s own builds of R14's directories in rc at -O2. */
export async function r38Fault(
  f: (typeof R38_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const R14 = await import("./r14-tests.ts");
  const r = await R14.autoReshapedDual([accel], jobs, ["rc"] as PipeMode[], f.name, [2]);
  return {
    caught: r.failures.length,
    answers: wrongAnswers(r.failures),
    first: (firstInOrder(r.failures) ?? "").slice(0, 200),
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const jobs = Number(flag("--jobs") ?? "4");
  if (!process.argv.includes("--faults-only")) {
    const s = await r38Shapes();
    console.log(s.rows.join("\n"));
    for (const x of s.failures.slice(0, 30)) console.log(`  FAIL ${x}`);
    const t = await r38Timing(accel);
    console.log(t.row);
    for (const x of t.failures) console.log(`  FAIL ${x}`);
  }
  if (!process.argv.includes("--shapes-only") && !process.argv.includes("--faults-only")) {
    const d = await r38Dual(accel, jobs);
    console.log(
      `dual (auto, rc): ${d.agreed}/${d.cases} cases in ${d.taken} programs (${d.generated} generated); third route ${d.printedSame}/${d.printedCases}, divergences ${JSON.stringify(d.divergences)}`,
    );
    for (const x of d.failures.slice(0, 30)) console.log(`  FAIL ${x}`);
  }
  if (process.argv.includes("--faults") || process.argv.includes("--faults-only"))
    for (const f of R38_FAULTS) {
      const r = await r38Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  process.exit(0);
}
