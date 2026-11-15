// M1: TSL core to Wasm with a differential corpus (SPEC M1). One unit: its last box times the whole of it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPath } from "../build-dir.ts";
import { defaultEngines, listPrograms, ROOT, type Engines } from "../corpus.ts";
import {
  compileBatch,
  doctorChecks,
  jobsFlag,
  needInstall,
  repoChecks,
  runNegative,
  runNoBuild,
  runPositive,
  runTrap,
  suiteItem,
  unitTests,
  type Item,
  type MilestoneDef,
} from "../tmk-common.ts";
import { suite } from "../timing.ts";

async function byteIdentity(engines: Engines, jobs: number): Promise<Item> {
  const files = listPrograms(join(ROOT, "corpus/pos"));
  const a = await compileBatch(files, buildPath("repro/node-a"), jobs, engines.node);
  const b = await compileBatch(files, buildPath("repro/node-b"), jobs, engines.node);
  const c = await compileBatch(files, buildPath("repro/bun"), jobs, engines.bun);
  const failures: string[] = [];
  const index = (list: typeof a): Map<string, (typeof a)[number]> =>
    new Map(list.map((x) => [x.file, x]));
  const ia = index(a);
  const ib = index(b);
  const ic = index(c);
  for (const f of files) {
    const x = ia.get(f);
    const y = ib.get(f);
    const z = ic.get(f);
    const short = f.replace(`${ROOT}/`, "");
    if (x?.wasmSha === undefined) {
      failures.push(`${short}: no output: ${x?.crash ?? ""}`);
      continue;
    }
    if (x.wasmSha !== y?.wasmSha || x.tirHash !== y?.tirHash)
      failures.push(`${short}: differs between two Node runs`);
    if (x.wasmSha !== z?.wasmSha || x.tirHash !== z?.tirHash) {
      failures.push(`${short}: differs between Node and Bun: ${z?.crash ?? ""}`);
    }
  }
  return {
    box: "tmk compile twice gives byte-identical Wasm and identical tirhash, also when hosted on Bun",
    ok: failures.length === 0 && files.length > 0,
    detail: `${files.length} programs, 3 builds each (Node, Node, Bun)`,
    failures,
  };
}

export async function defineM1(M: MilestoneDef): Promise<void> {
  needInstall();
  const jobs = jobsFlag();
  const engines = defaultEngines();
  const items = { push: M.report };

  M.unit("1-9", async () => {
    const started = Date.now();
    const checks = doctorChecks();
    const required = ["node", "tsc", "oxlint", "oxfmt", "qemu"];
    const missing = required.filter((t) => checks.find((c) => c.tool === t)?.status === "missing");
    items.push({
      box: "tmk doctor reports node, tsc, oxlint, oxfmt, qemu and the versions in Appendix B",
      ok: missing.length === 0,
      detail: checks
        .filter((c) => required.includes(c.tool))
        .map((c) => `${c.tool} ${c.version ?? "missing"} (Appendix B: ${c.expected})`)
        .join(", "),
      failures: missing,
    });

    items.push(
      suiteItem("tsc, oxlint and oxfmt --check are clean over the repo", ...(await repoChecks())),
    );
    items.push(
      suiteItem(
        "All positive corpus files run under Node with ts-hook.mjs and under Bun directly, with no build step",
        await runNoBuild(jobs, engines),
      ),
    );

    const pos = await runPositive(jobs, undefined, engines);
    const enough = pos.count >= 30;
    items.push(
      suiteItem(
        "tmk corpus passes 100% with all 30 programs on 4 configurations",
        enough
          ? pos
          : {
              ...pos,
              ok: false,
              failures: [...pos.failures, `only ${pos.count} of 30 programs pass`],
            },
      ),
    );

    const shaCases = join(ROOT, "corpus/pos/sha256_u32.cases.json");
    const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const pinned = existsSync(shaCases) && readFileSync(shaCases, "utf8").includes(digest);
    const shaFailures = pos.failures.filter((f) => f.includes("sha256_u32"));
    items.push({
      box: 'sha256_u32 matches the FIPS 180 known-answer for "abc"',
      ok: pinned && shaFailures.length === 0 && pos.count >= 30,
      detail: pinned
        ? `pinned ${digest}, checked on all 4 configurations`
        : "known-answer case is missing",
      failures: shaFailures,
    });

    const neg = await runNegative(jobs, undefined, engines);
    items.push(
      suiteItem(
        "tmk corpus --neg passes with at least 30 cases: exact code and position",
        neg.count >= 30
          ? neg
          : { ...neg, ok: false, failures: [...neg.failures, `only ${neg.count} cases`] },
      ),
    );

    const trapSuite = await runTrap(jobs, undefined, engines);
    const needed = ["overflow", "bad_index", "div_zero", "to_u8_300"];
    const missingTraps = needed.filter((n) => !existsSync(join(ROOT, `corpus/trap/${n}.ts`)));
    items.push(
      suiteItem(
        "tmk corpus --trap: overflow, bad index, divide by zero, toU8(300), each with the right code on Wasm and js-checked",
        missingTraps.length === 0
          ? trapSuite
          : {
              ...trapSuite,
              ok: false,
              failures: [...trapSuite.failures, `missing: ${missingTraps.join(", ")}`],
            },
      ),
    );

    items.push(await suite("byteIdentity", () => byteIdentity(engines, jobs)));

    const units = await unitTests();
    // The whole milestone, as one unit, from its first box to here: what it always measured.
    const seconds = (Date.now() - started) / 1000;
    items.push({
      box: "All tests are guarded, and the suite finishes in under 2 minutes",
      ok: units.ok && seconds < 120,
      detail: `guarded-run on every child; ${units.name}: ${units.summary}; total ${seconds.toFixed(1)} s`,
      failures: units.failures,
    });
  });
}
