// maps: two maps (D47), incremental `Map` growth, opaque `Map` and `Set` for native callers, and the fixes that came with them
// (SPEC 3.5, 4.5, D47, M5's Maps phase).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  caughtText,
  defaultEngines,
  faultCount,
  listPrograms,
  ROOT,
  type SuiteResult,
} from "../corpus.ts";
import { INT_MOVED, MAPS_MOVED, mapsMoved } from "../maps-pins.ts";
import { guardedRun, jobsFlag, needInstall, tmkOut, type MilestoneDef } from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

export async function defineMaps(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative, runLower } = timedModule("corpus", await import("../corpus.ts"));
  const { lowerFile } = timedModule("tslc", await import("../lowering.ts"));
  const T = timedModule("strmap", await import("../strmap-tests.ts"));
  const R = timedModule("rc", await import("../rc-tests.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
  const accels = hvf.ok ? (["hvf", "tcg"] as const) : (["tcg"] as const);
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
  type Tally = Awaited<ReturnType<typeof T.mapsCorpusRun>>[string];
  const tallyOk = (t: Tally): boolean =>
    t.failures.length === 0 && t.agreed === t.cases && t.cases > 0;

  // 1. Everything before, from this tree: lang-a, which runs opt-a, and through it everything else.
  M.nested(
    "1",
    "1. Every existing suite still passes: tmk milestone lang-a from this tree, which runs opt-a, native-g twice and through it native-f to native-a, m1 and m2, now with the incremental move under every Map and Set in lowered code, and @tsl/std's two maps",
    "lang-a",
  );

  // 2. Lowered Map and Set across the move: iteration, lookups, cycles, the ABI's view, against V8.
  M.unit("2", async () => {
    const text: string[] = [];
    const failures: string[] = [];
    let ok = true;
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        for (const a of accels) {
          const r = await T.mapsCorpusRun(a, jobs, {}, a === "tcg" ? ["rc+poison"] : undefined);
          for (const [mode, t] of Object.entries(r)) {
            if (!tallyOk(t)) ok = false;
            failures.push(...t.failures);
            text.push(`-O${level} ${a} ${mode} ${t.agreed}/${t.cases}`);
          }
        }
      });
    const progs = listPrograms(join(ROOT, "corpus/lower/maps"));
    report({
      box: "2. Lowered Map and Set across the incremental move (D47), against V8: every form of iterator over tables at and around the sizes where a move starts, with changes at chosen positions that start a move, run into one, or sleep through several; a cursor made mid-move; lookups, updates and deletes on keys the move has and hasn't reached, with number, string and object keys and counted values; tables shrinking through moves; cycles through maps that move; maps returned mid-move; in rc, its poisoning build, leak and manual, at -O0 and -O2, on HVF, and the poisoning build on TCG",
      ok: ok && hvf.ok,
      detail: `${progs.length} programs; ${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 3. rc under the move: no leak, the freeing bound with a table dropped mid-move.
  M.unit("3", async () => {
    const failures: string[] = [];
    const files = listPrograms(join(ROOT, "corpus/lower/maps")).filter(
      (f) => !/move_iter|drop_moving/.test(f),
    );
    const leak = await R.leakTest(accel, jobs, true, files);
    failures.push(...leak.failures);
    const bound = await R.boundTest(accel, join(ROOT, "corpus/lower/maps/drop_moving.ts"));
    if (!bound.ok || bound.maxSteps > bound.budget || bound.fullDrains !== 0)
      failures.push(`the freeing bound: ${JSON.stringify(bound).slice(0, 300)}`);
    report({
      box: "3. rc under the move: no leak over 4 repeats of the lookup, cycle and returned-map programs, with the collector on; a 131,072-object map and a 65,536-string set dropped mid-move, with a cursor's generation, freed within RC_BUDGET steps an allocation and no full drain",
      ok: failures.length === 0 && leak.rows.length > 0 && hvf.ok,
      detail: `no leak: ${leak.rows.filter((r) => !r.grew && r.skipped === undefined).length} of ${leak.rows.length}; bound ${bound.maxSteps} of ${bound.budget} steps, ${bound.fullDrains} full drains, ${bound.allocs} allocations${skipNote}`,
      failures,
    });
  });

  // 4. Measured: the worst single operation and the throughput. No gate on a time.
  M.unit("4", async () => {
    const { benchMaps, printMaps } = await import("../bench-maps.ts");
    const r = await benchMaps({ n: (1 << 20) + 1 });
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string): void => {
      lines.push(s);
    };
    try {
      printMaps(r);
    } finally {
      console.log = log;
    }
    report({
      box: "4. Measured: the worst single set, add or delete on a Map or Set grown to 2^20 entries and one more, by the counter around each call, and the throughput of a build and of a mix (tmk bench maps). No gate on a time",
      ok: r.errors.length === 0 && r.skipped === null,
      detail: lines.join("; "),
      failures: r.errors,
    });
  });

  // 5. Opaque at the native boundary: a caller reads a Map and a Set through accessors alone.
  M.unit("5", async () => {
    const { mapAbiTest } = await import("../map-abi-tests.ts");
    const failures: string[] = [];
    const text: string[] = [];
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        for (const a of accels) {
          const r = await mapAbiTest(a);
          failures.push(...r.failures.map((f) => `-O${level} ${a}: ${f}`));
          text.push(`-O${level} ${a} ${r.agreed}/${r.cases}`);
          if (r.agreed !== r.cases || r.cases === 0)
            failures.push(`-O${level} ${a}: ${r.agreed}/${r.cases}`);
        }
      });
    report({
      box: "5. Map and Set are opaque at the native boundary (4.5): DownMeta gives a caller no fields, only exports, size, has, iter, step, key and val (and make and put where one can be passed in), and a guest that walks maps an export returned, mid-move ones included, through those alone, says what V8 says, in the same order, at -O0 and -O2, on HVF and TCG",
      ok: failures.length === 0 && hvf.ok,
      detail: `${text.join("; ")}${skipNote}`,
      failures,
    });
  });

  // 6. @tsl/std: Map is JS's, ExactMap traps, and a scalar `V | undefined` is two registers.
  M.unit("6", async () => {
    const failures: string[] = [];
    const rows: SuiteResult[] = [];
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        for (const a of accels) rows.push(await runNative("std", [a], jobs, undefined, engines));
      });
    const s = suites(...rows);
    failures.push(...s.failures);
    const oracle = await tmkOut(tmk, "tools/std-map-oracle.ts");
    if (!oracle.ok) failures.push(`std-map-oracle: ${oracle.stdout.slice(0, 300)}`);
    const model = await tmkOut(tmk, "tools/std-oracle.ts");
    if (!model.ok) failures.push(`std-oracle: ${model.stdout.slice(0, 300)}`);
    // `get` of a u32 is a flag and a value, in registers, with no allocation (3.3 rule 12, D26).
    const { checkFile, compileTyped } = await import("../../compiler/host/tslc.ts");
    const c = checkFile(join(ROOT, "corpus/std/map_js.ts"));
    const o = c.typed !== null ? compileTyped(c.typed) : null;
    const get = o?.tir?.funcs.find((f) => f.name.startsWith("ex-std-map.Map<u32_u32>.get~"));
    const calls = (get?.blocks ?? []).flatMap((b) =>
      b.instrs
        .filter((i) => i.op === "call")
        .map((i) => (i.ops[0]?.t === "sym" ? i.ops[0].name : "")),
    );
    const rets = get?.rets ?? [];
    if (get === undefined) failures.push("no Map<u32, u32>.get in map_js's TIR");
    else if (
      JSON.stringify(rets) !== '["i32","i32"]' ||
      calls.some((n) => /alloc|Heap|Slab/.test(n))
    )
      failures.push(`Map<u32, u32>.get: ${JSON.stringify(rets)}, calls ${calls.join(", ")}`);
    report({
      box: "6. @tsl/std (D47): Map and Set are JS's, by JS's own Map and Set as oracle (tools/std-map-oracle.ts: get of a missing key, and every change at every position of a forEach, nested ones too, and random programs), and ExactMap traps 2 on a missing key and 13 on a change during forEach; the whole std corpus natively against V8 at -O0 and -O2, on HVF and TCG; Map<u32, u32>.get gives two i32 registers and allocates nothing",
      ok: failures.length === 0 && hvf.ok,
      detail: `${s.detail}; ${oracle.stdout.trim()}; ${model.stdout.trim()}; Map<u32, u32>.get returns ${JSON.stringify(rets)} and calls ${[...new Set(calls)].join(", ")}${skipNote}`,
      failures,
    });
  });

  // 7. Injected bugs, each caught.
  M.unit("7", async () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const fault of ["old-unchecked", "move-skips"]) {
      const r = await T.mapsCorpusRun(accel, jobs, { rtFault: fault });
      const n = Object.values(r).reduce((x, t) => x + t.failures.length, 0);
      const name =
        fault === "old-unchecked"
          ? "a lookup that checks only the new table during a move"
          : "a move that skips an entry";
      rows.push(`${name}: ${n > 0 ? "caught" : "MISSED"} (${n} failures)`);
      if (n === 0) failures.push(`missed: ${name}`);
    }
    // An increment left out on the cursor's generation path (the module's 40th, in mapAdvance): the poisoning build catches it.
    {
      const r = await T.mapsCorpusRun(accel, jobs, { omitInc: 40 }, ["rc+poison"]);
      const n = Object.values(r).reduce((x, t) => x + t.failures.length, 0);
      rows.push(
        `an increment left out of mapAdvance: ${n > 0 ? "caught" : "MISSED"} (${n} failures)`,
      );
      if (n === 0) failures.push("missed: an increment left out of mapAdvance");
    }
    const S = await import("../std-tests.ts");
    for (const f of S.FAULTS.filter((x) => /ExactMap|^Map/.test(x.name))) {
      const r = await S.faultRun(f, accel, jobs, engines);
      rows.push(`${f.name}: ${r.caught > 0 && !r.broken ? "caught" : "MISSED"} (${caughtText(r)})`);
      if (r.caught === 0 || r.broken) failures.push(`missed: ${f.name}`);
    }
    // A cast from unknown to a class that doesn't check (the lowering gaps, 4.5): rc-only's cast_lie pins the traps 17.
    {
      const r = await R.rcOnly(accel, jobs, { rtFault: "cast-unchecked" });
      rows.push(
        `a cast narrowing that doesn't check: ${r.failures.length > 0 ? "caught" : "MISSED"} (${faultCount(r.failures)})`,
      );
      if (r.failures.length === 0) failures.push("missed: a cast narrowing that doesn't check");
    }
    report({
      box: "7. Injected bugs, each caught: a lookup that checks only the new table during a move, a move that skips an entry, ExactMap not trapping (on a missing key, and on a delete during forEach), Map giving a value for a missing key, Map compacting or losing its place on clear during forEach, and a cast narrowing that doesn't check",
      ok: failures.length === 0 && hvf.ok,
      detail: rows.join("; "),
      failures,
    });
  });

  // 8. The lowering gaps from language phase A's review.
  M.unit("8", async () => {
    const failures: string[] = [];
    const rows: SuiteResult[] = [];
    let pinned = 0;
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        for (const memory of ["rc", "leak", "manual"] as const)
          rows.push(await runNative("exc", [accel], jobs, "cast_unknown", engines, memory));
        // Integers past i32 and 2^53 (4.5): f64 where a range isn't proved, never a trap where V8 gives a result.
        rows.push(await runNative("lower", [accel], jobs, "int_overflow", engines));
        rows.push(await runNative("lower", [accel], jobs, "int_overflow", engines, "rc"));
        rows.push(await runLower(jobs, "int_overflow", engines));
        const r = await R.rcOnly(accel, jobs);
        failures.push(...r.failures.map((f) => `rc-only -O${level}: ${f}`));
        pinned += r.cases;
      });
    const s = suites(...rows);
    failures.push(...s.failures);
    for (const memory of ["rc", "leak", "manual"] as const) {
      const lo = lowerFile(join(ROOT, "corpus/lower/exc/cast_unknown.ts"), { memory });
      if (lo.fallbackDiags.length > 0)
        failures.push(`cast_unknown ${memory}: ${JSON.stringify(lo.fallbackDiags).slice(0, 300)}`);
    }
    // A read before a field is set still falls back; a write doesn't.
    const fb = lowerFile(join(ROOT, "corpus/lower/exc-fallback/field_before_init.ts"), {
      memory: "rc",
    });
    for (const fn of ["early", "bumped"])
      if (fb.fallbackDiags.find((d) => d.fn === fn)?.blocker !== "field-before-init")
        failures.push(`field_before_init: ${fn} should stay field-before-init`);
    report({
      box: "8. Lowering gaps (4.5): (e as Error).message and .cause on a caught unknown, as a checked narrowing that traps 17 on a lie (pinned in corpus/lower/rc-only/cast_lie.ts), and casts to string, number and boolean; Number() of an unknown, by JS's ToNumber; a base constructor writing a field a subclass declares lowers, and only a read (or +=) before it's set falls back; with no fallback, against V8, in rc, leak and manual at -O0 and -O2; and integers past i32 and 2^53 (int_overflow: sums, products, factorials, counters bounded by a parameter) giving V8's result where they used to trap 1, in strict, rc and on Wasm at -O0 and -O2",
      ok: failures.length === 0 && hvf.ok,
      detail: `${s.detail}; rc-only ${pinned} pinned cases${skipNote}`,
      failures,
    });
  });

  // 9. Pins.
  M.unit("9", async () => {
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
    const moved = new Set<string>();
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
        else if (mapsMoved(k)) moved.add(k.split("@")[0]!);
        else failures.push(`${p.file}: ${k} moved, and it uses none of this`);
      }
    }
    // The maps corpus and std's two maps, pinned from here on, at -O0 and -O2.
    const pinFile = join(ROOT, "corpus/memory/maps-tirhash.json");
    const now: Record<string, string> = {};
    // The exceptions corpus too: lang-a's pins of it moved with the lowering gaps' runtime (tools/maps-pins.ts).
    for (const f of [
      ...listPrograms(join(ROOT, "corpus/lower/maps")),
      ...listPrograms(join(ROOT, "corpus/lower/exc")),
    ])
      for (const l of [0, 2] as const)
        now[`${relative(ROOT, f)}@rc@O${l}`] = lowerFile(f, { memory: "rc", opt: l }).tirHash;
    if (!existsSync(pinFile)) writeFileSync(pinFile, `${JSON.stringify(now, null, 1)}\n`);
    const mp = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string>;
    const mmoved = Object.keys(mp).filter((k) => mp[k] !== now[k]);
    failures.push(...mmoved.map((k) => `${k}: moved from corpus/memory/maps-tirhash.json`));
    const unused = [...Object.keys(MAPS_MOVED), ...Object.keys(INT_MOVED)].filter(
      (p) => !moved.has(p),
    );
    report({
      box: "9. Pins: every tirhash pinned before is byte-identical for a module that uses none of this; the ones that move are listed with why (tools/maps-pins.ts): a module that uses Map or Set, @tsl/std's maps, or throws, and every lowered program whose integer arithmetic isn't proved to fit i32 and is f64 now, strict's included; TSL proper's don't move; the maps corpus and the exceptions corpus pinned again at -O0 and -O2 in corpus/memory/maps-tirhash.json",
      ok: failures.length === 0,
      detail: `${same} of ${total} the same; moved, as listed: ${moved.size} programs (${[...moved].slice(0, 12).join(", ")}${moved.size > 12 ? ", ..." : ""}); listed and not moved here: ${unused.length}; ${Object.keys(mp).length} new pins, ${mmoved.length} moved`,
      failures,
    });
  });

  // 10. The gate's own fixes.
  M.unit("10", async () => {
    const failures: string[] = [];
    const { suiteCountDiffs } = await import("../gate.ts");
    const a = [
      { name: "x", counts: { n: 1 } },
      { name: "y", counts: { n: 2 } },
      { name: "y", counts: { n: 2 } },
    ];
    // A suite only one run kept, by time, isn't a difference; a count that differs is.
    if (
      suiteCountDiffs(a, [
        { name: "y", counts: { n: 2 } },
        { name: "z", counts: { n: 9 } },
      ]).length !== 0
    )
      failures.push("a list that differs by time was a difference");
    if (suiteCountDiffs(a, [{ name: "x", counts: { n: 3 } }]).length !== 1)
      failures.push("a count that differs wasn't found");
    const { metaOf } = await import("../registry.ts");
    const w = metaOf("native-d", "4").jobs;
    if (w === undefined || w >= 4) failures.push("native-d box 4 isn't given fewer suites at once");
    report({
      box: "10. The gate: tmk gate --sample compares the counts of the suites both runs kept, not which ones a time filter kept (the false alarm on opt-a's box 4); native-d's box 4 runs 2 suites at once rather than 4, so it's further from the watchdog (its peak is in the gate's manifest)",
      ok: failures.length === 0,
      detail: `native-d box 4: ${w ?? "-"} suites at once`,
      failures,
    });
  });

  // 11. The spec.
  M.unit("11", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = ["ExactMap", "D47", "tmk milestone maps", "Maps phase", "mapIter", "TmkOld"];
    const absent = wanted.filter((w) => !specText.includes(w));
    report({
      box: "11. The spec says all of this (3.3, 3.5, 3.10, 4.5, the working rules, 8.3, 9.3, M5's Maps phase and D47), its // file: blocks are in sync, and it was backed up first as SPEC.md.bak-pre-maps",
      ok: absent.length === 0 && spec.ok && existsSync(join(ROOT, "SPEC.md.bak-pre-maps")),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.vms(
    "12",
    "12. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
