// native-d: the `rc` memory mode (SPEC 3.5, 4.5, D39).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT } from "../corpus.ts";
import {
  args,
  guardedRun,
  jobsFlag,
  langAMoved,
  needInstall,
  USE_STRMAP,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";
import { seedSlice } from "../sweep.ts";

export async function defineNativeD(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const quick = args.includes("--quick");
  const { runNative, runNegative, runLower } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile, checkFile } = timedModule("tslc", await import("../lowering.ts"));
  const rcTests = timedModule("rc", await import("../rc-tests.ts"));
  const { fuzz } = timedModule("rcfuzz", await import("../rc-fuzz.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const needBoth = (s: { agreement: { skipped: boolean }[] }): boolean =>
    s.agreement.every((a) => !a.skipped);
  const both: ("hvf" | "tcg")[] = ["hvf", "tcg"];
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const tmkRun = async (...a: string[]): Promise<Awaited<ReturnType<typeof guardedRun>>> =>
    guardedRun(process.execPath, ["--no-warnings", tmk, ...a], {
      timeoutMs: 120_000,
      label: `tmk ${a.join(" ")}`,
      cwd: ROOT,
    });

  M.unit("1", async () => {
    // 1. The setting, and every new rule's exact code and position.
    const neg = await runNegative(jobs, undefined, engines);
    const failures1: string[] = [...neg.failures];
    const flag = await tmkRun(
      "lower",
      "corpus/lower/memory/store_closure.ts",
      "--memory",
      "rc",
      "--no-fallback",
      "--target",
      "aarch64",
      "--out",
      buildPath("lower/store_closure-rc"),
    );
    if (!flag.ok) failures1.push(`tmk lower --memory rc: ${flag.stdout.slice(0, 300)}`);
    const fromPackage = lowerFile(join(ROOT, "corpus/rc-package/rc_pkg.ts"));
    if (fromPackage.meta?.memory !== "rc" || fromPackage.diags.length > 0)
      failures1.push(`a package with "memory": "rc" lowers as ${String(fromPackage.meta?.memory)}`);
    // tslc takes an rc package since D74, expanding it onto @tsl/gc: this one is ordinary TS for tmk lower, so tslc
    // reports what TSL proper rejects in it, where it's written, and nothing about the mode
    const tslPkg = checkFile(join(ROOT, "corpus/rc-package/rc_pkg.ts")).diags;
    const t25 = tslPkg[0];
    if (
      tslPkg.some((d) => d.code === "TSL9001") ||
      t25 === undefined ||
      t25.code !== "TSL2005" ||
      t25.line !== 3 ||
      t25.col !== 25
    )
      failures1.push(`tslc on an rc package: ${JSON.stringify(tslPkg).slice(0, 300)}`);
    const exact = (
      file: string,
      memory: string | undefined,
      code: string,
      fn: string,
      line: number,
      col: number,
    ): void => {
      const o = lowerFile(join(ROOT, file), memory !== undefined ? { memory } : {});
      const d = o.fallbackDiags.find((x) => x.code === code && x.fn === fn);
      if (d === undefined || d.line !== line || d.col !== col) {
        failures1.push(
          `${file}: expected ${code} on ${fn} at ${line}:${col}, got ${JSON.stringify(o.fallbackDiags).slice(0, 300)}`,
        );
      }
    };
    exact("corpus/lower/fallback/weakref_mode.ts", undefined, "TSLD0228", "weakInStrict", 8, 9);
    exact("corpus/lower/fallback/weakref_mode.ts", "leak", "TSLD0228", "weakInStrict", 8, 9);
    exact("corpus/lower/fallback/weakref_mode.ts", "manual", "TSLD0228", "weakInStrict", 8, 9);
    exact("corpus/lower/fallback/finalization.ts", "rc", "TSLD0229", "finalizes", 4, 9);
    exact("corpus/lower/rc-neg/weak_typed_array.ts", "rc", "TSLD0228", "weakBytes", 4, 9);
    const bad = lowerFile(join(ROOT, "corpus/lower/memory/store_closure.ts"), {
      memory: "gc",
    }).diags;
    if (bad[0]?.code !== "TSL1019") failures1.push(`--memory gc: ${JSON.stringify(bad)}`);
    const cyc =
      lowerFile(join(ROOT, "corpus/lower/memory/cycles.ts"), { memory: "rc" }).cycles ?? [];
    const peer = cyc.find((c) => c.classes.includes("Peer"));
    if (
      peer === undefined ||
      !peer.sites.includes("corpus/lower/memory/cycles.ts:12:13 (object)") ||
      !peer.sites.includes("corpus/lower/memory/cycles.ts:13:13 (object)")
    ) {
      failures1.push(`cycle report for cycles.ts: ${JSON.stringify(cyc).slice(0, 400)}`);
    }
    const closureCycle = (
      lowerFile(join(ROOT, "corpus/lower/memory/closures_returned.ts"), { memory: "rc" }).cycles ??
      []
    ).some((c) => c.classes.includes("Box"));
    if (!closureCycle) failures1.push("a class holding a closure over itself should be reported");
    const acyclic = lowerFile(join(ROOT, "corpus/rc-package/rc_pkg.ts")).cycles ?? [{}];
    if (acyclic.length !== 0) failures1.push(`rc_pkg.ts has no cycles: ${JSON.stringify(acyclic)}`);
    const reportText = await tmkRun(
      "lower",
      "corpus/lower/memory/cycles.ts",
      "--memory",
      "rc",
      "--report",
    );
    if (!reportText.stdout.includes("cycles: 2 groups") || !reportText.stdout.includes("Peer"))
      failures1.push(`--report doesn't show cycles: ${reportText.stdout.slice(-400)}`);
    const quiet = await tmkRun("lower", "corpus/rc-package/rc_pkg.ts", "--report");
    if (!quiet.stdout.includes("cycles: no class here can form one"))
      failures1.push(`--report on an acyclic program: ${quiet.stdout.slice(-300)}`);
    report({
      box: '1. "memory": "rc" in tsl.json and tmk lower --memory rc, for lowered ordinary TS. TSL proper gets TSL9001 at the value. Negative and report tests with exact codes and positions: TSLD0228, TSLD0229, TSL1019, and the cycle report for a cyclic and an acyclic type graph',
      ok: failures1.length === 0,
      detail: `${neg.summary}; report on cycles.ts: ${cyc.map((c) => c.classes.join("+")).join(", ")}`,
      failures: failures1,
    });
  });

  // Boxes 6 and 7 read what 2 and 5 ran, and 7 what 6 did.
  M.unit("2,5-7", async () => {
    // 2. Everything leak runs, in rc, with the same results.
    const rcAll = await runNative("lower", both, jobs, undefined, engines, "rc");
    const leakAll = await runNative("lower", both, jobs, undefined, engines, "leak");
    const inRc = new Set(rcAll.skippedPrograms);
    const leakRan = (a: typeof leakAll): number => a.agreement[0]?.programs ?? 0;
    const failures2 = [...rcAll.failures, ...leakAll.failures];
    for (const f of inRc) {
      if (!leakAll.skippedPrograms.includes(f)) failures2.push(`${f} runs in leak and not in rc`);
    }
    report({
      box: "2. Everything leak runs today from corpus/lower and corpus/native also runs in rc, with the same results: each against V8, under QEMU on HVF and TCG",
      ok: rcAll.ok && leakAll.ok && needBoth(rcAll) && needBoth(leakAll) && failures2.length === 0,
      detail: `rc: ${rcAll.summary.split(";")[0]}. leak: ${leakAll.summary.split(";")[0]}. rc runs ${rcAll.agreement[0]?.programs ?? 0} programs and leak ${leakRan(leakAll)}: rc's extras are corpus/lower/rc and the WeakRef program${skipNote}`,
      failures: failures2,
    });

    // 5. Use-after-free detection.
    const poison = await runNative("lower", both, jobs, undefined, engines, "rc", {
      rc: { check: true },
      harness: { collect: true },
      suffix: "-poison",
    });
    const fault = await rcTests.faultInjection("hvf", jobs);
    M.keep("fault", fault);
    report({
      box: "5. A test-only build of the runtime poisons freed blocks and traps with code 16 on an access to a poisoned or zero-count object. The whole rc corpus passes under it on HVF and TCG, and leaving out an increment at the TIR level makes it fire",
      ok:
        poison.ok &&
        needBoth(poison) &&
        fault.trapped16 > 0 &&
        fault.trapped16 >= fault.silent &&
        fault.decLeaked > 0 &&
        !fault.skipped,
      detail: `${poison.summary.split(";")[0]}. Faults injected in the adversarial programs: ${fault.injected} increments left out, one at a time: ${fault.trapped16} trapped with code 16, ${fault.otherFailures} gave a wrong answer or a fatal exception, ${fault.silent} went unnoticed (${fault.silentNeverRan} of them at a site those cases never reach). ${fault.decTried} decrements left out: ${fault.decLeaked} showed as a leak`,
      failures: poison.failures,
    });

    // 6. The classic failures, by name.
    const adversarial: [string, string][] = [
      ["a callee clears the only other holder of its own argument", "adv_callee_clears_arg"],
      ["self-assignment and swaps", "adv_self_assign_swap"],
      [
        "a stored closure clears or replaces its own holder during its own call",
        "adv_closure_clears_holder",
      ],
      ["a method whose this loses its last holder during the call", "adv_method_this"],
      ["for...of with its elements or holder replaced, and an array growing", "adv_forof_mutation"],
      [
        "a returned field of an object that dies on return, and chained calls on temporaries",
        "adv_temporaries",
      ],
      ["a mutated capture shared by closures, one of which is dropped", "adv_shared_capture"],
      [
        "short-circuit, conditional, early-return, break and continue paths holding a reference",
        "adv_control_paths",
      ],
      [
        "pop, shift, splice, length = 0 and overwriting elements, which must release",
        "adv_array_release",
      ],
      [
        "a million-node list and a very large array of references dropped, under a 64 KiB stack",
        "adv_large_drop",
      ],
      [
        "accessors, recursive closures, destructuring, spreads, unions, views on temporaries, labelled loops, module state",
        "adv_misc",
      ],
    ];
    const failures6: string[] = [];
    const lines6: string[] = [];
    for (const [what, name] of adversarial) {
      const file = join(ROOT, `corpus/lower/rc/${name}.ts`);
      const n = (
        JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as unknown[]
      ).length;
      const bad6 = [...rcAll.failures, ...poison.failures].filter((f) => f.includes(`${name}.ts`));
      failures6.push(...bad6);
      lines6.push(`${bad6.length === 0 ? "ok" : "FAILED"}: ${what} (${n} cases)`);
    }
    const only = await rcTests.rcOnly("hvf", jobs);
    const onlyTcg = quick ? null : await rcTests.rcOnly("tcg", jobs);
    failures6.push(...only.failures, ...(onlyTcg?.failures ?? []));
    report({
      box: "6. Adversarial programs for borrow elision and ordering, each named, against V8 under the release and poisoning builds on HVF and TCG, and rc-only pins of what's released when, and of draining before exhaustion",
      ok: failures6.length === 0 && only.cases > 0 && poison.ok,
      detail: `${lines6.join("; ")}. rc-only: ${only.cases} checks on HVF${onlyTcg !== null ? `, ${onlyTcg.cases} on TCG` : ""}, ${only.drains} full drains on the way to exhaustion`,
      failures: failures6,
    });

    // 7. WeakRef.
    const weak = await runNative("lower", both, jobs, "weak_held", engines, "rc");
    const finalization = lowerFile(join(ROOT, "corpus/lower/fallback/finalization.ts"), {
      memory: "rc",
    });
    report({
      box: "7. WeakRef: deref gives undefined once its target's count hits zero, including while it's queued, and never resurrects it: rc-only pins. Against V8 only where the target is strongly held (3.10, item 9). FinalizationRegistry is a fallback with its root cause",
      ok:
        weak.ok &&
        needBoth(weak) &&
        finalization.fallbackDiags.some((d) => d.blocker === "finalization") &&
        only.failures.filter((f) => f.includes("weak_")).length === 0,
      detail: `${weak.summary}; corpus/lower/rc-only/weak_cleared.ts passes in the box above`,
      failures: weak.failures,
    });
  });

  M.unit("3", async () => {
    // 3. What rc is for.
    const churnLeak = await runNative("lower", both, jobs, "churn", engines, "leak");
    const churnRc = await runNative("lower", both, jobs, "churn", engines, "rc");
    const churnCases = JSON.parse(
      readFileSync(join(ROOT, "corpus/lower/memory/churn.cases.json"), "utf8"),
    ) as { fn: string; memory_trap?: { leak?: number; rc?: number } }[];
    const allTrapInLeak = churnCases.every(
      (c) => c.memory_trap?.leak === 14 && c.memory_trap.rc === undefined,
    );
    const kinds = ["objects", "arrays", "closures", "arraysGrowing"].filter(
      (k) => !churnCases.some((c) => c.fn === k),
    );
    report({
      box: "3. Churn: objects, arrays, closures, arrays growing, typed arrays and a queue, far more in total than the page limit with a small live set. Each traps 14 under leak and completes under rc, with the same limit",
      ok:
        churnLeak.ok &&
        churnRc.ok &&
        needBoth(churnRc) &&
        needBoth(churnLeak) &&
        allTrapInLeak &&
        kinds.length === 0,
      detail: `${churnCases.length} kinds, 96 pages (393,216 bytes); leak: ${churnLeak.summary}; rc: ${churnRc.summary}`,
      failures: [...churnLeak.failures, ...churnRc.failures],
    });
  });

  M.unit("4", async () => {
    // 4. No leak.
    const leakHvf = await rcTests.leakTest("hvf", jobs);
    const leakTcg = quick ? null : await rcTests.leakTest("tcg", jobs);
    const leftOut = leakHvf.rows.filter((r) => r.skipped !== undefined);
    report({
      box: "4. No leak: each program's cases, repeated 4 times, with results and arguments released. Live object and byte counts don't grow across repeats. A test-only accounting hook, not in release code paths",
      ok:
        leakHvf.failures.length === 0 &&
        (leakTcg?.failures.length ?? 0) === 0 &&
        !leakHvf.skippedAccel &&
        leakHvf.rows.length > 0,
      detail: `${leakHvf.rows.length - leftOut.length}/${leakHvf.rows.length} programs on HVF${leakTcg !== null ? ` and on TCG` : ""}. Left out, each for what its source says: ${leftOut.map((r) => `${r.program} (${r.skipped})`).join("; ")}`,
      failures: [...leakHvf.failures, ...(leakTcg?.failures ?? [])],
    });
  });

  M.unit("8", async () => {
    // 8. The bound, as steps, and latency, as numbers.
    const boundHvf = await rcTests.boundTest("hvf");
    const boundTcg = await rcTests.boundTest("tcg");
    M.keep("bound", { boundHvf, boundTcg });
    const boundOk = (b: typeof boundHvf): boolean =>
      b.ok && b.maxSteps <= b.budget && b.maxSteps > 0 && b.fullDrains === 0 && b.steps > 1000000;
    report({
      box: `8. The freeing bound is per allocation in steps, deterministically: dropping a million-node list and a 300,000-element array never does more than the budget in one allocation, and needed no full drain`,
      ok: (boundOk(boundHvf) || boundHvf.skipped) && boundOk(boundTcg),
      detail: `HVF: max ${boundHvf.maxSteps} steps per allocation (budget ${boundHvf.budget}), ${boundHvf.steps} steps over ${boundHvf.allocs} allocations, ${boundHvf.fullDrains} full drains. TCG: max ${boundTcg.maxSteps}, ${boundTcg.steps} steps, ${boundTcg.fullDrains} full drains${boundHvf.skipped ? "; HVF SKIPPED" : ""}`,
      failures: [boundHvf.why, boundTcg.why].filter((x) => x !== ""),
    });
  });

  M.unit("9", async () => {
    const lat = await rcTests.latency();
    M.keep("latency", lat);
    report({
      box: "9. Latency of an allocation including its bounded freeing work, by the counter, during a large drop and with nothing pending. No gate: timing under QEMU isn't one",
      ok: lat.skipped === null && lat.phases.length === 2,
      detail:
        lat.skipped ??
        `counter at ${lat.frequency} Hz. ${lat.phases
          .map(
            (p) =>
              `${p.name}: median ${p.medianTicks} ticks (${p.medianNs.toFixed(0)} ns), p99 ${p.p99Ticks} (${p.p99Ns.toFixed(0)} ns), max ${p.maxTicks} (${p.maxNs.toFixed(0)} ns) of ${p.n}`,
          )
          .join(". ")}`,
      failures: [],
    });
  });

  M.unit("10", async () => {
    // 10. Nothing else moved.
    const pinned = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/strict-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const pinnedModes = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/modes-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const failures10: string[] = [];
    const hashRun = async (tool: string, pin: Record<string, string>): Promise<void> => {
      const h = await guardedRun(process.execPath, ["--no-warnings", join(ROOT, tool)], {
        timeoutMs: 600_000,
        label: tool,
        cwd: ROOT,
      });
      if (!h.ok) {
        failures10.push(h.why);
        return;
      }
      const got = JSON.parse(h.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        // Phase F (D42) lowers these in a mode. native-f pins everything else, strict included.
        if (USE_STRMAP.some((p) => k.startsWith(`${p}@`))) continue;
        if (langAMoved(k)) continue;
        if (got[k] !== v) failures10.push(`${k}: tirhash changed`);
      }
    };
    await hashRun("tools/strict-hashes.ts", pinned);
    await hashRun("tools/mode-hashes.ts", pinnedModes);
    report({
      box: "10. strict, leak and manual output is unchanged: every tirhash is the one pinned before this work",
      ok: failures10.length === 0,
      detail: `${Object.keys(pinned).length} strict programs, ${Object.keys(pinnedModes).length} in leak and manual`,
      failures: failures10,
    });
  });

  M.unit("11", async () => {
    // 11. Release builds have none of it.
    // The direct route's runtime (D36, D41), which this box is of: since R36 `auto` takes class_list.ts through the TSL route
    const release = lowerFile(join(ROOT, "corpus/lower/memory/class_list.ts"), {
      memory: "rc",
      route: "direct",
    });
    const known =
      /^(__arena_|__alloc|__vec_|__trap_args|__page_source_use|__pages_get|__leak_|__heap_|__init|__rc_)/;
    const strange = release
      .tir!.funcs.map((f) => f.name)
      .filter((n) => n.startsWith("__") && !known.test(n));
    const testCode = [
      ...release.tir!.funcs.map((f) => f.name).filter((n) => n.startsWith("__rc_chk")),
      ...release.tir!.globals.map((g) => g.name).filter((n) => n.startsWith("__rc_s_")),
      ...release.tir!.traps.filter((t) => t.code === 16).map((t) => `trap ${t.id}`),
    ];
    const exportsWanted = [
      "__rc_new",
      "__rc_release",
      "__rc_retain",
      "__rc_release_arr",
      "__rc_retain_arr",
      "__rc_collect",
      "__vec_new_rc",
    ];
    const notExported = exportsWanted.filter(
      (n) => release.tir!.funcs.find((f) => f.name === n)?.attrs.includes("export") !== true,
    );
    report({
      box: "11. A release rc module has no accounting and no poison: its runtime is a page source's, the counted heap's and, when it can have cycles, the cycle collector's (D41), and a native caller has __rc_release and the rest (D36)",
      ok: strange.length === 0 && testCode.length === 0 && notExported.length === 0,
      detail: `test code present: ${testCode.join(", ") || "none"}; exports missing: ${notExported.join(", ") || "none"}`,
      failures: strange,
    });
  });

  M.unit("12", async () => {
    // 12. The three small gaps.
    const failures12: string[] = [];
    const hostCases = join(ROOT, "corpus/hostonly/manual/double_free.cases.json");
    for (const [engine, argv0] of [
      ["V8", [engines.node, "--import", join(ROOT, "tools/ts-hook.mjs"), "--no-warnings"]],
      ["JSC", [engines.bun]],
    ] as [string, string[]][]) {
      const r = await guardedRun(
        argv0[0]!,
        [
          ...argv0.slice(1),
          join(ROOT, "tools/corpus-exec.ts"),
          JSON.stringify({
            mode: "source",
            program: join(ROOT, "corpus/hostonly/manual/double_free.ts"),
            cases: hostCases,
          }),
        ],
        { timeoutMs: 60_000, label: `double free on ${engine}`, cwd: ROOT },
      );
      if (!r.ok) {
        failures12.push(`${engine}: ${r.why} ${r.stderr.slice(0, 300)}`);
        continue;
      }
      const got = (JSON.parse(r.stdout) as { result: { trap?: number } }[]).map(
        (x) => x.result.trap,
      );
      if (got[1] !== 5 || got[0] !== undefined || got[2] !== undefined)
        failures12.push(`${engine}: ${r.stdout.slice(0, 300)}`);
    }
    const compiles = checkFile(join(ROOT, "corpus/hostonly/manual/double_free.ts"));
    if (compiles.typed === null) failures12.push(JSON.stringify(compiles.diags).slice(0, 300));
    const pinNull = await runLower(jobs, "nullable_field_order", engines);
    const shiftLowers = lowerFile(join(ROOT, "corpus/lower/rc/adv_array_release.ts")).fallbackDiags;
    const shiftStrict = lowerFile(join(ROOT, "corpus/lower/rc/adv_array_release.ts"), {
      memory: "leak",
    });
    if (shiftStrict.fallbackDiags.length > 0)
      failures12.push(`shift in leak: ${JSON.stringify(shiftStrict.fallbackDiags).slice(0, 300)}`);
    void shiftLowers;
    report({
      box: "12. The three gaps: Array.prototype.shift, splice and length = lower. unsafeFree's double free traps 5 on the host, by a host-only test on V8 and JSC. A strict program pins a nullable field keeping its null when an object literal unified first",
      ok: failures12.length === 0 && pinNull.ok,
      detail: `${pinNull.summary}; corpus/lower/pos/nullable_field_order.ts fails with the shared fix taken out, by hand`,
      failures: [...failures12, ...pinNull.failures],
    });
  });

  M.unit("13", async () => {
    // 13. Beyond the brief: random programs.
    // A phase gate runs a quarter of the seeds, a different quarter each day (tools/sweep.ts, D51).
    const sH = seedSlice("native-d 13 rc-fuzz HVF", 5000, quick ? 40 : 400, 4);
    const sT = seedSlice("native-d 13 rc-fuzz TCG", 9000, quick ? 10 : 60, 4);
    const fz = await fuzz(sH.start, sH.count, "hvf", jobs);
    const fzT = await fuzz(sT.start, sT.count, "tcg", jobs);
    report({
      box: "13. Random programs that hold, drop, swap and clear references, in the poisoning build, against V8 (added beyond the brief: a hand-written list only finds what its author thought of)",
      ok: fz.failures.length === 0 && fzT.failures.length === 0 && fz.ran > 0 && fzT.ran > 0,
      detail: `HVF: ${fz.ran}/${fz.seeds} programs, ${fz.cases} cases, ${fz.fellBack} fell back${fz.skipped ? ", SKIPPED" : ""}. TCG: ${fzT.ran}/${fzT.seeds} programs, ${fzT.cases} cases`,
      failures: [...fz.failures, ...fzT.failures],
    });
  });

  M.unit("14", async () => {
    // 14. The figures.
    const elide = await rcTests.elisionFigures("hvf", jobs);
    M.keep("elide", elide);
    const { benchMemory, memoryText } = timedModule("bench", await import("../bench-memory.ts"));
    // No gate: a short run here, the measurement in tmk bench all (SPEC 8.4, D51).
    const bench = await benchMemory({ quick: true });
    M.keep("bench", bench);
    report({
      box: "14. tmk bench memory ran, with a lowered list and a churn program under rc against leak, V8 and C, what counts cost and what borrow elision removed, statically and dynamically, and bytes per object. No gate: reported plainly, with host load",
      ok:
        bench.skipped === null &&
        bench.errors.length === 0 &&
        bench.rows.length >= 6 &&
        elide.failures.length === 0,
      detail: `${memoryText(bench).split("\n").join("\n     ")}\n     borrow elision over ${elide.programs} programs: static ${elide.staticOff} sites to ${elide.staticOn} (${(100 - (100 * elide.staticOn) / Math.max(elide.staticOff, 1)).toFixed(1)}% removed), dynamic ${elide.dynamicOff} counts to ${elide.dynamicOn} (${(100 - (100 * elide.dynamicOn) / Math.max(elide.dynamicOff, 1)).toFixed(1)}% removed)`,
      failures: [...bench.errors, ...elide.failures],
    });
  });

  M.unit("15", async () => {
    // 15. The spec.
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const spec = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/spec-extract.ts")],
      {
        timeoutMs: 60_000,
        label: "spec-extract",
        cwd: ROOT,
      },
    );
    const wanted = [
      "D39",
      "Phase D",
      "`rc`",
      "per thread",
      "9. A `WeakRef`",
      "__rc_release",
      "cycle collector",
      "RC_BUDGET",
      "Cycles leak",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    const backedUp = existsSync(join(ROOT, "SPEC.md.bak-pre-rc"));
    report({
      box: "15. The spec says all of this, its code blocks with // file: are in sync through tools/spec-extract.ts, and the old one is backed up as SPEC.md.bak-pre-rc",
      ok: absent.length === 0 && spec.ok && backedUp,
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.nested(
    "16",
    "16. Milestone native-c still passes, and through it native-b, native-a, m1 and m2",
    "native-c",
  );
  M.vms(
    "17",
    "No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
