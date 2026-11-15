// native-b: phase B of the native proof (SPEC M5): TSL proper with memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, listPrograms, ROOT } from "../corpus.ts";
import {
  compileBatch,
  guardedRun,
  jobsFlag,
  needInstall,
  runNegative,
  suiteItem,
  type MilestoneDef,
} from "../tmk-common.ts";
import { suite, timedModule } from "../timing.ts";

/** M3's box: tslc's sizes and offsets against the host's capture mode, for every layout class in the corpus. */
async function layoutAgreement(): Promise<{ classes: number; failures: string[] }> {
  const { layoutsOfFile } = timedModule("tslc", await import("../lowering.ts"));
  const files = [
    ...listPrograms(join(ROOT, "corpus/mem")),
    ...listPrograms(join(ROOT, "corpus/spec")),
  ];
  const failures: string[] = [];
  let classes = 0;
  for (const f of files) {
    const short = f.replace(`${ROOT}/`, "");
    const tslc = layoutsOfFile(f);
    if (tslc.length === 0) continue;
    const r = await guardedRun(
      process.execPath,
      [
        "--import",
        join(ROOT, "tools/ts-hook.mjs"),
        "--no-warnings",
        join(ROOT, "tools/layout-host.ts"),
        JSON.stringify({ file: f, classes: tslc.map((c) => c.name) }),
      ],
      { timeoutMs: 60_000, label: `layouts of ${short}`, cwd: ROOT },
    );
    if (!r.ok) {
      failures.push(`${short}: the host failed: ${r.why} ${r.stderr.slice(0, 400)}`);
      continue;
    }
    const host = JSON.parse(r.stdout) as Record<
      string,
      { size: number; align: number; fields: Record<string, number> } | null
    >;
    for (const c of tslc) {
      classes++;
      const h = host[c.name];
      if (h === null || h === undefined) {
        failures.push(`${short}: ${c.name} isn't exported, so the host can't see it`);
        continue;
      }
      const a = JSON.stringify({ size: c.size, align: c.align, fields: c.fields });
      const b = JSON.stringify({ size: h.size, align: h.align, fields: h.fields });
      // A reserved field has no accessor on the host, but capture mode still lays it out.
      if (a !== b) failures.push(`${short}: ${c.name}: tslc ${a}, host ${b}`);
    }
  }
  return { classes, failures };
}

export async function defineNativeB(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const { runNative } = timedModule("corpus", await import("../corpus.ts"));
  const { hvfAvailable } = await import("../qemu-run.ts");
  const report = M.report;
  const hvf = hvfAvailable();
  const onBoth = async (filter: string): Promise<Awaited<ReturnType<typeof runNative>>> =>
    runNative("mem", ["hvf", "tcg"], jobs, filter, engines);
  const needBoth = (s: { agreement: { skipped: boolean }[] }): boolean =>
    s.agreement.every((a) => !a.skipped);

  // Boxes 4 and 6 share the negative corpus, and the whole of it is about 20 s: one unit.
  M.unit("1-11", async () => {
    // 1. TSL proper: classes, and typed-array methods and relative imports along the way.
    const classes = await onBoth("plain_class");
    const misc = await onBoth("lang_misc");
    report({
      ...suiteItem(
        "1. Plain classes in TSL proper: fields, constructors, parameter properties, methods, getters and setters, static constants, stack and top-level new, enumValue, .subarray, .fill, .set, relative imports, and 3.6's bans still hold. Natively on HVF and TCG, against V8 and JSC",
        classes,
        misc,
      ),
    });
    // 2. Closures.
    const closures = await onBoth("closures");
    {
      const { checkFile, compileTyped } = timedModule("tslc", await import("../lowering.ts"));
      const { typed } = checkFile(join(ROOT, "corpus/mem/closures.ts"));
      const text = typed !== null ? compileTyped(typed).tirText : "";
      const allocating =
        /call @(?!__|.*Counter|apply|twice|each|topLevel|capturesConst|mutates|nested|capturesThis|inNoAlloc)/.test(
          text,
        );
      report({
        ...suiteItem(
          "2. Non-escaping capturing closures: code pointer and environment on the caller's stack, working in @tsl.noalloc code, allocating nothing (the program's TIR calls only its own functions)",
          closures,
        ),
        ok: closures.ok && needBoth(closures) && typed !== null && !allocating,
      });
    }
    // 3. Layout classes.
    const layout = await onBoth("layout");
    const agree = await suite("layoutAgreement", () => layoutAgreement());
    report({
      box: "3. Layout classes and helpers with the normative algorithm: every helper natively, and tslc's sizes and offsets agree with the host's capture mode for every layout class in the corpus (M3's box). @tsl.size on plain classes",
      ok: layout.ok && needBoth(layout) && agree.failures.length === 0 && agree.classes > 0,
      detail: `${layout.summary}; ${agree.classes} layout classes agree`,
      failures: [...layout.failures, ...agree.failures],
    });
    // 4 and 6. Pointers, and everything that must be rejected.
    const heapS = await onBoth("alloc_heap");
    const neg = await runNegative(jobs, undefined, engines);
    const codes = [
      "TSL3001",
      "TSL3002",
      "TSL3003",
      "TSL3005",
      "TSL3006",
      "TSL3007",
      "TSL5001",
      "TSL5002",
      "TSL5005",
      "TSL1012",
      "TSL1014",
      "TSL1015",
      "TSL1016",
      "TSL1017",
    ];
    const negFiles = listPrograms(join(ROOT, "corpus/neg"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const uncovered = codes.filter((c) => !negFiles.includes(`expect: ${c} at`));
    report({
      box: "4. @tsl/unsafe: Ptr, ptrAt, elemSize, ref, inlineOf, sliceOf, copyBytes, viewAt, bytesAt, addrOf, placeObject, objectAt, slotOf, genOf, retireObject, simulated on the host and real memory natively. TSL5001, TSL5002 and TSL5005 enforced",
      ok: heapS.ok && needBoth(heapS) && neg.ok && !uncovered.some((c) => c.startsWith("TSL500")),
      detail: heapS.summary,
      failures: heapS.failures,
    });
    // The hard requirement on all compilers: the same source gives the same TIR, whichever engine hosts tslc.
    {
      const files = listPrograms(join(ROOT, "corpus/mem"), "alloc_");
      const a = await compileBatch(files, buildPath("repro/mem-a"), jobs, engines.node);
      const b = await compileBatch(files, buildPath("repro/mem-b"), jobs, engines.bun);
      const problems = a.flatMap((x, i) =>
        x.tirHash === undefined || x.tirHash !== b[i]?.tirHash
          ? [`${x.file}: differs: ${x.crash ?? ""} ${b[i]?.crash ?? ""}`]
          : [],
      );
      report({
        box: "Determinism: a program using classes and @tsl/alloc gives the same tirhash with tslc on Node and on Bun",
        ok: problems.length === 0 && a.length > 0,
        detail: `${a.length} programs`,
        failures: problems,
      });
    }
    // 5. Stored references.
    const slab = await onBoth("alloc_slab");
    const adv = await onBoth("gen_adversarial");
    report({
      ...suiteItem(
        "5. Stored references: a 48-bit pointer and 16-bit generation, a generation word before each object, gen.chk on member access trapping with code 5, comparison doesn't dereference, static objects carry a prefix. With adversarial tests: slot reuse with an old reference, a wrapped generation, a stale reference in a stack object",
        slab,
        adv,
      ),
    });
    report({
      box: "6. Escape checking: whole-program summaries, TSL3001, 3002, 3003, 3005, 3006, 3007, @tsl.moves, errors naming the storing line and call chain, @tsl.noalloc verified transitively. Negative corpus covers each rule, exact code and position",
      ok: neg.ok && uncovered.length === 0,
      detail: `${neg.summary}; codes covered: ${codes.join(", ")}`,
      failures: [...neg.failures, ...uncovered.map((c) => `no negative test for ${c}`)],
    });
    // 7. The library, from the spec.
    const { checkBlocks, specBlocks, ALLOC_MODULES } = await import("../spec-extract.ts");
    const drift = checkBlocks(false);
    const run = await onBoth("run_");
    const typecheck = await guardedRun(
      join(ROOT, "node_modules/.bin/tsc"),
      ["-p", join(ROOT, "tsconfig.json"), "--noEmit"],
      { timeoutMs: 300_000, label: "tsc", cwd: ROOT },
    );
    report({
      box: "7. @tsl/alloc is the spec's ex-heap, ex-vec and ex-slab byte for byte, with no compiler knowledge of the containers. ex-virtq, ex-mmio, ex-entry, ex-sys and ex-pages typecheck, and ex-heap, ex-vec, ex-slab, ex-memory and ex-messages compile and run",
      ok: drift.length === 0 && run.ok && needBoth(run) && typecheck.ok,
      detail: `${specBlocks().size} spec blocks extracted and compared (${ALLOC_MODULES.join(", ")} also in packages/tsl-alloc); ${run.summary}; tsc over packages and corpus: ${typecheck.ok ? "clean" : "errors"}`,
      failures: [
        ...drift,
        ...run.failures,
        ...(typecheck.ok ? [] : [typecheck.stdout.slice(0, 1500)]),
      ],
    });
    // 8. Everything together, by the corpus machinery.
    const all = await runNative("mem", ["hvf", "tcg"], jobs, undefined, engines);
    const divergence5 = readFileSync(
      join(ROOT, "corpus/mem/gen_adversarial.cases.json"),
      "utf8",
    ).includes("diverge5");
    report({
      box: "8. The whole memory corpus natively under QEMU on HVF and TCG, against V8 and JSC: block reuse, Vec growth past 1,000 of scalars and references, withSlice and the code 13 trap, use-after-free, double free, using, slab growth, slot reuse, removal during forEach, stale references, generation exhaustion, out of memory, ex-memory and ex-messages. Divergence 5 shown by a test on both sides",
      ok: all.ok && needBoth(all) && divergence5 && hvf.ok,
      detail: `${all.summary}${hvf.ok ? "" : `; HVF SKIPPED: ${hvf.why}`}`,
      failures: all.failures,
    });
    // 9. Numbers, with no gate.
    const { benchAlloc, allocText } = timedModule("bench", await import("../bench-alloc.ts"));
    // No gate: a short run here, the measurement in tmk bench all (SPEC 8.4, D51).
    const bench = await benchAlloc({ quick: true });
    M.keep("bench", bench);
    report({
      box: "9. tmk bench alloc ran: native Vec.push, Slab.add and remove, and field access through a stored reference, against hand-written C with clang -O2 -ffp-contract=off. No gate: reported plainly",
      ok:
        bench.skipped === null && bench.errors.length === 0 && Object.keys(bench.rows).length === 3,
      detail: allocText(bench).split("\n").join("\n     "),
      failures: bench.errors,
    });
    // 10. The audit.
    const { audit, auditText } = await import("../audit.ts");
    const a = audit();
    M.keep("audit", a);
    report({
      box: "10. tmk audit: unsafe modules, unsafe LOC against total, and @tsl/alloc's size (3.8). Every module importing @tsl/unsafe is listed",
      ok: a.modules.length > 0 && a.modules.every((m) => m.listed) && a.alloc.loc > 0,
      detail: auditText(a).split("\n").join("\n     "),
      failures: [],
    });
  });

  M.nested(
    "12",
    "11. Milestones native-a, m1 and m2 still pass (native-a runs the other two as its own boxes)",
    "native-a",
  );
  M.vms("13", "No QEMU process of this run is left", false);
}
