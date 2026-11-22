// R36's tests (SPEC M5's R36 record, 4.3, D44, D46): the optimiser's compile time cut, its output byte for byte as before
// (every pin holds; tools/r36-pins.ts). What R36 added that a bug could break:
//
// - LICM makes a function's graph and loops again only after a loop has had something moved out of it (licm.ts);
// - value numbering's tables, and the other passes', kept by value number in arrays made for each function (ir.ts's
//   ValMap);
// - tslc giving the optimiser its module to optimise where it is, not copied (`consume`), as nothing reads it after.
//
// Here:
//
// - what must hold where it applies: corpus/r36/r36_passes.ts at -O1 has something moved out of a loop and something
//   shared by value numbering (so the faults below reach their code); and the optimiser's module with `consume` is the
//   module without it, byte for byte, at -O1 and -O2, for corpus/r36 and corpus/lower/r36 through the TSL route in `rc`,
//   while without it the module given is left as it was;
// - corpus/r36 natively at -O0, -O1 and -O2 against V8 and JSC;
// - corpus/lower/r36 through the dual route with class printing forced, in `rc` and `leak`, at -O0, -O1 and -O2;
// - each of R36's bugs caught (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure).
//
//   node tools/r36-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults] [--faults-only] [--only name]
import { join, relative } from "node:path";
import { defaultEngines, ROOT, runNative, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R36_DIR = "corpus/r36";
export const R36_LOWER_DIR = "corpus/lower/r36";
const PASSES = "corpus/r36/r36_passes.ts";
const ROUTE = "corpus/lower/r36/r36_route.ts";

/**
 * R36's bugs, each put in by name in the optimiser (TMK_OPT_FAULT; also in `OPT_FAULTS`, so opt-a box 12 runs them), over
 * corpus/r36 natively and corpus/lower/r36 through the dual route in `rc` at -O1 and -O2. `r36-constkeys-shared` gives wrong
 * answers. `r36-licm-stale` can't: whatever a stale graph moves out of a loop is moved above a preheader made in the loop,
 * which the values it uses are in, so the optimiser's own verifier, run on every build after the optimiser, refuses the
 * build (corpus/r36's doLoops). `r36-consume-always` changes no answer either (a module optimised where it is computes what
 * its copy would) and is caught by the shapes' check that the module given is left as it was.
 */
export const R36_FAULTS: {
  name: string;
  what: string;
  optFault: string;
  levels: (1 | 2)[];
  by: "answers" | "verifier" | "shapes";
}[] = [
  {
    name: "r36-licm-stale",
    what: "LICM keeping the function's graph and loops after a loop has had something moved out of it, so the loops after it are read at the places their blocks were before the preheader was put in",
    optFault: "r36-licm-stale",
    levels: [1, 2],
    by: "verifier",
  },
  {
    name: "r36-constkeys-shared",
    what: "value numbering's table of constants kept from one function to the next, not made for each, so a value of one function is taken for the constant another function had at its number",
    optFault: "r36-constkeys-shared",
    levels: [1, 2],
    by: "answers",
  },
  {
    name: "r36-consume-always",
    what: "the optimiser optimising every module where it is, given up by its caller or not, so a module a caller still holds is changed under it",
    optFault: "r36-consume-always",
    levels: [1, 2],
    by: "shapes",
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

/** What R36 must do where it applies: its programs reach its code, and `consume` changes nothing but the copy. */
export async function r36Shapes(): Promise<{ failures: string[]; rows: string[] }> {
  const failures: string[] = [];
  const rows: string[] = [];
  const { lowerFile, checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { optimizeModule, optFromEnv } = await import("../compiler/tir/passes/manager.ts");
  const { cloneModule } = await import("../compiler/tir/passes/util.ts");
  const { printModule } = await import("../compiler/tir/text.ts");
  const c = checkFile(join(ROOT, PASSES));
  if (c.typed === null) {
    failures.push("r36_passes.ts doesn't compile");
    return { failures, rows };
  }
  // the programs reach LICM's moving and value numbering's sharing at -O1
  const o1 = compileTyped(c.typed, { opt: 1 }).opt;
  rows.push(
    `r36_passes.ts at -O1: LICM moved ${o1.licm.pure} pure, value numbering shared ${o1.gvn.pure}`,
  );
  if (o1.licm.pure < 2)
    failures.push(`r36_passes.ts at -O1 has ${o1.licm.pure} moved out of loops`);
  if (o1.gvn.pure < 2)
    failures.push(`r36_passes.ts at -O1 has ${o1.gvn.pure} shared by value numbering`);
  // `consume`: the same module out; the module given left as it was without it
  const fronts: { what: string; front: import("../compiler/tir/ir.ts").Module; prune: boolean }[] =
    [{ what: "r36_passes.ts", front: compileTyped(c.typed, { opt: 0 }).tir, prune: true }];
  const lo = lowerFile(join(ROOT, ROUTE), { memory: "rc", opt: 0, route: "tsl", classes: true });
  if (lo.tir === null) failures.push("r36_route.ts didn't build through the TSL route in rc");
  else fronts.push({ what: "r36_route.ts (rc, TSL route)", front: lo.tir, prune: false });
  for (const { what, front, prune } of fronts) {
    for (const level of [1, 2] as const) {
      const before = printModule(front);
      const kept = optimizeModule(front, { ...optFromEnv(level), prune });
      const untouched = printModule(front) === before;
      const given = optimizeModule(cloneModule(front), {
        ...optFromEnv(level),
        prune,
        consume: true,
      });
      const same = printModule(given.module) === printModule(kept.module);
      rows.push(
        `${what} -O${level}: consume ${same ? "the same" : "DIFFERENT"}, given module ${untouched ? "untouched" : "CHANGED"}`,
      );
      if (!same)
        failures.push(
          `${what} at -O${level}: the module optimised where it is differs from its copy's`,
        );
      if (!untouched)
        failures.push(`${what} at -O${level}: optimising without consume changed the module given`);
    }
  }
  return { failures, rows };
}

/** corpus/r36 natively at its levels, against V8 and JSC. */
export async function r36Native(
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
      runNative("mem", [accel], jobs, undefined, engines, undefined, undefined, false, R36_DIR),
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
 * The dual route with class printing forced, over corpus/lower/r36, in `rc` and `leak`: every case agrees with V8 natively
 * and with the TSL route, and the printed TSL on V8 and JSC with the source (off where a bug is in).
 */
export async function r36Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
  printed = true,
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
    dirs: [R36_LOWER_DIR],
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
 * One of R36's bugs, put in: what caught it (wrong answers, and the first in a stable order). Those caught by answers over
 * corpus/r36 natively and corpus/lower/r36 through the dual route in `rc`, at their levels; `r36-consume-always` by the
 * shapes.
 */
export async function r36Fault(
  f: (typeof R36_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const run = async (): Promise<string[]> => {
    if (f.by === "shapes") return (await r36Shapes()).failures;
    return [
      ...(await r36Native(accel, jobs, f.levels)).failures,
      ...(await r36Dual([accel], jobs, f.levels, false, ["rc"])).failures,
    ];
  };
  return withEnv({ TMK_OPT_FAULT: f.optFault }, async () => {
    const failures = faultFailures(await run(), f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  });
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
    const s = await r36Shapes();
    for (const x of s.rows) console.log(x);
    for (const x of s.failures) console.log(`FAIL ${x}`);
    bad += s.failures.length;
    if (!argv.includes("--shapes-only")) {
      const n = await r36Native(accel, jobs);
      console.log(`native: ${n.agreed}/${n.cases} (${n.rows.join(", ")})`);
      for (const x of n.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += n.failures.length;
      const d = await r36Dual([accel], jobs);
      console.log(`dual: ${d.agreed}/${d.cases} cases, ${d.handled} builds through the TSL route`);
      for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
      bad += d.failures.length;
    }
  }
  if (argv.includes("--faults") || argv.includes("--faults-only"))
    for (const f of R36_FAULTS) {
      if (val("--only") !== undefined && !new RegExp(val("--only")!).test(f.name)) continue;
      const x = await r36Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
      if (x.caught === 0) bad++;
    }
  process.exitCode = bad > 0 ? 1 : 0;
}
