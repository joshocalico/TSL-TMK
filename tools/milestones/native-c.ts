// native-c: noStd and the memory modes (SPEC 3.5, 4.5, D38).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT } from "../corpus.ts";
import {
  guardedRun,
  jobsFlag,
  listTs,
  needInstall,
  langAMoved,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

export async function defineNativeC(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { runNative, runNegative, runLower } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile, checkFile, compileTyped } = timedModule(
    "tslc",
    await import("../lowering.ts"),
  );
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const needBoth = (s: { agreement: { skipped: boolean }[] }): boolean =>
    s.agreement.every((a) => !a.skipped);
  const both: ("hvf" | "tcg")[] = ["hvf", "tcg"];
  const tmkRun = async (...a: string[]): Promise<Awaited<ReturnType<typeof guardedRun>>> =>
    guardedRun(process.execPath, ["--no-warnings", tmk, ...a], {
      timeoutMs: 120_000,
      label: `tmk ${a.join(" ")}`,
      cwd: ROOT,
    });

  M.unit("1", async () => {
    // 1. The settings, and every new rule's exact code and position.
    const neg = await runNegative(jobs, undefined, engines);
    const newCodes = ["TSL1018", "TSL1019", "TSL3008", "TSL5006", "TSL5007", "TSL5008", "TSL5009"];
    const negText = listTs(join(ROOT, "corpus/neg/memory"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const missing = newCodes.filter((c) => !negText.includes(`// expect: ${c} at`));
    // `rc` was reserved here until phase D, and TSL proper got TSL9001 for it until D74. tslc now expands an rc package onto
    // @tsl/gc, checking what's written as TSL proper first, where it's written: corpus/neg/memory/rc/rc_reserved.ts pins that.
    const rcFlag = await tmkRun("lower", "corpus/lower/memory/store_closure.ts", "--memory", "rc");
    const fromPackage = lowerFile(join(ROOT, "corpus/memory/leak/leak_store.ts")).meta?.memory;
    report({
      box: '1. tsl.json: "noStd", and "memory" strict, leak, manual or rc, default strict, with "rc" lowered code\'s (since phase D) and in TSL proper expanded onto @tsl/gc, what\'s written checked first (D74). Negative tests with exact code and position for every new rule (TSL1018, TSL1019, TSL3008, TSL5006 to TSL5009, and TSL proper\'s rules in an rc package), on a stub of @tsl/std by specifier and by path',
      ok:
        neg.ok &&
        missing.length === 0 &&
        rcFlag.ok &&
        readFileSync(join(ROOT, "corpus/neg/memory/rc/rc_reserved.ts"), "utf8").includes(
          "// expect: TSL2005 at 4:22",
        ) &&
        fromPackage === "leak",
      detail: `${neg.summary}; new codes uncovered: ${missing.join(", ") || "none"}; --memory rc: ${rcFlag.stdout.trim().slice(0, 120)}; tmk lower takes the package's mode: ${String(fromPackage)}`,
      failures: neg.failures,
    });
  });

  M.unit("2", async () => {
    // 2. The test that matters.
    const low = await tmkRun(
      "lower",
      "corpus/lower/memory/store_closure.ts",
      "--memory",
      "leak",
      "--no-fallback",
      "--target",
      "aarch64",
      "--out",
      buildPath("lower/store_closure-leak"),
    );
    const head = await runNative("lower", both, jobs, "store_closure", engines, "leak");
    report({
      box: "2. storeClosure, in ordinary TS, compiles natively with --memory leak --no-fallback, and matches V8 under QEMU on HVF and TCG",
      ok: low.ok && head.ok && needBoth(head) && head.agreement.every((a) => a.cases > 0),
      detail: `${low.stdout.trim().split("\n").join("; ")}; ${head.summary}${hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`}`,
      failures: head.failures,
    });
  });

  M.unit("3-5", async () => {
    // 3. Every lowered program, in each mode.
    const leakAll = await runNative("lower", both, jobs, undefined, engines, "leak");
    report({
      box: "3. Every program under corpus/lower, and corpus/native, run natively in leak where it has no remaining fallback, against V8, on HVF and TCG: lists and trees of classes that outlive their call, cycles, returned closures with mutable state and per-iteration captures, arrays of objects in globals across calls, results under D36",
      ok: leakAll.ok && needBoth(leakAll),
      detail: leakAll.summary,
      failures: leakAll.failures,
    });
    const manualAll = await runNative("lower", both, jobs, undefined, engines, "manual");
    report({
      box: "4. The same programs in manual, whose lowered form takes the heap and frees a growing array's old buffers where nothing else can hold them",
      ok: manualAll.ok && needBoth(manualAll),
      detail: manualAll.summary,
      failures: manualAll.failures,
    });
    const leakList = new Set(leakAll.skippedPrograms);
    const memoryPrograms = listTs(join(ROOT, "corpus/lower/memory")).map((f) =>
      f.slice(ROOT.length + 1),
    );
    const leftOut = memoryPrograms.filter((f) => leakList.has(f));
    report({
      box: "5. Nothing in corpus/lower/memory was left out, and exhaustion against a small page limit traps with code 14 (exhaust.ts in both modes, grow_reuse.ts in leak only: manual fits, because it freed)",
      ok: leftOut.length === 0 && memoryPrograms.length >= 7,
      detail: `${memoryPrograms.length} programs; left out: ${leftOut.join(", ") || "none"}`,
      failures: [],
    });
  });

  M.unit("6", async () => {
    // 6. Counts, and what stays a fallback with its root cause.
    const before = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/lower-baseline.json"), "utf8"),
    ) as Record<string, { fallbacks: string[]; externs: number }>;
    const clean = (o: ReturnType<typeof lowerFile>): boolean =>
      o.fallbackDiags.length === 0 && o.tir !== null && o.tir.externs.length === 0;
    const names = Object.keys(before);
    const beforeClean = names.filter((n) => {
      const b = before[n]!;
      return b.fallbacks.length === 0 && b.externs === 0;
    });
    const failures6: string[] = [];
    let nowLeak = 0;
    let nowStrict = 0;
    const still: string[] = [];
    for (const n of names) {
      const file = join(ROOT, n);
      if (clean(lowerFile(file))) nowStrict++;
      const o = lowerFile(file, { memory: "leak" });
      if (clean(o)) nowLeak++;
      else
        still.push(
          `${n.replace("corpus/lower/fallback/", "")}: ${[...new Set(o.fallbackDiags.map((d) => d.blocker))].join(",")}`,
        );
    }
    if (nowStrict !== beforeClean.length)
      failures6.push(`strict changed: ${beforeClean.length} before, ${nowStrict} now`);
    // In leak these were fallbacks until Phase F (D42), which lowers them. In strict they stay fallbacks, with this cause.
    const rooted = (file: string, blocker: string): void => {
      const o = lowerFile(join(ROOT, file));
      if (!o.fallbackDiags.some((d) => d.blocker === blocker))
        failures6.push(`${file} should stay a fallback with ${blocker} in strict`);
    };
    rooted("corpus/lower/fallback/map_set.ts", "map-set");
    rooted("corpus/lower/fallback/string_use.ts", "string-use");
    report({
      box: "6. corpus/lower compiles natively: counted against the baseline taken before this work. Map, Set and run-time strings stay fallbacks with their root cause in strict",
      ok: failures6.length === 0 && nowLeak > beforeClean.length,
      detail: `no fallback at all: ${beforeClean.length}/${names.length} before (and strict now ${nowStrict}), ${nowLeak}/${names.length} with --memory leak. Still a fallback: ${still.join("; ")}`,
      failures: failures6,
    });
  });

  M.unit("7", async () => {
    // 7. TSL proper.
    const modes = await runNative("memory", both, jobs, undefined, engines);
    report({
      box: "7. TSL proper in leak and manual packages: an escaping new is legal, a stack object is still a stack object, generation checks are off in manual and on for anything from a Slab, a leak package holding Slab objects, a leak reference in a strict package's field, a safe API over a manual one, unsafeFree's normal free, reuse and the host's trap on use after free, a registered page source, and exhaustion. Native on HVF and TCG, against V8 and JSC",
      ok: modes.ok && needBoth(modes),
      detail: modes.summary,
      failures: modes.failures,
    });
  });

  M.unit("8", async () => {
    // 8. strict is unchanged.
    const pinned = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/strict-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const hashes = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/strict-hashes.ts")],
      { timeoutMs: 600_000, label: "strict hashes", cwd: ROOT },
    );
    const failures8: string[] = [];
    if (!hashes.ok) failures8.push(hashes.why);
    else {
      const got = JSON.parse(hashes.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pinned)) {
        // Moved by a later phase, each listed with why (tools/maps-pins.ts: integers not proved to fit i32 are f64).
        if (got[k] !== v && !langAMoved(k)) failures8.push(`${k}: tirhash changed`);
      }
    }
    const tirOf = (file: string): string => {
      const c = checkFile(join(ROOT, file));
      if (c.typed === null) return JSON.stringify(c.diags);
      return compileTyped(c.typed)
        .tirText.replaceAll("corpus/memory/strict_explicit/", "corpus/memory/")
        .replaceAll("strict_explicit/", "");
    };
    if (
      tirOf("corpus/memory/strict_same.ts") !==
      tirOf("corpus/memory/strict_explicit/strict_same.ts")
    )
      failures8.push('"memory": "strict" written out compiles differently from no setting');
    report({
      box: '8. strict is unchanged: every corpus program\'s tirhash is the one pinned before this work, and "memory": "strict" written out compiles to the same TIR as no setting. Its errors are pinned by the existing corpus --neg',
      ok: failures8.length === 0,
      detail: `${Object.keys(pinned).length} programs compared`,
      failures: failures8,
    });
  });

  M.unit("9", async () => {
    // 9. Nothing but a page source is linked.
    const linked = lowerFile(join(ROOT, "corpus/lower/memory/class_list.ts"), { memory: "leak" });
    const known =
      /^(__arena_|__alloc|__vec_|__trap_args|__page_source_use|__pages_get|__leak_|__heap_|__init)/;
    const rtNames = linked.tir!.funcs.map((f) => f.name).filter((n) => n.startsWith("__"));
    const strange = rtNames.filter((n) => !known.test(n));
    const stdFree = !linked.tirText.includes("@tsl/std");
    report({
      box: "9. A lowered module links nothing but a page source: no collector and no std. Its runtime functions are the arena's, the vectors', and the mode's allocators",
      ok: strange.length === 0 && stdFree,
      detail: `${rtNames.length} runtime functions in a lowered leak module, none unexplained`,
      failures: strange,
    });
  });

  M.unit("10", async () => {
    // 10. The audit.
    const { audit, auditText } = await import("../audit.ts");
    const a = audit();
    M.keep("audit", a);
    report({
      box: "10. tmk audit counts every module of a manual package, and each one is listed in unsafeModules",
      ok:
        a.manual.length > 0 &&
        a.manual.every((m) => m.listed || !m.path.startsWith("packages/")) &&
        a.modules.every((m) => m.listed),
      detail: auditText(a)
        .split("\n")
        .filter((l) => l.includes("manual"))
        .join("; "),
      failures: a.manual.filter((m) => !m.listed).map((m) => `not listed: ${m.path}`),
    });
  });

  M.unit("11", async () => {
    // 11. The spec.
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
      "D38",
      "8. Use after `unsafeFree`",
      "`kernel-core` stays `strict`",
      "`--memory",
      "TSL3008",
      "debugging baseline",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    report({
      box: "11. The spec says all of this, and its code blocks with // file: are in sync through tools/spec-extract.ts",
      ok: absent.length === 0 && spec.ok,
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.unit("12", async () => {
    // 12. Numbers, with no gate.
    const { benchMemory, memoryText } = timedModule("bench", await import("../bench-memory.ts"));
    // No gate: a short run here, the measurement in tmk bench all (SPEC 8.4, D51).
    const bench = await benchMemory({ quick: true });
    M.keep("bench", bench);
    report({
      box: "12. tmk bench memory ran: a list-heavy lowered program natively in leak against V8, and the same structure by hand in manual TSL against C. No gate: reported plainly, with host load",
      ok: bench.skipped === null && bench.errors.length === 0 && bench.rows.length >= 3,
      detail: memoryText(bench).split("\n").join("\n     "),
      failures: bench.errors,
    });
  });

  M.unit("13", async () => {
    // 13. Nothing else broke.
    const lowerAgain = await runLower(jobs, undefined, engines);
    report({
      box: "13. corpus --lower, with the existing configurations of every lowered program, still passes",
      ok: lowerAgain.ok,
      detail: lowerAgain.summary,
      failures: lowerAgain.failures,
    });
  });

  M.nested(
    "14",
    "14. Milestones native-b, native-a, m1 and m2 still pass (native-b runs the others as its own boxes)",
    "native-b",
  );
  M.vms(
    "15",
    "No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
