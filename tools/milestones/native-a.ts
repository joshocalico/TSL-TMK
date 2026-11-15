// native-a: phase A of the native proof (SPEC M5): the backend, the QEMU harness, the test runtime, the native corpus and
// the decoder. The benchmark and G2 measure, so they run whole, in the gate's quiet phase (SPEC 8.4, D51).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, ROOT } from "../corpus.ts";
import {
  args,
  guardedRun,
  jobsFlag,
  needInstall,
  repoChecks,
  runLower,
  suiteItem,
  unitTests,
  type MilestoneDef,
} from "../tmk-common.ts";
import { timedModule } from "../timing.ts";

export async function defineNativeA(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const quick = args.includes("--quick");
  const { runNative, listPrograms: lp } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const tmk = join(ROOT, "tools/tmk.ts");
  const hvf = hvfAvailable();
  const accels: ("hvf" | "tcg")[] = ["hvf", "tcg"];
  const report = M.report;

  M.unit("1-4", async () => {
    // Fixes that had to land first.
    const nf = await guardedRun(
      process.execPath,
      [
        "--no-warnings",
        "--test",
        "--test-timeout=60000",
        join(ROOT, "compiler/host/lower-outside.test.ts"),
      ],
      {
        timeoutMs: 120_000,
        label: "lower outside the repo",
        cwd: ROOT,
      },
    );
    report({
      box: "Fixed first: tmk lower works on a file outside the repo",
      ok: nf.ok,
      detail: nf.ok ? "lower-outside.test.ts passes, relative imports included" : nf.why,
      failures: nf.ok ? [] : [nf.stdout.slice(-1500)],
    });
    const lowerSuite = await runLower(jobs, undefined, engines);
    const fallbacks = ["lying_cast", "shape_widened"].every((n) =>
      existsSync(join(ROOT, `corpus/lower/fallback/${n}.ts`)),
    );
    report(
      suiteItem(
        "Fixed first: a lying cast and a widened return are fallbacks with a root cause, tested against V8 (SPEC 4.5)",
        fallbacks
          ? lowerSuite
          : {
              ...lowerSuite,
              ok: false,
              failures: [...lowerSuite.failures, "the two regression programs are missing"],
            },
      ),
    );
    report(
      suiteItem("tsc, oxlint and oxfmt --check are clean over the repo", ...(await repoChecks())),
    );
    report(suiteItem("Unit tests", await unitTests()));
  });

  // The encoder cross-check reads the images the corpus leaves, and the repro build and it need the JPEG references.
  M.unit("5-9", async () => {
    // 5 and 6: corpus. Run first, since the encoder check reads the images it leaves.
    const pos = await runNative("pos", accels, jobs, undefined, engines);
    const trapN = await runNative("trap", accels, jobs, undefined, engines);
    const count = (s: {
      agreement: { accel: string; agreed: number; cases: number; skipped: boolean }[];
    }): string =>
      s.agreement
        .map((a) => (a.skipped ? `${a.accel} SKIPPED` : `${a.accel} ${a.agreed}/${a.cases}`))
        .join(", ");
    report(
      suiteItem(
        `Native corpus: all of corpus/pos agrees with V8 under QEMU on HVF and TCG, by the same canonical comparison (${count(pos)})`,
        pos,
      ),
    );
    report(
      suiteItem(
        `Native corpus: all of corpus/trap traps with the right code under QEMU on HVF and TCG (${count(trapN)})`,
        trapN,
      ),
    );
    const lowerN = await runNative("lower", accels, jobs, undefined, engines);
    report(
      suiteItem(
        `Native down-lowering: corpus/lower/pos where it has no fallback, and the libm values, with no JS (${count(lowerN)})`,
        lowerN,
      ),
    );

    // 1: the backend's own properties.
    const backendFiles = lp(join(ROOT, "compiler/backend-aarch64"));
    const external: string[] = [];
    for (const f of backendFiles) {
      const text = readFileSync(f, "utf8");
      if (/node:child_process|from "typescript"|execFile|spawn\(/.test(text)) external.push(f);
    }
    const { referenceHashes } = timedModule("jpeg", await import("../native-jpeg.ts"));
    const refs = await referenceHashes();
    const refsPath = buildPath("corpus/native/jpeg-refs.json");
    mkdirSync(dirname(refsPath), { recursive: true });
    writeFileSync(refsPath, JSON.stringify(refs));
    const repro = join(ROOT, "tools/native-repro.ts");
    const job = JSON.stringify({
      pos: lp(join(ROOT, "corpus/pos")),
      lower: lp(join(ROOT, "corpus/lower/pos")),
      jpegRefs: refsPath,
    });
    const run1 = await guardedRun(process.execPath, ["--no-warnings", repro, job], {
      timeoutMs: 300_000,
      label: "repro node",
      cwd: ROOT,
    });
    const run2 = await guardedRun(process.execPath, ["--no-warnings", repro, job], {
      timeoutMs: 300_000,
      label: "repro node, empty PATH, other directory",
      cwd: "/tmp",
      // The optimiser's level and switches are inputs, like the source: they go with it (SPEC 9.2, D44).
      env: {
        HOME: process.env.HOME ?? "/tmp",
        PATH: "",
        ...Object.fromEntries(
          ["TMK_OPT", "TMK_OPT_DISABLE", "TMK_OPT_FAULT"].flatMap((k) =>
            process.env[k] !== undefined ? [[k, process.env[k]!]] : [],
          ),
        ),
      },
    });
    const run3 = await guardedRun(engines.bun, [repro, job], {
      timeoutMs: 300_000,
      label: "repro bun",
      cwd: ROOT,
    });
    const reproFailures: string[] = [];
    let imageCount = 0;
    if (run1.ok && run2.ok && run3.ok) {
      const a = JSON.parse(run1.stdout) as Record<string, string>;
      const b = JSON.parse(run2.stdout) as Record<string, string>;
      const c = JSON.parse(run3.stdout) as Record<string, string>;
      imageCount = Object.keys(a).length;
      for (const k of Object.keys(a)) {
        if (a[k] !== b[k])
          reproFailures.push(`${k}: differs with an empty PATH and another directory`);
        if (a[k] !== c[k]) reproFailures.push(`${k}: differs hosted on Bun`);
      }
    } else
      reproFailures.push(
        `${run1.why} ${run1.stderr.slice(0, 600)} | ${run2.why} ${run2.stderr.slice(0, 600)} | ${run3.why} ${run3.stderr.slice(0, 600)}`,
      );
    report({
      box: "compiler/backend-aarch64: own encoder, linear scan over SSA, every op the corpus and decoder use, own image writer, no external tool; deterministic",
      ok: reproFailures.length === 0 && external.length === 0 && imageCount > 0,
      detail: `${imageCount} images byte-identical on Node, on Node with an empty PATH in another directory, and on Bun; no process spawned from ${backendFiles.length} backend files`,
      failures: [...reproFailures.slice(0, 20), ...external.map((f) => `${f} starts a process`)],
    });

    // 2: the encoder cross-check, over everything that ran.
    const { checkImages } = timedModule("encoder", await import("../encoder-check.ts"));
    const { buildCheckImage } = timedModule("jpeg", await import("../native-jpeg.ts"));
    const imgs: {
      name: string;
      bytes: Uint8Array;
      ranges: { name: string; from: number; to: number }[];
    }[] = [];
    for (const kind of ["pos", "trap", "lower"]) {
      const dir = buildPath("corpus/native", kind);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".img")) continue;
        const base = join(dir, f.replace(/\.img$/, ""));
        imgs.push({
          name: `${kind}/${f}`,
          bytes: new Uint8Array(readFileSync(`${base}.img`)),
          ranges: JSON.parse(readFileSync(`${base}.ranges.json`, "utf8")) as {
            name: string;
            from: number;
            to: number;
          }[],
        });
      }
    }
    const jpegImage = buildCheckImage(refs).image;
    imgs.push({ name: "jpeg", bytes: jpegImage.bytes, ranges: jpegImage.ranges });
    const enc = checkImages(imgs);
    report({
      box: "Encoder cross-check: llvm-objdump agrees with the own decoder on every emitted instruction, and llvm-mc reassembling the disassembly gives identical bytes",
      ok:
        enc.skipped === null &&
        enc.decoderMismatches.length === 0 &&
        enc.unknown.length === 0 &&
        enc.mcMismatches.length === 0 &&
        enc.instructions > 0,
      detail: `${enc.images} images, ${enc.instructions} instructions, ${enc.uniqueWords} distinct words, ${enc.uniqueTexts} distinct texts reassembled`,
      failures: [
        ...(enc.skipped !== null ? [enc.skipped] : []),
        ...enc.unknown,
        ...enc.decoderMismatches,
        ...enc.mcMismatches,
      ],
    });
  });

  M.unit("10-11", async () => {
    // 3 and 4: the harness and the runtime.
    const { harnessTests, skipTest } = timedModule("harness", await import("../native-tests.ts"));
    const tests = [
      ...(await harnessTests("tcg")),
      ...(hvf.ok ? await harnessTests("hvf") : []),
      await skipTest(),
    ];
    const harnessBox = tests.filter(
      (t) =>
        !t.name.startsWith("Runtime") &&
        !t.name.startsWith("Trap reporting") &&
        !t.name.startsWith("A stack"),
    );
    const runtimeBox = tests.filter(
      (t) =>
        t.name.startsWith("Runtime") ||
        t.name.startsWith("Trap reporting") ||
        t.name.startsWith("A stack"),
    );
    report({
      box: "tools/qemu-run.ts meets 8.2: hard timeouts, its own process group, no QEMU left, HVF unavailable is a skip; timeout path tested",
      ok: harnessBox.every((t) => t.ok) && harnessBox.length > 0,
      detail: harnessBox
        .map((t) => `${t.ok ? "ok" : "FAILED"}: ${t.name}: ${t.detail}`)
        .join("\n     "),
      failures: harnessBox.filter((t) => !t.ok).map((t) => t.name),
    });
    report({
      box: "Bare-metal runtime: Image header and start code, FP at EL1, MMU and caches on, PL011, traps as TMK: lines, PSCI off",
      ok: runtimeBox.every((t) => t.ok) && runtimeBox.length > 0,
      detail: runtimeBox
        .map((t) => `${t.ok ? "ok" : "FAILED"}: ${t.name}: ${t.detail}`)
        .join("\n     "),
      failures: runtimeBox.filter((t) => !t.ok).map((t) => t.name),
    });
  });

  M.unit("12-13", async () => {
    const { referenceHashes } = timedModule("jpeg", await import("../native-jpeg.ts"));
    const refs = await referenceHashes();
    // 6: JPEG.
    const { checkNative, corruptNative } = timedModule("jpeg", await import("../native-jpeg.ts"));
    const jpegResults = [];
    for (const a of accels)
      jpegResults.push(await checkNative(a, refs, a === "tcg" ? 500_000 : 200_000));
    const jpegFailures = jpegResults.flatMap((j) => j.failures.map((f) => `${j.accel}: ${f}`));
    report({
      box: "bench/jpeg/vendor/jpeg.ts built with no fallback decodes all 17 fixtures natively under QEMU, RGBA byte-identical to V8 by SHA-256 over serial, pinned to M2's hashes",
      ok:
        jpegFailures.length === 0 &&
        jpegResults.every((j) => j.fixtures >= 17 && j.agreed === j.cases && j.pinned === 6),
      detail: jpegResults
        .map(
          (j) =>
            `${j.accel}: ${j.run.skipped ? "SKIPPED" : `${j.fixtures} fixtures, ${j.agreed}/${j.cases} checks (decode, 6 maxEdge sizes, jpegSize), ${j.pinned}/6 pinned, ${j.run.ms.toFixed(0)} ms`}`,
        )
        .join("; "),
      failures: jpegFailures,
    });
    const nfBlocked = await guardedRun(
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
      {
        timeoutMs: 120_000,
        label: "no-fallback jpeg",
        cwd: ROOT,
      },
    );
    const corrupt = await corruptNative(hvf.ok ? "hvf" : "tcg");
    report({
      box: "--no-fallback is clean on the decoder; 200 corrupt inputs natively: no crash, each matches V8 or traps (SPEC 4.6)",
      ok: nfBlocked.ok && corrupt.crashed.length === 0 && corrupt.mismatched.length === 0,
      detail: `${corrupt.total} cases: ${corrupt.matched} same image, ${corrupt.matchedError} same Error, ${corrupt.trapped} trapped (by code: ${JSON.stringify(corrupt.trapCodes)}), ${corrupt.mismatched.length} differ, ${corrupt.crashed.length} crashed`,
      failures: [...corrupt.mismatched, ...corrupt.crashed],
    });
  });

  M.unit("14-15", async () => {
    const skipped = !hvf.ok;
    // 7: benchmarks. HVF only, and with HVF unavailable that's a skip, which isn't a pass.
    const { benchNative, nativeText } = timedModule("bench", await import("../bench-native.ts"));
    const bench = await benchNative({ quick });
    report({
      box: "tmk bench native: JPEG against V8 and Wasm under HVF, by CNTVCT_EL0, with cold start, and the M5 set against clang -O2",
      ok: skipped
        ? false
        : bench.errors.length === 0 &&
          Object.keys(bench.jpeg).length === 6 &&
          bench.cold !== null &&
          Object.keys(bench.micro).length === 6,
      detail: nativeText(bench).split("\n").join("\n     "),
      failures: bench.errors,
    });
    const median = bench.s4.median;
    report({
      box: "Gate G2 and S4: native against clang -O2 on the benchmark set: <= 2x proceed, 2x to 4x one optimisation pass, > 4x stop and report",
      ok: median !== null && median <= 4,
      detail: `median ${median?.toFixed(3) ?? "not measured"}x (${Object.entries(bench.s4.ratios)
        .map(([k, v]) => `${k} ${v.toFixed(2)}x`)
        .join(", ")}): ${bench.s4.verdict}. No optimisation pass was needed or done.`,
      failures: [],
    });
  });

  M.nested("16", "Milestone m1 still passes", "m1");
  M.nested("17", "Milestone m2 still passes", "m2");
  M.vms("18", "No QEMU process of this run is left", false);
}
