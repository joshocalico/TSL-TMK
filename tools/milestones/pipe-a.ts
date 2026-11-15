// pipe-a: the pipeline's phase 1, ordinary TS -> TSL -> TIR (SPEC 4.1, 4.5, D62, design/pipeline.md), with the dual-route
// differential and the falsy `unknown` fix that came first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT, type SuiteResult } from "../corpus.ts";
import { EMIT_FAULTS, PIPE_DIRS, coverageOf, dualRoute, type PipeProgram } from "../pipe-tests.ts";
import { guardedRun, jobsFlag, needInstall, tmkOut, type MilestoneDef } from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

/** Why the TSL route doesn't take a program yet, in phase 1: each is a feature the order in design/pipeline.md moves later. */
const NOT_YET = [
  /the runtime function __rc_|a counted environment|the rc mode/, // `rc`
  /a closure|the expression callclo|the expression closure|the expression fnref/, // closure values
  /an empty nullish as a value/, // `undefined` passed where a parameter has no leaves: with closures' calling conventions
];

export async function definePipeA(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative } = timedModule("corpus", await import("../corpus.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
  const withLevel = async <X>(level: string, run: () => Promise<X>): Promise<X> => {
    const was = process.env.TMK_OPT;
    process.env.TMK_OPT = level;
    try {
      return await run();
    } finally {
      if (was === undefined) delete process.env.TMK_OPT;
      else process.env.TMK_OPT = was;
    }
  };
  const suites = (...ss: SuiteResult[]): { ok: boolean; detail: string; failures: string[] } => ({
    ok: ss.every((s) => s.ok),
    detail: ss.map((s) => `${s.name}: ${s.summary}`).join("; "),
    failures: ss.flatMap((s) => s.failures),
  });
  const notYet = (p: PipeProgram): boolean =>
    p.why !== undefined &&
    p.why.startsWith("not printable yet") &&
    NOT_YET.some((r) => r.test(p.why!));

  // 1. Everything before, from this tree, with the TSL route the default where it applies.
  M.nested(
    "1",
    "1. Every existing suite still passes: tmk milestone maps from this tree, which runs lang-a, opt-a and through it everything else, now with tmk lower taking the TSL route by default wherever the printer can print the program",
    "maps",
  );

  // 2. --emit tsl: every program the direct route lowers in strict, and in leak and manual everything without what's not yet.
  M.unit("2", async () => {
    const failures: string[] = [];
    const r = await dualRoute({
      modes: ["strict", "leak", "manual"],
      levels: [2],
      accels: [],
      jobs,
    });
    for (const p of r.programs) {
      if (p.why?.startsWith("FAILED") === true) failures.push(`${p.file} ${p.mode}: ${p.why}`);
      else if (p.why?.startsWith("not printable yet") === true && !notYet(p))
        failures.push(`${p.file} ${p.mode}: ${p.why}`);
      else if (p.mode === "strict" && p.why?.startsWith("not printable yet") === true)
        failures.push(
          `${p.file} strict: the direct route lowers it and the TSL route doesn't: ${p.why}`,
        );
    }
    const handled = r.programs.filter((p) => p.handled);
    const cov = coverageOf(r.programs);
    mkdirSync(buildPath("pipe"), { recursive: true });
    writeFileSync(join(buildPath("pipe"), "coverage.json"), `${JSON.stringify(cov, null, 1)}\n`);
    const lines = Object.entries(cov).map(
      ([d, m]) =>
        `${d.replace("corpus/", "")}: ${Object.entries(m)
          .map(([k, v]) => `${k} ${v.split(" of")[0]}`)
          .join(", ")}`,
    );
    report({
      box: "2. tmk lower --emit tsl: a TSL program tslc compiles, for every program the direct route lowers in strict, and in leak and manual for every one with no closure values (strings, Map, Set, exceptions and inheritance included); anything left out is a closure value or rc, by name, and tslc rejects nothing it's given",
      ok: failures.length === 0 && handled.length > 0,
      detail: `${handled.length} program builds through TSL at -O2; ${lines.join("; ")}`,
      failures,
    });
  });

  // 3. The dual-route differential, natively: HVF at -O0 and -O2 in every mode it supports, TCG at -O2.
  M.unit("3", async () => {
    const r = await dualRoute({
      modes: ["strict", "leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      v8: (f) => f.startsWith("corpus/lower/pipe/"),
    });
    const t = hvf.ok
      ? await dualRoute({
          modes: ["strict", "leak"],
          levels: [2],
          accels: ["tcg"],
          jobs,
          // TCG is the slow emulator: the lowering rules' corpus and this phase's own programs, as the other milestones do.
          dirs: ["corpus/lower/pos", "corpus/native", "corpus/lower/pipe"],
        })
      : null;
    const all = [...r.rows, ...(t?.rows ?? [])];
    const cases = all.reduce((n, x) => n + x.cases, 0);
    const agreed = all.reduce((n, x) => n + x.agreed, 0);
    const failures = [...r.failures, ...(t?.failures ?? [])];
    report({
      box: "3. The dual-route differential: every program the TSL route takes, compiled straight to TIR and through TSL and tslc, both images run natively on the same cases, with the same result, arguments after and trap code on every case: strict, leak and manual at -O0 and -O2 on HVF, and the lowering rules' corpus and this phase's programs in strict and leak at -O2 on TCG; the programs this phase adds (corpus/lower/pipe: class dispatch, statement-expressions in every position) against V8 as well",
      ok: failures.length === 0 && cases > 0 && agreed === cases && hvf.ok,
      detail: `${agreed}/${cases} cases in ${all.length} program builds (${r.rows.length} on ${accel}, ${t?.rows.length ?? 0} on TCG)${skipNote}`,
      failures,
    });
  });

  // 4. The same TIR: identical TIR is identical machine code, which is what the switch-over's speed rests on.
  M.unit("4", async () => {
    const failures: string[] = [];
    const r = await dualRoute({
      modes: ["strict", "leak", "manual"],
      levels: [0, 2],
      accels: [],
      jobs,
    });
    const handled = r.programs.filter((p) => p.handled);
    const o2 = handled.filter((p) => p.level === 2);
    const o0 = handled.filter((p) => p.level === 0);
    // What the printer printed exactly gives the same TIR at both levels: that's what `auto` switches over. Where it had to
    // reshape a loop or a branch, or move an operand past a statement-expression, the TIR can differ, and the reference
    // compiles it by default until that's shown not to matter (the differential runs it either way).
    const exact = handled.filter((p) => (p.restructured ?? 0) === 0);
    for (const p of exact)
      if (p.sameTir !== true)
        failures.push(`${p.file} ${p.mode} -O${p.level}: printed exactly, and the TIR differs`);
    // The JPEG decoder, the benchmark this phase moves.
    const { lowerFile } = await import("../lowering.ts");
    const jpeg = join(ROOT, "bench/jpeg/vendor/jpeg.ts");
    for (const opt of [0, 2] as const) {
      const a = lowerFile(jpeg, { opt, route: "direct" });
      const b = lowerFile(jpeg, { opt, route: "tsl" });
      if (a.tirHash !== b.tirHash) failures.push(`the JPEG decoder at -O${opt}: the TIR differs`);
    }
    report({
      box: "4. The same TIR through both routes for everything the printer printed exactly, at -O0 and -O2, which is what tmk lower now takes through TSL by default: identical TIR is identical machine code and speed; the JPEG decoder among them at both levels. Where the printer reshaped a loop or branch, or moved an operand, the TIR may differ, and those stay on the direct route by default",
      ok: failures.length === 0 && exact.length > 0,
      detail: `exactly printed: ${exact.filter((p) => p.sameTir).length} of ${exact.length} identical (-O2 ${exact.filter((p) => p.level === 2).length}, -O0 ${exact.filter((p) => p.level === 0).length}); reshaped: ${handled.length - exact.length}, of which identical anyway at -O2 ${o2.filter((p) => (p.restructured ?? 0) > 0 && p.sameTir).length} of ${o2.filter((p) => (p.restructured ?? 0) > 0).length}, at -O0 ${o0.filter((p) => (p.restructured ?? 0) > 0 && p.sameTir).length} of ${o0.filter((p) => (p.restructured ?? 0) > 0).length}; the JPEG decoder identical at -O0 and -O2`,
      failures,
    });
  });

  // 5. Injected bugs in the printer, each caught by the dual route.
  M.unit("5", async () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of EMIT_FAULTS) {
      const r = await dualRoute({
        modes: ["strict", "leak"],
        levels: [2],
        accels: [accel],
        jobs,
        fault: f.name,
      });
      const n = r.failures.length;
      rows.push(`${f.what}: ${n > 0 ? "caught" : "MISSED"} (${n})`);
      if (n === 0) failures.push(`missed: ${f.what}`);
      // The class-id dispatch in particular: a wrong arm there is a wrong method.
      if (f.name === "switch-arm" && !r.failures.some((x) => x.includes("class_dispatch.ts")))
        failures.push("missed: the wrong class-id arm in corpus/lower/pipe/class_dispatch.ts");
    }
    report({
      box: "5. Injected bugs in the printer, each caught by the dual route on HVF at -O2: the wrong arm of a switch (in class_dispatch.ts, the wrong class-id arm of a dispatch), a statement-expression's statements run after the part of the expression before them, a load from the wrong field, and JS's wrapping arithmetic printed as checked. A finally in the wrong order, a closure's shared capture slot and a versioned loop losing its state belong to features still desugared before the printer (D49 in down-exc.ts, closures in down.ts) or not built (loop versioning), so a bug there is in both routes and isn't the differential's to see: each comes with its feature's move (design/pipeline.md, section 9)",
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 6. The falsy unknown, fixed first.
  M.unit("6", async () => {
    const rows: SuiteResult[] = [];
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        for (const memory of ["rc", "leak", "manual"] as const)
          rows.push(await runNative("exc", [accel], jobs, "dyn_truthy", engines, memory));
      });
    const s = suites(...rows);
    const r = await dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      filter: (f) => f.endsWith("dyn_truthy_param.ts"),
    });
    const failures = [...s.failures, ...r.failures];
    if (r.rows.length === 0) failures.push("dyn_truthy_param.ts didn't take the TSL route");
    report({
      box: '6. if (e) on an unknown is JS\'s ToBoolean: a boxed false, 0, -0, NaN and "" are falsy, null and undefined too, and every other value truthy, through if, !, &&, ||, ?:, Boolean() and a loop, against V8 in rc, leak and manual at -O0 and -O2 (corpus/lower/exc/dyn_truthy*.ts, with and without run-time strings), and the program with no strings through both routes',
      ok: failures.length === 0 && s.ok && hvf.ok,
      detail: `${s.detail}; through both routes: ${r.rows.reduce((n, x) => n + x.agreed, 0)}/${r.rows.reduce((n, x) => n + x.cases, 0)}${skipNote}`,
      failures,
    });
  });

  // 7. Pins: the default route's switch moves none; the TSL route's own pinned.
  M.unit("7", async () => {
    const failures: string[] = [];
    const pins: { file: string; tool: string }[] = [
      { file: "corpus/memory/pre-std-tirhash.json", tool: "tools/pre-std-hashes.ts" },
      { file: "corpus/memory/strict-tirhash.json", tool: "tools/strict-hashes.ts" },
      { file: "corpus/memory/modes-tirhash.json", tool: "tools/mode-hashes.ts" },
      { file: "corpus/memory/rc-off-tirhash.json", tool: "tools/rc-off-hashes.ts" },
      { file: "corpus/memory/pre-strings-tirhash.json", tool: "tools/pre-strings-hashes.ts" },
    ];
    let same = 0;
    let total = 0;
    const { mapsMoved } = await import("../maps-pins.ts");
    for (const p of pins) {
      const h = await guardedRun(process.execPath, ["--no-warnings", join(ROOT, p.tool)], {
        timeoutMs: 900_000,
        label: p.tool,
        cwd: ROOT,
      });
      if (!h.ok) {
        failures.push(`${p.tool}: ${h.why}`);
        continue;
      }
      const got = JSON.parse(h.stdout) as Record<string, string>;
      const pin = JSON.parse(readFileSync(join(ROOT, p.file), "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        total++;
        if (got[k] === v) same++;
        // The maps step's moves are listed and checked by tmk milestone maps; nothing here may add one.
        else if (!mapsMoved(k)) failures.push(`${p.file}: ${k} moved`);
      }
    }
    // The maps and exceptions corpora at -O0 and -O2, as tmk milestone maps pinned them.
    const { lowerFile } = await import("../lowering.ts");
    const mp = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/maps-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    for (const [k, v] of Object.entries(mp)) {
      const [f, mem, o] = k.split("@");
      total++;
      const h = lowerFile(join(ROOT, f!), {
        memory: mem!,
        opt: Number(o!.slice(1)) as 0 | 2,
      }).tirHash;
      if (h === v) same++;
      else failures.push(`corpus/memory/maps-tirhash.json: ${k} moved`);
    }
    // The TSL route's own: every program build it takes, at -O0 and -O2, by its TIR.
    const pinFile = join(ROOT, "corpus/memory/pipe-tirhash.json");
    const r = await dualRoute({
      modes: ["strict", "leak", "manual"],
      levels: [0, 2],
      accels: [],
      jobs,
    });
    const now: Record<string, string> = {};
    for (const p of r.programs.filter((x) => x.handled)) {
      const o = lowerFile(join(ROOT, p.file), { memory: p.mode, opt: p.level, route: "tsl" });
      now[`${p.file}@${p.mode}@O${p.level}`] = o.tirHash;
    }
    if (!existsSync(pinFile)) writeFileSync(pinFile, `${JSON.stringify(now, null, 2)}\n`);
    const pp = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string>;
    const moved = Object.keys(pp).filter((k) => pp[k] !== now[k]);
    failures.push(...moved.map((k) => `${k}: moved from corpus/memory/pipe-tirhash.json`));
    report({
      box: "7. Pins: every tirhash pinned before is byte-identical with the TSL route the default (strict's, the memory modes', pre-std, rc off, pre-strings, and the maps and exceptions corpora at -O0 and -O2), so the switch-over moved none, and the falsy fix moved none either; the TSL route's own builds pinned at -O0 and -O2 in corpus/memory/pipe-tirhash.json",
      ok: failures.length === 0 && total > 0,
      detail: `${same} of ${total} the same; ${Object.keys(pp).length} TSL-route pins, ${moved.length} moved`,
      failures,
    });
  });

  // 8. Compile time through the new route, and what the printed TSL is made of.
  M.unit("8", async () => {
    const r = await dualRoute({ modes: ["strict", "leak"], levels: [2], accels: [], jobs: 1 });
    const h = r.programs.filter((p) => p.handled && p.ms !== undefined);
    const direct = h.reduce((n, p) => n + p.ms!.direct, 0);
    const tsl = h.reduce((n, p) => n + p.ms!.tsl, 0);
    const lines = h.reduce((n, p) => n + (p.tslLines ?? 0), 0);
    const intr = h.reduce((n, p) => n + (p.intrinsics ?? 0), 0);
    const mem = h.reduce((n, p) => n + (p.memoryOps ?? 0), 0);
    report({
      box: "8. Measured: compile time straight to TIR and through TSL, in one process, strict and leak at -O2, and how much of the printed TSL is @tsl/lowered's (the memory operations being what lowered classes are to replace). No gate on a time",
      ok: h.length > 0,
      detail: `${h.length} builds: ${(direct / 1000).toFixed(1)} s straight to TIR, ${(tsl / 1000).toFixed(1)} s through TSL (${(tsl / Math.max(1, direct)).toFixed(2)}x); ${lines} lines of TSL, ${intr} calls into @tsl/lowered, ${mem} of them memory operations`,
      failures: [],
    });
  });

  // 9. The spec.
  M.unit("9", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "D62",
      "emits TSL, which tslc compiles",
      "tmk milestone pipe-a",
      "TSL1023",
      "@tsl/lowered",
      "--emit tsl",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    const design = existsSync(join(ROOT, "design/pipeline.md"));
    report({
      box: "9. The spec says all of this (4.1, 4.5, D8 rewritten to say down-lowering emits TSL, D62, TSL1023, 9.2, 9.3, and M5's pipeline record), its // file: blocks are in sync, it was backed up first as SPEC.md.bak-pre-pipe-a, and design/pipeline.md is the design",
      ok:
        absent.length === 0 &&
        spec.ok &&
        design &&
        existsSync(join(ROOT, "SPEC.md.bak-pre-pipe-a")) &&
        !specText.includes("Down-lowering stays on the host, emits TIR"),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.vms(
    "10",
    "10. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
  void PIPE_DIRS;
}
