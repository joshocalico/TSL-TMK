// R34's tests (SPEC M5's R34 record, 3.5, D39's R34): @tsl/gc's batched frees and the strings' channel. A run of waiting
// leaves is given back in one pass with the budget brought down once (leafRun), in line at an allocation where the run is
// all there is (freeLeaves); an object whose references are all null when it's made and stay so (a flat string) is made in
// its store's leaf entry (`makeTailLeaf`, which tslc's expansion picks), so freeing gives it back as one step with no call;
// and a leaf whose last count a release function drops is handed to freeing through what that function returns
// (`handLeaf`, `RC_HANDED`), where `spare` was written before each release call and read back after. Here:
//
// - what must change where it applies: corpus/lower/r34/r34_leaves.ts through the TSL route in `rc` at -O1 makes its flat
//   strings in a leaf entry (`registerLeaf` is built) and its freeAlloc writes no `spare`; with R34 off
//   (TMK_R34_OFF=leaf,hand) there's no leaf entry and freeAlloc writes `spare`;
// - corpus/lower/r34 through the dual route with class printing forced, in `rc` at -O0, -O1 and -O2 (it's sized to run in a
//   small memory only where what's let go of is freed, so not in `leak`): every case agrees with V8 natively and through both
//   routes, and the printed TSL on V8 and JSC with the source;
// - corpus/std/rc_r34_leaves.ts natively at -O0 and -O2, against V8 and JSC (leaves made and handed by hand, every
//   allocation's steps and live count, and `sameAsVisitLeaf`: handing a leaf back takes `visitLeaf`'s steps exactly);
// - corpus/rc's step-count programs natively in `rc` (rc_steps*): D39's steps exactly as pinned;
// - each of R34's bugs caught by a wrong answer or a trap (SPEC 8.3's fault rule: a bug that isn't in the build is a harness
//   failure).
//
//   node tools/r34-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures, withPatch, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R34_DIR = "corpus/lower/r34";
const LEAVES = "corpus/lower/r34/r34_leaves.ts";
const RC = "ex-gc-rc.ts";

/**
 * R34's bugs, each to be caught by a wrong answer or a trap against V8: in tslc's expansion by name (TMK_TEST_RC_TSL), or
 * in @tsl/gc by patch (TSL_TEST_PATCH, matched exactly).
 */
export const R34_FAULTS: {
  name: string;
  what: string;
  rcEnv?: string;
  patch?: TestPatch | TestPatch[];
}[] = [
  {
    name: "r34-run-over",
    what: "a run of waiting leaves that frees one leaf too many past the budget: leafRun stops only once it has given back more than the budget had left",
    patch: {
      file: RC,
      from: "    n = BigInt.asUintN(64, n + 1n); // at most left, a u64\n    if (n === left) break;",
      to: "    n = BigInt.asUintN(64, n + 1n); // at most left, a u64\n    if (n > left) break;",
    },
  },
  {
    name: "r34-run-any",
    what: "a run that takes a non-leaf: leafRun goes on through the next waiting object whatever its store, so an object with slots (a view, holding its buffer) is given back as a leaf, its slots never visited",
    patch: {
      file: RC,
      from: "    if (no >>> 8 !== id) break; // another store's: freeAlloc's loop takes it",
      to: "    if (no === 0) break; // another store's: freeAlloc's loop takes it",
    },
  },
  {
    name: "r34-hand-lost",
    what: "a handed leaf dropped: freeing, told a release function handed it a leaf, takes it and counts its step but never gives its block back",
    patch: {
      file: RC,
      from: "  const owner = ownerAt(lf).read();\n  giveBack(lf, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));\n  return BigInt.asUintN(64, left - 1n);",
      to: "  return BigInt.asUintN(64, left - 1n);",
    },
  },
  {
    name: "r34-hand-twice",
    what: "a handed leaf given back twice: freeing gives its block back, then again, so its slot is on its size's list twice and two later objects share it",
    patch: {
      file: RC,
      from: "  const owner = ownerAt(lf).read();\n  giveBack(lf, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));\n  return BigInt.asUintN(64, left - 1n);",
      to: "  const owner = ownerAt(lf).read();\n  giveBack(lf, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));\n  giveBack(lf, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));\n  return BigInt.asUintN(64, left - 1n);",
    },
  },
  {
    name: "r34-leaf-any",
    what: "tslc's expansion taking every tailed `new` of a class with slots as a leaf make, so a view is made in its store's leaf entry and freed without its buffer's count dropped",
    rcEnv: "r34-leaf-any",
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
    instrs: { op: string; ops: { t: string; name?: string; id?: number }[]; res: number[] }[];
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

/** What R34 must do where it applies, and must not do where it's off. */
export async function r34Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const funcs = (off: string | undefined): Promise<TirFunc[] | null> =>
    withEnv({ TMK_R34_OFF: off }, async () => {
      const r = lowerFile(join(ROOT, LEAVES), {
        memory: "rc",
        opt: 1,
        route: "tsl",
        classes: true,
      });
      return r.tir === null ? null : (r.tir.funcs as TirFunc[]);
    });
  const on = await funcs(undefined);
  const off = await funcs("leaf,hand");
  if (on === null || off === null) {
    failures.push("r34_leaves.ts didn't build through the TSL route in rc at -O1");
    return { failures, rows };
  }
  const leafEntry = (fs: TirFunc[]): boolean => fs.some((f) => f.name.endsWith(".registerLeaf"));
  const spareStores = (fs: TirFunc[]): number => {
    const f = fs.find((x) => x.name === "ex-gc-rc.freeAlloc");
    return f === undefined ? -1 : globalStores(f, "ex-gc-rc.spare");
  };
  rows.push(
    `r34_leaves -O1: a leaf entry ${leafEntry(on) ? "yes" : "no"} (R34 off ${leafEntry(off) ? "yes" : "no"}), freeAlloc's stores to spare ${spareStores(on)} (R34 off ${spareStores(off)})`,
  );
  if (!leafEntry(on)) failures.push("r34_leaves.ts makes no flat string in a leaf entry");
  if (leafEntry(off))
    failures.push(
      "r34_leaves.ts makes flat strings in a leaf entry with R34 off: the switch does nothing",
    );
  if (spareStores(on) !== 0)
    failures.push(
      `r34_leaves.ts's freeAlloc writes \`spare\` (${spareStores(on)}), though its release functions hand leaves back`,
    );
  if (spareStores(off) <= 0)
    failures.push(
      "r34_leaves.ts's freeAlloc writes no `spare` with R34 off: the switch does nothing",
    );
  return { failures, rows };
}

/**
 * The dual route with class printing forced, over R34's programs, in `rc`: every case agrees with V8 natively
 * and with the TSL route, and the printed TSL on V8 and JSC with the source (off where a bug is in).
 */
export async function r34Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
  modes: ("rc" | "leak")[] = ["rc"],
): Promise<{ failures: string[]; cases: number; agreed: number; handled: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels: levels as never,
    accels,
    jobs,
    classes: true,
    printed,
    dirs: [R34_DIR],
    v8: () => true,
  });
  return {
    failures: r.failures,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    handled: r.programs.filter((p) => p.handled && relative(ROOT, p.file) !== "").length,
  };
}

/** corpus/std/rc_r34_leaves.ts natively at -O0 and -O2, against V8 and JSC. */
export async function r34Std(
  accel: Accel,
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
): Promise<{ failures: string[]; cases: number; agreed: number }> {
  let cases = 0;
  let agreed = 0;
  const failures: string[] = [];
  for (const level of levels)
    await withEnv({ TMK_OPT: String(level) }, async () => {
      const r = await runNative("std", [accel], jobs, "rc_r34_", defaultEngines());
      failures.push(...r.failures.map((f) => `-O${level}: ${f}`));
      for (const a of r.agreement) {
        cases += a.cases;
        agreed += a.agreed;
      }
    });
  return { failures, cases, agreed };
}

/** corpus/rc's step-count programs natively in `rc`: D39's steps as pinned. */
export async function r34Steps(
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
 * One of R34's bugs, put in: what caught it (wrong answers, and the first in a stable order). Each over corpus/rc's
 * step-count programs natively, corpus/std/rc_r34_leaves.ts natively at -O2, and R34's programs through the dual route in
 * `rc` at -O2.
 */
export async function r34Fault(
  f: (typeof R34_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => [
    ...(await r34Steps(accel, jobs)).failures,
    ...(await r34Std(accel, jobs, [2])).failures,
    ...(await r34Dual([accel], jobs, [2], false, ["rc"])).failures,
  ];
  const go = (): Promise<string[]> => (f.patch !== undefined ? withPatch(f.patch, run) : run());
  const failures = faultFailures(
    f.rcEnv !== undefined ? await withEnv({ TMK_TEST_RC_TSL: f.rcEnv }, go) : await go(),
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
    const s = await r34Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const d = await r34Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
      const sd = await r34Std(accel, jobs);
      console.log(`std: ${sd.agreed}/${sd.cases}`);
      for (const x of sd.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += sd.failures.length;
      const st = await r34Steps(accel, jobs);
      console.log(`rc_steps: ${st.agreed}/${st.cases}`);
      for (const x of st.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += st.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R34_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r34Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
