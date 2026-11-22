// lang-a: language phase A, exceptions and class inheritance in down-lowered code (SPEC 4.5, D48, D49, D50).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, faultCount, listPrograms, ROOT, type SuiteResult } from "../corpus.ts";
import { LANG_A_MOVED } from "../lang-a-pins.ts";
import { INT_MOVED, MAPS_MOVED, mapsMoved } from "../maps-pins.ts";
import {
  coverageRun,
  guardedRun,
  jobsFlag,
  needInstall,
  tmkOut,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";
import { seedSlice, sliceGenerated } from "../sweep.ts";
import { firstInOrder } from "../stable.ts";

export async function defineLangA(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative, runLower } = timedModule("corpus", await import("../corpus.ts"));
  const { lowerFile } = timedModule("tslc", await import("../lowering.ts"));
  const { excFuzz } = timedModule("excfuzz", await import("../exc-fuzz.ts"));
  const R = timedModule("rc", await import("../rc-tests.ts"));
  const O = timedModule("opt", await import("../opt-tests.ts"));
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
  const withLevel = async <T>(level: string, run: () => Promise<T>): Promise<T> => {
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
  const poison = {
    rc: { check: true, account: true },
    harness: { collect: true },
    suffix: "-poison-on",
  };

  // 1. Everything before, from this tree: opt-a, which runs native-g at -O0 and -O2, and through it everything else,
  // with the exceptions corpus in every memory mode and rc's tests among them.
  M.nested(
    "1",
    "1. Every existing suite still passes, at -O0 and -O2: tmk milestone opt-a from this tree, which runs native-g twice and through it native-f to native-a, m1 and m2, now with the exceptions and classes corpus in every memory mode, rc's no-leak repeats and its counters",
    "opt-a",
  );

  // 2. The exceptions and classes corpus: every mode, the poisoning build, -O0 and -O2, HVF and TCG.
  M.unit("2", async () => {
    const rows: SuiteResult[] = [];
    for (const level of ["0", "2"]) {
      await withLevel(level, async () => {
        for (const a of hvf.ok ? (["hvf", "tcg"] as const) : (["tcg"] as const)) {
          rows.push(await runNative("exc", [a], jobs, undefined, engines, "rc"));
          rows.push(await runNative("exc", [a], jobs, undefined, engines, "rc", poison));
          rows.push(await runNative("exc", [a], jobs, undefined, engines, "leak"));
          rows.push(await runNative("exc", [a], jobs, undefined, engines, "manual"));
        }
      });
    }
    const s = suites(...rows);
    const progs = listPrograms(join(ROOT, "corpus/lower/exc")).filter(
      (f) => !/gen_finally/.test(f),
    );
    report({
      box: "2. Exceptions and classes natively, against V8: the parser with error recovery, the validation library's error hierarchy, the retry loop with finally, using under throw, the interpreter that throws for return and break, shapes, an AST with visitors, an event system, exceptions through every kind of frame, every kind of thrown value, runtime errors as exceptions, the freeing-bound and exhaustion programs, and the generated finally tests; in rc, its poisoning build, leak and manual, at -O0 and -O2, on HVF and TCG",
      ok: s.ok && hvf.ok,
      detail: `${progs.length} named programs and ${listPrograms(join(ROOT, "corpus/lower/exc")).length - progs.length} generated; ${s.detail}${skipNote}`,
      failures: s.failures,
    });
  });

  // 3. Every way out of every position of a try, nested two deep.
  M.unit("3", async () => {
    const { POSITIONS, EXITS } = await import("../exc-gen.ts");
    const rows: SuiteResult[] = [];
    for (const level of ["0", "2"])
      await withLevel(level, async () => {
        rows.push(await runNative("exc", [accel], jobs, "gen_finally", engines, "rc", poison));
      });
    const s = suites(...rows);
    report({
      box: `3. Exhaustive control flow through finally: ${EXITS.length} ways out (${EXITS.join(", ")}) from each of ${POSITIONS.length} positions, inside a try sitting in each position of another with the same, ${POSITIONS.length ** 3 * EXITS.length ** 2} functions with and without catch bindings, each run thrown-through and not, against V8, in rc's poisoning build at -O0 and -O2`,
      ok: s.ok && hvf.ok,
      detail: `${s.detail}${skipNote}`,
      failures: s.failures,
    });
  });

  // 4. Random programs with exceptions.
  M.unit("4", async () => {
    // A phase gate runs a quarter of the seeds, a different quarter each day (D51).
    const sa = seedSlice("lang-a 4 exc-fuzz -O0", 1, 120, 4);
    const sb = seedSlice("lang-a 4 exc-fuzz -O2", 1001, 120, 4);
    const sc = seedSlice("lang-a 4 exc-fuzz TCG", 5001, 20, 4);
    const a = await excFuzz(sa.start, sa.count, accel, jobs, { level: 0 });
    const b = await excFuzz(sb.start, sb.count, accel, jobs, { level: 2 });
    const c = await excFuzz(sc.start, sc.count, "tcg", jobs, { level: 2 });
    const all = [a, b, c];
    report({
      box: "4. Random programs with try, catch and finally in every arrangement, every control flow out of them, throws of errors, subclasses, numbers and strings, closures and callbacks that throw, overriding methods and counted objects: against V8 in rc's poisoning build at freeing budgets 1 to 32, and after a reset that drops every global, nothing alive; at -O0 and -O2, HVF and TCG",
      ok: all.every((x) => x.failures.length === 0 && x.ran === x.seeds && !x.skipped),
      detail: `-O0: ${a.ran}/${a.seeds} programs, ${a.cases} cases (${a.threw} thrown to the caller); -O2: ${b.ran}/${b.seeds}, ${b.cases} (${b.threw}); TCG at -O2: ${c.ran}/${c.seeds}, ${c.cases}; fell back ${a.fellBack + b.fellBack + c.fellBack}, leaked ${a.leaked + b.leaked + c.leaked}`,
      failures: all.flatMap((x) => x.failures),
    });
  });

  // 5. rc and the collector under exceptions.
  M.unit("5", async () => {
    const failures: string[] = [];
    const leak = await R.leakTest(accel, jobs, true);
    const excRows = leak.rows.filter((r) => r.program.startsWith("corpus/lower/exc/"));
    failures.push(...leak.failures);
    const bound = await R.boundTest(accel, join(ROOT, "corpus/lower/exc/adv_exc_drop.ts"));
    if (!bound.ok || bound.maxSteps > bound.budget || bound.fullDrains !== 0)
      failures.push(`the freeing bound with exceptions: ${JSON.stringify(bound).slice(0, 300)}`);
    const budgets: SuiteResult[] = [];
    for (const budget of [1, 2, 3, 8])
      budgets.push(
        await runNative("exc", [accel], jobs, undefined, engines, "rc", {
          rc: { check: true, account: true, budget },
          harness: { collect: true },
          suffix: `-poison-b${budget}`,
        }),
      );
    const b = suites(...budgets);
    failures.push(...b.failures);
    report({
      box: "5. rc under exceptions: what every frame holds is released exactly once when an exception leaves it, temporaries mid-expression and a block's result included (the poisoning build at freeing budgets 1, 2, 3 and 8, and the collector run after each case); no leak over 4 repeats, every exceptions program; the freeing bound with a million-node list dropped by an exception and by a caught error; exhaustion while making an Error is trap 14 (exc_exhaust); a value held only by the exception in flight lives until caught",
      ok: failures.length === 0 && hvf.ok,
      detail: `no leak: ${excRows.filter((r) => r.skipped === undefined && !r.grew).length} of ${excRows.length} exceptions programs (${
        excRows
          .filter((r) => r.skipped !== undefined)
          .map((r) => r.program)
          .join(", ") || "none left out"
      }), ${leak.rows.length} programs in all; bound ${bound.maxSteps} of ${bound.budget} steps, ${bound.fullDrains} full drains, ${bound.allocs} allocations; ${b.detail}${skipNote}`,
      failures,
    });
  });

  // 6. Runtime failures: exceptions where V8 throws and something can catch, traps where TSL's own checks are.
  M.unit("6", async () => {
    const rows: SuiteResult[] = [];
    for (const a of hvf.ok ? (["hvf", "tcg"] as const) : (["tcg"] as const))
      rows.push(await runNative("exc", [a], jobs, "runtime_errors", engines, "rc"));
    const s = suites(...rows);
    report({
      box: "6. Traps versus exceptions (3.10): RangeError for a string too long, a bad repeat count, toFixed and toString arguments, a bad code point, a bad array length, and recursion too deep (a stack test in each recursive function), each caught as V8's is, on HVF and TCG; TSL's own checks stay traps",
      ok: s.ok && hvf.ok,
      detail: `${s.detail}${skipNote}`,
      failures: s.failures,
    });
  });

  // 7. Classes: what lowers, and what's a fallback with its root cause.
  M.unit("7", async () => {
    const failures: string[] = [];
    const f = lowerFile(join(ROOT, "corpus/lower/exc-fallback/field_before_init.ts"), {
      memory: "rc",
    });
    const hit = f.fallbackDiags.find((d) => d.fn === "early");
    if (hit?.blocker !== "field-before-init")
      failures.push(`field_before_init: ${JSON.stringify(f.fallbackDiags).slice(0, 300)}`);
    const shapes = lowerFile(join(ROOT, "corpus/lower/exc/class_shapes.ts"), {
      memory: "rc",
      opt: 0,
    });
    const order = lowerFile(join(ROOT, "corpus/lower/exc/class_init_order.ts"), {
      memory: "rc",
      opt: 0,
    });
    for (const o of [shapes, order])
      if (o.fallbackDiags.length > 0) failures.push(JSON.stringify(o.fallbackDiags).slice(0, 300));
    const switches = (shapes.tirText.match(/^\s+switch /gm) ?? []).length;
    report({
      box: "7. Classes (D50): extends, super() and super.method(), overriding with dispatch on a class id, abstract classes, protected, getters, instanceof across a hierarchy, extends Error and the standard errors, static members inherited, and field initialisation in JS's order including a base constructor that reaches an override reading a field not yet set (as undefined where its type allows; a fallback, field-before-init, where it doesn't)",
      ok: failures.length === 0,
      detail: `class_shapes and class_init_order lower with no fallback (${switches} dispatch switches in class_shapes at -O0); field_before_init falls back with ${hit?.blocker ?? "nothing"}`,
      failures,
    });
  });

  // 8. The boundary: a native caller, and a JS host.
  M.unit("8", async () => {
    const rows: SuiteResult[] = [];
    rows.push(
      await runNative("exc", [accel], jobs, undefined, engines, "rc", {
        rc: {},
        harness: { excTrap: true },
        suffix: "-exctrap",
      }),
    );
    rows.push(await runLower(jobs, "js_throw_through", engines));
    const s = suites(...rows);
    report({
      box: "8. Across the boundary (D36): a native caller that doesn't take exceptions gets the trap path, reported with the thrown value's class, name, message and cause, the same shape V8's caller sees; one that calls __exc_catch_use(1) takes it with __exc_pending and __exc_take (every other box); on a JS host, a JS fallback that throws through lowered Wasm reaches the caller as the same exception",
      ok: s.ok && hvf.ok,
      detail: `${s.detail}${skipNote}`,
      failures: s.failures,
    });
  });

  // 9. Injected bugs, each caught.
  M.unit("9", async () => {
    // A phase gate runs a quarter of the generated `finally` programs here too: every bug is caught outside them, in every
    // quarter (MEASURED, M5's record). The random programs below are the same seeds at every gate (D51).
    const faults: { name: string; env: string; how: "corpus" | "fuzz" }[] = [
      {
        name: "a missed release on the exceptional path",
        env: '{"fault":"no-release-path"}',
        how: "fuzz",
      },
      // A missing check is caught by the next one while the exception is still in flight, unless something observable
      // happens in between: exc_effects.ts puts an effect straight after each of its 7 calls to a throwing function.
      ...[0, 1, 2, 3, 4, 5, 6].map((at) => ({
        name: `a missed check after a call (the ${at + 1}${["st", "nd", "rd"][at] ?? "th"} to a throwing function)`,
        env: `{"fault":"no-check","at":${at}}`,
        how: "corpus" as const,
      })),
      {
        name: "finally run after the way out it should come before",
        env: '{"fault":"finally-late"}',
        how: "corpus",
      },
      {
        name: "a wrong vtable slot (each class its neighbour's method)",
        env: '{"fault":"wrong-slot"}',
        how: "corpus",
      },
      {
        name: "a wrong instanceof (a class without its subclasses)",
        env: '{"fault":"wrong-instanceof"}',
        how: "corpus",
      },
      {
        name: "an initialiser-order mistake (fields before super())",
        env: '{"fault":"init-order"}',
        how: "corpus",
      },
    ];
    const rows: string[] = [];
    const failures: string[] = [];
    for (const f of faults) {
      const was = process.env.TMK_TEST_EXC;
      process.env.TMK_TEST_EXC = f.env;
      // R38: these bugs are down.ts's and down-exc.ts's, which in rc only the direct route compiles now that auto takes
      // a program with exceptions through class printing there (TRUSTED_EXC_IN rc): the corpus is built through it by name
      const wasRoute = process.env.TMK_ROUTE;
      if (f.how === "corpus") process.env.TMK_ROUTE = "direct";
      let caught = false;
      let by = "";
      try {
        if (f.how === "fuzz") {
          const r = await excFuzz(1, 40, accel, jobs, { level: 0, exc: f.env });
          caught = r.failures.length > 0;
          by = `${faultCount(r.failures)} failures in ${r.ran} random programs`;
        } else {
          const r = await runNative("exc", [accel], jobs, undefined, engines, "rc");
          caught = !r.ok;
          by = `${faultCount(r.failures)} failures, first ${firstInOrder(r.failures)?.slice(0, 80) ?? "-"}`;
        }
      } finally {
        if (was === undefined) delete process.env.TMK_TEST_EXC;
        else process.env.TMK_TEST_EXC = was;
        if (wasRoute === undefined) delete process.env.TMK_ROUTE;
        else process.env.TMK_ROUTE = wasRoute;
      }
      rows.push(`${f.name}: ${caught ? "caught" : "MISSED"} (${by})`);
      if (!caught) failures.push(`missed: ${f.name}`);
    }
    report({
      box: "9. Injected bugs, each caught: a missed release on the exceptional path, a missed check after a call, a wrong finally ordering, a wrong vtable slot, a wrong instanceof, an initialiser-order mistake",
      ok: failures.length === 0 && hvf.ok,
      detail: rows.join("; "),
      failures,
    });
  });

  // 10. The optimiser and calls that can throw.
  M.unit("10", async () => {
    const failures: string[] = [];
    const c = await O.corpusCounters(accel, jobs, 2, ["corpus/lower/exc"]);
    failures.push(...c.failures);
    // What -O2 did with throwing callees: inlined, and the code after a throw gone.
    let inlinedThrowing = 0;
    let removed = 0;
    // A phase gate looks at a quarter of the generated `finally` programs, a different quarter each day (D51).
    for (const f of sliceGenerated(listPrograms(join(ROOT, "corpus/lower/exc")))) {
      const o0 = lowerFile(f, { memory: "rc", opt: 0 });
      const o2 = lowerFile(f, { memory: "rc", opt: 2 });
      if (o0.tir === null || o2.tir === null || o2.opt === undefined) continue;
      const throwing = new Set(
        o0.tir.funcs
          .filter((fn) =>
            fn.blocks.some((bl) =>
              bl.instrs.some(
                (i) =>
                  i.op === "globaladdr" && i.ops[0]?.t === "sym" && i.ops[0].name === "__exc_val",
              ),
            ),
          )
          .map((fn) => fn.name),
      );
      inlinedThrowing += o2.opt.remarks.filter(
        (r) => (r.how === "inlined" || r.how === "partial") && throwing.has(r.callee),
      ).length;
      const blocks = (m: typeof o0.tir): number =>
        m!.funcs.reduce((n, fn) => n + fn.blocks.length, 0);
      removed += Math.max(0, blocks(o0.tir) - blocks(o2.tir));
    }
    if (inlinedThrowing === 0) failures.push("nothing that throws was inlined at -O2");
    const verify = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        tmk,
        "lower",
        "corpus/lower/exc/exc_paths.ts",
        "--memory",
        "rc",
        "-O2",
        "--emit",
        "tir",
      ],
      {
        timeoutMs: 120_000,
        label: "verify after every pass",
        cwd: ROOT,
        env: { ...process.env, TMK_OPT_VERIFY: "1" },
      },
    );
    if (!verify.ok) failures.push(`the verifier after every pass: ${verify.stderr.slice(0, 300)}`);
    report({
      box: "10. The optimiser and calls that can throw: a throw is a store and a jump, a check a load and a branch, so every pass sees ordinary control flow. Over the exceptions corpus every result and every rc counter is the same at -O0 and -O2, case by case; the verifier passes after every pass; -O2 inlines throwing callees and removes what a throw leaves dead; the keep rule is unchanged, and the random programs of box 4 agree at both levels",
      ok: failures.length === 0 && c.ran > 0 && hvf.ok,
      detail: `${c.ran} programs, ${c.cases} cases, ${c.counters} counter values the same at -O0 and -O2; ${inlinedThrowing} calls to functions that throw inlined at -O2; ${removed} blocks fewer at -O2${skipNote}`,
      failures,
    });
  });

  // 11. Coverage, as a number (D48).
  M.unit("11", async () => {
    const r = await coverageRun({
      real: true,
      compiler: ROOT,
      budgetMs: 120_000,
      jobs,
      label: "lang-a",
    });
    const before = join(ROOT, "corpus/real/coverage-before.json");
    const was = existsSync(before)
      ? (JSON.parse(readFileSync(before, "utf8")) as { rows: import("../coverage.ts").Coverage[] })
          .rows
      : [];
    const C = await import("../coverage.ts");
    const pair = (name: string): string => {
      const a = was.find((x) => x.name === name);
      const b = r.rows.find((x) => x.name === name);
      return `${name} ${a !== undefined ? C.percent(a) : "?"} -> ${b !== undefined ? C.percent(b) : "?"}`;
    };
    report({
      box: "11. tmk coverage: the fraction of functions that lower natively in rc, by root cause, over every local corpus and the pinned real projects (corpus/real/manifest.json, fetched by tmk corpus-fetch), before this work (corpus/real/coverage-before.json, from the tree as it was) and now",
      ok: r.failures.length === 0 && was.length > 0,
      detail: ["local-before", "local", "real projects, in total"].map(pair).join("; "),
      failures: r.failures,
    });
  });

  // 12. Measured: costs and code, and S4.
  M.unit("12", async () => {
    const { benchExc, excText } = timedModule("bench", await import("../bench-exc.ts"));
    // No gate: short runs here, the measurements in tmk bench all (SPEC 8.4, D51).
    const b = await benchExc({ quick: true });
    writeFileSync(buildPath("milestones/lang-a-bench.json"), JSON.stringify(b, null, 2));
    const { benchNative } = timedModule("bench", await import("../bench-native.ts"));
    const s4 = (await withLevel("2", () => benchNative({ quick: true, label: "lang-a" }))).s4;
    writeFileSync(buildPath("milestones/lang-a-s4.json"), JSON.stringify(s4, null, 2));
    report({
      box: "12. Measured, no gate: a try that nothing throws through, a call that can throw against one that can't, throw and catch across 1, 10 and 100 frames against V8, code size, with host load; and S4 again",
      ok: b.errors.length === 0 && b.skipped === null,
      detail: `${excText(b).split("\n").join(" | ")}; S4: ${JSON.stringify(s4).slice(0, 400)}`,
      failures: b.errors,
    });
  });

  // 13. Pins.
  M.unit("13", async () => {
    const failures: string[] = [];
    const h = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/pre-std-hashes.ts")],
      {
        timeoutMs: 900_000,
        label: "pre-std hashes",
        cwd: ROOT,
      },
    );
    const pin = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/pre-std-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const strictPin = JSON.parse(
      readFileSync(join(ROOT, "corpus/memory/strict-tirhash.json"), "utf8"),
    ) as Record<string, string>;
    const s = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/strict-hashes.ts")],
      {
        timeoutMs: 900_000,
        label: "strict hashes",
        cwd: ROOT,
      },
    );
    let same = 0;
    const moved: string[] = [];
    if (!h.ok || !s.ok) failures.push(`${h.why} ${s.why}`);
    else {
      const got = JSON.parse(h.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        if (got[k] === v) same++;
        else if (
          (Object.keys(LANG_A_MOVED).some((p) => k.startsWith(`${p}@`)) &&
            !k.endsWith("@strict")) ||
          mapsMoved(k)
        )
          moved.push(k);
        else failures.push(`${k}: moved, and it uses none of this`);
      }
      const gs = JSON.parse(s.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(strictPin))
        if (gs[k] !== v && !mapsMoved(k)) failures.push(`${k}: strict moved`);
    }
    // The exceptions corpus, pinned from here on, at -O0 and -O2.
    const pinFile = join(ROOT, "corpus/memory/lang-a-tirhash.json");
    const now: Record<string, string> = {};
    for (const f of listPrograms(join(ROOT, "corpus/lower/exc")))
      for (const l of [0, 2] as const) {
        const o = lowerFile(f, { memory: "rc", opt: l });
        now[`${relative(ROOT, f)}@rc@O${l}`] = o.tirHash;
      }
    if (!existsSync(pinFile)) writeFileSync(pinFile, `${JSON.stringify(now, null, 1)}\n`);
    const lp = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string>;
    const lmoved = Object.keys(lp).filter((k) => lp[k] !== now[k]);
    // The maps phase moves some, each listed with why, and pins them again (tools/maps-pins.ts, `tmk milestone maps`).
    failures.push(
      ...lmoved
        .filter((k) => !mapsMoved(k))
        .map((k) => `${k}: moved from corpus/memory/lang-a-tirhash.json`),
    );
    report({
      box: "13. Pins: every -O0 tirhash pinned before is byte-identical for modules that use none of this, strict's all of them; the ones that move are listed with why (tools/lang-a-pins.ts); the exceptions corpus pinned at -O0 and -O2 in corpus/memory/lang-a-tirhash.json",
      ok: failures.length === 0,
      detail: `${same} of ${Object.keys(pin).length} the same; moved, as listed: ${[...new Set(moved.map((k) => k.split("@")[0]))].map((p) => `${p} (${LANG_A_MOVED[p!] ?? MAPS_MOVED[p!] ?? INT_MOVED[p!]})`).join("; ")}; ${Object.keys(lp).length} new pins, ${lmoved.length} moved`,
      failures,
    });
  });

  // 14. The spec.
  M.unit("14", async () => {
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "D49",
      "D50",
      "Language phase A",
      "tmk milestone lang-a",
      "tmk coverage",
      "__exc_take",
      "SuppressedError",
      "field-before-init",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    report({
      box: "14. The spec says all of this (1.2, 3.10, 4.5, 8.1, 9.2, 9.3, Appendix A, M5's Language phase A, D36, D48, D49 and D50), its // file: blocks are in sync, and it was backed up first as SPEC.md.bak-pre-lang-a",
      ok: absent.length === 0 && spec.ok && existsSync(join(ROOT, "SPEC.md.bak-pre-lang-a")),
      detail: `missing: ${absent.join(", ") || "nothing"}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.vms(
    "15",
    "15. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
