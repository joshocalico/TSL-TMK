// native-f: `Map`, `Set` and run-time strings (SPEC 3.5, 4.5, D42).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { ROOT } from "../corpus.ts";
import {
  args,
  guardedRun,
  jobsFlag,
  langAMoved,
  needInstall,
  tmkOut,
  USE_STRMAP,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";
import { listSlice, seedSlice } from "../sweep.ts";

export async function defineNativeF(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const quick = args.includes("--quick");
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile } = timedModule("tslc", await import("../lowering.ts"));
  const T = timedModule("strmap", await import("../strmap-tests.ts"));
  const { strmapFuzz } = timedModule("strmapfuzz", await import("../strmap-fuzz.ts"));
  const { RC_BUDGET } = await import("../../compiler/host/down-rt.ts");
  const { benchStrmap, strmapText, benchCow } = timedModule(
    "bench",
    await import("../bench-strmap.ts"),
  );
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = hvf.ok ? ["hvf", "tcg"] : ["tcg"];
  const tallyOk = (t: {
    agreed: number;
    cases: number;
    failures: string[];
    skipped?: boolean;
  }): boolean => t.failures.length === 0 && t.agreed === t.cases && t.cases > 0;
  const tallyText = (t: { agreed: number; cases: number; programs: number }): string =>
    `${t.agreed}/${t.cases} cases in ${t.programs} images`;

  // 1. Everything in corpus/lower/strmap: word counts, tokenisers, a printer and parser, an LRU, graphs, group-by, builders.
  M.unit("1", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = true;
    for (const a of both) {
      const c = await T.corpusRun(a, jobs);
      for (const [mode, t] of Object.entries(c)) {
        if (!tallyOk(t)) ok = false;
        failures.push(...t.failures);
        text.push(`${a} ${mode} ${t.agreed}/${t.cases} in ${t.programs}`);
      }
    }
    report({
      box: "1. New corpus: word counts, tokenisers, a JSON-like printer and parser, an LRU with delete-and-reinsert, graph algorithms on Map<number, number[]>, group-by, dedupe by Set, string builders, every string method and Map and Set operation, all with --no-fallback, against V8, in rc, its poisoning build, leak and manual, on HVF and TCG",
      ok: ok && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // Hashing: what's visible can't depend on a key or an address.
  M.unit("2", async () => {
    const k = hvf.ok ? await T.hashKeyIndependence("hvf", jobs) : null;
    const direct = lowerFile(T.strmapFile("map_basic"), { memory: "rc" });
    const usesAddr = direct.tirText.includes("hashI32");
    report({
      box: "1b. No result depends on a hash key or an address: three other keys give every result of every Map program, against V8, and map_basic's addressFree moves objects' addresses by allocating first, with insertion order and V8's answer each time",
      ok: k !== null && tallyOk(k) && usesAddr,
      detail: `${k !== null ? tallyText(k) : "skipped"}${skipNote}`,
      failures: k?.failures ?? [],
    });
  });

  // 2. Number to text and back.
  M.unit("3", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = true;
    for (const a of both) {
      const d = await T.numberDifferential(a, jobs, 20000);
      if (!tallyOk(d) || d.doubles < 100000) ok = false;
      failures.push(...d.failures);
      text.push(
        `${a}: ${d.doubles} doubles to text, ${d.roundTrips} back again with noisy and truncated text, ${d.others} each-way others (random decimals, toFixed, toString(radix), parseInt), ${tallyText(d)}`,
      );
    }
    const edges = lowerFile(T.strmapFile("num_text"), { memory: "rc" }).fallbackDiags.length === 0;
    report({
      box: "2. Number to string and string to number against V8, natively, over at least 100,000 random doubles of every kind, plus subnormals, powers of ten, integers past 2^53, -0, NaN and infinities (num_text's own cases, in box 1), and toFixed, by exact integers (Burger and Dybvig, Clinger)",
      ok: ok && edges && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 3. Iteration under mutation.
  M.unit("4", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = true;
    const all = T.iterationCases().length;
    const runs: { a: "hvf" | "tcg"; rc: Record<string, unknown>; label: string }[] = [
      { a: "hvf", rc: { check: true, account: true }, label: "poison" },
      { a: "hvf", rc: {}, label: "release" },
      { a: "tcg", rc: {}, label: "release" },
      {
        a: "hvf",
        rc: { check: true, account: true, pace: false, budget: 1 },
        label: "poison, budget 1",
      },
      { a: "tcg", rc: { check: true, account: true }, label: "poison" },
    ];
    for (const r of runs) {
      if (r.a === "hvf" && !hvf.ok) continue;
      // A phase gate runs every 4th case, from an offset that turns, so four gates run them all (D51).
      const off = listSlice(`native-f 3 iteration ${r.a} ${r.label}`, [0, 1, 2, 3], 4);
      const t = await T.iterationExhaustive(
        r.a,
        jobs,
        r.rc,
        r.label,
        off.length === 4 ? 1 : 4,
        off.length === 4 ? 0 : off[0],
      );
      if (!tallyOk(t)) ok = false;
      failures.push(...t.failures);
      text.push(`${r.a} ${r.label}: ${tallyText(t)}`);
    }
    report({
      box: "3. Iteration under mutation, exhaustively: each of 12 operations (delete, set, delete and re-add, clear, clear and add, growth, compaction, deleting what's being visited) at every position, in 10 forms over a Map and 6 over a Set, with explicit iterators, iterators in step, iterators made before the change, and one that has finished staying finished, against V8",
      ok: ok && hvf.ok && all > 5000,
      detail: `${all} generated cases. ${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 4. The random programs, and proof they can catch something.
  M.unit("5", async () => {
    const budgets = [1, 2, 3, 5, 8, 13, 32];
    const failures: string[] = [];
    // A phase gate runs a quarter of the seeds, a different quarter each day (D51).
    const sH = seedSlice("native-f 4 strmap-fuzz HVF", 1, quick ? 40 : 400, 4);
    const sT = seedSlice("native-f 4 strmap-fuzz TCG", 5000, quick ? 10 : 60, 4);
    const h = hvf.ok ? await strmapFuzz(sH.start, sH.count, "hvf", jobs, budgets) : null;
    const t = await strmapFuzz(sT.start, sT.count, "tcg", jobs, budgets);
    if (h !== null) failures.push(...h.failures);
    failures.push(...t.failures);
    report({
      box: "4. Random programs over strings, Map and Set, extending tools/rc-fuzz.ts, in the poisoning build, at budgets from 1 to 32, against V8, with the objects holding maps that hold them",
      ok: failures.length === 0 && hvf.ok && (h?.ran ?? 0) > 0 && t.ran > 0,
      detail: `HVF ${h?.ran}/${h?.seeds} programs, ${h?.cases} cases, ${h?.freed} objects freed as cycles; TCG ${t.ran}/${t.seeds}, ${t.cases} cases, ${t.freed} freed${skipNote}`,
      failures,
    });
  });

  // 5. Under the collector, repeats, cycles and churn.
  M.unit("6", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = hvf.ok;
    for (const a of both) {
      const i = await T.underInterleaving(
        a,
        jobs,
        a === "hvf"
          ? listSlice("native-f 5 budgets HVF", [1, 2, 3, 5, 8, 16, 32], 2, [1, 2, 3])
          : [1, 3, 8],
      );
      if (!tallyOk(i)) ok = false;
      failures.push(...i.failures);
      text.push(
        `${a} at small budgets: ${tallyText(i)}, ${i.freed} freed as cycles, ${i.touches} touched during a scan`,
      );
      const l = await T.noLeak(a, jobs);
      if (l.failures.length > 0 || l.programs === 0) ok = false;
      failures.push(...l.failures);
      text.push(`${a} no leak over 4 repeats: ${l.programs} programs`);
      const c = await T.mapCycles(a);
      if (!c.ok) {
        ok = false;
        failures.push(
          `${a} cycles: ${c.why}, ${c.onLive} live with the collector and ${c.offLive} without`,
        );
      }
      text.push(
        `${a} cycles through a Map or Set: ${c.freed} freed, ${c.onLive} live after, against ${c.offLive} with the collector off`,
      );
    }
    report({
      box: "5. Everything that passes in rc also passes under the collector's interleaving at small budgets and repeats without leaking; cycles through a Map are collected; a churn of maps and strings far beyond the page limit completes in rc and traps 14 in leak and manual (rc_churn, in box 1)",
      ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 6. The bound.
  M.unit("7", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = hvf.ok;
    for (const a of both) {
      const b = await T.dropBound(a);
      if (!b.ok || b.maxSteps > RC_BUDGET || b.fullDrains !== 0) {
        ok = false;
        failures.push(`${a}: ${b.why}, max ${b.maxSteps} steps, ${b.fullDrains} full drains`);
      }
      text.push(
        `${a}: at most ${b.maxSteps} steps in any allocation over ${b.allocs} allocations and ${b.steps} steps, ${b.frees} freed, ${b.fullDrains} full drains`,
      );
    }
    report({
      box: `6. The freeing bound holds as a deterministic count, ${RC_BUDGET} steps an allocation, while dropping and clearing a 200,000-entry map with string keys, a 300,000-entry set, 200,000 strings in an array and 20,000 nested maps, under a 64 KiB stack`,
      ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 7. Strange strings.
  M.unit("8", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    let ok = hvf.ok;
    for (const a of both) {
      const t = await T.strangeMatrix(a, jobs, "rc", { check: true, account: true }, "poison");
      if (!tallyOk(t)) ok = false;
      failures.push(...t.failures);
      text.push(`${a}: ${tallyText(t)}`);
    }
    const cs: string[] = [];
    for (const a of both) {
      const c = await T.caseMappingAll(a, jobs);
      if (!tallyOk(c)) ok = false;
      failures.push(...c.failures);
      cs.push(`${a} ${tallyText(c)}`);
    }
    report({
      box: "7. Non-ASCII, emoji, lone surrogates and empty strings through every string method lowered, and across the ABI both ways, against V8; toUpperCase and toLowerCase against V8 on every code point there is",
      ok,
      detail: `${T.STRANGE.length} strings crossed with every method. ${text.join("; ")}. Case mapping: ${cs.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 8. Counts.
  M.unit("9", async () => {
    const c = T.loweringCounts();
    const beforeFallback =
      c.loweredInFallbackDir -
      USE_STRMAP.filter((p) => !c.blockers.some((b) => b.program === p)).length;
    const beforeTotal =
      c.lowered - USE_STRMAP.filter((p) => !c.blockers.some((b) => b.program === p)).length;
    const gapsOk = lowerFile(T.strmapFile("gaps"), { memory: "rc" }).fallbackDiags.length === 0;
    report({
      box: "8. Counts: programs under corpus/lower/fallback and in total that now lower in rc with no fallback, against before, with what still blocks each. The two gaps from review are closed",
      ok: c.lowered > beforeTotal && c.loweredInFallbackDir > beforeFallback && gapsOk,
      detail: `corpus/lower/fallback: ${c.loweredInFallbackDir}/${c.fallbackDir} now, ${beforeFallback}/${c.fallbackDir} before. All lowered programs: ${c.lowered}/${c.total} now, ${beforeTotal}/${c.total} before (before is now, less those of ${USE_STRMAP.length} programs that changed for this and now lower; the pins in box 9 say nothing else changed). Still blocked: ${c.blockers.map((b) => `${b.program.replace("corpus/lower/", "")} (${b.causes.join(", ")})`).join("; ")}`,
      failures: gapsOk ? [] : ["gaps.ts still falls back"],
    });
  });

  // 9. Nothing else moved, and the fuzz is shown to catch something.
  M.unit("10", async () => {
    const failures: string[] = [];
    const pin = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/pre-strings-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const h = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/pre-strings-hashes.ts")],
      {
        timeoutMs: 600_000,
        label: "pre-strings hashes",
        cwd: ROOT,
      },
    );
    let same = 0;
    const moved: string[] = [];
    if (h.ok) {
      const got = JSON.parse(h.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        if (got[k] === v) same++;
        else if (USE_STRMAP.some((p) => k.startsWith(`${p}@`)) && !k.endsWith("@strict"))
          moved.push(k);
        else if (langAMoved(k)) same++;
        else failures.push(`${k}: tirhash changed`);
      }
    } else failures.push(h.why);
    const faults = [
      "cursor-stale",
      "finished-wakes",
      "sees-deleted",
      "no-norm",
      "append-anywhere",
      "view-uncounted",
    ];
    const faultText: string[] = [];
    // Each bug's fuzz, and the omitted increment's, in a process of its own, two at once (T2, tools/parts.ts): the same
    // calls, read back in this order.
    const { inParts } = await import("../parts.ts");
    type FuzzCall = {
      from: number;
      seeds: number;
      accel: "hvf";
      jobs: number;
      budgets: number[];
      rcExtra: Record<string, unknown>;
    };
    const calls: FuzzCall[] = hvf.ok
      ? [
          ...faults.map((f) => ({
            from: 500,
            seeds: quick ? 30 : 120,
            accel: "hvf" as const,
            jobs,
            budgets: [1, 3, 8, 32],
            rcExtra: { rtFault: f },
          })),
          // The 40th increment is in mapAdvance now (D47), on the cursor's generation, which the random programs rarely
          // reach and corpus/lower/maps catches (maps box 7); the 30th is one these programs reach. Before, the 40th was.
          {
            from: 500,
            seeds: quick ? 30 : 60,
            accel: "hvf" as const,
            jobs,
            budgets: [32],
            rcExtra: { omitInc: 30 },
          },
        ]
      : [];
    const got = await inParts<FuzzCall, { failures: number; answers: number }>(
      "strmapFuzz",
      (c) => String(c.rcExtra.rtFault ?? `omit${String(c.rcExtra.omitInc)}`),
      calls,
    );
    for (const [i, f] of faults.entries()) {
      if (!hvf.ok) break;
      const n = got[i]!.failures;
      faultText.push(
        `${f}: ${got[i]!.answers > 0 ? got[i]!.answers : n > 0 ? "by time alone" : 0} failures`,
      );
      if (n === 0) failures.push(`the fuzz didn't catch the injected ${f}`);
    }
    const omit = hvf.ok ? got[faults.length]! : null;
    faultText.push(
      `an increment left out of the program: ${omit === null ? "skipped" : omit.answers > 0 ? omit.answers : omit.failures > 0 ? "by time alone" : 0} failures`,
    );
    if (omit !== null && omit.failures === 0)
      failures.push("the fuzz didn't catch an omitted increment");
    report({
      box: "9. strict, and rc, leak and manual modules using none of this, are byte-identical to tirhashes pinned before any of this was written, and the fuzz catches each bug put into the runtime",
      ok: failures.length === 0 && hvf.ok && same > 0,
      detail: `${same}/${Object.keys(pin).length} the same, in strict, leak, manual, rc, rc's test builds and rc with the collector off. Changed, and only in a mode, because they use these and were fallbacks for it: ${[...new Set(moved.map((k) => k.split("@")[0]))].join(", ")}. Injected: ${faultText.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 10. Fragmentation.
  M.unit("11", async () => {
    const failures: string[] = [];
    const text: string[] = [];
    for (const a of hvf.ok ? (["hvf"] as const) : (["tcg"] as const)) {
      const f = await T.fragmentation(a);
      failures.push(...f.failures);
      text.push(f.rows.map((r) => `${r.fn} runs in ${r.pages} pages`).join("; "));
    }
    report({
      box: "10. A churn of varied-length strings under a page limit doesn't hit a false trap 14: it completes in 512 pages, and here's the smallest limit each shape runs in",
      ok: failures.length === 0 && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 11. Measured, with no gate.
  M.unit("12", async () => {
    // No gate: short runs here, the measurement in tmk bench all (SPEC 8.4, D51).
    const r = await benchStrmap({ quick: true });
    const cow = await benchCow({ quick: true });
    const text = strmapText(r);
    writeFileSync(
      buildPath("milestones/native-f-bench.txt"),
      `${text}\n${JSON.stringify(cow, null, 1)}\n`,
    );
    report({
      box: "11. Measured: tmk bench strmap, the runtime's size in a module that uses it and in one that doesn't, and whether copy-on-write pays for arrays. No gate",
      ok: r.errors.length === 0 && r.rows.length > 0 && cow.errors.length === 0,
      detail: `${text.replaceAll("\n", " | ")} || copy-on-write's write test, plain then with it, ms: ${cow.rows.map((x) => `${x.fn}(${x.n}) ${x.plain.toFixed(3)} ${x.probed.toFixed(3)}`).join("; ")}, load ${cow.host.loadStart[0]?.toFixed(1)} to ${cow.host.loadEnd[0]?.toFixed(1)}`,
      failures: [...r.errors, ...cow.errors],
    });
  });

  // The spec.
  M.unit("13", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "D42",
      "Phase F",
      "tmk milestone native-f",
      "__str_place",
      "HalfSipHash",
      "copy-on-write",
      "compiler/rt",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    report({
      box: "11b. The spec says all of this, its code blocks with // file: are in sync through tools/spec-extract.ts, and the old one is backed up as SPEC.md.bak-pre-strings",
      ok: absent.length === 0 && spec.ok && existsSync(join(ROOT, "SPEC.md.bak-pre-strings")),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.nested(
    "14",
    "12. native-e and everything under it still pass (native-d, native-c, native-b, native-a, m1, m2)",
    "native-e",
  );
  M.vms(
    "15",
    "13. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
