// opt-a: the optimiser's levels, its pass manager, the inliner and the cleanup it needs (SPEC 4.1, 4.3, D44, D46).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, relative } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, listPrograms, ROOT } from "../corpus.ts";
import {
  guardedRun,
  jobsFlag,
  langAMoved,
  needInstall,
  tmkOut,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";
import { seedSlice } from "../sweep.ts";

export async function defineOptA(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { lowerFile, checkFile, compileTyped } = timedModule(
    "tslc",
    await import("../lowering.ts"),
  );
  const P = await import("../../compiler/tir/passes/manager.ts");
  const O = timedModule("opt", await import("../opt-tests.ts"));
  const { tirFuzz } = timedModule("tirfuzz", await import("../tir-fuzz.ts"));
  const { lowerAndBuild } = await import("../compile-pool.ts");
  const tmk = join(ROOT, "tools/tmk.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const accel = hvf.ok ? ("hvf" as const) : ("tcg" as const);
  const withEnv = async <T>(
    env: Record<string, string | undefined>,
    run: () => Promise<T>,
  ): Promise<T> => {
    const was: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      was[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await run();
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const lowerCli = async (env: Record<string, string>, ...a: string[]): Promise<string> => {
    const base = { ...process.env };
    delete base.TMK_OPT;
    const r = await guardedRun(process.execPath, ["--no-warnings", tmk, "lower", ...a], {
      timeoutMs: 120_000,
      label: `tmk lower ${a.join(" ")}`,
      cwd: ROOT,
      env: { ...base, ...env },
    });
    return r.ok ? r.stdout : `FAILED ${r.why} ${r.stderr.slice(0, 300)}`;
  };
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  // Every lowered and TSL program, at a level, for the stats and remarks the boxes below read.
  const corpusReports = (
    level: 0 | 1 | 2,
  ): {
    name: string;
    m: import("../../compiler/tir/ir.ts").Module;
    r: import("../../compiler/tir/passes/manager.ts").OptReport;
  }[] => {
    const out: {
      name: string;
      m: import("../../compiler/tir/ir.ts").Module;
      r: import("../../compiler/tir/passes/manager.ts").OptReport;
    }[] = [];
    for (const d of [
      "corpus/lower/pos",
      "corpus/lower/rc",
      "corpus/lower/strmap",
      "corpus/lower/memory",
    ]) {
      for (const f of listPrograms(join(ROOT, d))) {
        const o = lowerFile(f, { memory: "rc", opt: level });
        if (o.tir !== null && o.opt !== undefined)
          out.push({ name: `${relative(ROOT, f)}@rc`, m: o.tir, r: o.opt });
      }
    }
    for (const d of ["corpus/pos", "corpus/trap", "corpus/mem", "corpus/std", "corpus/spec"]) {
      for (const f of listPrograms(join(ROOT, d))) {
        const c = checkFile(f);
        if (c.typed === null) continue;
        const o = compileTyped(c.typed, { opt: level });
        out.push({ name: relative(ROOT, f), m: o.tir, r: o.opt });
      }
    }
    return out;
  };

  M.unit("1", async () => {
    // 1. Levels, threaded through.
    const failures: string[] = [];
    const file = "corpus/lower/pos/class_struct.ts";
    const h: string[] = [];
    for (const l of ["-O0", "-O1", "-O2"])
      h.push(sha(await lowerCli({}, file, "--memory", "rc", l, "--emit", "tir")));
    const lib0 = lowerFile(join(ROOT, file), { memory: "rc", opt: 0 });
    const viaDefault = sha(await lowerCli({}, file, "--memory", "rc", "--emit", "tir"));
    const viaEnv = sha(await lowerCli({ TMK_OPT: "1" }, file, "--memory", "rc", "--emit", "tir"));
    if (new Set(h).size !== 3) failures.push(`tmk lower -O0, -O1, -O2 should differ on ${file}`);
    if (h[0] !== sha(lib0.tirText)) failures.push("tmk lower -O0 isn't the library's -O0");
    if (viaDefault !== h[2]) failures.push("tmk lower with no level isn't -O2");
    if (viaEnv !== h[1]) failures.push("TMK_OPT=1 doesn't reach tmk lower");
    const tir = async (l: string): Promise<string> => {
      const r = await guardedRun(
        process.execPath,
        ["--no-warnings", tmk, "tir", "corpus/pos/inline_rules.ts", l],
        {
          timeoutMs: 120_000,
          label: `tmk tir ${l}`,
          cwd: ROOT,
        },
      );
      return r.stdout;
    };
    const t0 = await tir("-O0");
    const t2 = await tir("-O2");
    if (t0 === t2 || !t0.includes("tirhash") || !t2.includes("tirhash"))
      failures.push("tmk tir -O2 should differ from -O0 on inline_rules.ts");
    const worker = await withEnv({ TMK_OPT: "2" }, () =>
      lowerAndBuild({ file: join(ROOT, file), lower: { memory: "rc" }, cases: [] }),
    );
    if (worker.o.opt?.level !== 2)
      failures.push(`a test worker under TMK_OPT=2 built at -O${worker.o.opt?.level}`);
    const same = P.optimizeModule(lib0.tir!, { level: 0 }).module === lib0.tir;
    if (!same) failures.push("-O0 isn't the input untouched");
    report({
      box: "1. -O0, -O1 and -O2 for tmk lower, tmk compile and tmk tir (tslc), and every test harness, through TMK_OPT to its workers and children, threaded to TIR. -O0 is the module as lowered, the same object. tmk lower's default is -O2 (D44)",
      ok: failures.length === 0,
      detail: `${file}: -O0 ${h[0]!.slice(0, 12)}, -O1 ${h[1]!.slice(0, 12)}, -O2 ${h[2]!.slice(0, 12)}; no level given: ${viaDefault === h[2] ? "-O2" : "NOT -O2"}; a worker under TMK_OPT=2: -O${worker.o.opt?.level}`,
      failures,
    });
  });

  M.unit("2", async () => {
    // 2. The pass manager.
    const failures: string[] = [];
    const text: string[] = [];
    const broken = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        tmk,
        "lower",
        "corpus/lower/rc/adv_control_paths.ts",
        "--memory",
        "rc",
        "-O2",
        "--emit",
        "tir",
      ],
      {
        timeoutMs: 120_000,
        label: "a pass that breaks TIR",
        cwd: ROOT,
        env: { ...process.env, TMK_OPT_FAULT: "dce-drop-live", TMK_OPT_VERIFY: "1" },
      },
    );
    const named = /TIR verifier, after dce on @/.test(broken.stderr);
    if (broken.ok || !named)
      failures.push(
        `a broken pass should be named by the verifier: ${broken.stderr.slice(0, 300)}`,
      );
    // `keep` is the one pass that's an obligation, not an optimisation: off, a load -O0 ran can go, which is box 12's
    // keep-off bug. It can be switched off to bisect, and isn't expected to agree then.
    for (const pass of P.PASSES.filter((p) => p !== "keep")) {
      const r = await withEnv({ TMK_OPT_DISABLE: pass }, () => tirFuzz(500, 12, accel, jobs));
      text.push(`${pass} off: ${r.ran}/${r.seeds}`);
      failures.push(...r.failures.map((x) => `${pass} off: ${x}`));
      if (r.skipped || r.ran === 0) failures.push(`${pass} off: nothing ran`);
    }
    report({
      box: "2. A pass manager: the verifier on the input and output always, and after every pass in a test build, naming the pass that broke it; each pass switched off by name (--no-pass, TMK_OPT_DISABLE), and random TIR still agrees with -O0 with each optimisation off (keep, the obligation that a load -O0 ran still runs, is box 12's keep-off when it's off)",
      ok: failures.length === 0 && hvf.ok,
      detail: `a dce that drops a live value: ${named ? 'caught, "after dce on @..."' : "NOT named"}; ${text.join(", ")}${skipNote}`,
      failures,
    });
  });

  M.unit("3", async () => {
    // 3. Remarks.
    const out = await lowerCli(
      {},
      "corpus/lower/rc/adv_control_paths.ts",
      "--memory",
      "rc",
      "--report",
      "-O2",
    );
    const tsl = await lowerCli(
      {},
      "corpus/lower/pos/alloc_rules.ts",
      "--memory",
      "rc",
      "--report",
      "-O2",
    );
    const want = [
      /^optimiser -O2: \d+ calls inlined, \d+ partly/m,
      /^ {2}inlined @\S+ into @\S+.*: .*\[cost \d+, threshold \d+\]/m,
      /^ {2}partial @\S+ into @\S+.*side-effect-free entry/m,
      /^ {2}not inlined @\S+ into @\S+.*too big/m,
    ];
    const missing = want.filter((re) => !re.test(out)).map(String);
    if (!/not inlined @deep into @deep.*recursive/.test(tsl))
      missing.push("a recursive call's reason, in alloc_rules.ts");
    report({
      box: "3. Optimisation remarks in tmk lower --report: what was inlined where, partly or whole, what was made direct, and why not, with cost and threshold",
      ok: missing.length === 0,
      detail: `${out.split("\n").find((l) => l.startsWith("optimiser")) ?? "no summary"}; missing: ${missing.join(", ") || "nothing"}`,
      failures: missing,
    });
  });

  // Boxes 4, 5 and 10 read every program's -O0 and -O2 report.
  M.unit("4-5,10", async () => {
    const at2 = corpusReports(2);
    const at0 = corpusReports(0);
    // 4. The inliner.
    {
      const failures: string[] = [];
      const unit = await guardedRun(
        process.execPath,
        ["--test", "--no-warnings", join(ROOT, "compiler/tir/passes/passes.test.ts")],
        {
          timeoutMs: 120_000,
          label: "the passes' unit tests",
          cwd: ROOT,
        },
      );
      if (!unit.ok) failures.push(`unit tests: ${unit.stdout.slice(-600)}`);
      const all = at2.flatMap((x) => x.r.remarks);
      const did = all.filter((r) => r.how === "inlined" || r.how === "partial");
      const count = (pred: (r: (typeof all)[number]) => boolean): number => all.filter(pred).length;
      const kinds = {
        "small or leaf": did.filter((r) => /leaf|small|constant/.test(r.why)).length,
        "made direct (a known closure or function value)": count((r) => r.how === "devirtualized"),
        "rc's fast paths": did.filter((r) =>
          /^__rc_(new|inc|dec|zero|cand|touch|chk|retain|release)/.test(r.callee),
        ).length,
        "__rc_new, in a loop": did.filter((r) => r.callee === "__rc_new").length,
        "@tsl/alloc and @tsl/std methods": did.filter((r) =>
          /^ex-(vec|slab|heap|std-[a-z]+)\./.test(r.callee),
        ).length,
        "Vec and Map accessors": did.filter(
          (r) =>
            /(Vec|Map)(<[^>]*>)?\.(get|set|has|get_length|length|size|at|check)\b/.test(r.callee) ||
            /^__(vec|map)_/.test(r.callee),
        ).length,
        "recursion refused": count((r) => r.how === "not inlined" && r.why.startsWith("recursive")),
        "@tsl.inline": did.filter((r) => r.why === "@tsl.inline").length,
        "@tsl.noinline refused": count(
          (r) => r.how === "not inlined" && r.why.includes("@tsl.noinline"),
        ),
      };
      for (const [k, n] of Object.entries(kinds))
        if (n === 0) failures.push(`nothing in the corpus at -O2 shows: ${k}`);
      // A noalloc function's direct callees are noalloc at -O0, and nothing inlining did may change that.
      const violations = (set: typeof at2): Set<string> => {
        const out = new Set<string>();
        for (const { name, m } of set) {
          const by = new Map(m.funcs.map((f) => [f.name, f]));
          for (const f of m.funcs) {
            if (!f.attrs.includes("noalloc")) continue;
            for (const b of f.blocks)
              for (const ins of b.instrs) {
                const s = ins.op === "call" ? ins.ops[0] : undefined;
                const g = s?.t === "sym" ? by.get(s.name) : undefined;
                if (g !== undefined && !g.attrs.includes("noalloc"))
                  out.add(`${name}: @${f.name} calls @${g.name}`);
              }
          }
        }
        return out;
      };
      const v0 = violations(at0);
      const newV = [...violations(at2)].filter((x) => !v0.has(x));
      if (newV.length > 0) failures.push(...newV.map((x) => `noalloc no longer holds: ${x}`));
      const noallocFns = at2.reduce(
        (n, x) => n + x.m.funcs.filter((f) => f.attrs.includes("noalloc")).length,
        0,
      );
      report({
        box: "4. The inliner, by a cost model D46 explains: small and leaf functions, calls through known closures and function values made direct, rc's fast paths (__rc_new and the count functions), @tsl/alloc and @tsl/std methods, Vec and Map accessors; recursion and mutual recursion refused, growth limited, @tsl.inline and @tsl.noinline honoured, several results, and @tsl.noalloc facts still holding; with its unit tests",
        ok: failures.length === 0,
        detail: `${Object.entries(kinds)
          .map(([k, n]) => `${k} ${n}`)
          .join(
            "; ",
          )}; ${noallocFns} noalloc functions, none calling one that isn't; unit tests ${unit.ok ? "pass" : "FAIL"}`,
        failures,
      });
    }
    // 5. The cleanup passes.
    {
      const s = {
        folded: 0,
        identities: 0,
        checks: 0,
        params: 0,
        branches: 0,
        merged: 0,
        forwarded: 0,
        removed: 0,
        dead: 0,
        deadParams: 0,
        promoted: 0,
        kept: 0,
      };
      for (const { r } of at2) {
        s.folded += r.simplify.folded;
        s.identities += r.simplify.identities;
        s.checks += r.simplify.checks;
        s.params += r.simplify.params;
        s.branches += r.cfg.branches;
        s.merged += r.cfg.merged;
        s.forwarded += r.cfg.forwarded;
        s.removed += r.cfg.removed;
        s.dead += r.dce.instrs;
        s.deadParams += r.dce.params;
        s.promoted += r.sroa.promoted;
        s.kept += r.keptLoads;
      }
      const zero = Object.entries(s).filter(([k, v]) => v === 0 && k !== "kept");
      report({
        box: "5. The cleanup inlining needs, each doing work across the corpus at -O2: constant folding, copy propagation (block parameters given one value), dead code, branch folding and block merging, and scalar replacement of frame slots; checks removed only where constants prove them",
        ok: zero.length === 0,
        detail: `over ${at2.length} modules: ${s.folded} folded, ${s.identities} identities, ${s.checks} checks proved by constants, ${s.params} parameters made copies, ${s.branches} branches folded, ${s.merged} blocks merged, ${s.forwarded} jumps forwarded, ${s.removed} blocks unreachable, ${s.dead} dead instructions and ${s.deadParams} dead parameters, ${s.promoted} frame slots made values, ${s.kept} loads kept`,
        failures: zero.map(([k]) => `${k}: none`),
      });
    }
    // 10. Traps and where they're reported.
    {
      const failures: string[] = [];
      let sites = 0;
      const key = (t: { kind: string; code: number; loc: string; msg?: string }): string =>
        `${t.kind} ${t.code} ${t.loc} ${t.msg ?? ""}`;
      const by0 = new Map(at0.map((x) => [x.name, new Set(x.m.traps.map(key))]));
      for (const { name, m } of at2) {
        const before = by0.get(name);
        if (before === undefined) continue;
        for (const t of m.traps) {
          sites++;
          if (!before.has(key(t)))
            failures.push(`${name}: a trap site -O0 doesn't have: ${key(t)}`);
        }
      }
      report({
        box: "10. Traps: the same code at every level (every trap corpus, native and on V8, at -O0, -O1 and -O2 in boxes 7 to 9, and the fuzz in box 11); a trap reports its code, and where the spec gives a location it's the trap site's, which inlining copies with its id and never changes, so no location moves",
        ok: failures.length === 0 && sites > 0,
        detail: `${sites} trap sites in ${at2.length} modules at -O2, each one of -O0's (kind, code, location and message)`,
        failures: failures.slice(0, 20),
      });
    }
  });

  // Measures: -O1's compile time against -O0's is a gate on times, so it runs in the gate's quiet phase (SPEC 8.4, D51).
  M.unit("6", async () => {
    // 6. What's in each level, and what -O1 costs to compile.
    const t = await O.compileTimes();
    const c0 = t.corpus.find((x) => x.level === 0)!.ms;
    const c1 = t.corpus.find((x) => x.level === 1)!.ms;
    const c2 = t.corpus.find((x) => x.level === 2)!.ms;
    writeFileSync(buildPath("milestones/opt-a-compile.json"), JSON.stringify(t, null, 2));
    report({
      box: "6. Levels (D46): -O1 is folding, copy propagation, dead code, branch folding and block merging, and inlining only where the call is bigger than the callee or the callee is a leaf costing up to 16 at a call in a loop (B3), one function at a time; -O2 adds the whole program: the call graph, inlining by cost, partial inlining, calls made direct, scalar replacement, more rounds. -O1's compile time within 25% of -O0's over the corpus, measured cold and warm",
      ok: c1 <= c0 * 1.25,
      detail: `corpus, ${t.corpus[0]!.programs} programs in one process: -O0 ${c0.toFixed(0)} ms, -O1 ${c1.toFixed(0)} ms (${(c1 / c0).toFixed(2)}x), -O2 ${c2.toFixed(0)} ms (${(c2 / c0).toFixed(2)}x); ${t.rows.map((r) => `${r.what} -O${r.level} cold ${r.coldMs.toFixed(0)}, warm ${r.warmMs.toFixed(0)}`).join("; ")}; load ${loadavg()[0]!.toFixed(1)}`,
      failures: [],
    });
  });

  M.unit("11", async () => {
    // 11. Differential fuzz, no V8.
    const failures: string[] = [];
    // A phase gate runs a quarter of the seeds, a different quarter each day (D51).
    const q1 = seedSlice("opt-a 11 tir-fuzz HVF", 1000, 200, 4);
    const q2 = seedSlice("opt-a 11 tir-fuzz TCG", 2000, 40, 4);
    const q3 = seedSlice("opt-a 11 rc source diff HVF", 1000, 60, 4);
    const q4 = seedSlice("opt-a 11 rc source diff TCG", 2000, 15, 4);
    const t1 = await tirFuzz(q1.start, q1.count, accel, jobs);
    const t2 = await tirFuzz(q2.start, q2.count, "tcg", jobs);
    const s1 = await O.sourceDiff(q3.start, q3.count, accel, jobs);
    const s2 = await O.sourceDiff(q4.start, q4.count, "tcg", jobs);
    for (const [n, r] of [
      ["TIR on HVF", t1],
      ["TIR on TCG", t2],
      ["rc on HVF", s1],
      ["rc on TCG", s2],
    ] as const) {
      failures.push(...r.failures.map((x) => `${n}: ${x}`));
      if (r.skipped || r.ran === 0) failures.push(`${n}: nothing ran`);
    }
    report({
      box: "11. Differential fuzz with no V8: random TIR (multiple returns, recursion, calls through pointers, every trap, frame slots, switches, constants at each type's edges) at -O0, -O1 and -O2, and rc's random programs at -O0 and -O2 with every counter compared, natively on HVF and TCG",
      ok: failures.length === 0 && hvf.ok,
      detail: `TIR: HVF ${t1.ran}/${t1.seeds} programs, ${t1.cases} cases, ${t1.traps} trapped (${JSON.stringify(t1.trapCodes)}), ${t1.inlined} calls inlined; TCG ${t2.ran}/${t2.seeds}, ${t2.cases} cases. rc: HVF ${s1.ran}/${s1.seeds} programs, ${s1.cases} cases, ${s1.counters} counters; TCG ${s2.ran}/${s2.seeds}, ${s2.cases} cases, ${s2.counters} counters${skipNote}`,
      failures: failures.slice(0, 30),
    });
  });

  M.unit("12", async () => {
    // Each bug is caught by the random TIR or rc's random programs, whose seeds are the same at every gate; the corpus
    // after them, and the run with no bug, take a phase gate's quarter of the generated `finally` programs (D51).
    // 12. Not vacuous.
    const rows = await O.faultsCaught(accel, jobs);
    const missed = rows.filter((r) => !r.caught || r.fault === "(none)");
    writeFileSync(buildPath("milestones/opt-a-faults.json"), JSON.stringify(rows, null, 2));
    report({
      box: `12. Not vacuous: each of ${P.OPT_FAULTS.length} bugs put into the passes is caught (a wrong fold, a check folded that overflows, a dropped side effect, a value dropped that's live, swapped parameters, an inlined check made unable to trap, results reversed, a slow path that runs a store twice, an rc count missed, a load left unkept; R15's: a test's answer taken where its edge doesn't dominate, a versioning guard one turn short, a bound the loop changes read once for the guard, a guard against the wrong length; R20's: partial inlining taking a callee's entry with a frame slot as free of effects), and with none in, every test passes`,
      ok: missed.length === 0 && rows.length === P.OPT_FAULTS.length && hvf.ok,
      detail:
        rows.map((r) => `${r.fault}: ${r.caught ? `caught by ${r.by}` : "MISSED"}`).join("; ") +
        skipNote,
      failures: missed.map((r) => `${r.fault}: ${r.detail || "missed"}`),
    });
  });

  M.unit("13", async () => {
    // 13. Pins.
    const failures: string[] = [];
    const pinFile = join(ROOT, "corpus/memory/opt-tirhash.json");
    const pin = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string>;
    const node = await guardedRun(
      process.execPath,
      ["--no-warnings", join(ROOT, "tools/opt-hashes.ts")],
      {
        timeoutMs: 900_000,
        label: "opt hashes on Node",
        cwd: ROOT,
      },
    );
    const bun = await guardedRun(defaultEngines().bun, [join(ROOT, "tools/opt-hashes.ts")], {
      timeoutMs: 900_000,
      label: "opt hashes on Bun",
      cwd: ROOT,
    });
    let same = 0;
    if (!node.ok) failures.push(`Node: ${node.why}`);
    else {
      const got = JSON.parse(node.stdout) as Record<string, string>;
      for (const [k, v] of Object.entries(pin)) {
        if (got[k] === v || langAMoved(k)) same++;
        else failures.push(`${k}: tirhash moved`);
      }
    }
    const bunSame = bun.ok && bun.stdout === node.stdout;
    if (!bunSame) failures.push(`Bun and Node differ: ${bun.why}`);
    report({
      box: "13. Pins: -O0 byte-identical to before (every tirhash pinned before this work, in boxes 7 and 8, strict's among them); -O1 and -O2 pinned in corpus/memory/opt-tirhash.json; the same bytes from Node and from Bun",
      ok: failures.length === 0 && same === Object.keys(pin).length && same > 1000,
      detail: `${same}/${Object.keys(pin).length} -O1 and -O2 tirhashes the same; Node and Bun ${bunSame ? "byte-identical" : "DIFFER"}`,
      failures: failures.slice(0, 20),
    });
  });

  M.unit("14", async () => {
    // 14. Safety facts survive.
    const failures: string[] = [];
    const c = await O.corpusCounters(accel, jobs);
    failures.push(...c.failures);
    const { boundTest, cycleBound, interleave } = timedModule("rc", await import("../rc-tests.ts"));
    const { underInterleaving } = timedModule("strmap", await import("../strmap-tests.ts"));
    const extra = await withEnv({ TMK_OPT: "2" }, async () => {
      const b = await boundTest(accel);
      const cb = await cycleBound(accel);
      const il = await interleave(accel, jobs, [1, 2, 3]);
      const ui = await underInterleaving(accel, jobs, [1, 3]);
      return { b, cb, il, ui };
    });
    if (!extra.b.ok || extra.b.maxSteps > extra.b.budget || extra.b.fullDrains !== 0)
      failures.push(`the freeing bound at -O2: ${JSON.stringify(extra.b).slice(0, 300)}`);
    if (extra.cb.maxSteps > extra.cb.budget || extra.cb.fullDrains !== 0)
      failures.push(`the collector's bound at -O2: ${JSON.stringify(extra.cb).slice(0, 300)}`);
    failures.push(...extra.il.failures, ...extra.ui.failures);
    report({
      box: "14. Safety facts survive: over rc's corpus, every counter the same at -O0 and -O2, case by case (increments, decrements, allocations, frees, live objects and bytes, steps, the largest step count in one allocation, full drains, and the collector's scans, touches, freed and the rest), so counts and the barrier happen exactly when they did; checks are kept or proved; the freeing bound, the collector's bound and its interleavings at budgets 1 to 3 re-run at -O2",
      ok: failures.length === 0 && c.ran > 0 && hvf.ok,
      detail: `${c.ran} programs, ${c.cases} cases, ${c.counters} counter values the same; at -O2: freeing bound ${extra.b.maxSteps} of ${extra.b.budget} steps, ${extra.b.fullDrains} full drains, ${extra.b.allocs} allocations; collector ${extra.cb.maxSteps} of ${extra.cb.budget}, ${extra.cb.freed} freed; interleavings ${extra.il.cases} cases at 1 to 3, ${extra.ui.cases} over Map, Set and strings at 1 and 3${skipNote}`,
      failures: failures.slice(0, 20),
    });
  });

  M.unit("15", async () => {
    // 15. What it bought: calls, and size.
    const calls = await O.callCounts(accel, jobs);
    const sizes = await O.codeSizes();
    writeFileSync(
      buildPath("milestones/opt-a-calls.json"),
      JSON.stringify({ calls, sizes }, null, 2),
    );
    const pct = (a: number, b: number): string => `${(100 * (1 - b / a)).toFixed(1)}%`;
    report({
      box: "15. Measured: calls the inliner removed, in the module and at run time over rc's corpus, and code size per level. No gate",
      ok: calls.failures.length === 0 && calls.programs > 0,
      detail: `${calls.programs} programs: calls in the module ${calls.staticBefore} at -O0, ${calls.staticAfter} at -O2 (${pct(calls.staticBefore, calls.staticAfter)} fewer); calls made at run time ${calls.dynamicBefore} at -O0, ${calls.dynamicAfter} at -O2 (${pct(calls.dynamicBefore, calls.dynamicAfter)} fewer). Code: ${sizes.rows.map((r) => `${r.what}, ${r.programs} programs: -O0 ${r.bytes[0]}, -O1 ${r.bytes[1]}, -O2 ${r.bytes[2]} bytes`).join("; ")}${skipNote}`,
      failures: calls.failures,
    });
  });

  M.unit("16", async () => {
    // 16. The spec.
    const spec = await tmkOut(tmk, "tools/spec-extract.ts");
    const specText = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const wanted = [
      "D46",
      "Optimiser phase A",
      "tmk milestone opt-a",
      "TMK_OPT",
      "opt-tirhash.json",
      "partial inlining",
      "__opt_keep",
      "--no-pass",
    ];
    const absent = wanted.filter((w) => !specText.includes(w));
    const stale = specText.includes("All unbuilt: today `-O0` and `-O1` are one pipeline");
    report({
      box: "16. The spec says all of this (4.1, 4.3, 3.10, 8.1, 9.2, 9.3, D44, D46, S4's record and M5's Optimiser phase A), its // file: blocks are in sync, and it was backed up first as SPEC.md.bak-pre-opt-a",
      ok:
        absent.length === 0 && !stale && spec.ok && existsSync(join(ROOT, "SPEC.md.bak-pre-opt-a")),
      detail: `missing: ${absent.join(", ") || "nothing"}; D44 still says unbuilt: ${String(stale)}; ${spec.stdout.trim().slice(0, 160)}`,
      failures: spec.ok ? [] : [spec.stdout.slice(0, 600)],
    });
  });

  M.nested(
    "7",
    "7. Same behaviour at -O0: native-g and everything under it (native-f, -e, -d, -c, -b, -a, m1, m2), every corpus, mode and build, every tirhash pinned before, with TMK_OPT=0",
    "native-g",
    "0",
  );
  M.nested(
    "8",
    "8. Same behaviour at -O2: native-g and everything under it, every corpus, mode and build (V8 and JSC references, rc release, poisoning and collector budgets, leak, manual, strict, @tsl/std, @tsl/alloc's safety suites), on HVF and TCG where each runs today, the freeing bound and the collector's interleavings at small budgets among them, with TMK_OPT=2",
    "native-g",
    "2",
  );
  M.tier(
    "9",
    "9. A smaller set at -O1: the quick tier with TMK_OPT=1, every native corpus on HVF, TCG's share, rc's and the collector's tests, the Map, Set and strings suites, and the fuzzers",
    "1",
  );
  M.vms(
    "17",
    "17. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
