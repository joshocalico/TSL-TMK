// R30's tests (SPEC M5's R30 record, 3.5, 4.3, 4.4, D39, D44, D75): @tsl/gc's making placed where the object is made, the
// copy that placed it written as stores, `rc` strings' repeat and copy, and values split around cold calls. Here:
//
// - what the changes must do where they apply: a lowered `rc` string program's jsStrZeroed at -O2 has no frame slot and no
//   copy left (the new string's fields stored straight into its slot), and with R30's scalar replacement off
//   (TMK_R30_OFF=sroa) it has both; @tsl/gc's freeAlloc in that build saves fewer callee-saved registers with values split
//   around cold calls than with the split off (TMK_OPT_DISABLE=coldsplit); and r30_split.ts's `many` has a cold call and
//   `outer` none (coldCalls);
// - corpus/r30 natively at -O0, -O1 and -O2 against V8 and JSC, every answer and trap the same;
// - corpus/lower/r30 through the dual route with class printing forced, in `rc` and `leak`, at -O0 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source;
// - each of R30's bugs caught by wrong answers or traps (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r30-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R30_DIR = "corpus/r30";
export const R30_LOWER_DIR = "corpus/lower/r30";
const SPLIT = "corpus/r30/r30_split.ts";
const STRINGS = "corpus/lower/r30/r30_strings.ts";
const RC = "ex-gc-rc.ts";

/**
 * R30's bugs, each to be caught by a wrong answer or a trap against V8: in the optimiser and the backend by name
 * (TMK_OPT_FAULT; also in `OPT_FAULTS`, so opt-a box 12 runs them), in the printed string runtime by name (TMK_TEST_EMIT,
 * emit-rcstr.ts), and in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly). Each runs where it says: corpus/r30 natively
 * (`native`) at its levels, corpus/lower/r30 through the dual route (`dual`) at -O2, or both.
 */
export const R30_FAULTS: {
  name: string;
  what: string;
  optFault?: string;
  emit?: string;
  patch?: TestPatch;
  levels: (1 | 2)[];
  where: ("native" | "dual")[];
}[] = [
  {
    name: "r30-copy-stale",
    what: "scalar replacement writing a copy out of a frame slot as stores of each field as the fill left it, zero, not its last value: every new object's fields read as zero",
    optFault: "r30-copy-stale",
    levels: [2],
    where: ["native", "dual"],
  },
  {
    name: "r30-split-norestore",
    what: "a value split around a cold call stored to its slot before the call but never loaded back after it, so it's whatever the call left in its register",
    optFault: "r30-split-norestore",
    levels: [1, 2],
    where: ["native"],
  },
  {
    name: "r30-split-save-late",
    what: "a value split around a cold call stored after the call's arguments are moved, not before, so one in an argument's register is saved as that argument",
    optFault: "r30-split-save-late",
    levels: [1, 2],
    where: ["native"],
  },
  {
    name: "r30-split-callee-free",
    what: "a value across cold calls only given a callee-saved register that the prologue doesn't save, as one the caller doesn't need kept, so the caller's own value there is lost",
    optFault: "r30-split-callee-free",
    levels: [1, 2],
    where: ["native"],
  },
  {
    name: "r30-repeat-short",
    what: "JsStr's repeatFrom copying each doubling a unit short, so a repeat's later units are left zero",
    emit: "r30-repeat-short",
    levels: [2],
    where: ["dual"],
  },
  {
    name: "r30-slot-twice",
    what: "tailFast taking a free slot off its list without moving the list on, so the next object of its size class is given the same slot and two objects share memory",
    patch: {
      file: RC,
      from: "      if (slot !== 0n) head.write(countAt(slot).read());\n      else {\n        // R28: without the collector, a fresh slot cut in line where its page has room, as tailSlotAfter cuts it",
      to: "      if (slot !== 0n) head.write(head.read());\n      else {\n        // R28: without the collector, a fresh slot cut in line where its page has room, as tailSlotAfter cuts it",
    },
    levels: [2],
    where: ["native", "dual"],
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

/** The machine code of the functions whose names match, in a lowered program's cases image, through a route. */
async function machineCode(
  file: string,
  level: 1 | 2,
  route: "tsl" | "direct",
  re: RegExp,
): Promise<Map<string, string[]>> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { bulkFor, buildDownImage } = await import("./native-exec.ts");
  const { decode } = await import("../compiler/backend-aarch64/decode.ts");
  const { pinsOf } = await import("./dual-build.ts");
  const { readFileSync } = await import("node:fs");
  const lo = lowerFile(join(ROOT, file), {
    memory: "rc",
    opt: level,
    route,
    ...(route === "tsl" ? { classes: true } : {}),
  });
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

/** The callee-saved registers (x19 to x28) a function's prologue stores. */
function calleeSaved(ins: string[]): number {
  let n = 0;
  for (const t of ins.slice(0, 12)) {
    const m = /^stp (x\d+|xzr), (x\d+|xzr), \[sp/.exec(t);
    if (m === null) continue;
    for (const r of [m[1]!, m[2]!]) if (/^x(19|2\d)$/.test(r)) n++;
  }
  return n;
}

/** What R30's changes must do where they apply, and must not do where they're off. */
export async function r30Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const zeroed = (off: boolean): string => {
    const lo = withOffSync(off, () =>
      lowerFile(join(ROOT, STRINGS), { memory: "rc", opt: 2, route: "tsl", classes: true }),
    );
    const t = lo.tirText ?? "";
    const at = t.indexOf("func @jsStrZeroed(");
    return at < 0 ? "" : t.slice(at, t.indexOf("\n}", at) + 2);
  };
  const on = zeroed(false);
  const off = zeroed(true);
  if (on === "" || off === "") failures.push("r30_strings.ts's rc build has no jsStrZeroed");
  else {
    const has = (t: string): boolean => /alloca|mem\.copy/.test(t);
    rows.push(
      `jsStrZeroed at -O2: ${has(on) ? "a frame slot or copy" : "fields stored in place"}, off ${has(off) ? "a frame slot and copy" : "none"}`,
    );
    if (has(on))
      failures.push(
        "jsStrZeroed keeps a frame slot or a copy at -O2 with R30's scalar replacement on",
      );
    if (!has(off))
      failures.push(
        "jsStrZeroed has no frame slot or copy with R30's scalar replacement off: the switch does nothing",
      );
  }
  for (const level of [1, 2] as const) {
    const split = await machineCode(STRINGS, level, "tsl", /freeAlloc$/);
    const whole = await withEnv({ TMK_OPT_DISABLE: "coldsplit" }, () =>
      machineCode(STRINGS, level, "tsl", /freeAlloc$/),
    );
    const a = [...split.values()][0];
    const b = [...whole.values()][0];
    if (a === undefined || b === undefined) {
      failures.push(`-O${level}: no freeAlloc in r30_strings.ts's rc image`);
      continue;
    }
    rows.push(
      `-O${level} freeAlloc saves ${calleeSaved(a)} callee-saved registers split, ${calleeSaved(b)} not`,
    );
    if (calleeSaved(a) >= calleeSaved(b))
      failures.push(
        `-O${level}: freeAlloc saves ${calleeSaved(a)} registers split around cold calls, ${calleeSaved(b)} not`,
      );
  }
  // coldCalls over r30_split.ts's TIR: `many`'s call is taken one turn in k, `outer`'s every turn
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { coldCalls } = await import("../compiler/backend-aarch64/regalloc.ts");
  const { typed } = checkFile(join(ROOT, SPLIT));
  if (typed === null) failures.push("r30_split.ts doesn't compile");
  else {
    const m = await withEnv({ TMK_OPT: "2" }, async () => compileTyped(typed).tir);
    const cold = (name: string): [number, number] => {
      const f = m.funcs.find((x) => x.name === name);
      if (f === undefined) return [-1, -1];
      const all = f.blocks.flatMap((b) => b.instrs).filter((i) => i.op === "call");
      return [[...coldCalls(f)].filter((i) => i.op === "call").length, all.length];
    };
    const [mc, ma] = cold("many");
    const [oc, oa] = cold("outer");
    rows.push(`coldCalls: many ${mc} of ${ma} calls, outer ${oc} of ${oa}`);
    if (mc < 1) failures.push(`r30_split.ts's many has no cold call (${mc} of ${ma})`);
    if (oc !== 0 || oa === 0) failures.push(`r30_split.ts's outer has ${oc} cold calls of ${oa}`);
  }
  return { failures, rows };
}

function withOffSync<T>(off: boolean, f: () => T): T {
  const was = process.env.TMK_R30_OFF;
  if (off) process.env.TMK_R30_OFF = "sroa";
  else delete process.env.TMK_R30_OFF;
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env.TMK_R30_OFF;
    else process.env.TMK_R30_OFF = was;
  }
}

/** corpus/r30 natively at each level, against V8 and JSC (runNative's `mem` rules, over this directory alone). */
export async function r30Native(
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
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R30_DIR),
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
 * The dual route with class printing forced, over corpus/lower/r30, in `rc` and `leak`: every case agrees with V8 natively
 * and with the TSL route, and the printed TSL on V8 and JSC with the source (the third route; off where a bug is put in).
 */
export async function r30Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
  printed = true,
  fault?: string,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc", "leak"],
    levels,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R30_LOWER_DIR],
    v8: () => true,
    ...(fault !== undefined ? { fault } : {}),
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
  };
}

/** One of R30's bugs, put in: what caught it (wrong answers, and the first in a stable order). */
export async function r30Fault(
  f: (typeof R30_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => {
    const out: string[] = [];
    if (f.where.includes("native")) out.push(...(await r30Native(accel, jobs, f.levels)).failures);
    if (f.where.includes("dual"))
      out.push(...(await r30Dual([accel], jobs, [2], false, f.emit)).failures);
    return out;
  };
  const env = f.optFault !== undefined ? { TMK_OPT_FAULT: f.optFault } : {};
  const failures = faultFailures(
    await withEnv(env, () => (f.patch !== undefined ? withPatch(f.patch, run) : run())),
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
    const s = await r30Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r30Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length;
      const d = await r30Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases}`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R30_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r30Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
