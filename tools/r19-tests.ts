// R19's tests (SPEC M5's R19 record, 3.4, 3.5, 4.3, D39, D41, D73): `rc` class printing's remaining measured costs. Arrays
// growing by rooms (`@tsl/gc`'s `tailFast` making a tail of any length in line, a fresh slot cut from a page of its size
// class, a holder with no slots or one freed without freeSteps' frame), closure calls through the kind switch (an `rc`
// environment's `call` inlined, its kind and captures invariant by tslc's rule, D73), and the backend leaving a `!` on a
// reference to the load through its address (`ref.addr`).
//
// - corpus/lower/r19/r19_rooms.ts through the dual route with class printing forced in `rc`, at -O0 and -O2: every case
//   agrees with the direct route natively, and the printed TSL on V8 and JSC with the source;
// - the shapes: in `rc`, an environment's `call` printed `@tsl.inline`, and at -O1 and -O2 the kind's load in TIR invariant
//   (`load.i32.inv`); and in a hand-written lowered `rc` package (corpus/lowered-rc/r19_fields.ts), a field stored only by its
//   class's constructor invariant, one a method stores too not;
// - corpus/lowered-rc/r19_fields.ts natively at -O0, -O1 and -O2, each case's pinned value: a load of a field a call stores
//   read once for the loop, or once for two reads around that call, is a wrong answer;
// - each of R19's bugs caught (SPEC 8.3's fault rule: a bug that isn't in the build is a harness failure, never caught).
//
//   node tools/r19-tests.ts [--accel hvf|tcg] [--jobs 4] [--faults]
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, wrongAnswers } from "./corpus.ts";
import { faultFailures, patchEnv, type TestPatch } from "./faults.ts";
import type { Accel } from "./qemu-run.ts";
import { firstInOrder } from "./stable.ts";

export const R19_PROGRAM = "corpus/lower/r19/r19_rooms.ts";
export const R19_FIELDS = "corpus/lowered-rc/r19_fields.ts";

const RC = "ex-gc-rc.ts";
const ROOMS = "ex-gc-roomarray.ts";
const MAP = "ex-jsrt-map.ts";

/**
 * R19's bugs, each with how it's put in and what has to catch it: `dual`, a wrong answer or trap code through the dual route
 * on R19's program in `rc` at -O2; `fields`, a wrong answer from corpus/lowered-rc/r19_fields.ts natively at -O1 or -O2.
 */
export const R19_FAULTS: {
  name: string;
  what: string;
  patch?: TestPatch | TestPatch[]; // TSL_TEST_PATCH: a bug in a library's source (R24: or several places of one)
  emit?: string; // TMK_TEST_EMIT: a bug in the printer
  tslEnv?: string; // TMK_TEST_TSL: a bug in tslc
  by: "dual" | "fields";
}[] = [
  {
    name: "room-grow-short",
    what: "a room array's growth copying one element short into its new room",
    patch: {
      file: ROOMS,
      from: "    copyBytes(at, this.data, this.len * size);",
      to: "    copyBytes(at, this.data, (this.len - 1) * size);",
    },
    by: "dual",
  },
  {
    name: "kind-wrong-arm",
    what: "an rc environment's inlined call switch dispatching to the wrong arm: its first two kinds' calls swapped",
    emit: "r19-kind-arm",
    by: "dual",
  },
  {
    name: "ctor-store-unseen",
    what: "tslc's rule taking a field a method stores too as stored by its constructor alone, so its load is invariant across the call that stores it",
    tslEnv: "r19-ctor-store",
    by: "fields",
  },
  {
    name: "map-grow-lose",
    what: "a map table's growth losing an entry: the entry its move puts first in the new table left out of every chain there",
    patch: {
      file: MAP,
      // R29: link stores the key too now
      from: "        this.link(r, k, hashOf(k));",
      to: "        if (r !== 0) this.link(r, k, hashOf(k));",
    },
    by: "dual",
  },
  {
    name: "pair-elem-undropped",
    what: "a freed array literal's element not dropped: freeing a holder visits its slots from the third, so a literal of two objects is given back with its second still counted",
    // R24: and in freeRest, the same loop where freeAlloc, an allocation's freeing without the collector since R24, takes
    // an object of more than one slot; freeFlat's is reached now only after another step or by runSteps' other callers
    patch: [
      {
        file: RC,
        from: "    let a: usize = 1;\n    stepping = true;",
        to: "    let a: usize = 2;\n    stepping = true;",
      },
      {
        file: RC,
        from: "  let a: usize = 1;\n  stepping = true;\n  while (a < s && left !== 0n) {",
        to: "  let a: usize = 2;\n  stepping = true;\n  while (a < s && left !== 0n) {",
      },
    ],
    by: "dual",
  },
  {
    name: "tail-class-stale",
    what: "a tail of a new length made in line at the last length's size class, so a longer room overruns its slot",
    patch: {
      file: RC,
      from: "      if (n !== this.tn || this.tk === 0) {",
      to: "      if (this.tk === 0) {",
    },
    by: "dual",
  },
  {
    name: "fresh-slot-overlap",
    what: "a fresh slot cut from its size class's page only half a slot past the last, so two objects share memory (R28: in pageSlot and in pageCut, make's and tailFast's in-line cut, alike)",
    patch: {
      file: RC,
      from: "  at.write(BigInt.asUintN(64, slot + size));",
      to: "  at.write(BigInt.asUintN(64, slot + size / 2n));",
      times: 2,
    },
    by: "dual",
  },
];

/**
 * The dual route with class printing forced, over R19's program, in `rc` at -O0 and -O2: every case agrees with the direct
 * route natively, and the printed TSL on V8 and JSC with the source (the third route).
 */
export async function r19Dual(
  accels: Accel[],
  jobs: number,
  levels: (0 | 2)[] = [0, 2],
): Promise<{ failures: string[]; printed: string[]; cases: number; agreed: number }> {
  const P = await import("./pipe-tests.ts");
  const r = await P.dualRoute({
    modes: ["rc"],
    levels,
    accels,
    jobs,
    classes: true,
    dirs: ["corpus/lower/r19"],
    filter: (f) => relative(ROOT, f) === R19_PROGRAM,
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

/**
 * The shapes: R19's program in `rc` with class printing forced prints each environment's `call` `@tsl.inline`, and at -O1
 * and -O2 `chosen`'s kind is loaded `load.i32.inv`; in corpus/lowered-rc/r19_fields.ts, `fixed`'s kind load is invariant
 * and `switching`'s and `around`'s, which `retarget` stores, aren't.
 */
export async function r19Shapes(): Promise<{ ok: boolean; rows: string[]; failures: string[] }> {
  const { lowerFile, checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { printModule } = await import("../compiler/tir/text.ts");
  const rows: string[] = [];
  const failures: string[] = [];
  const funcOf = (tir: string, name: string): string =>
    tir.split("\nfunc ").find((f) => f.startsWith(`@${name}(`)) ?? "";
  for (const opt of [1, 2] as const) {
    const lo = lowerFile(join(ROOT, R19_PROGRAM), {
      memory: "rc",
      opt,
      route: "tsl",
      classes: true,
    });
    const file = lo.tsl?.file ?? "";
    if (lo.tir === null || file === "") {
      failures.push(`-O${opt}: ${R19_PROGRAM} didn't print in rc: ${lo.tslSkipped ?? ""}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const calls = text.match(/\/\*\* @tsl\.inline \*\/\n {2}call\(/g)?.length ?? 0;
    if (calls < 2)
      failures.push(`-O${opt}: ${calls} environments' call printed @tsl.inline, not 2`);
    const chosen = funcOf(printModule(lo.tir), "chosen");
    const inv = chosen.match(/load\.i32\.inv/g)?.length ?? 0;
    if (inv === 0) failures.push(`-O${opt}: chosen's kind isn't loaded invariant`);
    rows.push(`-O${opt}: ${calls} calls inlined, chosen's kind invariant (${inv})`);
    // a fresh check each build: lowering a typed module twice isn't supported
    const c = checkFile(join(ROOT, R19_FIELDS));
    if (c.typed === null) {
      failures.push(`${R19_FIELDS}: ${c.diags.map((d) => d.code).join(", ")}`);
      continue;
    }
    const tir = printModule(compileTyped(c.typed, { opt }).tir);
    const n = (f: string): number => funcOf(tir, f).match(/load\.i32\.inv/g)?.length ?? 0;
    if (n("fixed") === 0)
      failures.push(`-O${opt}: Fixed's kind, stored by its constructor alone, isn't invariant`);
    for (const f of ["switching", "around"])
      if (n(f) > 0)
        failures.push(`-O${opt}: ${f}'s kind, which retarget stores, is loaded invariant`);
    rows.push(`-O${opt}: r19_fields Fixed's kind invariant, Pick's not`);
  }
  return { ok: failures.length === 0, rows, failures };
}

/** corpus/lowered-rc/r19_fields.ts natively at -O0, -O1 and -O2, each case's pinned value (`value`). */
export async function r19Fields(
  accel: Accel,
  levels: (0 | 1 | 2)[] = [0, 1, 2],
): Promise<{ failures: string[]; cases: number; agreed: number; skipped: boolean }> {
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { buildTslImage, tslResults, bulkFor } = await import("./native-exec.ts");
  const { qemuRun } = await import("./qemu-run.ts");
  const file = join(ROOT, R19_FIELDS);
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
  const failures: string[] = [];
  let n = 0;
  let agreed = 0;
  for (const opt of levels) {
    const c = checkFile(file);
    if (c.typed === null) {
      failures.push(
        `${R19_FIELDS} -O${opt}: ${c.diags.map((d) => `${d.code} ${d.msg}`).join("; ")}`,
      );
      continue;
    }
    const o = compileTyped(c.typed, { opt });
    if (opt === 1 || opt === 2) o.tir.opt = opt;
    const image = buildTslImage(o.tir, o.meta as never, cases, undefined, bulkFor());
    const q = await qemuRun({
      name: `r19-fields-O${opt}`,
      image: image.bytes,
      accel,
      timeoutMs: 120_000,
      ...(image.bulk !== undefined ? { bulk: image.bulk } : {}),
    });
    if (q.skipped) return { failures, cases: n, agreed, skipped: true };
    if (!q.ok) {
      failures.push(`${R19_FIELDS} -O${opt}: ${q.status} ${q.why.slice(0, 200)}`);
      continue;
    }
    const { results, problems } = tslResults(o.meta as never, cases, q.lines);
    failures.push(...problems.map((p) => `${R19_FIELDS} -O${opt}: ${p}`));
    results.forEach((r, i) => {
      n++;
      if (r.pin === "ok") agreed++;
      else failures.push(`${R19_FIELDS} -O${opt}: ${r.fn}#${i}: ${r.pin ?? "no pin"}`);
    });
  }
  return { failures, cases: n, agreed, skipped: false };
}

/** One of R19's bugs: how many cases caught it, and how many by a wrong answer. */
export async function r19FaultRun(
  f: (typeof R19_FAULTS)[number],
  accel: Accel,
  jobs: number,
): Promise<{ caught: number; answers: number; first: string }> {
  const saved = { patch: process.env.TSL_TEST_PATCH, tsl: process.env.TMK_TEST_TSL };
  // checked first (SPEC 8.3): a patch that doesn't apply throws, failing the box, never caught
  const patch = f.patch !== undefined ? patchEnv(f.patch) : undefined;
  if (patch !== undefined) process.env.TSL_TEST_PATCH = patch;
  if (f.tslEnv !== undefined) process.env.TMK_TEST_TSL = f.tslEnv;
  try {
    let failures: string[];
    if (f.by === "fields") failures = (await r19Fields(accel, [1, 2])).failures;
    else {
      const P = await import("./pipe-tests.ts");
      const r = await P.dualRoute({
        modes: ["rc"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
        printed: false,
        dirs: ["corpus/lower/r19"],
        filter: (x) => relative(ROOT, x) === R19_PROGRAM,
        ...(f.emit !== undefined ? { fault: f.emit } : {}),
      });
      failures = r.failures;
    }
    faultFailures(failures, f.name);
    return {
      caught: failures.length,
      answers: wrongAnswers(failures),
      first: (firstInOrder(failures) ?? "").slice(0, 200),
    };
  } finally {
    if (saved.patch === undefined) delete process.env.TSL_TEST_PATCH;
    else process.env.TSL_TEST_PATCH = saved.patch;
    if (saved.tsl === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = saved.tsl;
  }
}

if (import.meta.main) {
  const i = process.argv.indexOf("--accel");
  const accel = (i >= 0 ? process.argv[i + 1] : "hvf") as Accel;
  const j = process.argv.indexOf("--jobs");
  const jobs = j >= 0 ? Number(process.argv[j + 1]) : 4;
  const sh = await r19Shapes();
  console.log(sh.rows.join("; "));
  for (const x of sh.failures) console.log(`FAIL ${x}`);
  const fl = await r19Fields(accel);
  console.log(
    `r19_fields: ${fl.agreed}/${fl.cases}${fl.skipped ? " (HVF unavailable: skipped, not passed)" : ""}`,
  );
  for (const x of fl.failures) console.log(`FAIL ${x}`);
  const d = await r19Dual([accel], jobs);
  console.log(`dual: ${d.agreed}/${d.cases}, printed ${d.printed.join(", ")}`);
  for (const x of d.failures.slice(0, 20)) console.log(`FAIL ${x}`);
  if (process.argv.includes("--faults"))
    for (const f of R19_FAULTS) {
      const x = await r19FaultRun(f, accel, jobs);
      console.log(`${f.name}: caught ${x.caught} (answers ${x.answers}) ${x.first}`);
    }
  process.exitCode = sh.failures.length + fl.failures.length + d.failures.length > 0 ? 1 : 0;
}
