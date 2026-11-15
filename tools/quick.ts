// `tmk test`: the tier a builder runs after each change (SPEC 8.1, D45). It runs the same tests as the milestones, on fewer
// configurations, so a failure here means what it means there. It proves nothing a milestone proves: only a milestone from
// `tmk clean` counts as verified. Each step is a job of `tmk gate`'s pool (D51), and says what it reads, for `--changed`.
// `tmk test --catch-rate` measures what it catches, with the bugs the tools already know how to inject.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as corpus from "./corpus.ts";
import { defaultEngines, ROOT, type SuiteResult } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { buildPath } from "./build-dir.ts";
import { jobsFlag, repoChecks, unitTests, type MilestoneDef } from "./tmk-common.ts";
import { timedFn } from "./timing.ts";

const runLower = timedFn("corpus.runLower", corpus.runLower);
const runNative = timedFn("corpus.runNative", corpus.runNative);
const runNegative = timedFn("corpus.runNegative", corpus.runNegative);
const runPositive = timedFn("corpus.runPositive", corpus.runPositive);
const runTrap = timedFn("corpus.runTrap", corpus.runTrap);

/**
 * One step. `data` is what it reads besides code (directories and files under the repo, "*" for everything), and `mods`
 * the test modules it loads, so `tmk test --changed` can tell what a change can reach (SPEC 9.3, D51).
 */
export interface Step {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string; failures: string[] }>;
  data?: string[];
  mods?: string[];
}

const fromSuite = (s: SuiteResult): { ok: boolean; detail: string; failures: string[] } => ({
  ok: s.ok,
  detail: s.summary,
  failures: s.failures,
});

const fromTally = (t: {
  failures: string[];
  skipped?: boolean;
}): { ok: boolean; detail: string; failures: string[] } => ({
  ok: t.failures.length === 0 && t.skipped !== true,
  detail: Object.entries(t)
    .filter(
      ([k, v]) => typeof v === "number" && /^(agreed|cases|programs|images|ran|seeds)$/.test(k),
    )
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(", "),
  failures: t.failures,
});

/** A step run with the optimiser at a level, for it and everything it starts (SPEC 9.2, D44). */
function atLevel(level: "1" | "2", s: Step): Step {
  return {
    ...s,
    name: `-O${level}: ${s.name}`,
    run: async () => {
      const was = process.env.TMK_OPT;
      process.env.TMK_OPT = level;
      try {
        return await s.run();
      } finally {
        if (was === undefined) delete process.env.TMK_OPT;
        else process.env.TMK_OPT = was;
      }
    },
  };
}

/** What `corpus --native` reads for a kind and mode (tools/corpus.ts runNative). */
function nativeData(kind: string, memory?: string): string[] {
  const lowered = ["compiler/rt", "packages"];
  if (kind === "exc") return ["corpus/lower/exc", ...lowered];
  if (kind === "lower")
    return memory === undefined
      ? ["corpus/lower/pos", "corpus/native", ...lowered]
      : ["corpus/lower", "corpus/native", ...lowered];
  if (kind === "mem") return ["corpus/mem", "corpus/spec", "packages"];
  return [`corpus/${kind}`, "packages"];
}

export function steps(jobs: number): Step[] {
  const engines = defaultEngines();
  const hvf = ["hvf"] as const;
  const native = (
    name: string,
    kind: Parameters<typeof runNative>[0],
    memory?: "leak" | "manual" | "rc",
    rcTest?: Parameters<typeof runNative>[6],
    filter?: string,
    accels: ("hvf" | "tcg")[] = [...hvf],
  ): Step => ({
    name,
    run: async () =>
      fromSuite(await runNative(kind, accels, jobs, filter, engines, memory, rcTest)),
    data: nativeData(kind, memory),
  });
  return [
    {
      name: "tsc, oxlint, oxfmt --check",
      data: ["*"],
      run: async () => {
        const r = [...(await repoChecks()), await unitTests()];
        return {
          ok: r.every((x) => x.ok),
          detail: r.map((x) => `${x.name}: ${x.summary}`).join("; "),
          failures: r.flatMap((x) => x.failures),
        };
      },
    },
    {
      name: "corpus --neg",
      data: ["corpus/neg", "packages"],
      run: async () => fromSuite(await runNegative(jobs, undefined, engines)),
    },
    {
      name: "corpus",
      data: ["corpus/pos", "packages"],
      run: async () => fromSuite(await runPositive(jobs, undefined, engines)),
    },
    {
      name: "corpus --trap",
      data: ["corpus/trap", "packages"],
      run: async () => fromSuite(await runTrap(jobs, undefined, engines)),
    },
    {
      name: "corpus --lower",
      data: ["corpus/lower", "compiler/rt", "packages"],
      run: async () => fromSuite(await runLower(jobs, undefined, engines)),
    },
    {
      name: "every tirhash pinned before @tsl/std",
      data: ["corpus", "compiler/rt", "packages"],
      mods: ["tools/lang-a-pins.ts"],
      run: async () => {
        const pin = JSON.parse(
          readFileSync(join(ROOT, "corpus/memory/pre-std-tirhash.json"), "utf8"),
        ) as Record<string, string>;
        const h = await guardedRun(
          process.execPath,
          ["--no-warnings", join(ROOT, "tools/pre-std-hashes.ts")],
          { timeoutMs: 600_000, label: "pre-std hashes", cwd: ROOT },
        );
        if (!h.ok) return { ok: false, detail: h.why, failures: [h.why] };
        const got = JSON.parse(h.stdout) as Record<string, string>;
        const { LANG_A_MOVED } = await import("./lang-a-pins.ts");
        const { mapsMoved } = await import("./maps-pins.ts");
        const moved = Object.entries(pin).filter(
          ([k, v]) =>
            got[k] !== v &&
            !Object.keys(LANG_A_MOVED).some((p) => k.startsWith(`${p}@`)) &&
            !mapsMoved(k),
        );
        return {
          ok: moved.length === 0,
          detail: `${Object.keys(pin).length - moved.length}/${Object.keys(pin).length} the same`,
          failures: moved.map(([k]) => `${k}: tirhash changed`),
        };
      },
    },
    native("native pos, HVF", "pos"),
    native("native trap, HVF", "trap"),
    native("native mem, HVF", "mem"),
    native("native memory modes, HVF", "memory"),
    native("native std, HVF", "std"),
    native("native lower, HVF", "lower"),
    native("native lower in leak, HVF", "lower", "leak"),
    native("native lower in manual, HVF", "lower", "manual"),
    native("native lower in rc, HVF", "lower", "rc"),
    native("native lower in rc's poisoning build, HVF", "lower", "rc", {
      rc: { check: true, account: true },
      harness: { collect: true },
      suffix: "-poison-on",
    }),
    native("native mem, TCG", "mem", undefined, undefined, undefined, ["tcg"]),
    native("native lower in rc, adversarial programs, TCG", "lower", "rc", undefined, "adv_", [
      "tcg",
    ]),
    {
      name: "rc-only pins, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/rc-tests.ts"],
      run: async () => {
        const { rcOnly } = await import("./rc-tests.ts");
        return fromTally(await rcOnly("hvf", jobs));
      },
    },
    {
      name: "collector under user code, budgets 1, 2, 3, 5, 8, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/rc-tests.ts"],
      run: async () => {
        const { interleave } = await import("./rc-tests.ts");
        return fromTally(await interleave("hvf", jobs, [1, 2, 3, 5, 8]));
      },
    },
    {
      name: "collector under user code, every Map, Set and strings program, budgets 1, 3, 8, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { underInterleaving } = await import("./strmap-tests.ts");
        return fromTally(await underInterleaving("hvf", jobs, [1, 3, 8]));
      },
    },
    {
      name: "Map, Set and strings no leak over 4 repeats, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { noLeak } = await import("./strmap-tests.ts");
        return fromTally(await noLeak("hvf", jobs));
      },
    },
    {
      name: "rc no leak over 4 repeats, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/rc-tests.ts"],
      run: async () => {
        const { leakTest } = await import("./rc-tests.ts");
        const r = await leakTest("hvf", jobs, true);
        return {
          ok: r.failures.length === 0,
          detail: `${r.rows.length} programs`,
          failures: r.failures,
        };
      },
    },
    {
      name: "random programs with cycles, 80 seeds, HVF",
      data: ["compiler/rt", "packages"],
      mods: ["tools/rc-fuzz.ts"],
      run: async () => {
        const { fuzz } = await import("./rc-fuzz.ts");
        return fromTally(
          await fuzz(20000, 80, "hvf", jobs, {}, false, { budgets: [1, 2, 3, 5, 8, 13, 32] }),
        );
      },
    },
    {
      name: "Map, Set and strings corpus in rc, poison, leak and manual, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { corpusRun } = await import("./strmap-tests.ts");
        const c = await corpusRun("hvf", jobs);
        const t = Object.values(c);
        return {
          ok: t.every((x) => x.failures.length === 0 && x.agreed === x.cases),
          detail: t.map((x) => `${x.agreed}/${x.cases}`).join(", "),
          failures: t.flatMap((x) => x.failures),
        };
      },
    },
    {
      name: "iteration under mutation, every 4th case, poisoning build, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { iterationExhaustive } = await import("./strmap-tests.ts");
        return fromTally(
          await iterationExhaustive("hvf", jobs, { check: true, account: true }, "poison", 4),
        );
      },
    },
    {
      name: "number text against V8, 2,000 doubles of each kind, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { numberDifferential } = await import("./strmap-tests.ts");
        return fromTally(await numberDifferential("hvf", jobs, 2000));
      },
    },
    {
      name: "strange strings through every method, poisoning build, HVF",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { strangeMatrix } = await import("./strmap-tests.ts");
        return fromTally(
          await strangeMatrix("hvf", jobs, "rc", { check: true, account: true }, "poison"),
        );
      },
    },
    {
      name: "random programs over strings, Map and Set, 60 seeds, HVF",
      data: ["compiler/rt", "packages"],
      mods: ["tools/strmap-fuzz.ts"],
      run: async () => {
        const { strmapFuzz } = await import("./strmap-fuzz.ts");
        return fromTally(await strmapFuzz(1, 60, "hvf", jobs, [1, 2, 3, 5, 8, 13, 32]));
      },
    },
    {
      name: "Map, Set and strings corpus in rc, poison, leak and manual, TCG",
      data: ["corpus/lower", "corpus/native", "compiler/rt", "packages"],
      mods: ["tools/strmap-tests.ts"],
      run: async () => {
        const { corpusRun } = await import("./strmap-tests.ts");
        const t = Object.values(await corpusRun("tcg", jobs));
        return {
          ok: t.every((x) => x.failures.length === 0 && x.agreed === x.cases),
          detail: t.map((x) => `${x.agreed}/${x.cases}`).join(", "),
          failures: t.flatMap((x) => x.failures),
        };
      },
    },
    // The optimiser (D44, D46): a representative set at -O2, and its own differential tests, which need no V8.
    atLevel("2", native("native pos, HVF", "pos")),
    atLevel("2", native("native trap, HVF", "trap")),
    atLevel("2", native("native mem, HVF", "mem")),
    atLevel("2", native("native std, HVF", "std")),
    atLevel("2", native("native lower in leak, HVF", "lower", "leak")),
    atLevel(
      "2",
      native("native lower in rc's poisoning build, HVF", "lower", "rc", {
        rc: { check: true, account: true },
        harness: { collect: true },
        suffix: "-poison-on",
      }),
    ),
    atLevel(
      "2",
      native("native lower in rc, adversarial programs, TCG", "lower", "rc", undefined, "adv_", [
        "tcg",
      ]),
    ),
    // Language phase A (D49, D50): the exceptions and classes corpus, its runtime errors on TCG, and random programs.
    native("exceptions and classes in rc's poisoning build, HVF", "exc", "rc", {
      rc: { check: true, account: true },
      harness: { collect: true },
      suffix: "-poison-on",
    }),
    native(
      "exceptions and classes, runtime errors, TCG",
      "exc",
      "rc",
      undefined,
      "runtime_errors",
      ["tcg"],
    ),
    {
      name: "random programs with exceptions, rc's poisoning build, 12 seeds, HVF",
      data: ["compiler/rt", "packages"],
      mods: ["tools/exc-fuzz.ts"],
      run: async () => {
        const { excFuzz } = await import("./exc-fuzz.ts");
        const r = await excFuzz(1, 12, "hvf", jobs);
        return {
          ok: r.failures.length === 0 && r.ran === r.seeds && !r.skipped,
          detail: `${r.ran}/${r.seeds} programs, ${r.cases} cases, ${r.leaked} leaked`,
          failures: r.failures,
        };
      },
    },
    {
      name: "random TIR at -O0, -O1 and -O2, compared natively, 20 seeds, HVF",
      data: [],
      mods: ["tools/tir-fuzz.ts"],
      run: async () => {
        const { tirFuzz } = await import("./tir-fuzz.ts");
        const r = await tirFuzz(100, 20, "hvf", jobs);
        return {
          ok: r.failures.length === 0 && !r.skipped && r.ran > 0,
          detail: `${r.ran} programs, ${r.cases} cases, ${r.traps} trapped, ${r.inlined} calls inlined`,
          failures: r.failures,
        };
      },
    },
    {
      name: "random programs in rc at -O0 and -O2, results and every counter, 12 seeds, HVF",
      data: ["compiler/rt", "packages"],
      mods: ["tools/opt-tests.ts"],
      run: async () => {
        const { sourceDiff } = await import("./opt-tests.ts");
        const r = await sourceDiff(1, 12, "hvf", jobs);
        return {
          ok: r.failures.length === 0 && !r.skipped && r.ran > 0,
          detail: `${r.ran} programs, ${r.cases} cases, ${r.counters} counters`,
          failures: r.failures,
        };
      },
    },
    {
      name: "the result channel's own faults, HVF and TCG",
      data: [],
      mods: ["tools/channel-tests.ts"],
      run: async () => {
        const { channelTests } = await import("./channel-tests.ts");
        const a = await channelTests("hvf");
        const b = await channelTests("tcg");
        const n = a.rows.length + b.rows.length;
        return {
          ok: a.failures.length === 0 && b.failures.length === 0 && n > 0,
          detail: `${n - a.failures.length - b.failures.length}/${n}`,
          failures: [...a.failures, ...b.failures],
        };
      },
    },
  ];
}

/** What a builder has to know this tier doesn't do. Printed by every run. */
export const LEFT_OUT = [
  "benchmarks and gates G1 and G2",
  "TCG, but for corpus/mem, rc's adversarial programs and the Map, Set and strings corpus",
  "JPEG decoding natively, and the fixtures and corrupt inputs on V8 and JSC",
  "the encoder cross-check against llvm-objdump and llvm-mc",
  "byte-identical builds on Node and Bun, and the repro checks",
  "omitted counts site by site, and the injected collector, runtime and @tsl/std bugs (--catch-rate runs them against this tier)",
  "most of iteration under mutation (it runs every 4th case), of number text (a tenth), of the random programs, of the budgets",
  "toUpperCase and toLowerCase on every code point",
  "hash key independence, fragmentation, the freeing bounds and latency",
  "the milestones' checks of what the spec says",
  "-O1 but for the random TIR, and at -O2 all but a representative set: the milestones run everything at -O0 and -O2",
  "the optimiser's pins at -O1 and -O2, its injected bugs, call counts and compile times",
];

/** The tier's steps as units, one job each in the gate's pool: a step's place is its number in the list. */
export async function defineQuick(M: MilestoneDef): Promise<void> {
  const list = steps(jobsFlag());
  list.forEach((st, i) => {
    M.unit(String(i + 1), async () => {
      let r: { ok: boolean; detail: string; failures: string[] };
      try {
        r = await st.run();
      } catch (e) {
        r = {
          ok: false,
          detail: `threw: ${String(e).slice(0, 400)}`,
          failures: [String(e).slice(0, 800)],
        };
      }
      M.report({ box: st.name, ...r });
    });
  });
}

/** What `tmk test` leaves in build/test.json, as it always did. */
export function writeTestJson(r: {
  ok: boolean;
  seconds: number;
  rows: { name: string; ok: boolean; seconds: number; detail: string }[];
  failed: string[];
}): void {
  writeFileSync(buildPath("test.json"), JSON.stringify(r, null, 2));
}

// --- what the tier catches

interface InjectedFault {
  family: string;
  name: string;
  env: Record<string, string>;
  order: string; // where this one can show, so it stops early when it does
}

export async function injectedFaults(): Promise<InjectedFault[]> {
  const { FAULTS } = await import("./std-tests.ts");
  const { CC_FAULTS } = await import("./rc-tests.ts");
  const rc = (o: Record<string, unknown>): Record<string, string> => ({
    TMK_TEST_RC: JSON.stringify(o),
  });
  const omit = (kind: string, k: number): InjectedFault => ({
    family: `${kind} left out`,
    name: `${kind} ${k}`,
    env: rc({ [kind]: k }),
    order: "poisoning|no leak|rc",
  });
  return [
    ...FAULTS.map((f) => ({
      family: "@tsl/std bug",
      name: f.name,
      env: { TSL_TEST_PATCH: JSON.stringify({ file: f.file, from: f.from, to: f.to }) },
      order: "native std",
    })),
    ...CC_FAULTS.map((f) => ({
      family: "collector bug",
      name: f.name,
      env: rc(f.rc),
      order: "collector|random programs with cycles",
    })),
    ...[
      "cursor-stale",
      "finished-wakes",
      "sees-deleted",
      "no-norm",
      "append-anywhere",
      "view-uncounted",
    ].map((f) => ({
      family: "runtime bug",
      name: f,
      env: rc({ rtFault: f }),
      order: "Map, Set|iteration|random programs over|strange",
    })),
    ...[0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 80].map((k) => omit("omitInc", k)),
    ...[0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 80].map((k) => omit("omitDec", k)),
  ];
}

/** One run of the tier for each fault, in a child with the fault in its environment. A fault is caught if the tier fails. */
export async function catchRate(jobs: number, only?: string): Promise<boolean> {
  const faults = (await injectedFaults()).filter(
    (f) => only === undefined || new RegExp(only).test(`${f.family} ${f.name}`),
  );
  const out: { family: string; name: string; caught: boolean; seconds: number; by: string }[] = [];
  for (const f of faults) {
    const r = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        join(ROOT, "tools/tmk.ts"),
        "test",
        "--fail-fast",
        "--jobs",
        String(jobs),
        "--order",
        f.order,
      ],
      {
        timeoutMs: 1_200_000,
        label: `catch ${f.name}`,
        cwd: ROOT,
        env: { ...process.env, ...f.env },
      },
    );
    const by = /^FAIL +[\d.]+ s (.*?):/m.exec(r.stdout)?.[1] ?? "";
    const row = { family: f.family, name: f.name, caught: !r.ok, seconds: r.ms / 1000, by };
    out.push(row);
    console.log(
      `${row.caught ? "caught" : "MISSED"} ${row.seconds.toFixed(0).padStart(5)} s ${f.family}: ${f.name}${by !== "" ? ` (by ${by})` : ""}`,
    );
    writeFileSync(buildPath("test-catch.json"), JSON.stringify(out, null, 2));
  }
  const fam = new Map<string, { caught: number; all: number }>();
  for (const r of out) {
    const x = fam.get(r.family) ?? { caught: 0, all: 0 };
    x.all++;
    if (r.caught) x.caught++;
    fam.set(r.family, x);
  }
  for (const [k, v] of fam) console.log(`${k}: ${v.caught}/${v.all} caught`);
  console.log(`all: ${out.filter((r) => r.caught).length}/${out.length} caught`);
  return true;
}
