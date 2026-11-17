// R18's tests (SPEC M5's R18 record, 3.5, 8.3, D39, D41): `rc` class printing keeps on the stack what the direct route keeps
// there. A class every object of which the lowering places on its function's stack, holding numbers and booleans alone and
// held by nothing counted, prints tagged `@tsl.stack`; tslc's expansion leaves it uncounted (no store, no release function,
// its `new` a plain `new`, its references never shared or dropped), and tslc's escape checking puts each `new` on the stack
// and refuses a program where one could outlive its frame.
//
// - corpus/lower/r18/r18_stack.ts through the dual route with class printing forced in `rc`, at -O0 and -O2: every case
//   agrees with the direct route natively, and the printed TSL on V8 and JSC with the source; and in `leak` and `manual`,
//   where nothing of R18 applies, the same;
// - the shapes: which of its classes print tagged, and that a tagged class's `new` is no allocation in TIR (no call to a
//   store's `make`) at -O1 and -O2;
// - tslc's own checks on a tagged class, on hand-written lowered packages (corpus/lower/r18/neg): one whose object escapes
//   is refused (TSL3001's family), one holding a reference is refused (TSL9001), and a hand-written `rc` package's tag means
//   nothing;
// - each of R18's bugs caught (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure, never caught).
//
//   node tools/r18-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R18_PROGRAM = "corpus/lower/r18/r18_stack.ts";

/**
 * R18's bugs, each with how it's put in and what has to catch it: `dual`, a wrong answer or trap code through the dual route
 * on R18's program in `rc` at -O2; `rejected`, tslc refusing that build at a stack object that would outlive its frame
 * (TSL3001 or TSL3002, its escape checking, which is what stands behind the printer's tag); `neg`, a program of
 * corpus/neg/lowered-rc that tslc must refuse not refused (that checking's own tests).
 */
export const R18_FAULTS: {
  name: string;
  what: string;
  emit?: string; // TMK_TEST_EMIT: a bug in the printer
  expansion?: string; // TMK_TEST_RC_TSL: a bug in tslc's expansion
  tslEnv?: string; // TMK_TEST_TSL: a bug in tslc's checking
  by: "dual" | "rejected" | "neg";
}[] = [
  {
    name: "stack-escaping",
    what: "an escaping object placed on the stack: the printer tagging every class of numbers, wherever its objects go",
    emit: "r18-stack-any",
    by: "rejected",
  },
  {
    name: "stack-escaping-unchecked",
    what: "an escaping object placed on the stack, and tslc's escape checking not taking a tagged class's `new` as a stack object",
    emit: "r18-stack-any",
    tslEnv: "r18-stack-unchecked",
    by: "dual",
  },
  {
    name: "stack-held",
    what: "a stack object reachable from a heap object the collector scans: the printer tagging a class a counted object's field holds",
    emit: "r18-stack-held",
    by: "rejected",
  },
  {
    name: "stack-held-unchecked",
    what: "a stack object reachable from a heap object the collector scans (a counted holder in a cycle), and tslc's escape checking letting it be stored there",
    emit: "r18-stack-held",
    tslEnv: "r18-stack-unchecked",
    by: "dual",
  },
  {
    name: "stack-counted",
    what: "a stack object released by @tsl/gc: the expansion leaving a tagged class's `new` on the stack but sharing and dropping its references",
    expansion: "r18-stack-counted",
    by: "dual",
  },
  {
    name: "stack-unchecked",
    what: "tslc's escape checking not taking a tagged class's `new` as a stack object, so a lowered package's stack object can be returned, kept in module state or held by a counted object",
    tslEnv: "r18-stack-unchecked",
    by: "neg",
  },
  {
    name: "stack-refs",
    what: "the expansion taking a tagged class that holds a reference, whose count nothing gives back when its frame ends",
    expansion: "r18-stack-refs",
    by: "neg",
  },
];

/**
 * The dual route with class printing forced, over R18's program, in `modes` at -O0 and -O2: every case agrees with the direct
 * route natively, and the printed TSL on V8 and JSC with the source (the third route).
 */
export async function r18Dual(
  accels: Accel[],
  jobs: number,
  modes: ("rc" | "leak" | "manual")[] = ["rc", "leak", "manual"],
  levels: (0 | 2)[] = [0, 2],
): Promise<{ failures: string[]; printed: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels,
    accels,
    jobs,
    classes: true,
    dirs: ["corpus/lower/r18"],
    filter: (f) => relative(ROOT, f) === R18_PROGRAM,
  });
  return {
    failures: r.failures,
    printed: [
      ...new Set(r.programs.filter((p) => p.handled).map((p) => `${p.file}@${p.mode}`)),
    ].sort(),
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
  };
}

/** The classes R18's program prints tagged in `rc`, and those it mustn't. */
export const R18_TAGGED = ["Pt", "Acc"];
export const R18_COUNTED = ["Escapes", "Inner", "Box", "Node", "Mark", "Span"];

/**
 * The shapes: at -O1 and -O2 in `rc`, with class printing forced, R18_TAGGED's classes print tagged `@tsl.stack` and have
 * no store in TIR (no `<Class>$rc`, so nothing of theirs is counted), and R18_COUNTED's print untagged, each with its store.
 */
export async function r18Shapes(): Promise<{ ok: boolean; rows: string[]; failures: string[] }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const { printModule } = await import("../compiler/tir/text.ts");
  const { readFileSync } = await import("node:fs");
  const rows: string[] = [];
  const failures: string[] = [];
  for (const opt of [1, 2] as const) {
    const lo = lowerFile(`${ROOT}/${R18_PROGRAM}`, {
      memory: "rc",
      opt,
      route: "tsl",
      classes: true,
    });
    const file = lo.tsl?.file ?? "";
    if (lo.tir === null || file === "") {
      failures.push(`-O${opt}: ${R18_PROGRAM} didn't print in rc: ${lo.tslSkipped ?? ""}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const tir = printModule(lo.tir);
    const tagged = (c: string): boolean =>
      new RegExp(`@tsl\\.stack \\*/\\nclass ${c} \\{`).test(text);
    for (const c of R18_TAGGED) {
      if (!tagged(c)) failures.push(`-O${opt}: ${c} isn't tagged @tsl.stack`);
      if (tir.includes(`@${c}$rc`)) failures.push(`-O${opt}: ${c} has a store in TIR`);
    }
    for (const c of R18_COUNTED) {
      if (tagged(c))
        failures.push(`-O${opt}: ${c} is tagged @tsl.stack, and an object of it escapes`);
      if (!tir.includes(`@${c}$rc`)) failures.push(`-O${opt}: ${c} has no store in TIR`);
    }
    rows.push(
      `-O${opt}: ${R18_TAGGED.join(" and ")} on the stack, ${R18_COUNTED.join(", ")} counted`,
    );
  }
  return { ok: failures.length === 0, rows, failures };
}

/** corpus/neg/lowered-rc: each refused, at its place, with its code (corpus.ts's runNegative). */
export async function r18Neg(jobs: number): Promise<{ rows: string[]; failures: string[] }> {
  const { defaultEngines, runNegative } = await import("./corpus.ts");
  const r = await runNegative(jobs, "stack_", defaultEngines());
  const failures = r.failures.filter((x) => x.includes("lowered-rc/"));
  const { readdirSync } = await import("node:fs");
  const n = readdirSync(`${ROOT}/corpus/neg/lowered-rc`).filter((f) => f.endsWith(".ts")).length;
  if (n < 4) failures.push(`corpus/neg/lowered-rc has ${n} programs, not 4`);
  return {
    rows: [`corpus/neg/lowered-rc: ${n - failures.length}/${n} refused as expected`],
    failures,
  };
}

/** One of R18's bugs: how many cases or builds caught it, and how many by a wrong answer. */
export async function r18FaultRun(
  f: (typeof R18_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const keys = ["TMK_TEST_TSL", "TMK_TEST_RC_TSL"] as const;
  const saved = keys.map((k) => process.env[k]);
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  if (f.expansion !== undefined) process.env.TMK_TEST_RC_TSL = f.expansion;
  try {
    let failures: string[];
    if (f.by === "neg") {
      // a fresh compile of each: the negative corpus's builds take TMK_* with the environment
      failures = (await r18Neg(jobs)).failures;
    } else {
      const P = await import("./pipe-tests.ts");
      const r = await P.dualRoute({
        modes: ["rc"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
        printed: false,
        dirs: ["corpus/lower/r18"],
        filter: (x) => relative(ROOT, x) === R18_PROGRAM,
        ...(f.emit !== undefined ? { fault: f.emit } : {}),
      });
      failures = r.failures;
    }
    faultFailures(failures, f.name);
    const counted = f.by === "rejected" ? failures.filter((x) => /TSL300[12]/.test(x)) : failures;
    return {
      caught: counted.length,
      answers:
        f.by === "dual" ? wrongAnswers(counted.filter((x) => !/TSL\d{4}/.test(x))) : counted.length,
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const j = process.argv.indexOf("--jobs");
  const jobs = j >= 0 ? Number(process.argv[j + 1]) : 4;
  const sh = await r18Shapes();
  console.log(sh.rows.join("; "));
  for (const x of sh.failures) console.log(`FAIL ${x}`);
  const ng = await r18Neg(jobs);
  console.log(ng.rows.join("; "));
  for (const x of ng.failures) console.log(`FAIL ${x}`);
  const d = await r18Dual([accel], jobs);
  console.log(`dual: ${d.agreed}/${d.cases}, printed ${d.printed.join(", ")}`);
  for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
  if (process.argv.includes("--faults"))
    for (const f of R18_FAULTS) {
      const x = await r18FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
  process.exitCode = d.failures.length > 0 ? 1 : 0;
}
