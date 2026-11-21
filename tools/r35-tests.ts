// R35's tests (SPEC M5's R35 record, 4.3, 4.4, 3.5, D44, D80): -O1's check elimination in one round of range.ts (a loop
// header's parameters taken as anything, so no going round), the backend saving around a cold call only what's live after
// it, a one-unit string past the table made where it's asked for with its length known (`jsStrUnitNew`), and short joins
// copying each part at the runs' lengths before it. Here:
//
// - what must change where it applies: r35_round.ts's `bounded` at -O1 has no checked operation left (every one proved by
//   the tests above it), and with R35 off (TMK_R35_OFF=checks) it has; r35_units.ts through the TSL route in `rc` at -O1
//   reads `scan`'s units with a saturating ToInt32 and fewer unsigned tests of an index against a length than with R35 off,
//   where it has a ToInt32; its jsStrZeroed has fewer checked operations; it has a `jsStrUnitNew`, and with R35 off
//   (TMK_R35_OFF=units) none; and its `JsStr.concat` at -O2 stores and loads fewer values around calls than with
//   TMK_R35_OFF=saves;
// - corpus/r35 natively at -O0, -O1 and -O2 against V8 and JSC, every answer and trap the same;
// - corpus/lower/r35 through the dual route with class printing forced, in `rc` and `leak`, at -O0, -O1 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source;
// - each of R35's bugs caught by a wrong answer or a trap (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r35-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R35_DIR = "corpus/r35";
export const R35_LOWER_DIR = "corpus/lower/r35";
const ROUND = "corpus/r35/r35_round.ts";
const UNITS = "corpus/lower/r35/r35_units.ts";

/**
 * R35's bugs, each to be caught by a wrong answer or a trap against V8: in the optimiser and the backend by name
 * (TMK_OPT_FAULT, range.ts and regalloc.ts; also in `OPT_FAULTS`, so opt-a box 12 runs them), or in the printing by name
 * (TMK_TEST_EMIT, emit-rcstr.ts). `levels` is where an optimiser bug acts.
 */
export const R35_FAULTS: {
  name: string;
  what: string;
  emit?: string;
  optFault?: string;
  levels?: (0 | 1 | 2)[];
}[] = [
  {
    name: "r35-round-header",
    what: "-O1's one round taking a loop header's parameter from the edges before the loop alone, as a first round of going round would, and stopping there: a counter 0 on the way in is taken as 0 on every turn, so a test of it is decided by its first turn and a check of a product that overflows later goes",
    optFault: "r35-round-header",
    levels: [1],
  },
  {
    name: "r35-save-block-only",
    what: "the backend taking a value split around a cold call as live after it only where the call's own block reads it later, so a value read only where two ways join, or on a loop's next turn, isn't loaded back, and is whatever the call left in its register",
    optFault: "r35-save-block-only",
    levels: [1, 2],
  },
  {
    name: "r35-unit-unwritten",
    what: "`jsStrUnitNew` in `rc` leaving its one unit unwritten, so a one-unit string past the table reads as unit 0",
    emit: "r35-unit-unwritten",
  },
  {
    name: "r35-joined3-offset",
    what: "`jsStrJoined3` in `rc` copying the third part after twice the first part's run, not after the first two runs, so a short join of three parts of different lengths is wrong (or traps where it runs past the string)",
    emit: "r35-joined3-offset",
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

type TirFunc = { name: string; blocks: { instrs: { op: string }[] }[] };

const opsOf = (f: TirFunc | undefined): string[] =>
  f === undefined ? [] : f.blocks.flatMap((b) => b.instrs.map((i) => i.op));
const checked = (ops: string[]): number =>
  ops.filter((o) => /^(add|sub|mul)\.chk\.|^range\.chk\./.test(o)).length;

/** The machine code of the functions whose names match, in a lowered program's cases image through the TSL route in rc. */
async function machineCode(file: string, level: 1 | 2, re: RegExp): Promise<Map<string, string[]>> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { bulkFor, buildDownImage } = await import("./native-exec.ts");
  const { decode } = await import("../compiler/backend-aarch64/decode.ts");
  const { pinsOf } = await import("./dual-build.ts");
  const lo = lowerFile(join(ROOT, file), { memory: "rc", opt: level, route: "tsl", classes: true });
  if (lo.tir === null) throw new Error(`${file} didn't lower`);
  const cases = JSON.parse(readFileSync(join(ROOT, file.replace(/\.ts$/, ".cases.json")), "utf8"));
  const { pages, stack } = pinsOf(join(ROOT, file));
  const img = buildDownImage(
    lo.tir,
    lo.meta as never,
    cases,
    pages,
    { bulkBytes: bulkFor(), noDump: true },
    undefined,
    stack,
  ).image;
  const dv = new DataView(img.bytes.buffer, img.bytes.byteOffset);
  const out = new Map<string, string[]>();
  for (const r of img.ranges) {
    if (!re.test(r.name)) continue;
    const ins: string[] = [];
    for (let p = r.from; p < r.to; p += 4) ins.push(decode(dv.getUint32(p, true), p) ?? "?");
    out.set(r.name, ins);
  }
  return out;
}

/** Stores and loads of one register to and from a frame slot (`[sp, #...]`), prologue and epilogue pairs aside. */
function frameMoves(ins: string[]): number {
  return ins.filter((t) => /^(str|ldr) [xwd]\d+, \[sp, #/.test(t)).length;
}

/** What R35 must do where it applies, and must not do where it's off. */
export async function r35Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { lowerFile, checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  // -O1's one round on straight-line code: r35_round.ts's `bounded`, every check proved by the tests above it
  const round = (off: boolean): Promise<string[] | null> =>
    withEnv({ TMK_R35_OFF: off ? "checks" : undefined }, async () => {
      const c = checkFile(join(ROOT, ROUND));
      if (c.typed === null) return null;
      const m = compileTyped(c.typed, { opt: 1 }).tir as { funcs: TirFunc[] };
      return opsOf(m.funcs.find((f) => f.name === "bounded"));
    });
  const bOn = await round(false);
  const bOff = await round(true);
  if (bOn === null || bOff === null) failures.push("r35_round.ts doesn't compile");
  else {
    rows.push(`-O1 bounded: checked operations ${checked(bOn)} (R35 off ${checked(bOff)})`);
    if (checked(bOn) !== 0)
      failures.push(`r35_round.ts's bounded keeps ${checked(bOn)} checked operations at -O1`);
    if (checked(bOff) === 0)
      failures.push(
        "r35_round.ts's bounded has no checked operation at -O1 with R35 off: the switch does nothing",
      );
  }
  // r35_units.ts through the TSL route in rc at -O1
  const units = (off: string | undefined): Promise<TirFunc[] | null> =>
    withEnv({ TMK_R35_OFF: off }, async () => {
      const r = lowerFile(join(ROOT, UNITS), { memory: "rc", opt: 1, route: "tsl", classes: true });
      return r.tir === null ? null : (r.tir.funcs as TirFunc[]);
    });
  const on = await units(undefined);
  const offChecks = await units("checks");
  const offUnits = await units("units");
  if (on === null || offChecks === null || offUnits === null) {
    failures.push("r35_units.ts didn't build through the TSL route in rc at -O1");
    return { failures, rows };
  }
  const scanOf = (fs: TirFunc[]): { sat: number; toint: number; tests: number } => {
    const ops = opsOf(fs.find((f) => f.name === "scan"));
    return {
      sat: ops.filter((o) => o === "fptosi.sat.i32").length,
      toint: ops.filter((o) => o === "js.toint32").length,
      tests: ops.filter((o) => o === "icmp.uge.ix").length,
    };
  };
  const s1 = scanOf(on);
  const s0 = scanOf(offChecks);
  rows.push(
    `-O1 scan: saturating ${s1.sat} (R35 off ${s0.sat}), js.toint32 ${s1.toint} (off ${s0.toint}), index tests ${s1.tests} (off ${s0.tests})`,
  );
  if (s1.sat < 1)
    failures.push(`scan reads its units with no saturating ToInt32 at -O1 (${s1.sat})`);
  if (s0.sat !== 0 || s0.toint < 1)
    failures.push(
      `scan at -O1 with R35 off has ${s0.sat} saturating ToInt32 and ${s0.toint} js.toint32: the switch does nothing`,
    );
  if (!(s1.tests < s0.tests))
    failures.push(
      `scan's unit reads test their index against a length as often at -O1 as with R35 off (${s1.tests} against ${s0.tests})`,
    );
  const z1 = checked(opsOf(on.find((f) => f.name === "jsStrZeroed")));
  const z0 = checked(opsOf(offChecks.find((f) => f.name === "jsStrZeroed")));
  rows.push(`-O1 jsStrZeroed: checked operations ${z1} (R35 off ${z0})`);
  if (!(z1 < z0))
    failures.push(
      `jsStrZeroed keeps as many checked operations at -O1 as with R35 off (${z1} against ${z0})`,
    );
  const hasNew = (fs: TirFunc[]): boolean => fs.some((f) => f.name === "jsStrUnitNew");
  rows.push(
    `jsStrUnitNew: ${hasNew(on) ? "yes" : "no"} (R35 off ${hasNew(offUnits) ? "yes" : "no"})`,
  );
  if (!hasNew(on)) failures.push("r35_units.ts has no jsStrUnitNew at -O1");
  if (hasNew(offUnits))
    failures.push(
      "r35_units.ts has a jsStrUnitNew with R35 off (TMK_R35_OFF=units): the switch does nothing",
    );
  // the backend's saves around cold calls: JsStr.concat's short way calls jsStrJoined as its last word
  const mc = await machineCode(UNITS, 2, /^JsStr\.concat$/);
  const mcOff = await withEnv({ TMK_R35_OFF: "saves" }, () =>
    machineCode(UNITS, 2, /^JsStr\.concat$/),
  );
  const a = [...mc.values()][0];
  const b = [...mcOff.values()][0];
  if (a === undefined || b === undefined)
    failures.push("no JsStr.concat in r35_units.ts's rc image at -O2");
  else {
    rows.push(
      `-O2 JsStr.concat: frame stores and loads ${frameMoves(a)} (R35 off ${frameMoves(b)})`,
    );
    if (!(frameMoves(a) < frameMoves(b)))
      failures.push(
        `JsStr.concat stores and loads as many values around calls as with R35 off (${frameMoves(a)} against ${frameMoves(b)})`,
      );
  }
  return { failures, rows };
}

/** corpus/r35 natively at its levels, against V8 and JSC. */
export async function r35Native(
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
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R35_DIR),
    );
    for (const x of r.agreement) {
      cases += x.cases;
      agreed += x.agreed;
      rows.push(`-O${level}: ${x.skipped ? "skipped" : `${x.agreed}/${x.cases}`}`);
    }
    failures.push(...r.failures.map((x) => `-O${level}: ${x}`));
  }
  return { failures, cases, agreed, rows };
}

/**
 * The dual route with class printing forced, over corpus/lower/r35, in `rc` and `leak`: every case agrees with V8 natively
 * and with the TSL route, and the printed TSL on V8 and JSC with the source (off where a bug is in).
 */
export async function r35Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  fault?: string,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
): Promise<{ failures: string[]; cases: number; agreed: number; handled: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels: levels as never,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R35_LOWER_DIR],
    v8: () => true,
    ...(fault !== undefined ? { fault } : {}),
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    handled: r.programs.filter((p) => p.handled && relative(ROOT, p.file) !== "").length,
  };
}

/**
 * One of R35's bugs, put in: what caught it (wrong answers, and the first in a stable order). The optimiser's and the
 * backend's over corpus/r35 natively at their levels and corpus/lower/r35 through the dual route in `rc` at those levels;
 * the printing's over corpus/lower/r35 in `rc` at -O1 and -O2.
 */
export async function r35Fault(
  f: (typeof R35_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const wasOpt = process.env.TMK_OPT_FAULT;
  const run = async (): Promise<string[]> => {
    if (f.emit !== undefined)
      return (await r35Dual([accel], jobs, [1, 2], false, f.emit, ["rc"])).failures;
    const levels = f.levels ?? [1, 2];
    return [
      ...(await r35Native(accel, jobs, levels)).failures,
      ...(await r35Dual([accel], jobs, levels, false, undefined, ["rc"])).failures,
    ];
  };
  if (f.optFault !== undefined) process.env.TMK_OPT_FAULT = f.optFault;
  try {
    const failures = faultFailures(await run(), f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  } finally {
    if (wasOpt === undefined) delete process.env.TMK_OPT_FAULT;
    else process.env.TMK_OPT_FAULT = wasOpt;
  }
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
    const s = await r35Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r35Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length;
      const d = await r35Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R35_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r35Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
