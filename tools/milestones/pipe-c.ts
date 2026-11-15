// pipe-c: the pipeline's phase 2, third chunk (SPEC 3.5, D64, D65, design/pipeline.md): a constructor stores no zero
// initialiser where every object starts zeroed, which makes the leak list's image through TSL classes the direct route's,
// byte for byte; and one TSL module per source module, with names that don't depend on the order of the imports.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultEngines, ROOT } from "../corpus.ts";
import { guardedRun } from "../guarded-run.ts";
import { jobsFlag, needInstall, type MilestoneDef } from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

/** Runs `f` with an environment variable set, and puts it back. */
async function withEnv<X>(k: string, v: string, f: () => Promise<X> | X): Promise<X> {
  const was = process.env[k];
  process.env[k] = v;
  try {
    return await f();
  } finally {
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
}

export async function definePipeC(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { hvfAvailable } = await import("../qemu-run.ts");
  const { runNative } = timedModule("corpus", await import("../corpus.ts"));
  const report = M.report;
  const hvf = hvfAvailable();
  const skipNote = hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`;
  const both: ("hvf" | "tcg")[] = hvf.ok ? ["hvf", "tcg"] : ["tcg"];

  // 1. Everything before.
  M.nested(
    "1",
    "1. Every existing suite still passes: tmk milestone pipe-b from this tree, which runs pipe-a, maps, lang-a, opt-a and through them everything else",
    "pipe-b",
  );

  // 2. Zeroed construction is sound on every path that reuses memory, and the test of it has teeth.
  M.unit("2", async () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const level of ["0", "2"]) {
      await withEnv("TMK_OPT", level, async () => {
        const s = await runNative("std", both, jobs, "zero_ctor", engines);
        const m = await runNative("memory", both, jobs, "zero_reuse", engines);
        rows.push(`-O${level}: std ${s.summary}; manual ${m.summary}`);
        if (!s.ok || !m.ok) failures.push(...s.failures, ...m.failures);
      });
    }
    // The fill a manual `new` depends on, left out: the reused block reads dirty, and the corpus says so.
    const bug = await withEnv("TMK_TEST_TSL", "manual-nofill", () =>
      runNative("memory", hvf.ok ? ["hvf"] : ["tcg"], jobs, "zero_reuse", engines),
    );
    if (bug.ok) failures.push("the manual heap's zero fill left out wasn't caught");
    report({
      box: "2. Zeroed construction (SPEC 3.5): a constructor stores no zero initialiser, and every path that reuses memory still gives zero fields, natively on HVF and TCG at -O0 and -O2 and on V8 and JSC: a reused Slab slot, a reused Rc slot and a stack object in a loop (corpus/std/zero_ctor.ts), a class built in place inside another keeping its stores, and a manual block freed dirty and reused (corpus/memory/manual/manual_zero_reuse.ts); with the manual heap's zero fill left out, that program fails",
      ok: failures.length === 0,
      detail: `${rows.join("; ")}; fill left out: ${bug.ok ? "NOT CAUGHT" : "caught"}${skipNote}`,
      failures,
    });
  });

  // 3. The list's gap closed in structure, not in a time: the images are the same bytes.
  M.unit("3", async () => {
    const failures: string[] = [];
    const { lowerFile } = await import("../lowering.ts");
    const { buildImageFor } = await import("../bench-alloc.ts");
    const { pagesSetup } = await import("../bench-memory.ts");
    const image = (file: string, fn: string, memory: string, route: "direct" | "tsl"): string => {
      const lo = lowerFile(join(ROOT, file), {
        memory,
        route,
        ...(route === "tsl" ? { classes: true } : {}),
      });
      if (lo.tir === null) return "none";
      const w = { name: fn, fn, args: [20000], which: 0, cArgs: [20000, 0], ops: 20000, what: "" };
      const img = buildImageFor(lo.tir, w, 20, 101, null, lo.meta!.strings, pagesSetup(true));
      return createHash("sha256").update(img).digest("hex").slice(0, 16);
    };
    const rows: string[] = [];
    for (const [file, fn] of [
      ["bench/memory/list_lowered.ts", "listWork"],
      ["bench/memory/churn_lowered.ts", "churnWork"],
    ] as const) {
      const d = image(file, fn, "leak", "direct");
      const t = image(file, fn, "leak", "tsl");
      rows.push(`${fn}: ${d === t ? "the same bytes" : "different"}`);
      if (d !== t) failures.push(`${fn} in leak: the TSL classes image isn't the direct route's`);
    }
    const off = await withEnv("TMK_TSL_OPT_OFF", "ctorzero", () =>
      image("bench/memory/list_lowered.ts", "listWork", "leak", "tsl"),
    );
    const on = image("bench/memory/list_lowered.ts", "listWork", "leak", "direct");
    if (off === on)
      failures.push("with the rule off the images are the same: the check checks nothing");
    report({
      box: "3. The leak list and churn benchmarks' images, built as tmk bench memory builds them, are the same bytes through TSL classes as by the direct route at -O2 (the constructor's zero stores gone, and the constructor left empty gone with them, so the code is laid out alike), and with the rule off (TMK_TSL_OPT_OFF=ctorzero) the list's isn't",
      ok: failures.length === 0,
      detail: `${rows.join("; ")}; rule off: ${off === on ? "the same" : "different"}`,
      failures,
    });
  });

  // 4. One TSL module per source module, with names that don't depend on the order of the imports.
  M.unit("4", async () => {
    const failures: string[] = [];
    const tmk = join(ROOT, "tools/tmk.ts");
    const src = join(ROOT, "corpus/lower/pipe/two_squares.ts");
    const swapped = join(ROOT, "corpus/lower/pipe/.two_squares_reordered.ts");
    const lines = readFileSync(src, "utf8").split("\n");
    const at = lines.flatMap((l, i) => (l.startsWith("import ") ? [i] : []));
    [lines[at[0]!], lines[at[1]!]] = [lines[at[1]!]!, lines[at[0]!]!];
    writeFileSync(swapped, lines.join("\n"));
    const emit = async (file: string, memory: string, classes: string): Promise<string> => {
      const r = await guardedRun(
        process.execPath,
        ["--no-warnings", tmk, "lower", file, "--memory", memory, "--emit", "tsl"],
        {
          timeoutMs: 120_000,
          label: "emit tsl",
          cwd: ROOT,
          env: { ...process.env, TMK_EMIT_CLASSES: classes },
        },
      );
      if (!r.ok) failures.push(`${file} in ${memory}: ${r.why.slice(0, 200)}`);
      return r.stdout.replaceAll(".two_squares_reordered", "two_squares");
    };
    const rows: string[] = [];
    try {
      for (const memory of ["strict", "leak", "manual"])
        for (const classes of memory === "strict" ? ["0"] : ["0", "1"]) {
          const a = await emit(src, memory, classes);
          const b = await emit(swapped, memory, classes);
          const mods = (a.match(/^\/\/ file: /gm) ?? []).length;
          rows.push(
            `${memory}${classes === "1" ? " classes" : ""}: ${mods} modules, ${a === b ? "unchanged" : "CHANGED"}`,
          );
          if (mods !== 3) failures.push(`${memory} classes=${classes}: ${mods} modules, not 3`);
          if (a !== b)
            failures.push(`${memory} classes=${classes}: reordering the imports changed the TSL`);
          if (classes === "1" && !/import \{ Square as Square_inShapes/.test(a))
            failures.push("the root doesn't import shapes.ts's Square named for its module");
        }
    } finally {
      rmSync(swapped, { force: true });
    }
    // --out writes the package as a directory, and tslc compiles it from there.
    // Inside the repo, where @tsl/* resolves, as for any package.
    mkdirSync(join(ROOT, "build"), { recursive: true });
    const dir = mkdtempSync(join(ROOT, "build", "pipe-c-out-"));
    try {
      const r = await guardedRun(
        process.execPath,
        ["--no-warnings", tmk, "lower", src, "--memory", "leak", "--emit", "tsl", "--out", dir],
        { timeoutMs: 120_000, label: "emit tsl --out", cwd: ROOT },
      );
      const files = ["pipe/two_squares.ts", "lib/shapes.ts", "lib/tiles.ts", "tsl.json"];
      for (const f of files) if (!existsSync(join(dir, f))) failures.push(`--out wrote no ${f}`);
      if (r.ok) {
        const { checkFile } = await import("../../compiler/host/tslc.ts");
        const c = checkFile(join(dir, "pipe/two_squares.ts"));
        if (c.typed === null)
          failures.push(
            `tslc rejected the written package: ${c.diags.map((d) => d.code).join(", ")}`,
          );
      } else failures.push(`--out: ${r.why.slice(0, 200)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Through both routes: per module, the same results, and outside class printing the same TIR as one file had.
    const { dualRoute } = await import("../pipe-tests.ts");
    const accels: ("hvf" | "tcg")[] = hvf.ok ? ["hvf"] : [];
    const only = (f: string): boolean => f.includes("two_squares") || f.includes("relative_import");
    const plain = await dualRoute({
      modes: ["strict", "leak", "manual"],
      levels: [0, 2],
      accels,
      jobs,
      filter: only,
      v8: () => true,
    });
    const cls = await withEnv("TMK_EMIT_CLASSES", "1", () =>
      dualRoute({
        modes: ["leak", "manual"],
        levels: [0, 2],
        accels,
        jobs,
        filter: only,
        classes: true,
        v8: () => true,
      }),
    );
    const cases = (x: typeof plain): string =>
      `${x.rows.reduce((n, r) => n + r.agreed, 0)}/${x.rows.reduce((n, r) => n + r.cases, 0)}`;
    const plainSame = plain.programs.filter((p) => p.handled && p.sameTir).length;
    const plainHandled = plain.programs.filter((p) => p.handled).length;
    if (plainSame !== plainHandled || plainHandled !== 12)
      failures.push(`${plainSame} of ${plainHandled} builds with the TIR one file gave, of 12`);
    failures.push(...plain.failures, ...cls.failures);
    report({
      box: "4. One TSL module per source module (D65): corpus/lower/pipe/two_squares.ts, whose two imported modules each declare a Square, a measure, a count and module state, prints as 3 modules in every mode and with classes, the root importing tiles.ts's Square as Square_inTiles and shapes.ts's as Square_inShapes; reordering its imports leaves the TSL unchanged; --emit tsl --out writes the package as a directory that tslc compiles; and through both routes, it and corpus/lower/pipe/relative_import.ts agree on every case at -O0 and -O2, with the TIR one file gave wherever classes aren't printed",
      ok: failures.length === 0,
      detail: `${rows.join("; ")}; dual route ${cases(plain)} cases, ${plainSame}/${plainHandled} builds the same TIR; classes ${cases(cls)}${skipNote}`,
      failures,
    });
  });

  // 5. Each pin zeroed construction moves is listed (tools/pipe-c-pins.ts), and nothing else moves with it.
  M.unit("5", async () => {
    const failures: string[] = [];
    const { PIPE_C_MOVED } = await import("../pipe-c-pins.ts");
    const run = async (off: boolean): Promise<Record<string, string>> => {
      const r = await guardedRun(
        process.execPath,
        ["--no-warnings", join(ROOT, "tools/pre-std-hashes.ts")],
        {
          timeoutMs: 900_000,
          label: "pre-std hashes",
          cwd: ROOT,
          env: { ...process.env, TMK_TSL_OPT_OFF: off ? "ctorzero" : "" },
        },
      );
      if (!r.ok) failures.push(`pre-std hashes: ${r.why.slice(0, 200)}`);
      return r.ok ? (JSON.parse(r.stdout) as Record<string, string>) : {};
    };
    const [on, off] = [await run(false), await run(true)];
    const moved = new Set(
      Object.keys(on)
        .filter((k) => on[k] !== off[k])
        .map((k) => k.split("@")[0]!),
    );
    for (const f of moved)
      if (PIPE_C_MOVED[f] === undefined && !f.includes("zero_"))
        failures.push(`${f} moves and isn't listed`);
    const inSet = new Set(Object.keys(on).map((k) => k.split("@")[0]!));
    for (const f of Object.keys(PIPE_C_MOVED))
      if (inSet.has(f) && !moved.has(f)) failures.push(`${f} is listed and doesn't move`);
    report({
      box: "5. Pins: every pinned tirhash zeroed construction moves is listed with why (tools/pipe-c-pins.ts), found by computing them with it on and off; none listed that it doesn't move",
      ok: failures.length === 0 && moved.size > 0,
      detail: `${moved.size} programs move, ${Object.keys(PIPE_C_MOVED).length} listed`,
      failures,
    });
  });

  M.vms(
    "6",
    "6. No QEMU process of this run is left, and the owner's UTM and QEMU processes were only observed",
    true,
  );
}
