// R33's tests (SPEC M5's R33 record, 3.5, D39, D41): @tsl/gc's freeing with `stepping` and `spare` set around a release
// call only where a release function may see them (`releasesTouch`, answered over the whole program's call graph,
// compiler/host/release-touch.ts), the release dispatch's chain ordered by how many places make each class, and freeing's
// loops over an object's slots with the budget tested inside and the object made in each call. Here:
//
// - what must change where it applies: corpus/lower/r33/r33_free.ts through the TSL route in `rc` at -O1, whose release
//   functions reach no `stepping`, has freeAlloc write it nowhere, and with R33 off (TMK_R33_OFF=touch) writes it; and
//   corpus/std/rc_r33_make.ts, whose release function makes an object, writes it; and in r33_cycles.ts at -O0 the chain's
//   first arm is a string's release function, and with R33 off (TMK_R33_OFF=order) it isn't;
// - corpus/lower/r33 through the dual route with class printing forced, in `rc` and `leak`, at -O0, -O1 and -O2: every case
//   agrees with V8 natively and through both routes, and the printed TSL on V8 and JSC with the source;
// - corpus/std/rc_r33_make.ts, rc_r33_hook.ts and rc_r33_quiet.ts natively at -O0 and -O2, against V8 and JSC (a make
//   inside a release function, by a direct call and through a function value; and release functions that only visit, so
//   neither is set);
// - corpus/rc's step-count programs natively in `rc` (rc_steps*): D39's steps exactly as pinned;
// - each of R33's bugs caught by a wrong answer or a trap (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r33-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R33_DIR = "corpus/lower/r33";
const FREE = "corpus/lower/r33/r33_free.ts";
const CYCLES = "corpus/lower/r33/r33_cycles.ts";
const REENTER = "corpus/std/rc_r33_make.ts";
const QUIET = "corpus/std/rc_r33_quiet.ts";
const RC = "ex-gc-rc.ts";

/**
 * R33's bugs, each to be caught by a wrong answer or a trap against V8: in tslc by name (TMK_TEST_TSL, release-touch.ts and
 * elab-native.ts), or in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly).
 */
export const R33_FAULTS: {
  name: string;
  what: string;
  tslEnv?: string;
  patch?: TestPatch | TestPatch[];
}[] = [
  {
    name: "r33-touch-own",
    what: "release-touch.ts taking each function's own instructions alone, not what it calls, so a release function that reaches `spare` (visitLeaf) or `stepping` (a make) through a call is taken as reaching neither, and @tsl/gc sets neither around its calls",
    tslEnv: "r33-touch-own",
  },
  {
    name: "r33-touch-indirect",
    what: "release-touch.ts taking an indirect call as reaching nothing, so a release function that makes an object through a function value is taken as never reading `stepping`, and a make inside it frees as if nothing were under way",
    tslEnv: "r33-touch-indirect",
  },
  {
    name: "r33-touch-none",
    what: "every `releasesTouch` answered false, so @tsl/gc never sets `stepping` or `spare` around a release call",
    tslEnv: "r33-touch-none",
  },
  {
    name: "r33-order-index",
    what: "the numbers stores register in R25's order and callRelease's chain in R33's, so where the two orders differ a number reaches another class's release function",
    tslEnv: "r33-order-index",
  },
  {
    name: "r33-loop-budget",
    what: "freeSteps' loop over an object's slots without its budget test, so the cursor's object has every slot visited in one freeing, past the budget, against D39's bound",
    patch: {
      file: RC,
      from: "      while (a < s) {\n        if (left === 0n) break;\n        if (releasesTouch(spare)) {\n          spare = BigInt.asUintN(64, left - 1n);\n          callRelease(rel, objectAt<Counted0>(c), a, Visit.Drop);",
      to: "      while (a < s) {\n        if (releasesTouch(spare)) {\n          spare = BigInt.asUintN(64, left - 1n);\n          callRelease(rel, objectAt<Counted0>(c), a, Visit.Drop);",
    },
  },
  {
    name: "r33-quiet-step",
    what: "freeAlloc's slot 0 visit, where no release function may see `spare`, not counting its step, so an allocation frees a step more than its budget",
    patch: {
      file: RC,
      from: "      } else {\n        s = callRelease(rel, objectAt<Counted0>(head), 0, Visit.Drop);\n        left = BigInt.asUintN(64, left - 1n);\n      }\n      if (releasesTouch(stepping)) stepping = false;",
      to: "      } else {\n        s = callRelease(rel, objectAt<Counted0>(head), 0, Visit.Drop);\n      }\n      if (releasesTouch(stepping)) stepping = false;",
    },
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

type TirFunc = {
  name: string;
  blocks: {
    id: number;
    instrs: {
      op: string;
      ops: { t: string; name?: string; id?: number; val?: bigint }[];
      res: number[];
    }[];
    term: { k: string; cond?: number; t?: { block: number } };
  }[];
};

/** How many plain stores to a global a function makes. */
function globalStores(f: TirFunc, g: string): number {
  const addrs = new Set<number>();
  let n = 0;
  for (const b of f.blocks)
    for (const ins of b.instrs) {
      if (ins.op === "globaladdr" && ins.ops[0]?.name === g) addrs.add(ins.res[0]!);
      if (ins.op.startsWith("store.") && ins.ops[0]?.t === "v" && addrs.has(ins.ops[0].id!)) n++;
    }
  return n;
}

/** How many plain stores to `@ex-gc-rc.stepping` a function makes. */
const steppingStores = (f: TirFunc): number => globalStores(f, "ex-gc-rc.stepping");

/** The release function each number of the chain calls, in a function's -O0 TIR: k → the callee its `rel == k` arm calls. */
function chainArms(f: TirFunc): Map<number, string> {
  const consts = new Map<number, bigint>();
  const eqs = new Map<number, number>();
  for (const b of f.blocks)
    for (const ins of b.instrs) {
      if (ins.op === "iconst.i32" && ins.ops[0]?.t === "i")
        consts.set(ins.res[0]!, ins.ops[0].val!);
      if (ins.op === "icmp.eq.i32") eqs.set(ins.res[0]!, ins.ops[1]?.id ?? -1);
    }
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const out = new Map<number, string>();
  for (const b of f.blocks) {
    if (b.term.k !== "brif" || b.term.cond === undefined) continue;
    const k = consts.get(eqs.get(b.term.cond) ?? -1);
    if (k === undefined) continue;
    const t = byId.get(b.term.t!.block);
    const call = t?.instrs.find(
      (i) => i.op === "call" && /(\$release|roomRelease)$/.test(i.ops[0]?.name ?? ""),
    );
    if (call !== undefined) out.set(Number(k), call.ops[0]!.name!);
  }
  return out;
}

/** What R33 must do where it applies, and must not do where it's off. */
export async function r33Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const funcOf = (
    file: string,
    opt: 0 | 1 | 2,
    fn: string,
    off: string | undefined,
    lowered: boolean,
  ): Promise<TirFunc | null> =>
    withEnv({ TMK_R33_OFF: off }, async () => {
      let tir: { funcs: unknown[] } | null = null;
      if (lowered) {
        tir = lowerFile(join(ROOT, file), { memory: "rc", opt, route: "tsl", classes: true }).tir;
      } else {
        const c = checkFile(join(ROOT, file));
        if (c.typed !== null) tir = compileTyped(c.typed, { opt }).tir;
      }
      if (tir === null) return null;
      return (tir.funcs as TirFunc[]).find((x) => x.name === fn) ?? null;
    });
  const on = await funcOf(FREE, 1, "ex-gc-rc.freeAlloc", undefined, true);
  const off = await funcOf(FREE, 1, "ex-gc-rc.freeAlloc", "touch", true);
  if (on === null || off === null) failures.push("r33_free.ts's freeAlloc didn't build at -O1");
  else {
    rows.push(
      `r33_free -O1 freeAlloc: stores to stepping ${steppingStores(on)} (R33 off ${steppingStores(off)})`,
    );
    if (steppingStores(on) !== 0)
      failures.push(
        `r33_free.ts's freeAlloc writes \`stepping\` though no release function reads it (${steppingStores(on)})`,
      );
    if (steppingStores(off) === 0)
      failures.push(
        "r33_free.ts's freeAlloc writes no `stepping` with R33 off: the switch does nothing",
      );
  }
  const re = await funcOf(REENTER, 1, "ex-gc-rc.freeAlloc", undefined, false);
  if (re === null) failures.push("rc_r33_make.ts's freeAlloc didn't build at -O1");
  else {
    rows.push(`rc_r33_make -O1 freeAlloc: stores to stepping ${steppingStores(re)}`);
    if (steppingStores(re) === 0)
      failures.push(
        "rc_r33_make.ts's freeAlloc writes no `stepping`, though its release function makes an object",
      );
  }
  const quiet = await funcOf(QUIET, 1, "ex-gc-rc.freeAlloc", undefined, false);
  if (quiet === null) failures.push("rc_r33_quiet.ts's freeAlloc didn't build at -O1");
  else {
    const sp = globalStores(quiet, "ex-gc-rc.spare");
    rows.push(
      `rc_r33_quiet -O1 freeAlloc: stores to stepping ${steppingStores(quiet)}, to spare ${sp}`,
    );
    if (steppingStores(quiet) !== 0 || sp !== 0)
      failures.push(
        `rc_r33_quiet.ts's freeAlloc writes \`stepping\` or \`spare\` (${steppingStores(quiet)}, ${sp}), though no release function reads either`,
      );
  }
  const armsOn = await funcOf(CYCLES, 0, "ex-gc-rc.quickFree", undefined, true);
  const armsOff = await funcOf(CYCLES, 0, "ex-gc-rc.quickFree", "order", true);
  if (armsOn === null || armsOff === null)
    failures.push("r33_cycles.ts's quickFree didn't build at -O0");
  else {
    const a = chainArms(armsOn);
    const b = chainArms(armsOff);
    rows.push(
      `r33_cycles -O0 quickFree: first arm ${a.get(1) ?? "?"} (R33 off ${b.get(1) ?? "?"}), ${a.size} arms`,
    );
    if (a.get(1) !== "JsStr$release")
      failures.push(
        `r33_cycles.ts's release chain doesn't reach a string's first (${a.get(1) ?? "none"})`,
      );
    if (b.get(1) === "JsStr$release" || b.size === 0)
      failures.push(
        "r33_cycles.ts's release chain reaches a string's first with R33 off: the switch does nothing",
      );
    if (a.size !== b.size)
      failures.push(`the chain has ${a.size} arms, and ${b.size} with R33 off`);
  }
  return { failures, rows };
}

/**
 * The dual route with class printing forced, over R33's programs, in `rc` and `leak`: every case agrees with V8 natively
 * and with the TSL route, and the printed TSL on V8 and JSC with the source (off where a bug is in).
 */
export async function r33Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  modes: ("rc" | "leak")[] = ["rc", "leak"],
  dirs: string[] = [R33_DIR],
): Promise<{ failures: string[]; cases: number; agreed: number; handled: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
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
    handled: r.programs.filter((p) => p.handled && relative(ROOT, p.file) !== "").length,
  };
}

/**
 * corpus/std's R33 programs, natively at -O0 and -O2, against V8 and JSC: two whose release function makes an object (by a
 * direct call, and through a function value), and one whose release functions only visit their slots.
 */
export async function r33Std(
  accel: Accel,
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  let cases = 0;
  let agreed = 0;
  const failures: string[] = [];
  for (const level of levels)
    await withEnv({ TMK_OPT: String(level) }, async () => {
      const r = await runNative("std", [accel], jobs, "rc_r33_", defaultEngines());
      failures.push(...r.failures.map((f) => `-O${level}: ${f}`));
      for (const a of r.agreement) {
        cases += a.cases;
        agreed += a.agreed;
      }
    });
  return { failures, cases, agreed };
}

/** corpus/rc's step-count programs natively in `rc`: D39's steps as pinned. */
export async function r33Steps(
  accel: Accel,
  jobs: number,
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  const r = await runNative("rc", [accel], jobs, "rc_steps", defaultEngines());
  let cases = 0;
  let agreed = 0;
  for (const a of r.agreement) {
    cases += a.cases;
    agreed += a.agreed;
  }
  return { failures: r.failures, cases, agreed };
}

/**
 * One of R33's bugs, put in: what caught it (wrong answers, and the first in a stable order). Each over corpus/rc's
 * step-count programs natively, corpus/std's R33 programs natively at -O2, and
 * R33's programs through the dual route in `rc` at -O2.
 */
export async function r33Fault(
  f: (typeof R33_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => [
    ...(await r33Steps(accel, jobs)).failures,
    ...(await r33Std(accel, jobs, [2])).failures,
    ...(await r33Dual([accel], jobs, [2], false, ["rc"])).failures,
  ];
  const go = (): Promise<string[]> => (f.patch !== undefined ? withPatch(f.patch, run) : run());
  const failures = faultFailures(
    f.tslEnv !== undefined ? await withEnv({ TMK_TEST_TSL: f.tslEnv }, go) : await go(),
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
    const s = await r33Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const d = await r33Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
      const sd = await r33Std(accel, jobs);
      console.log(`std: ${sd.agreed}/${sd.cases}`);
      for (const x of sd.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += sd.failures.length;
      const st = await r33Steps(accel, jobs);
      console.log(`rc_steps: ${st.agreed}/${st.cases}`);
      for (const x of st.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += st.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R33_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r33Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
