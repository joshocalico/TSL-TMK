// pipe-b: the pipeline's phase 2, its first step (SPEC 3.5, D63, design/pipeline.md): memory modes as desugarings onto TSL,
// reference counting as a library, `@tsl/gc`, with TSL's moves made strong enough that a use after `drop` or `take` doesn't
// compile; and the gate's sampler comparing a benchmark's counts, not its times.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { caughtText, defaultEngines, faultCount, ROOT, type SuiteResult } from "../corpus.ts";
import { jobsFlag, needInstall, tmkOut, type MilestoneDef } from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

export async function definePipeB(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative, runNegative } = timedModule("corpus", await import("../corpus.ts"));
  const G = timedModule("gc", await import("../gc-tests.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = hvf.ok ? ["hvf", "tcg"] : ["tcg"];
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
  const allBoth = (s: SuiteResult & { agreement?: { skipped: boolean; cases: number }[] }) =>
    s.agreement !== undefined &&
    s.agreement.length === 2 &&
    s.agreement.every((a) => !a.skipped && a.cases > 0);

  // 1. Everything before.
  M.nested(
    "1",
    "1. Every existing suite still passes: tmk milestone pipe-a from this tree, which runs maps, lang-a, opt-a and through them everything else",
    "pipe-a",
  );

  // 2. The library, on every engine, at both levels.
  M.unit("2", async () => {
    const s0 = await withLevel("0", () => runNative("std", both, jobs, "rc_gc", engines));
    const s2 = await withLevel("2", () => runNative("std", both, jobs, "rc_gc", engines));
    report({
      box: "2. @tsl/gc's Rc on V8, JSC, HVF and TCG, at -O0 and -O2, all matching: counts, a second handle, a count moved into a field, a field's value replaced, a list freed from its head with nothing left, freeing bounded at 32 steps a make (a slot or a block each, D74), a cycle left (a leak, safe), slots reused, and a stale copy and a double drop trapping 5",
      ok: s0.ok && s2.ok && allBoth(s0) && allBoth(s2) && engines.bun !== null,
      detail: `-O0: ${s0.summary}; -O2: ${s2.summary}${skipNote}. JSC: ${engines.bun !== null ? "ran" : "MISSING"}`,
      failures: [...s0.failures, ...s2.failures],
    });
  });

  // 3. Moves: a use after drop or take is a compile error, with its exact code and position, and what moves meant stays.
  M.unit("3", async () => {
    const consumed = await runNegative(jobs, "rc_use_after_", engines);
    const copied = await runNegative(jobs, "esc_moves_", engines);
    const files = ["rc_use_after_drop.ts", "rc_use_after_take.ts"].filter(
      (f) => !existsSync(join(ROOT, "corpus/neg", f)),
    );
    report({
      box: "3. TSL's moves, strengthened: a @tsl.moves parameter of a handle type (@tsl.handle) consumes the caller's local, and reading it again before it's assigned is TSL3009 at the read: use after drop, and use after take carried round a loop, each with exact code and position; a @tsl.moves parameter of a class type still takes a direct new (TSL3006)",
      ok: consumed.ok && copied.ok && files.length === 0,
      detail: `${consumed.summary}; TSL3006 as before: ${copied.summary}`,
      failures: [...consumed.failures, ...copied.failures, ...files.map((f) => `${f} is missing`)],
    });
  });

  // 4. Bugs put into the library, each caught.
  M.unit("4", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    const accel = hvf.ok ? "hvf" : "tcg";
    for (const f of G.GC_FAULTS) {
      const r = await G.gcFaultRun(f, accel, jobs, engines);
      text.push(`${f.name}: ${caughtText(r)}`);
      if (r.broken) failures.push(`${f.name}: it didn't compile, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `4. Each of ${G.GC_FAULTS.length} bugs put into @tsl/gc is caught by its corpus, with how many cases caught it by a wrong result or trap code (R7: one that ran out of time is not counted): a share left out (the generation catches it), a drop left out (the no-leak checks), release not called, freeing not bounded, and a freed slot's generation left alone (D74's per-slot release in each)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 5. The sampler.
  M.unit("5", async () => {
    const failures: string[] = [];
    const { suiteCountDiffs } = await import("../gate.ts");
    const bench = (ns: number, ops: number) => ({
      name: 'bench.benchAlloc({"quick":true})',
      counts: {
        "rows.vec_push.ops": ops,
        "rows.vec_push.nsPerOp": ns,
        "rows.vec_push.checkCost": ns / 3,
        "jpeg.harbour.jpg.v8": ns * 2,
        "errors.length": 0,
      },
    });
    if (suiteCountDiffs([bench(3.6, 100000)], [bench(3.1, 100000)]).length !== 0)
      failures.push("a benchmark's times were compared");
    if (suiteCountDiffs([bench(3.6, 100000)], [bench(3.6, 99999)]).length !== 1)
      failures.push("a benchmark's count that differs wasn't found");
    if (
      suiteCountDiffs(
        [{ name: "x", counts: { cases: 3, nsPerOp: 1 } }],
        [{ name: "x", counts: { cases: 3, nsPerOp: 2 } }],
      ).length !== 1
    )
      failures.push("a suite that isn't a benchmark lost a figure it compared before");
    const { measuredDetail, normalizeDetail } = await import("../gate.ts");
    const { measuresByKey } = await import("../registry.ts");
    const quiet =
      "after a 1M-node drop: median 1 ticks (42 ns), p99 1 (42 ns), max 88 (3667 ns) of 200000";
    const loaded =
      "after a 1M-node drop: median 1 ticks (42 ns), p99 1 (42 ns), max 241,948 (10,081 ns) of 200000";
    if (
      !measuresByKey("native-d/9@2") ||
      !measuresByKey("native-e/7@2") ||
      !measuresByKey("native-f/12@0") ||
      !measuresByKey("opt-a/6@unset") ||
      measuresByKey("native-d/4@2")
    )
      failures.push(
        "the registry's measuring boxes aren't native-d box 9, native-e box 7, native-f box 12 and the quiet ones",
      );
    if (measuredDetail(quiet) !== measuredDetail(loaded))
      failures.push("a measuring box's figures were compared");
    if (normalizeDetail("12/12 cases") === normalizeDetail("11/12 cases"))
      failures.push("a box that doesn't measure lost a count in its detail");
    if (measuredDetail("PASS 2 of 2") === measuredDetail("FAIL 2 of 2"))
      failures.push("a measuring box's words weren't compared");
    report({
      box: "5. The gate: tmk gate --sample compares a benchmark suite's counts (lengths, operations, iterations, errors) and none of its times, which are measurements whatever they're called (the bench.benchAlloc rows it used to flag); a count that differs is still found, and other suites are compared as before. A box the registry says measures (`measures`, and every `quiet` one: opt-a's compile times, native-d box 9's latencies, and since pipe-h native-e box 7's collector latency and native-f box 12's strmap benchmark) has its detail compared with every number taken out, its verdict and counts as before",
      ok: failures.length === 0,
      detail: failures.length === 0 ? "as above" : failures.join("; "),
      failures,
    });
  });

  // 6. The spec.
  M.unit("6", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "| D63 |",
      "@tsl/gc",
      "TSL3009",
      "@tsl.handle",
      "pause-free",
      "no tracing collector",
      "tmk milestone pipe-b",
      "// file: ex-gc-rc.ts",
      "| D64 |",
      "TMK_EMIT_CLASSES",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    const stale = [
      "compiles ahead of time with no GC",
      "**No GC and no language runtime.**",
    ].filter((w) => specText.includes(w));
    report({
      box: "6. The spec says all of this (3.5's @tsl/gc and handles, TSL3009, D38, D39 and D62 brought into line with D63, D63, the 'no GC' promises reworded to pause-free and no tracing collector, 9.3, and M5's record), its // file: blocks are in sync, @tsl/gc's module among them, and it was backed up first as SPEC.md.bak-pre-pipe-b",
      ok:
        absent.length === 0 &&
        stale.length === 0 &&
        spec.ok &&
        existsSync(join(ROOT, "SPEC.md.bak-pre-pipe-b")),
      detail: `missing: ${absent.join(", ") || "nothing"}; still there: ${stale.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  // 7. Phase 2's class printing (D62's rulings), against the direct route and V8.
  M.unit("7", async () => {
    const P = await import("../pipe-tests.ts");
    const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
    const r = await P.dualRoute({
      modes: ["leak", "manual"],
      levels: [0, 2],
      accels: [accel],
      jobs,
      classes: true,
      v8: (f) => f.includes("class_tsl"),
    });
    const handled = r.programs.filter((p) => p.handled);
    const files = new Set(handled.map((p) => p.file));
    const total = new Set(
      r.programs
        .filter((p) => p.why !== "doesn't compile" && p.why !== "the direct route has a fallback")
        .map((p) => `${p.file} ${p.mode}`),
    );
    const took = new Set(handled.map((p) => `${p.file} ${p.mode}`));
    const cases = r.rows.reduce((n, x) => n + x.cases, 0);
    const agreed = r.rows.reduce((n, x) => n + x.agreed, 0);
    // R9: cases one route ran out of memory in, where the other didn't, after both had (AFTER_EXHAUSTION, with why)
    const allowed = r.rows.reduce((n, x) => n + (x.allowed ?? 0), 0);
    const failed = r.programs.filter((p) => p.why?.startsWith("FAILED") === true);
    report({
      box: "7. Objects printed as TSL's own classes (phase 2's first printing, opt-in with --route tsl and TMK_EMIT_CLASSES=1): a hierarchy one class with a cid field and switch dispatch, instanceof an id test, methods members called on their receiver, constructors init, module state TSL globals, references typed by class with | null where the lowering says so and ! only where tsc can't see the TS's narrowing, and new placed by tslc's escape analysis in the package's mode. Every program it takes, in leak and manual at -O0 and -O2, agrees with the direct route on every case, corpus/lower/exc included, and corpus/lower/pipe/class_tsl.ts with V8 too; anything it can't print yet is said, never wrong",
      ok:
        r.failures.length === 0 &&
        failed.length === 0 &&
        files.has("corpus/lower/pipe/class_tsl.ts") &&
        cases > 0 &&
        cases === agreed + allowed &&
        !r.hvfSkipped,
      detail: `${took.size} of ${total.size} program builds by mode taken (${files.size} programs); ${handled.length} builds, ${cases} cases, ${agreed} the same through both routes on ${accel}${allowed > 0 ? `, ${allowed} out of memory in one route after both ran out (AFTER_EXHAUSTION): ${[...new Set(r.allowed.map((x) => x.split(":")[0]))].join(", ")}` : ""}${skipNote}`,
      failures: [...r.failures, ...failed.map((p) => `${p.file} ${p.mode} -O${p.level}: ${p.why}`)],
    });
  });

  // 8. Bugs put into class printing, each caught.
  M.unit("8", async () => {
    const P = await import("../pipe-tests.ts");
    const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
    const failures: string[] = [];
    const rows: string[] = [];
    for (const f of P.CLASS_FAULTS) {
      const r = await P.dualRoute({
        modes: ["leak"],
        levels: [2],
        accels: [accel],
        jobs,
        classes: true,
        fault: f.name,
        filter: (x) => x.includes("class_tsl"),
      });
      rows.push(
        `${f.what}: ${r.failures.length > 0 ? "caught" : "MISSED"} (${faultCount(r.failures)})`,
      );
      if (r.failures.length === 0) failures.push(`missed: ${f.what}`);
    }
    report({
      box: `8. Each of ${P.CLASS_FAULTS.length} bugs put into class printing is caught by the dual route on corpus/lower/pipe/class_tsl.ts at -O2: the wrong class-id arm of a dispatch, a read of the wrong field, and (pipe-h) a local set to this and then moved on printed as this throughout`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${rows.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 9. The speed rule, measured: nothing switches over on this, it's what says whether it can.
  M.unit("9", async () => {
    const { benchMemory } = await import("../bench-memory.ts");
    const b = await benchMemory({ quick: false, classes: true });
    const ratios = b.rows.filter((r) => r.name.includes("against direct"));
    report({
      box: "9. The speed rule, measured (no gate on a time; what made class printing the default in leak and manual, once TSL proper's classes were made as cheap, D64, and arrays as JsArray too, once a byte fill was one memset and growth zeroed only what it didn't copy, D66): tmk bench memory --classes, leak's list and churn, manual's list, and the arrays program in both, native at this level, straight to TIR and through TSL classes, each against the source on V8",
      ok: b.errors.length === 0 && (b.skipped !== null || ratios.length === 5),
      detail:
        b.skipped ??
        `${ratios.map((r) => `${r.name.replace(": TSL classes against direct", "")} ${r.ratio!.toFixed(2)}x direct`).join("; ")}; load ${b.host.loadStart.map((x) => x.toFixed(1)).join(" ")}`,
      failures: b.errors,
    });
  });

  // 11. TSL proper's classes, made as cheap as lowered objects (D64): what the TIR shows.
  M.unit("11", async () => {
    const failures: string[] = [];
    const { lowerFile } = await import("../../compiler/host/tslc.ts");
    const { printModule } = await import("../../compiler/tir/text.ts");
    const file = join(ROOT, "bench/memory/list_lowered.ts");
    const fnText = (o: ReturnType<typeof lowerFile>): string => {
      const text = printModule(o.tir!);
      const at = text.indexOf("func @listWork");
      return at < 0 ? "" : text.slice(at, text.indexOf("\n}", at));
    };
    const on = fnText(lowerFile(file, { memory: "leak", opt: 2, route: "tsl", classes: true }));
    const was = process.env.TMK_TSL_OPT_OFF;
    process.env.TMK_TSL_OPT_OFF = "prefix,init,mask";
    let off = "";
    try {
      off = fnText(lowerFile(file, { memory: "leak", opt: 2, route: "tsl", classes: true }));
    } finally {
      if (was === undefined) delete process.env.TMK_TSL_OPT_OFF;
      else process.env.TMK_TSL_OPT_OFF = was;
    }
    const masks = (t: string): number => (t.match(/ref\.addr/g) ?? []).length;
    const size = (t: string): string => /iconst\.ix (\d+)\n[^\n]*@__leak_cur/.exec(t)?.[1] ?? "?";
    if (on === "" || off === "") failures.push("listWork wasn't in the module");
    if (size(on) !== "16") failures.push(`a leak list node is ${size(on)} bytes, not 16`);
    if (masks(on) !== 0) failures.push(`${masks(on)} masks left in listWork`);
    if (masks(off) === 0)
      failures.push(
        "with the speed-ups off there are no masks to remove: the check checks nothing",
      );
    report({
      box: "11. TSL proper's classes as cheap as lowered objects (D64), in the class route's TIR for bench/memory/list_lowered.ts at -O2: a class nothing of which can go stale has no prefix in leak (a 16-byte node, as lowered) and plain references, with no mask in the walk; with the three speed-ups off (TMK_TSL_OPT_OFF=prefix,init,mask) it's what it was",
      ok: failures.length === 0,
      detail: `on: node ${size(on)} bytes, ${masks(on)} masks; off: node ${size(off)} bytes, ${masks(off)} masks`,
      failures,
    });
  });

  M.vms(
    "10",
    "10. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
