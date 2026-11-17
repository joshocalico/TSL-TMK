// R14's tests (SPEC M5's R14 record, D62, pile item 9): `auto` takes a program the printer reshaped where every reshape is a
// kind it trusts (tslc.ts's TRUSTED_RESHAPES): the lowering's statement-expressions inside an expression, whose statements
// go before the statement holding them in the order JS runs them. Every program `auto` now takes reshaped agrees with the
// direct route natively at -O0 and -O2 in every mode, and as printed on V8 and JSC with the source (the three-way
// differential, on `auto`'s own build); each bug put into a trusted kind's order is caught; and nothing with exceptions,
// nor any kind not trusted, is taken reshaped.
//
//   node tools/r14-tests.ts [--accel hvf|tcg] [--jobs n] [--faults] [--modes leak,rc]
import { join, relative } from "node:path";
import { listPrograms, ROOT, wrongAnswers } from "./corpus.ts";
import type { Accel } from "./qemu-run.ts";
import type { PipeMode } from "./pipe-tests.ts";
import { firstInOrder } from "./stable.ts";

/** Where R14's programs are: the differential's directories and rc-tsl's (R2 to R11's own). */
export const R14_DIRS = (dirs: readonly string[]): string[] => [...dirs, "corpus/lower/rc-tsl"];

/** R14's own program: one of each trusted kind, each where a statement-expression's order shows in its result. */
export const R14_PROGRAMS = ["corpus/lower/pipe/reshape_order.ts"];

/**
 * The dual route on `auto`'s own builds (dual-build.ts's `auto`): every program `auto` takes reshaped, at -O0 and -O2, in
 * each mode, natively against the direct route, and as printed on V8 and JSC against native and the source (D71).
 */
export async function autoReshapedDual(
  accels: Accel[],
  jobs: number,
  modes: PipeMode[] = ["strict", "leak", "manual", "rc"],
  fault?: string,
  levels: (0 | 2)[] = [0, 2],
): Promise<{
  failures: string[];
  taken: string[];
  cases: number;
  agreed: number;
  printedCases: number;
  printedSame: number;
  divergences: Record<string, number>;
}> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes,
    levels,
    accels,
    jobs,
    auto: true,
    ...(fault !== undefined ? { fault } : {}),
    dirs: R14_DIRS(P.PIPE_DIRS),
  });
  const handled = r.programs.filter((p) => p.handled);
  const taken = [...new Set(handled.map((p) => `${p.file} ${p.mode}`))].sort();
  return {
    failures: r.failures,
    taken,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    printedCases: r.printed.cases,
    printedSame: r.printed.same,
    divergences: r.printed.divergences,
  };
}

/**
 * What `auto` takes reshaped, and by which kinds, compiled only, at -O1 and -O2: none of a kind it doesn't trust, none with
 * exceptions (R14_TRUST_EXC), none in a printing TRUSTED_IN doesn't trust (class printing in `leak` and `rc`), and every one
 * phase 1 printed gives the direct route's TIR byte for byte, so its machine code too (the speed rule, as a fact).
 */
export async function autoReshapedKinds(
  modes: PipeMode[] = ["strict", "leak", "manual", "rc"],
): Promise<{
  failures: string[];
  taken: Record<string, number>;
  kinds: Record<string, number>;
  phase1Same: number;
  classes: number;
}> {
  const { lowerFile, TRUSTED_RESHAPES, TRUSTED_IN } = await import("../compiler/host/tslc.ts");
  const { PIPE_DIRS } = await import("./pipe-tests.ts");
  const files = R14_DIRS(PIPE_DIRS)
    .flatMap((d) => listPrograms(join(ROOT, d)))
    .filter((f) => !/\/gen_/.test(f));
  const failures: string[] = [];
  const taken: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  let phase1Same = 0;
  let classes = 0;
  for (const mode of modes)
    for (const f of files)
      for (const opt of [1, 2] as const) {
        let a: ReturnType<typeof lowerFile>;
        try {
          a = lowerFile(f, { memory: mode, opt, route: "auto" });
        } catch {
          continue; // the direct route can't build it either: not this box's
        }
        if (a.tsl === undefined || a.tsl.file === "" || a.tsl.stats.restructured === 0) continue;
        const rel = relative(ROOT, f);
        const at = `${rel} ${mode} -O${opt}`;
        if (opt === 2) taken[mode] = (taken[mode] ?? 0) + 1;
        for (const k of Object.keys(a.tsl.stats.reshapedWhy ?? {})) {
          if (opt === 2) kinds[k] = (kinds[k] ?? 0) + 1;
          if (!TRUSTED_RESHAPES.includes(k)) failures.push(`${at}: taken reshaped by "${k}"`);
        }
        if (a.tsl.stats.rcExc === true || (a.meta as { exc?: unknown }).exc !== undefined)
          failures.push(`${at}: taken reshaped with exceptions`);
        const cls = a.tsl.stats.classes === true;
        if (TRUSTED_IN[mode]?.[cls ? "classes" : "phase1"] !== true)
          failures.push(`${at}: taken reshaped in a printing TRUSTED_IN doesn't trust`);
        if (cls) {
          classes++;
          continue;
        }
        const d = lowerFile(f, { memory: mode, opt, route: "direct" });
        if (d.tirHash === a.tirHash) phase1Same++;
        else
          failures.push(`${at}: phase 1's printing, reshaped, gives TIR the direct route doesn't`);
      }
  return { failures, taken, kinds, phase1Same, classes };
}

/** The bugs put into the trusted kinds' printing (emit-tsl.ts, TMK_TEST_EMIT), each to be caught by the differential. */
export const R14_FAULTS: { name: string; what: string; kind: string }[] = [
  {
    name: "seq-late",
    what: "a sequence's earlier parts run after a later part's statements",
    kind: "a sequence with statements in a part after the first",
  },
  {
    name: "operand-late",
    what: "an earlier operand evaluated after a later operand's statements",
    kind: "statements before an operand",
  },
  {
    name: "cond-arms-first",
    what: "a conditional's arms' statements run before its test, whichever arm it picks",
    kind: "a conditional's arm with statements",
  },
  {
    name: "logic-always",
    what: "a logical operator's right side's statements run where the left side decides",
    kind: "a logical operator's right side with statements",
  },
];

/** One of R14's bugs, in `auto`'s reshaped builds at -O2: how many cases caught it, by a wrong answer, and in all. */
export async function r14FaultRun(
  f: (typeof R14_FAULTS)[number],
  accel: Accel,
  jobs: number,
  modes: PipeMode[] = ["strict", "leak", "manual", "rc"],
): Promise<{ caught: number; answers: number; first: string }> {
  const r = await autoReshapedDual([accel], jobs, modes, f.name, [2]);
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
  const modes = (flag("--modes")?.split(",") ?? ["strict", "leak", "manual", "rc"]) as PipeMode[];
  if (process.argv.includes("--faults")) {
    for (const f of R14_FAULTS) {
      const r = await r14FaultRun(f, accel, jobs, modes);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  } else if (process.argv.includes("--kinds")) {
    const k = await autoReshapedKinds(modes);
    console.log(
      JSON.stringify({
        taken: k.taken,
        kinds: k.kinds,
        phase1Same: k.phase1Same,
        classes: k.classes,
      }),
    );
    for (const x of k.failures) console.log(`  FAIL ${x}`);
  } else {
    const d = await autoReshapedDual([accel], jobs, modes);
    console.log(
      `dual (auto, reshaped): ${d.agreed}/${d.cases} cases; taken ${d.taken.length}; third route ${d.printedSame}/${d.printedCases}, allowed divergences ${JSON.stringify(d.divergences)}`,
    );
    for (const x of d.failures.slice(0, 30)) console.log(`  FAIL ${x}`);
  }
  process.exit(0);
}
