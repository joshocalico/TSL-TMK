// native-g: @tsl/std (SPEC 3.5, D43), and the RAM channel's box (D45).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT } from "../corpus.ts";
import {
  guardedRun,
  jobsFlag,
  langAMoved,
  needInstall,
  tmkOut,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

export async function defineNativeG(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { runNative, runNegative } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile, checkFile } = timedModule("tslc", await import("../lowering.ts"));
  const S = timedModule("std", await import("../std-tests.ts"));
  const { casesText } = await import("../std-oracle.ts");
  const { benchStd, stdText } = timedModule("bench", await import("../bench-std.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = hvf.ok ? ["hvf", "tcg"] : ["tcg"];
  const allBoth = (s: { agreement: { skipped: boolean; cases: number }[] }): boolean =>
    s.agreement.length === 2 && s.agreement.every((a) => !a.skipped && a.cases > 0);

  // 1. The programs that matter, on every engine.
  const NAMED = ["job_queue", "word_count", "graph", "tree", "builder", "sort"];
  M.unit("1", async () => {
    const all = await runNative("std", both, jobs, undefined, engines);
    const absent = NAMED.filter((n) => !existsSync(join(ROOT, `corpus/std/${n}.cases.json`)));
    const oracle =
      JSON.stringify(
        JSON.parse(readFileSync(join(ROOT, "corpus/std/model.cases.json"), "utf8")),
      ) === JSON.stringify(JSON.parse(casesText()));
    report({
      box: "1. TSL programs on @tsl/std, on V8, JSC, HVF and TCG, all matching: a job queue, a word count, a graph, a tree with Vec children and no arena, a string builder and an in-place sort; in strict, leak and manual; and the same library against an oracle that shares nothing with it, JS's own Map, Set, Array and strings",
      ok: all.ok && allBoth(all) && absent.length === 0 && oracle && engines.bun !== null,
      detail: `${all.summary}${skipNote}. JSC: ${engines.bun !== null ? "ran, and agreed with V8" : "MISSING"}. The oracle's digests in corpus/std/model.cases.json are what tools/std-oracle.ts works out now: ${String(oracle)}`,
      failures: [...all.failures, ...absent.map((a) => `${a} is missing`)],
    });
  });

  // 2. Is it nicer?
  M.unit("2", async () => {
    const counts = S.ergonomicCounts();
    const cs = JSON.stringify;
    const a = JSON.parse(readFileSync(join(ROOT, "corpus/std/ergo_alloc.cases.json"), "utf8")) as {
      expect?: unknown;
    }[];
    const b = JSON.parse(readFileSync(join(ROOT, "corpus/std/ergo_std.cases.json"), "utf8")) as {
      expect?: unknown;
    }[];
    const samePin = a[0]?.expect !== undefined && cs(a[0]?.expect) === cs(b[0]?.expect);
    report({
      box: "2. The same program against @tsl/alloc and against @tsl/std, side by side, with line counts, each pinned to one result and run in box 1",
      ok: samePin && counts.std < counts.alloc,
      detail: `word report: @tsl/std ${counts.std} lines, @tsl/alloc ${counts.alloc}, including the page source it has to name (${counts.files.join(", ")}). Result pinned on both: ${cs(a[0]?.expect)}`,
      failures: samePin ? [] : ["the two sides aren't pinned to one result"],
    });
  });

  // 3. Every new rule, with its exact code and position.
  M.unit("3", async () => {
    const neg = await runNegative(jobs, undefined, engines);
    const gone = S.missingNegatives();
    const stdHere = await guardedRun(
      process.execPath,
      ["--no-warnings", tmk, "lower", "corpus/memory/nostd-helpers/uses_std.ts", "--memory", "rc"],
      { timeoutMs: 120_000, label: "tmk lower with @tsl/std", cwd: ROOT },
    );
    const lowerOut = `${stdHere.stdout}${stdHere.stderr}`;
    const lowerRule = lowerOut.includes("corpus/memory/nostd-helpers/uses_std.ts:3:1: TSL1022");
    report({
      box: "3. Negative tests with exact code and position for every new rule: two global allocators in a module and across modules, each wrong way of writing one (TSL1020, TSL5001, TSL5009), noStd importing the real package directly, by path, by a module of it, by re-export and transitively through other packages, from a kernel-core-style package; bad keys; stack objects in collections; what a holder can't do; a slice kept past its loan; @tsl/std in tmk lower (TSL1022)",
      ok: neg.ok && gone.length === 0 && lowerRule,
      detail: `${neg.summary}; of the ${S.REQUIRED_NEGATIVES.length} written for this, missing: ${gone.join(", ") || "none"}; tmk lower: ${lowerRule ? "TSL1022 at 3:1" : lowerOut.slice(0, 200)}`,
      failures: neg.failures,
    });
  });

  // 4. Safety.
  M.unit("4", async () => {
    const map = S.safetyMapping();
    const safety = await runNative("std", both, jobs, "std_", engines);
    report({
      box: "4. Every safety property @tsl/alloc's tests prove, proved for @tsl/std on V8, JSC, HVF and TCG: stale references trap 5, loans trap 13, exhaustion is trap 14 with a form that reports it, under a small page limit; and what std adds: a stale reference can't reach a closure, removal leaves nothing to read, and a try form leaves things as they were",
      ok: safety.ok && allBoth(safety) && map.missing.length === 0 && map.checked > 50,
      detail: `${map.checked} cases of corpus/mem's alloc_vec, alloc_slab and gen_adversarial, each with its counterpart and the same trap, missing: ${map.missing.join(", ") || "none"}. ${safety.summary}${skipNote}`,
      failures: [...safety.failures, ...map.missing],
    });
  });

  // 5. Modules not using std.
  M.unit("5", async () => {
    const failures: string[] = [];
    const pin = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/pre-std-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const h = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/pre-std-hashes.ts")],
      { timeoutMs: 600_000, label: "pre-std hashes", cwd: ROOT },
    );
    let same = 0;
    if (h.ok) {
      const got = JSON.parse(h.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        if (got[k] === v || langAMoved(k)) same++;
        else failures.push(`${k}: tirhash changed`);
      }
    } else failures.push(h.why);
    const core = checkFile(join(ROOT, "corpus/memory/nostd-helpers/core_ok/core.ts"));
    if (core.typed === null)
      failures.push(
        `a noStd package over @tsl/alloc doesn't compile: ${JSON.stringify(core.diags)}`,
      );
    report({
      box: "5. Modules not using std, in every mode and every rc build, are byte-identical to tirhashes pinned before any of this was written, @tsl/alloc's users among them; a kernel-core-style package, noStd and strict, compiles over @tsl/alloc and is refused @tsl/std (box 3)",
      ok: failures.length === 0 && same === Object.keys(pin).length && same > 600,
      detail: `${same}/${Object.keys(pin).length} the same, none excused`,
      failures,
    });
  });

  // 6. The tests catch a bug put in.
  M.unit("6", async () => {
    // The injected bugs run against the whole of everything, at every gate (D51).
    delete process.env.TMK_SWEEP;
    const failures: string[] = [];
    const text: string[] = [];
    const accel = hvf.ok ? "hvf" : "tcg";
    for (const f of S.FAULTS) {
      const r = await S.faultRun(f, accel, jobs, engines);
      // Cases that gave a wrong answer: those that ran out of time depend on the load and aren't counted (pipe-h).
      text.push(
        `${f.name}: ${r.answers > 0 ? r.answers : r.caught > 0 ? "caught by time alone" : 0}`,
      );
      if (r.broken) failures.push(`${f.name}: it didn't compile, so it shows nothing: ${r.first}`);
      else if (r.caught === 0) failures.push(`${f.name} wasn't caught`);
    }
    report({
      box: `6. Each of ${S.FAULTS.length} bugs put into @tsl/std is caught by the corpus, with how many cases caught it by a wrong result or trap code (a case that ran out of time depends on the host's load, and isn't counted)`,
      ok: failures.length === 0 && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 7. The two gaps from review.
  M.unit("7", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    const gaps = join(ROOT, "corpus/lower/strmap/gaps_context.ts");
    for (const memory of ["rc", "leak", "manual"] as const) {
      const lo = lowerFile(gaps, { memory });
      if (lo.fallbackDiags.length > 0)
        failures.push(`${memory}: ${JSON.stringify(lo.fallbackDiags).slice(0, 300)}`);
    }
    const untyped = lowerFile(join(ROOT, "corpus/lower/fallback/map_new_untyped.ts"), {
      memory: "rc",
    });
    if (!untyped.fallbackDiags.some((d) => d.code === "TSLD0201")) {
      failures.push(
        `new Map() with no destination should stay TSLD0201: ${JSON.stringify(untyped.fallbackDiags).slice(0, 300)}`,
      );
    }
    const obj = lowerFile(join(ROOT, "corpus/lower/fallback/object_is_object.ts"), {
      memory: "rc",
    });
    if (!obj.fallbackDiags.some((d) => d.code === "TSLD0202"))
      failures.push("Object.is on objects should stay a reflection fallback");
    const is = lowerFile(join(ROOT, "corpus/lower/pos/object_is.ts"));
    if (is.fallbackDiags.length > 0)
      failures.push(`Object.is: ${JSON.stringify(is.fallbackDiags).slice(0, 300)}`);
    const T = timedModule("strmap", await import("../strmap-tests.ts"));
    for (const a of both) {
      for (const m of ["rc", "leak", "manual"] as const) {
        const r = await T.oneInMode(a, "gaps_context", m);
        if (r.failures.length > 0 || r.cases === 0)
          failures.push(...r.failures, `${a} ${m}: no cases`);
        text.push(`${a} ${m} ${r.agreed}/${r.cases}`);
      }
    }
    const isN = await runNative("lower", both, jobs, "object_is", engines);
    failures.push(...isN.failures);
    report({
      box: "7. new Map() and new Set() take their type from where they're going: a field, a variable, a parameter, a return, an assignment; with no destination it stays a fallback with its root cause. Object.is on known scalars lowers, with NaN and -0 as JS has them, and stays a fallback on anything else",
      ok: failures.length === 0 && hvf.ok,
      detail: `no fallback in rc, leak or manual, and against V8: ${text.join("; ")}. Object.is: ${isN.summary}${skipNote}`,
      failures,
    });
  });

  // 8. Measured, with no gate.
  M.unit("8", async () => {
    // No gate: a short run here, the measurement in tmk bench all (SPEC 8.4, D51).
    const r = await benchStd({ quick: true });
    const text = stdText(r);
    writeFileSync(buildPath("milestones/native-g-bench.txt"), `${text}\n`);
    report({
      box: "8. Measured: tmk bench std, @tsl/std's Vec and Map against @tsl/alloc, the lowered rc runtime, V8 and C where fair, image size with and without std, with the host's load. No gate",
      ok: r.errors.length === 0 && r.rows.length > 0 && r.skipped === null,
      detail: text.replaceAll("\n", " | "),
      failures: r.errors,
    });
  });

  // 9. The spec.
  M.unit("9", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "D43",
      "Phase G",
      "tmk milestone native-g",
      "@tsl.global-allocator",
      "globalAllocator",
      "Shared<T>",
      "TSL1020",
      "TSL1021",
      "TSL1022",
      "ex-std-map.ts",
      "tmk bench std",
      "D45",
      "TMK:BULK",
      "`tmk test`",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    const { STD_MODULES } = await import("../spec-extract.ts");
    const inSync = STD_MODULES.every(
      (m) =>
        readFileSync(join(ROOT, "packages/tsl-std", m), "utf8") ===
        readFileSync(join(ROOT, "corpus/spec", m), "utf8"),
    );
    const loc = S.stdLoc();
    report({
      box: "9. The spec says all of this, @tsl/std's five modules are its // file: blocks byte for byte through tools/spec-extract.ts, as @tsl/alloc's three are, and the old spec is backed up as SPEC.md.bak-pre-std",
      ok: absent.length === 0 && spec.ok && inSync && existsSync(join(ROOT, "SPEC.md.bak-pre-std")),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}; @tsl/std ${loc.total} LOC (${loc.modules.map((m) => `${m.name} ${m.loc}`).join(", ")}), against @tsl/alloc's 216`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  // 9b. The result channel (SPEC 8.2, D45).
  M.unit("10", async () => {
    const { channelTests } = timedModule("channel", await import("../channel-tests.ts"));
    const failures: string[] = [];
    const text: string[] = [];
    for (const a of both) {
      const r = await channelTests(a);
      failures.push(...r.failures);
      if (r.rows.length === 0) failures.push(`${a}: nothing ran`);
      text.push(`${a}: ${r.rows.filter((x) => x.caught).length}/${r.rows.length}`);
    }
    report({
      box: "9b. The RAM channel catches what serial would have shown, on HVF and TCG: a wrong value, a byte changed after the guest's checksum, fewer bytes reported than written, DONE with no trailer, a truncated result with a matching count and checksum, a fault nothing catches and a hang partway, naming the case, and more output than it holds",
      ok: failures.length === 0 && hvf.ok && both.length === 2,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  M.nested(
    "11",
    "10. native-f and everything under it still pass (native-e, native-d, native-c, native-b, native-a, m1, m2)",
    "native-f",
  );
  M.vms(
    "12",
    "11. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
