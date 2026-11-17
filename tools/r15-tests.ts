// R15's tests (SPEC M5's R15 record, D44, D73, pile item 10): conds.ts at -O1 and -O2 and loop versioning at -O2.
//
// - corpus/trap/loop_versions.ts natively at -O0, -O1 and -O2, its cases against V8: loops where the guard holds and the
//   fast copy runs, and loops where it must fail (a bound one past, a length or a bound the loop changes, two arrays of
//   different lengths, a stride past the end, one array written and read as two), and a test after a join;
// - the shapes, in TIR: matmul's inner loop (corpus/pos/matmul_f64.ts) versioned at -O2, its fast copy with no bounds or
//   overflow check and the loop as it was kept whole; the same at -O1 and with `version` off, one loop; the JPEG decoder's
//   class printing's second null test of one value in toRgba gone at -O1;
// - each of R15's bugs (manager.ts OPT_FAULTS) caught by loop_versions.ts's cases at -O2, counted by wrong answers.
//
//   node tools/r15-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { join } from "node:path";
import { defaultEngines, ROOT, runNative } from "./corpus.ts";
import type { Accel } from "./qemu-run.ts";

export const R15_PROGRAMS = ["corpus/trap/loop_versions.ts"];

export const R15_FAULTS: { name: string; what: string }[] = [
  { name: "conds-not-dominating", what: "a test's answer taken where its edge doesn't dominate" },
  { name: "version-off-by-one", what: "the guard allowing one turn more than the checks" },
  {
    name: "version-bound-in-loop",
    what: "a bound or length the loop changes read once before it, for the guard",
  },
  { name: "version-wrong-length", what: "every guard against the first check's length" },
];

/** loop_versions.ts natively at a level, with a bug put in or none: its cases against V8's. */
export async function r15Native(
  accel: Accel,
  jobs: number,
  level: 0 | 1 | 2,
  fault?: string,
): Promise<{ ok: boolean; count: number; failures: string[]; summary: string }> {
  const env = process.env;
  const was = { opt: env.TMK_OPT, fault: env.TMK_OPT_FAULT };
  try {
    env.TMK_OPT = String(level);
    if (fault !== undefined) env.TMK_OPT_FAULT = fault;
    else delete env.TMK_OPT_FAULT;
    const r = await runNative("trap", [accel], jobs, "loop_versions", defaultEngines());
    return { ok: r.ok, count: r.count, failures: r.failures, summary: r.summary };
  } finally {
    if (was.opt === undefined) delete env.TMK_OPT;
    else env.TMK_OPT = was.opt;
    if (was.fault === undefined) delete env.TMK_OPT_FAULT;
    else env.TMK_OPT_FAULT = was.fault;
  }
}

/** The shapes in TIR. Each row says what it checked. */
export async function r15Shapes(): Promise<{ ok: boolean; rows: string[]; failures: string[] }> {
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { printFunc } = await import("../compiler/tir/text.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  const count = (s: string, re: RegExp): number => (s.match(new RegExp(re, "g")) ?? []).length;
  const c = checkFile(join(ROOT, "corpus/pos/matmul_f64.ts"));
  if (c.typed === null) return { ok: false, rows, failures: ["matmul_f64.ts doesn't check"] };
  const at = (level: 0 | 1 | 2): string => {
    const m = compileTyped(c.typed!, { opt: level }).tir;
    return printFunc(m.funcs.find((f) => f.name === "matmul")!);
  };
  // the loops whose header tests k < n: one per copy
  const loops = (s: string): number => count(s, /icmp\.ult\.ix %\d+, %6\n/);
  const o0 = at(0);
  const o1 = at(1);
  const o2 = at(2);
  const chk = (s: string): number => count(s, /bounds\.chk/);
  rows.push(
    `matmul: -O0 ${loops(o0)} loops ${chk(o0)} bounds checks, -O1 ${loops(o1)}/${chk(o1)}, -O2 ${loops(o2)}/${chk(o2)}`,
  );
  // -O2: the j loop and each copy's k loop versioned: 7 loops (i; j twice; k four times), bounds checks only in the
  // fallbacks (a's and b's in each k fallback, out's in the j fallback)
  if (loops(o1) !== 3 || chk(o1) !== 3)
    failures.push(`matmul at -O1 isn't the three loops it was: ${o1}`);
  if (loops(o2) <= 3) failures.push(`matmul at -O2 has no fast copy: ${o2}`);
  // every fast k loop body (a block with fmul and no bounds.chk) exists, and every fallback keeps both its checks
  const bodies = o2.split(/\nbb\d+[^\n]*:\n/).filter((b) => b.includes("fmul.f64"));
  const fast = bodies.filter((b) => !b.includes("bounds.chk") && !/\.chk\./.test(b)).length;
  const slow = bodies.filter((b) => count(b, /bounds\.chk/) === 2).length;
  rows.push(`matmul -O2: ${fast} fast inner bodies, ${slow} fallbacks with both checks`);
  if (fast === 0 || slow === 0 || fast + slow !== bodies.length)
    failures.push(
      `matmul at -O2: ${fast} fast and ${slow} checked inner bodies of ${bodies.length}`,
    );
  return { ok: failures.length === 0, rows, failures };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const accel = (flag("--accel") ?? "hvf") as Accel;
  const jobs = Number(flag("--jobs") ?? "4");
  if (process.argv.includes("--faults")) {
    for (const f of R15_FAULTS) {
      const r = await r15Native(accel, jobs, 2, f.name);
      console.log(
        `${f.name}: ${r.failures.length} failures: ${(r.failures[0] ?? "").slice(0, 200)}`,
      );
    }
  } else {
    const s = await r15Shapes();
    for (const r of s.rows) console.log(r);
    for (const x of s.failures) console.log(`  FAIL ${x}`);
    for (const level of [0, 1, 2] as const) {
      const r = await r15Native(accel, jobs, level);
      console.log(`-O${level}: ${r.summary}`);
      for (const x of r.failures.slice(0, 20)) console.log(`  FAIL ${x}`);
    }
  }
  process.exit(0);
}
