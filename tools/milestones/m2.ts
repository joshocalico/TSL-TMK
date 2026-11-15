// M2: down-lowering and the JPEG benchmark, gate G1 (SPEC M2).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT, type Engines } from "../corpus.ts";
import { pool } from "../guarded-run.ts";
import {
  args,
  guardedRun,
  jobsFlag,
  needInstall,
  repoChecks,
  runLower,
  suiteItem,
  unitTests,
  type Item,
  type MilestoneDef,
} from "../tmk-common.ts";
import { suite, timedModule } from "../timing.ts";

/** The vendored file is the original, except for the one type import SPEC 4.6 allows. */
function vendorCheck(): Item {
  const failures: string[] = [];
  const text = readFileSync(join(ROOT, "bench/jpeg/vendor/jpeg.ts"), "utf8");
  const source = JSON.parse(readFileSync(join(ROOT, "bench/jpeg/vendor/SOURCE.json"), "utf8")) as {
    commit: string;
    sha256_original: string;
    sha256_vendored: string;
  };
  const local = "type ImageData = { rgba: Uint8Array; width: number; height: number };\n";
  const original = text.replace(local, 'import type { ImageData } from "./raster";\n');
  const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
  if (sha(text) !== source.sha256_vendored)
    failures.push("the vendored file doesn't match SOURCE.json");
  if (sha(original) !== "215182f153d002e73d414f6a2d5dfc9fa27fc6d6ccd5e4731b4191515cc2ac44") {
    failures.push("undoing the one allowed edit doesn't give the SHA-256 in SPEC 4.6");
  }
  return {
    box: "Vendored decoder: no edits beyond the type import, hash and commit recorded",
    ok: failures.length === 0,
    detail: `commit ${source.commit}, original SHA-256 ${source.sha256_original.slice(0, 16)}..., one line changed`,
    failures,
  };
}

async function fixtureCheck(engines: Engines): Promise<{ identical: Item; coverage: Item }> {
  const { buildJpeg, FIXTURES, makeLarge, PINNED, VENDOR } = timedModule(
    "bench",
    await import("../bench-jpeg.ts"),
  );
  const b = buildJpeg();
  const large = makeLarge();
  const dirs = [FIXTURES, ...(large !== null ? [dirname(large)] : [])];
  const correct = join(ROOT, "bench/jpeg/correct.ts");
  const job = JSON.stringify({ source: VENDOR, glue: b.glue, wasm: b.wasm, dirs });
  const runs = await pool(
    [
      {
        name: "V8",
        cmd: engines.node,
        cargs: ["--import", join(ROOT, "tools/ts-hook.mjs"), "--no-warnings", correct, job],
      },
      { name: "JSC", cmd: engines.bun, cargs: [correct, job] },
    ],
    2,
    async (x) => ({
      name: x.name,
      run: await guardedRun(x.cmd, x.cargs, {
        timeoutMs: 300_000,
        label: `fixtures on ${x.name}`,
        cwd: ROOT,
      }),
    }),
  );
  const failures: string[] = [];
  let count = 0;
  let checks = 0;
  const seen = new Map<string, string>();
  for (const { name, run } of runs) {
    if (!run.ok) {
      failures.push(`${name}: ${run.why} ${run.stderr.slice(0, 600)}`);
      continue;
    }
    const results = JSON.parse(run.stdout) as {
      fixture: string;
      rgba: string;
      checks: string[];
      fails: string[];
    }[];
    count = results.length;
    for (const r of results) {
      checks += r.checks.length;
      seen.set(r.fixture, r.rgba);
      for (const f of r.fails) failures.push(`${r.fixture} on ${name}: ${f}`);
    }
  }
  for (const [name, hash] of Object.entries(PINNED)) {
    if (seen.get(name) !== hash)
      failures.push(`${name}: RGBA hash ${seen.get(name)}, SPEC M2 pins ${hash}`);
  }
  const moire = 16;
  return {
    identical: {
      box: "All 16+ JPEG fixtures give byte-identical RGBA in V8 and in Wasm",
      ok: failures.length === 0 && count >= moire,
      detail: `${count} fixtures (${moire} from Moire${large !== null ? ", plus the generated 4000x3000" : ""}), compared on V8 and on JSC; ${Object.keys(PINNED).length} hashes pinned to SPEC M2`,
      failures,
    },
    coverage: {
      box: "Coverage for jpegSize, decodeJpeg and decodeJpeg with maxEdge",
      ok: failures.length === 0 && checks > 0,
      detail: `${checks} comparisons: jpegSize, decodeJpeg, and maxEdge on both sides of the 1/8 threshold, per fixture, per engine`,
      failures: [],
    },
  };
}

async function corruptCheck(engines: Engines, jobs: number): Promise<Item> {
  const { buildJpeg, FIXTURES, VENDOR } = timedModule("bench", await import("../bench-jpeg.ts"));
  const b = buildJpeg();
  const total = 200;
  const size = Math.ceil(total / jobs);
  const chunks_: { from: number; to: number }[] = [];
  for (let i = 0; i < total; i += size) chunks_.push({ from: i, to: Math.min(total, i + size) });
  const corrupt = join(ROOT, "bench/jpeg/corrupt.ts");
  const runs = await pool(chunks_, jobs, (c) =>
    guardedRun(
      engines.node,
      [
        "--import",
        join(ROOT, "tools/ts-hook.mjs"),
        "--no-warnings",
        corrupt,
        JSON.stringify({
          source: VENDOR,
          glue: b.glue,
          wasm: b.wasm,
          dir: FIXTURES,
          seed: 20261103,
          total,
          ...c,
        }),
      ],
      { timeoutMs: 400_000, label: `corrupt ${c.from}..${c.to}`, cwd: ROOT },
    ),
  );
  const t = { matched: 0, matchedError: 0, trapped: 0, mismatched: 0, crashed: 0 };
  const codes: Record<string, number> = {};
  const failures: string[] = [];
  for (const r of runs) {
    if (!r.ok) {
      failures.push(`a batch died: ${r.why} ${r.stderr.slice(0, 500)}`);
      t.crashed += size;
      continue;
    }
    const o = JSON.parse(r.stdout) as typeof t & {
      trapCodes: Record<string, number>;
      details: string[];
    };
    t.matched += o.matched;
    t.matchedError += o.matchedError;
    t.trapped += o.trapped;
    t.mismatched += o.mismatched;
    t.crashed += o.crashed;
    for (const [k, v] of Object.entries(o.trapCodes)) codes[k] = (codes[k] ?? 0) + v;
    failures.push(...o.details);
  }
  const counted = t.matched + t.matchedError + t.trapped + t.mismatched + t.crashed;
  return {
    box: "Corrupt-input test: 200 mutated fixtures, fixed seed: never crashes the host; matches V8 or traps",
    ok: t.mismatched === 0 && t.crashed === 0 && counted === total,
    detail: `${total} cases: ${t.matched} same image, ${t.matchedError} same Error, ${t.trapped} trapped (by code: ${JSON.stringify(codes)}), ${t.mismatched} differ, ${t.crashed} crashed`,
    failures,
  };
}

async function lowerDeterminism(engines: Engines, jobs: number): Promise<Item> {
  const { lowerBatch, listPrograms } = timedModule("corpus", await import("../corpus.ts"));
  const files = [
    join(ROOT, "bench/jpeg/vendor/jpeg.ts"),
    ...listPrograms(join(ROOT, "corpus/lower/pos")),
    ...listPrograms(join(ROOT, "corpus/lower/fallback")),
  ];
  const a = await lowerBatch(files, buildPath("repro/lower-a"), jobs, engines.node);
  const b = await lowerBatch(files, buildPath("repro/lower-b"), jobs, engines.node);
  const c = await lowerBatch(files, buildPath("repro/lower-bun"), jobs, engines.bun);
  const failures: string[] = [];
  a.forEach((x) => {
    const y = b.find((k) => k.file === x.file);
    const z = c.find((k) => k.file === x.file);
    if (x.wasmSha === undefined)
      failures.push(`${x.file}: no output ${x.crash?.slice(0, 300) ?? ""}`);
    if (x.wasmSha !== y?.wasmSha || x.tirHash !== y?.tirHash)
      failures.push(`${x.file}: two Node runs differ`);
    if (x.wasmSha !== z?.wasmSha || x.tirHash !== z?.tirHash) {
      failures.push(`${x.file}: Node and Bun differ ${z?.crash?.slice(0, 300) ?? ""}`);
    }
  });
  return {
    box: "tmk lower is deterministic: identical Wasm and tirhash across runs, and hosted on Bun",
    ok: failures.length === 0,
    detail: `${files.length} programs, 3 builds each (Node, Node, Bun)`,
    failures,
  };
}

export async function defineM2(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const quick = args.includes("--quick");
  const { lowerFile } = timedModule("tslc", await import("../lowering.ts"));
  const items = { push: M.report };
  const tmk = join(ROOT, "tools/tmk.ts");
  // The decoder's lowering report: box 6 reads it, and S3 and G1 its share lowered.
  const jpegReport = () => lowerFile(join(ROOT, "bench/jpeg/vendor/jpeg.ts"));
  const lowered = (report: ReturnType<typeof jpegReport>): number =>
    (report.counts.lowered / Math.max(1, report.counts.total)) * 100;

  M.unit("1-4", async () => {
    items.push(vendorCheck());
    items.push(
      suiteItem("tsc, oxlint and oxfmt --check are clean over the repo", ...(await repoChecks())),
    );
    items.push(suiteItem("Unit tests", await unitTests()));
    const lowerSuite = await runLower(jobs, undefined, engines);
    items.push(
      suiteItem(
        "Every rule in SPEC 4.5 has a program compared against V8, plus programs that must fall back with the right root cause",
        lowerSuite,
      ),
    );
  });

  M.unit("5-10", async () => {
    const { identical, coverage } = await suite("fixtureCheck", () => fixtureCheck(engines));
    items.push(identical);

    const report = jpegReport();
    const noCause = report.rows.filter(
      (r) => r.outcome === "fallback" && r.kind !== "closure" && r.blocker === null,
    );
    const noOutcome = report.rows.filter((r) => r.outcome === "unreached");
    // With a profile, the report says which functions are hot.
    const profiled = lowerFile(join(ROOT, "bench/jpeg/vendor/jpeg.ts"), {
      profile: { idctBlock: 9 },
    });
    const profileOk =
      profiled.rows.find((r) => r.fn === "idctBlock")?.hot === true &&
      profiled.rows.find((r) => r.fn === "jpegSize")?.hot === false;
    items.push({
      box: "tmk lower bench/jpeg/vendor/jpeg.ts --report: every function has an outcome and, if it fell back, a root cause",
      ok: report.rows.length > 0 && noCause.length === 0 && noOutcome.length === 0 && profileOk,
      detail: `${report.counts.total} functions: ${report.counts.lowered} lowered, ${report.counts.fallback} fallback, ${report.counts.unreached} unreached`,
      failures: [
        ...[...noCause, ...noOutcome].map((r) => `${r.fn}:${r.line}: ${r.outcome}`),
        ...(profileOk ? [] : ["a profile didn't mark hot functions"]),
      ],
    });
    const pct = lowered(report);
    items.push({
      box: "S3: at least 80% of functions lowered to pass the gate, 100% as the target",
      ok: pct >= 80,
      detail: `${pct.toFixed(1)}% of ${report.counts.total} functions, with no source edits beyond the type import`,
      failures: [],
    });
    items.push(coverage);
    items.push(await suite("corruptCheck", () => corruptCheck(engines, jobs)));
    items.push(await suite("lowerDeterminism", () => lowerDeterminism(engines, jobs)));
  });

  // --no-fallback must be real: this decoder passes, and a program with a real blocker doesn't.
  M.unit("11", async () => {
    const nf = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        tmk,
        "lower",
        "bench/jpeg/vendor/jpeg.ts",
        "--no-fallback",
        "--out",
        buildPath("lower/jpeg-nf"),
      ],
      { timeoutMs: 120_000, label: "no-fallback jpeg", cwd: ROOT },
    );
    const blocked = await guardedRun(
      process.execPath,
      ["--no-warnings", tmk, "lower", "corpus/lower/fallback/map_set.ts", "--no-fallback"],
      { timeoutMs: 120_000, label: "no-fallback map_set", cwd: ROOT },
    );
    const namesCause = /TSLD0210/.test(blocked.stdout) && /map-set/.test(blocked.stdout);
    items.push({
      box: "--no-fallback: a hard error naming the root cause when anything would stay JS, and clean on this decoder",
      ok: nf.ok && blocked.code === 1 && namesCause,
      detail: `jpeg.ts: exit ${nf.code}; corpus/lower/fallback/map_set.ts: exit ${blocked.code}${namesCause ? ", naming TSLD0210 map-set" : ""}`,
      failures: nf.ok ? [] : [nf.stderr.slice(0, 500)],
    });
  });

  // G1 measures: the full benchmark, in the gate's quiet phase (SPEC 8.4, D51).
  M.unit("12-13", async () => {
    const pct = lowered(jpegReport());
    const { benchJpeg, benchText } = timedModule("bench", await import("../bench-jpeg.ts"));
    const bench = await benchJpeg({ quick });
    const needConfigs = ["v8", "jsc", "wasm-v8", "wasm-opt-v8"];
    const missingConfig = needConfigs.filter(
      (c) => bench.fixtures["tower-portrait.jpg"]?.[c] === undefined,
    );
    items.push({
      box: "Benchmark outputs: V8, JSC, Wasm on V8 with and without wasm-opt; cold start; memory high-water",
      ok:
        !bench.fail &&
        missingConfig.length === 0 &&
        Object.keys(bench.cold).length >= 4 &&
        (bench.memory["wasm-v8"]?.rssBytes ?? 0) > 0,
      detail: benchText(bench).split("\n").join("\n     "),
      failures: [...bench.errors, ...missingConfig.map((c) => `no ${c} result`)],
    });
    const g1Ok = bench.gate.geomean <= 2 && pct >= 80;
    items.push({
      box: "Gate G1: Wasm against V8 (<= 1.25x proceed, 1.25x to 2x one fix pass, > 2x stop), coverage at least 80%",
      ok: g1Ok,
      detail: `${bench.gate.geomean.toFixed(3)}x geomean over the ${Object.keys(bench.gate.perFixture).length} fixtures in SPEC M2, worst ${bench.gate.worst.toFixed(3)}x, wasm-opt ${bench.gate.optGeomean?.toFixed(3) ?? "?"}x; coverage ${pct.toFixed(1)}%: ${bench.gate.verdict}`,
      failures: g1Ok ? [] : ["G1 failed: stop and report it to the owner"],
    });
  });

  M.nested("14", "Milestone 1 still passes", "m1");
}
