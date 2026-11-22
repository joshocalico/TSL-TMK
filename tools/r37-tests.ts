// R37's tests (SPEC M5's R37 record, 4.5, D49, D62, D68): `auto` takes a program with exceptions, printed reshaped only by
// the kinds it trusts, in the modes tslc.ts's TRUSTED_EXC_IN names (`leak` and `manual`), where it goes through phase 1's
// printing of down-exc.ts's flag and its checks. What must hold:
//
// - every such build at -O1 and -O2 gives the direct route's machine code byte for byte (its TIR at -O1 can differ in where
//   a constant is made, which the backend makes at its use), so the speed rule holds as a fact; none is taken in a mode
//   TRUSTED_EXC_IN doesn't name (`rc`, `strict`); and with the switch off (TMK_R37_OFF=exc) none is taken reshaped;
// - every such program of corpus/lower/exc, the 63 generated ones with every way out through `finally` included, agrees
//   with the direct route through `auto`'s own build in leak and manual at -O0 and -O2, natively, and as printed on V8 and
//   JSC with the source (the hand-written ones are box 47's too);
// - each of R37's bugs, put into phase 1's printing of the flag, is caught by that differential (SPEC 8.3's fault rule).
//
//   node tools/r37-tests.ts [--accel hvf|tcg] [--jobs 4] [--shapes-only] [--faults-only]
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listPrograms, ROOT, wrongAnswers } from "./corpus.ts";
import type { Accel } from "./qemu-run.ts";
import type { PipeMode } from "./pipe-tests.ts";
import { firstInOrder } from "./stable.ts";

/** The modes R37 turned the trust on in: tslc.ts's TRUSTED_EXC_IN, checked against it by r37Shapes. */
export const R37_MODES: PipeMode[] = ["leak", "manual"];

/** R37's bugs, each put into phase 1's printing by name (TMK_TEST_EMIT), caught on `auto`'s own builds by wrong answers. */
export const R37_FAULTS: { name: string; what: string; emit: string }[] = [
  {
    name: "r37-exc-flag-unset",
    what: "a throw's setting of the exception flag printed as clearing it, so nothing sees the exception",
    emit: "r37-exc-flag-unset",
  },
  {
    name: "r37-exc-flag-kept",
    what: "a catch's clearing of the exception flag printed as setting it, so a caught exception goes on being seen",
    emit: "r37-exc-flag-kept",
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

/** The programs R37 looks at: R14's (the differential's directories and rc-tsl's), the generated ones included. */
async function r37Files(): Promise<string[]> {
  const { PIPE_DIRS } = await import("./pipe-tests.ts");
  const { R14_DIRS } = await import("./r14-tests.ts");
  // A module has exceptions only where something can catch (D49): a `try` or `using`; and a `throw` is kept for safety. Box
  // 47 looks at every program, and fails one taken with exceptions in a mode TRUSTED_EXC_IN doesn't name.
  return R14_DIRS(PIPE_DIRS)
    .flatMap((d) => (existsSync(join(ROOT, d)) ? listPrograms(join(ROOT, d)) : []))
    .filter((f) => /\b(try|using|throw)\b/.test(readFileSync(f, "utf8")));
}

/**
 * What `auto` takes with exceptions, compiled only: at -O1 and -O2 in each mode, every program it takes reshaped with
 * exceptions is in a mode TRUSTED_EXC_IN names and gives the direct route's machine code byte for byte (the image built
 * from each route's TIR with the program's own cases, as the gate runs it); with TMK_R37_OFF=exc, none (the switch is what
 * takes them). In `rc` and `strict`, none.
 */
export async function r37Shapes(): Promise<{
  failures: string[];
  rows: string[];
  taken: Record<string, number>;
  sameTir: number;
  sameCode: number;
}> {
  const { lowerFile, TRUSTED_EXC_IN } = await import("../compiler/host/tslc.ts");
  const { buildDownImage, bulkFor } = await import("./native-exec.ts");
  const { pinsOf } = await import("./dual-build.ts");
  const failures: string[] = [];
  const taken: Record<string, number> = {};
  let sameTir = 0;
  let sameCode = 0;
  for (const m of R37_MODES)
    if (TRUSTED_EXC_IN[m] !== true) failures.push(`TRUSTED_EXC_IN doesn't trust ${m}`);
  for (const m of ["rc", "strict"])
    if (TRUSTED_EXC_IN[m] === true) failures.push(`TRUSTED_EXC_IN trusts ${m}, which R37 didn't`);
  const files = await r37Files();
  const hash = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  const hasExc = (a: ReturnType<typeof lowerFile>): boolean =>
    a.tsl?.stats.rcExc === true || (a.meta as { exc?: unknown } | null)?.exc !== undefined;
  const isTaken = (a: ReturnType<typeof lowerFile>): boolean =>
    a.tsl !== undefined && a.tsl.file !== "" && a.tsl.stats.restructured > 0;
  for (const mode of ["leak", "manual", "rc"] as PipeMode[])
    for (const f of files)
      for (const opt of [1, 2] as const) {
        let a: ReturnType<typeof lowerFile>;
        try {
          a = lowerFile(f, { memory: mode, opt, route: "auto" });
        } catch {
          continue; // the direct route can't build it either: not this box's
        }
        if (!isTaken(a) || !hasExc(a)) continue;
        const rel = relative(ROOT, f);
        const at = `${rel} ${mode} -O${opt}`;
        if (!R37_MODES.includes(mode)) {
          failures.push(
            `${at}: taken reshaped with exceptions in a mode TRUSTED_EXC_IN doesn't trust`,
          );
          continue;
        }
        if (opt === 2) taken[mode] = (taken[mode] ?? 0) + 1;
        const d = lowerFile(f, { memory: mode, opt, route: "direct" });
        if (d.tir === null || a.tir === null) {
          failures.push(`${at}: no TIR`);
          continue;
        }
        if (d.tirHash === a.tirHash) sameTir++;
        const casesFile = f.replace(/\.ts$/, ".cases.json");
        const cases = existsSync(casesFile) ? JSON.parse(readFileSync(casesFile, "utf8")) : [];
        const { pages, stack } = pinsOf(f);
        const image = (r: typeof d): string =>
          hash(
            buildDownImage(
              r.tir!,
              r.meta as never,
              cases,
              pages,
              { bulkBytes: bulkFor(), noDump: true },
              undefined,
              stack,
            ).image.bytes,
          );
        if (image(d) === image(a)) sameCode++;
        else failures.push(`${at}: auto's machine code isn't the direct route's`);
      }
  // The switch is what takes them: off, a program with exceptions is left to the direct route, as before R37.
  let offTaken = 0;
  await withEnv({ TMK_R37_OFF: "exc" }, async () => {
    for (const mode of R37_MODES)
      for (const f of files.filter((x) => /corpus\/lower\/exc\//.test(x)).slice(0, 12)) {
        try {
          const a = lowerFile(f, { memory: mode, opt: 2, route: "auto" });
          if (isTaken(a) && hasExc(a)) offTaken++;
        } catch {
          // not this check's
        }
      }
  });
  if (offTaken > 0)
    failures.push(`with TMK_R37_OFF=exc, auto still took ${offTaken} builds with exceptions`);
  for (const m of R37_MODES)
    if ((taken[m] ?? 0) < 81)
      failures.push(`auto takes ${taken[m] ?? 0} programs with exceptions in ${m}, not 81`);
  return {
    failures,
    taken,
    sameTir,
    sameCode,
    rows: [
      `taken with exceptions at -O2: ${JSON.stringify(taken)}`,
      `the direct route's machine code byte for byte in ${sameCode} builds at -O1 and -O2 (its TIR too in ${sameTir})`,
      `with the switch off: ${offTaken} taken`,
    ],
  };
}

/** The differential on `auto`'s own builds over corpus/lower/exc, the generated programs included, in leak and manual. */
export async function r37Dual(
  accel: Accel,
  jobs: number,
  fault?: string,
  levels: (0 | 2)[] = [0, 2],
  modes: PipeMode[] = R37_MODES,
): Promise<{
  failures: string[];
  taken: string[];
  generated: number;
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
    accels: [accel],
    jobs,
    auto: true,
    generated: true,
    dirs: ["corpus/lower/exc"],
    ...(fault !== undefined ? { fault } : {}),
  });
  const handled = r.programs.filter((p) => p.handled);
  const taken = [...new Set(handled.map((p) => `${p.file} ${p.mode}`))].sort();
  return {
    failures: r.failures,
    taken,
    generated: new Set(handled.map((p) => p.file).filter((f) => /\/gen_/.test(f))).size,
    cases: r.rows.reduce((n, x) => n + x.cases, 0),
    agreed: r.rows.reduce((n, x) => n + x.agreed, 0),
    printedCases: r.printed.cases,
    printedSame: r.printed.same,
    divergences: r.printed.divergences,
  };
}

/** One of R37's bugs, on `auto`'s own builds of corpus/lower/exc's hand-written programs in leak at -O2. */
export async function r37Fault(
  f: (typeof R37_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["leak"],
    levels: [2],
    accels: [accel],
    jobs,
    auto: true,
    dirs: ["corpus/lower/exc"],
    fault: f.emit,
  });
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
    const s = await r37Shapes();
    console.log(s.rows.join("\n"));
    for (const x of s.failures.slice(0, 30)) console.log(`  FAIL ${x}`);
  }
  if (!process.argv.includes("--shapes-only") && !process.argv.includes("--faults-only")) {
    const d = await r37Dual(accel, jobs);
    console.log(
      `dual (auto, exceptions): ${d.agreed}/${d.cases} cases in ${d.taken.length} builds' programs (${d.generated} generated); third route ${d.printedSame}/${d.printedCases}, divergences ${JSON.stringify(d.divergences)}`,
    );
    for (const x of d.failures.slice(0, 30)) console.log(`  FAIL ${x}`);
  }
  if (process.argv.includes("--faults") || process.argv.includes("--faults-only"))
    for (const f of R37_FAULTS) {
      const r = await r37Fault(f, accel, jobs);
      console.log(`${f.name}: caught ${r.caught}, answers ${r.answers}: ${r.first}`);
    }
  process.exit(0);
}
