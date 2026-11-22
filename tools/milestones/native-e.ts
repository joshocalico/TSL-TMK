// native-e: the cycle collector under `rc` (SPEC 3.5, 4.5, D41).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { listSlice, seedSlice } from "../sweep.ts";

export async function defineNativeE(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const quick = args.includes("--quick");
  const { runNative } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile } = timedModule("tslc", await import("../lowering.ts"));
  const rcTests = timedModule("rc", await import("../rc-tests.ts"));
  const { fuzz } = timedModule("rcfuzz", await import("../rc-fuzz.ts"));
  const { RC_BUDGET } = await import("../../compiler/host/down-rt.ts");
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = ["hvf", "tcg"];
  const needBoth = (s: { agreement: { skipped: boolean }[] }): boolean =>
    s.agreement.every((a) => !a.skipped);
  const tmkRun = async (...a: string[]): Promise<Awaited<ReturnType<typeof guardedRun>>> =>
    guardedRun(process.execPath, ["--no-warnings", tmk, ...a], {
      timeoutMs: 120_000,
      label: `tmk ${a.join(" ")}`,
      cwd: ROOT,
    });

  M.unit("1", async () => {
    // 1. The setting.
    const failures1: string[] = [];
    const cyclic = join(ROOT, "corpus/lower/memory/cycles.ts");
    const acyclicFile = join(ROOT, "bench/memory/acyclic_lowered.ts");
    const onByDefault = lowerFile(cyclic, { memory: "rc" });
    const on = lowerFile(cyclic, { memory: "rc", cycles: true });
    const off = lowerFile(cyclic, { memory: "rc", cycles: false });
    if (onByDefault.tirHash !== on.tirHash) failures1.push("the default isn't on");
    if (on.tirHash === off.tirHash) failures1.push("on and off are the same on a cyclic program");
    if (on.cycleCollector !== true || off.cycleCollector !== false)
      failures1.push(`collector in module: on ${on.cycleCollector}, off ${off.cycleCollector}`);
    const noCollector = off.tir!.funcs.filter((f) =>
      /^__rc_(cc_|touch|cand|steps|dry|rest)/.test(f.name),
    );
    if (noCollector.length > 0) failures1.push(`with it off: ${noCollector[0]!.name}`);
    // The direct route's collector setting, which this box is of: since R36 `auto` takes acyclic_lowered.ts through the TSL
    // route, whose collector is @tsl/gc's
    const acyclicOn = lowerFile(acyclicFile, { memory: "rc", cycles: true, route: "direct" });
    const acyclicOff = lowerFile(acyclicFile, { memory: "rc", cycles: false, route: "direct" });
    if (acyclicOn.tirHash !== acyclicOff.tirHash || acyclicOn.cycleCollector !== false)
      failures1.push("an acyclic program with the collector on isn't the same module");
    const pkg = lowerFile(join(ROOT, "corpus/rc-package-off/rc_off.ts"));
    if (pkg.cycleCollector !== false || pkg.meta?.memory !== "rc")
      failures1.push(`"cycles": false in tsl.json: ${String(pkg.cycleCollector)}`);
    const flagOn = await tmkRun(
      "lower",
      "corpus/lower/memory/cycles.ts",
      "--memory",
      "rc",
      "--cycles",
      "on",
      "--report",
    );
    const flagOff = await tmkRun(
      "lower",
      "corpus/lower/memory/cycles.ts",
      "--memory",
      "rc",
      "--cycles",
      "off",
      "--report",
    );
    const flagBad = await tmkRun(
      "lower",
      "corpus/lower/memory/cycles.ts",
      "--memory",
      "rc",
      "--cycles",
      "maybe",
    );
    if (!flagOn.stdout.includes("is collected"))
      failures1.push(`--cycles on: ${flagOn.stdout.slice(-300)}`);
    if (!flagOff.stdout.includes("leaks"))
      failures1.push(`--cycles off: ${flagOff.stdout.slice(-300)}`);
    if (flagBad.code !== 2) failures1.push(`--cycles maybe exits ${String(flagBad.code)}`);
    report({
      box: '1. The setting: tmk lower --memory rc --cycles on|off, and "cycles" in tsl.json. On by default. Off has none of the collector. A program no type of which can be in a cycle is the same module, byte for byte, with it on',
      ok: failures1.length === 0,
      detail: `tirhash on cycles.ts: on ${on.tirHash.slice(0, 12)}, off ${off.tirHash.slice(0, 12)}; acyclic on and off both ${acyclicOn.tirHash.slice(0, 12)}`,
      failures: failures1,
    });
  });

  M.unit("2", async () => {
    // 2. Churn.
    const churnH = await rcTests.cycleChurn("hvf", jobs);
    const churnT = await rcTests.cycleChurn("tcg", jobs);
    const churnLine = (r: typeof churnH): string =>
      r.rows
        .map(
          (x) =>
            `${x.fn}: off traps ${String(x.offTrap)}, ${x.freed} freed as cycles, at most ${x.maxSteps} steps, ${x.fullDrains} full drains`,
        )
        .join("; ");
    report({
      box: "2. Cycle churn under one page limit (96 pages): self-loops, two-node, long rings, doubly linked lists, closures over this, closures in arrays capturing the array, trees with parent pointers, cycles reachable from a global then cleared. Each traps 14 with the collector off and completes with it on, against V8, in the release and poisoning builds, on HVF and TCG",
      ok:
        churnH.failures.length === 0 &&
        churnT.failures.length === 0 &&
        !churnT.skipped &&
        churnH.rows.length === 8 &&
        churnT.rows.length === 8,
      detail: `HVF${churnH.skipped ? " SKIPPED" : ""}: ${churnLine(churnH)}. TCG: ${churnT.rows.length} of 8 as well, ${churnT.rows.reduce((a, x) => a + x.fullDrains, 0)} full drains in all`,
      failures: [...churnH.failures, ...churnT.failures],
    });
  });

  M.unit("3", async () => {
    // 3. No leak.
    const leakH = await rcTests.leakTest("hvf", jobs, true);
    const leakT = quick ? null : await rcTests.leakTest("tcg", jobs, true);
    const leftOut = leakH.rows.filter((r) => r.skipped !== undefined);
    const inNow = leakH.rows.filter((r) => /cycles\.ts|closures_returned|cyc_/.test(r.program));
    report({
      box: "3. No leak with the collector on: each program's cases, repeated 4 times, with results and arguments released. cycles.ts, Box's closure over this, and the new cyclic programs are in now. What's still left out, and why, is listed",
      ok:
        leakH.failures.length === 0 &&
        (leakT?.failures.length ?? 0) === 0 &&
        leakH.rows.length > 0 &&
        inNow.every((r) => r.skipped === undefined),
      detail: `${leakH.rows.length - leftOut.length}/${leakH.rows.length} programs on HVF${leakT !== null ? " and on TCG" : ""}. Brought in: ${inNow.map((r) => `${r.program} (live objects ${r.liveObjects.join(" ")})`).join("; ")}. Left out, whole: ${leftOut.map((r) => `${r.program} (${r.skipped})`).join("; ")}. Left out, by function: insertTree in class_list.ts and fits and tooMany in exhaust.ts, which add to a module list or tree on each call, and any case that traps, as a trap leaves what its frames held`,
      failures: [...leakH.failures, ...(leakT?.failures ?? [])],
    });
  });

  M.unit("4", async () => {
    // 4. Never frees a live object.
    const budgets = [...Array.from({ length: 16 }, (_, i) => i + 1), 24, 32, 64];
    // A phase gate runs budgets 1 to 3 always and a turning share of the rest, and a quarter of the seeds (D51). The
    // injected collector faults below always run whole.
    const ivH = await rcTests.interleave(
      "hvf",
      jobs,
      listSlice("native-e 4 budgets HVF", budgets, 4, [1, 2, 3]),
    );
    const ivT = await rcTests.interleave(
      "tcg",
      jobs,
      listSlice(
        "native-e 4 budgets TCG",
        quick ? [1, 3, 32] : [1, 2, 3, 5, 8, 13, 32],
        2,
        [1, 2, 3],
      ),
      {},
      40,
    );
    const faults = await rcTests.collectorFaults("hvf", jobs);
    M.keep("faults", faults);
    const faultsSeen = faults.rows.every((r) => r.failures > 0);
    const freedF = { freed: 0 };
    const sH = seedSlice("native-e 4 rc-fuzz HVF", 20000, quick ? 40 : 600, 4);
    const sT = seedSlice("native-e 4 rc-fuzz TCG", 30000, quick ? 10 : 80, 4);
    const fz = await fuzz(sH.start, sH.count, "hvf", jobs, {}, false, {
      budgets: [1, 2, 3, 5, 8, 13, 32],
      collected: freedF,
    });
    const fzT = await fuzz(sT.start, sT.count, "tcg", jobs, {}, false, {
      budgets: [1, 2, 3, 5, 32],
    });
    report({
      box: "4. Never frees a live object: partly live cycles, holders dropped and re-held, objects reachable again from a candidate, external references added and removed, elements moved inside a scanned array, with user code between every collector step and at every budget from 1 up, under the poisoning build, against V8. Random programs with cycles at very small budgets. Each mistake put into the collector is caught",
      ok:
        ivH.failures.length === 0 &&
        ivT.failures.length === 0 &&
        !ivT.skipped &&
        ivH.freed > 0 &&
        ivH.touches > 0 &&
        faultsSeen &&
        fz.failures.length === 0 &&
        fzT.failures.length === 0 &&
        fz.ran > 0 &&
        fzT.ran > 0 &&
        freedF.freed > 0,
      detail: `interleaving, HVF${ivH.skipped ? " SKIPPED" : ""}: ${ivH.images} images at budgets ${budgets.join(",")}, ${ivH.cases} cases, ${ivH.freed} objects freed as cycles, ${ivH.touches} touched during a scan. TCG: ${ivT.images} images, ${ivT.cases} cases. Faults caught: ${faults.rows.map((r) => `${r.fault}: ${r.failures} failures`).join("; ")}. Random: HVF ${fz.ran}/${fz.seeds} programs, ${fz.cases} cases, ${freedF.freed} objects freed as cycles${fz.skipped ? ", SKIPPED" : ""}; TCG ${fzT.ran}/${fzT.seeds} programs, ${fzT.cases} cases`,
      failures: [
        ...ivH.failures,
        ...ivT.failures,
        ...fz.failures,
        ...fzT.failures,
        ...faults.rows.filter((r) => r.failures === 0).map((r) => `not caught: ${r.fault}`),
      ],
    });
  });

  M.unit("5", async () => {
    // 5. WeakRef.
    const only = await rcTests.rcOnly("hvf", jobs);
    const onlyT = quick ? null : await rcTests.rcOnly("tcg", jobs);
    const forgotH = await rcTests.forgottenCandidates("hvf");
    const forgotT = await rcTests.forgottenCandidates("tcg");
    const weakFailures = [...only.failures, ...(onlyT?.failures ?? [])];
    for (const f of [forgotH, forgotT]) {
      if (!f.ok || f.evicted <= 0 || f.walks <= 0)
        weakFailures.push(`forgotten candidates: ${JSON.stringify(f)}`);
    }
    report({
      box: "5. WeakRef with a target in a garbage cycle: deref is right at every step (box 4 runs it at every budget), gives undefined once it's decided, including partway through freeing, and never gives it again. Rc-only pins in the release and poisoning builds, and trap 14 only after the queue and the collector have run to completion",
      ok: weakFailures.length === 0 && only.cases > 0,
      detail: `rc-only: ${only.cases} checks on HVF${onlyT !== null ? `, ${onlyT.cases} on TCG` : ""}, ${only.drains} full drains on the way to exhaustion. Rings dropped among more candidates than the table holds: ${forgotH.evicted} didn't fit, ${forgotH.walks} walks of the heap at exhaustion, ${forgotH.freed} objects freed as cycles, ${forgotH.drains} full drains, and no trap`,
      failures: weakFailures,
    });
  });

  M.unit("6", async () => {
    // 6. The bound.
    const boundH = await rcTests.cycleBound("hvf");
    const boundT = await rcTests.cycleBound("tcg");
    const zig = await rcTests.zigzag("hvf", [100, 1000, 4000]);
    M.keep("bound", { boundH, boundT, zig });
    const bOk = (b: typeof boundH): boolean =>
      b.ok &&
      b.maxSteps <= b.budget &&
      b.maxSteps > 0 &&
      b.fullDrains === 0 &&
      b.freed === b.ring + b.list;
    const bLine = (b: typeof boundH): string =>
      `at most ${b.maxSteps} steps an allocation (budget ${b.budget}), ${b.steps} steps of which ${b.ccSteps} the collector's, over ${b.allocs} allocations; ${b.freed} freed as cycles, of ${b.ring}+${b.list}; ${b.fullDrains} full drains; ${b.scans} scans, ${b.fruitless} of them fruitless, ${b.roots} roots, ${b.retries} roots tried again after a scan was cut off, ${b.touches} touches, ${b.evicted} candidates that didn't fit, at most ${b.maxPasses} passes, at most ${b.maxScan} objects in a scan`;
    report({
      box: "6. The bound as a deterministic count: steps per allocation while a large ring and a large doubly linked list are collected, and restarts. There's no restart: a change marks an object, and what's cut off by a limit goes again. No full drain. The shape that needs the most passes is measured, not hidden",
      ok: (bOk(boundH) || boundH.skipped) && bOk(boundT) && boundH.budget === RC_BUDGET,
      detail: `HVF: ${bLine(boundH)}. TCG: ${bLine(boundT)}. Worst shape for marking, by size: ${zig.map((z) => `${z.n} objects, ${z.passes} passes, ${z.steps} steps${z.alive ? "" : ", FAILED"}`).join("; ")}${boundH.skipped ? "; HVF SKIPPED" : ""}`,
      failures: [boundH.why, boundT.why].filter((x) => x !== ""),
    });
  });

  M.unit("7", async () => {
    // 7. Latency.
    const lat = await rcTests.cycleLatency();
    M.keep("latency", lat);
    report({
      box: "7. Latency of an allocation with a large garbage cycle being collected, by the counter, every allocation doing its share. No gate: timing under QEMU isn't one",
      ok: lat.skipped === null && lat.phases.length === 5,
      detail:
        lat.skipped ??
        `counter at ${lat.frequency} Hz, ${lat.dropped} objects. ${lat.phases
          .map(
            (p) =>
              `${p.name}: median ${p.medianTicks} ticks (${p.medianNs.toFixed(0)} ns), p99 ${p.p99Ticks} (${p.p99Ns.toFixed(0)} ns), max ${p.maxTicks} (${p.maxNs.toFixed(0)} ns) of ${p.n}`,
          )
          .join(". ")}`,
      failures: [],
    });
  });

  M.unit("8", async () => {
    // 8. Off and the other modes unchanged, and the corpus with it on.
    const failures8: string[] = [];
    const hashRun = async (tool: string, pinFile: string): Promise<number> => {
      const pin = JSON.parse(readFileSync(join(ROOT, pinFile), "utf8")) as Record<string, string>;
      const h = await guardedRun(process.execPath, ["--no-warnings", join(ROOT, tool)], {
        timeoutMs: 600_000,
        label: tool,
        cwd: ROOT,
      });
      if (!h.ok) {
        failures8.push(h.why);
        return 0;
      }
      const got = JSON.parse(h.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        // Phase F (D42) lowers these in a mode. native-f pins everything else, strict included.
        if (USE_STRMAP.some((p) => k.startsWith(`${p}@`))) continue;
        if (langAMoved(k)) continue;
        if (got[k] !== v) failures8.push(`${k}: tirhash changed`);
      }
      return Object.keys(pin).length;
    };
    const nStrict = await hashRun("tools/strict-hashes.ts", "corpus/memory/strict-tirhash.json");
    const nModes = await hashRun("tools/mode-hashes.ts", "corpus/memory/modes-tirhash.json");
    const nOff = await hashRun("tools/rc-off-hashes.ts", "corpus/memory/rc-off-tirhash.json");
    const rcAll = await runNative("lower", both, jobs, undefined, engines, "rc");
    const leakAll = await runNative("lower", both, jobs, undefined, engines, "leak");
    const poison = await runNative("lower", both, jobs, undefined, engines, "rc", {
      rc: { check: true, account: true },
      harness: { collect: true },
      suffix: "-poison-on",
    });
    failures8.push(...rcAll.failures, ...leakAll.failures, ...poison.failures);
    report({
      box: "8. With the collector off, rc is what it was: every tirhash pinned before this work, in release and test builds, as are strict, leak and manual. The corpus under rc with it on gives the same results as V8 and leak, on HVF and TCG, in the release and poisoning builds, the poisoning one with a check at every site that says its type can't be in a cycle",
      ok:
        failures8.length === 0 &&
        rcAll.ok &&
        leakAll.ok &&
        poison.ok &&
        needBoth(rcAll) &&
        needBoth(leakAll) &&
        needBoth(poison),
      detail: `${nOff} pinned with it off, ${nStrict} strict, ${nModes} in leak and manual. On: ${rcAll.summary.split(";")[0]}. Leak: ${leakAll.summary.split(";")[0]}. Poison: ${poison.summary.split(";")[0]}${skipNote}`,
      failures: failures8,
    });
  });

  // Measures: the list's slowdown is a comparison of times, so it runs in the gate's quiet phase (SPEC 8.4, D51).
  M.unit("9", async () => {
    // 9. The three leftovers.
    const diag = await rcTests.listDiagnosis();
    const faultOff = await rcTests.faultInjection("hvf", jobs, { cycles: false });
    M.keep("faultOff", faultOff);
    M.keep("diag", diag);
    // R16: the same inequalities, each variant's time the median of its iterations 180 to 199 rather than iteration 199's
    // one sample, which a single scheduling hiccup flipped (R15's gate); the share on one page as before, at 199, with the
    // same thresholds (SPEC M5's R16 record says why this is at least as strong). tools/r16-tests.ts's box9Check.
    const { box9Check, BOX9_FAULTS } = await import("../r16-tests.ts");
    const check = box9Check(diag);
    // Not vacuous: each bug put into the diagnosis fails the check (the free list keeping order, the reused variant's work
    // a tenth), with what of it failed
    const faulty: string[] = [];
    const missed: string[] = [];
    for (const f of BOX9_FAULTS) {
      const c = box9Check(await rcTests.listDiagnosis("hvf", f.name));
      faulty.push(
        `${f.name}: ${c.ok ? "NOT CAUGHT" : `caught (${[c.samePage ? "" : "same page", c.timing ? "" : "medians"].filter((x) => x !== "").join(", ")})`}`,
      );
      if (c.ok) missed.push(`${f.name} (${f.what}) wasn't caught: ${c.text}`);
    }
    const diagFound = check.ok && missed.length === 0;
    const accounted =
      faultOff.silent === faultOff.silentNeverRan &&
      faultOff.silentSites.length === 0 &&
      faultOff.silentNeverRan ===
        faultOff.notInTheCode + faultOff.reachedOnlyNull + faultOff.neverReached &&
      faultOff.decTried ===
        faultOff.decLeaked +
          faultOff.decNotInTheCode +
          faultOff.decReachedOnlyNull +
          faultOff.decNeverReached +
          faultOff.decImmortal.length;
    report({
      box: "9. The three leftovers. The list's slowdown is measured apart: it's the free list losing the list's order, not counts, and it's gone with the collector linked (each variant's time the median of its last 20 iterations, and two bugs put into the diagnosis each failing it, R16). Every omitted increment and decrement that went unnoticed is accounted for, with the test gaps closed",
      ok: diagFound && accounted && !faultOff.skipped,
      detail: `list: ${check.text}${check.samePage ? "" : " (same-page shares wrong)"}${check.timing ? "" : " (the medians' order wrong)"}; bugs put in: ${faulty.join("; ")}; at iterations 1, 20, 60 and 199: ${[
        ...new Set(diag.rows.map((r) => r.what)),
      ]
        .map(
          (w) =>
            `${w}: ${diag.rows
              .filter((r) => r.what === w)
              .map((r) => `${r.ms.toFixed(3)} ms, ${(100 * r.samePage).toFixed(1)}% same page`)
              .join(" / ")}`,
        )
        .join(
          "; ",
        )}. Increments left out, of ${faultOff.injected}: ${faultOff.trapped16} trapped 16, ${faultOff.otherFailures} gave a wrong answer or a fatal exception, ${faultOff.silent} did nothing: ${faultOff.notInTheCode} not in the code at all (worked out, then not used), ${faultOff.reachedOnlyNull} only ever on a null, ${faultOff.neverReached} never reached. Decrements left out, of ${faultOff.decTried}: ${faultOff.decLeaked} showed as a leak, ${faultOff.decImmortal.length} an extra count on what module state holds for good (${faultOff.decImmortal.join(", ")}), ${faultOff.decReachedOnlyNull} only ever on a null, ${faultOff.decNotInTheCode} not in the code at all, ${faultOff.decNeverReached} never reached (${faultOff.decNeverReachedSites.join(", ")})`,
      failures: [
        ...(check.ok ? [] : [`the list's diagnosis: ${check.text}`]),
        ...missed,
        ...(accounted ? [] : [JSON.stringify(faultOff).slice(0, 1200)]),
      ],
    });
  });

  M.unit("10", async () => {
    // 10. The figures.
    const { benchMemory, memoryText } = timedModule("bench", await import("../bench-memory.ts"));
    // No gate: a short run here, the measurement in tmk bench all (SPEC 8.4, D51).
    const bench = await benchMemory({ quick: true });
    M.keep("bench", bench);
    report({
      box: "10. tmk bench memory ran: cyclic churn under rc with the collector on and off, against V8; the acyclic programs with it on and off; the collector's steps as a share of all work; and bytes per object. No gate: reported plainly, with host load",
      ok: bench.skipped === null && bench.errors.length === 0 && bench.cycles.length === 4,
      detail: memoryText(bench).split("\n").join("\n     "),
      failures: bench.errors,
    });
  });

  M.unit("11", async () => {
    // 11. The spec.
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const spec = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/spec-extract.ts")],
      { timeoutMs: 60_000, label: "spec-extract", cwd: ROOT },
    );
    const wanted = [
      "D41",
      "Phase E",
      "owner asked for it 2026-11-05, design delegated",
      "--cycles",
      "`native-e`",
      "__rc_touch",
      "the one permitted pause",
      "honest worst case",
      "Why it can't free a live object",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    report({
      box: "11. The spec says all of this, its code blocks with // file: are in sync through tools/spec-extract.ts, and the old one is backed up as SPEC.md.bak-pre-cycles",
      ok: absent.length === 0 && spec.ok && existsSync(join(ROOT, "SPEC.md.bak-pre-cycles")),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.nested(
    "12",
    "12. Milestone native-d still passes, and through it native-c, native-b, native-a, m1 and m2",
    "native-d",
  );
  M.vms(
    "13",
    "No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
