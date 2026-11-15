// R6 (SPEC M5's R6 record, D36, D62, D66): D36 moved to TSL's own layout, a read's checks printed once, and tslc's per-call
// region for lowered `leak` and `manual`. The bugs put into each new transform, and what catches each: the dual route
// (r2-tests.ts's runner), tslc's layout check (r5-tests.ts's checkFaultRun, with R6's bug), or a run with no arena reset.
import { readFileSync } from "node:fs";
import type { R2Fault } from "./r2-tests.ts";
import type { Accel } from "./qemu-run.ts";
import { ROOT } from "./corpus.ts";

/** R6's own programs, each built through both routes by the differential (corpus/lower/pipe). */
export const R6_PROGRAMS = ["corpus/lower/pipe/region.ts", "corpus/lower/pos/read_checks.ts"];

/** D36's layout through the direct route and the native caller, in every mode against V8 (not printable: a bool array). */
export const R6_LAYOUT = "corpus/lower/pos/d36_layout.ts";

export const R6_FAULTS: R2Fault[] = [
  {
    name: "read-check-wrap",
    what: "a read whose bounds check was folded into JsArray's get given an index get can't refuse (i % length), as if the check were folded into a read that doesn't make it",
    transform:
      "a vector read's bounds check printed as JsArray's get alone (emit-tsl.ts's foldedReads)",
    where: "printer",
    dirs: ["corpus/lower/pos"],
    modes: ["leak", "manual"],
    classes: true,
    only: "read_checks",
  },
  {
    name: "region-escaping",
    what: "a class kept in module state placed in the per-call region all the same, so what a later call reads was given back and overwritten",
    transform: "tslc's per-call region (region.ts's placeRegion)",
    where: "backend",
    dirs: ["corpus/lower/pipe"],
    modes: ["leak", "manual"],
    classes: true,
    only: "region",
  },
  {
    name: "region-buffer-heap",
    what: "a JsArray in the per-call region taking its buffers from the global allocator, which nothing gives back in leak, so a churning call runs its 64 pages out",
    transform: "JsArray's buffers in the region where the array is (inCallRegion, callRegionBytes)",
    where: "library",
    patch: {
      file: "packages/tsl-jsrt/ex-jsrt-array.ts",
      from: "inCallRegion(this) ? callRegionBytes(bytes) : heap.allocBytes(bytes)",
      to: "heap.allocBytes(bytes)",
    },
    dirs: ["corpus/lower/pipe"],
    modes: ["leak", "manual"],
    classes: true,
    only: "region",
  },
];

/**
 * The bug in D36's layout itself, which only the direct route against V8 sees (the TSL route's classes are TSL's own):
 * caught by d36_layout.ts natively in each mode (tmk's corpus --native lower).
 */
export const R6_LAYOUT_FAULT = {
  name: "d36-bool-word",
  what: "a bool laid out as a byte by TSL's rule but stored and loaded as a 4-byte word, over the fields after it",
  transform:
    "D36's layout by TSL's rule in the direct route and phase 1's printing (down-model.ts's memOf)",
};

/** R6_LAYOUT_FAULT, or none: d36_layout.ts natively in each mode, how many cases disagree with V8. */
export async function layoutRun(
  accel: Accel,
  fault: boolean,
): Promise<{ cases: number; agreed: number; failures: string[] }> {
  const { runNative, defaultEngines } = await import("./corpus.ts");
  const was = process.env.TMK_TEST_DOWN;
  if (fault) process.env.TMK_TEST_DOWN = R6_LAYOUT_FAULT.name;
  let cases = 0;
  let agreed = 0;
  const failures: string[] = [];
  try {
    for (const m of [undefined, "leak", "manual", "rc"] as const) {
      const r = await runNative("lower", [accel], 4, "d36_layout", defaultEngines(), m);
      for (const a of r.agreement) {
        cases += a.cases;
        agreed += a.agreed;
      }
      failures.push(...r.failures);
    }
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_DOWN;
    else process.env.TMK_TEST_DOWN = was;
  }
  return { cases, agreed, failures };
}

/** The bug a run with no arena reset catches: an export that never gives its region back. */
export const R6_KEPT_FAULT = {
  name: "region-kept",
  what: "an export that never gives the per-call region back at its return, so calls with no caller's reset between them run the arena out",
  transform:
    "each export marking the region at entry and giving it back at every return (lower.ts's giveBackRegion)",
};

/**
 * The region given back at each export's return, seen by a caller that never rewinds the arena (a native caller may rely
 * on it, as nothing else does it for it): region.ts's churn called 30 times in leak and manual, ~7 MB of call-bounded
 * objects each in a 96 MiB arena. Through the TSL route every case comes back and agrees with V8; through the direct route,
 * whose call arena only a caller rewinds, it runs out (trap 14), which is the difference the region makes. With `fault`
 * set (TMK_TEST_TSL), the TSL route's own result.
 */
export async function keptRun(
  accel: Accel,
  fault?: string,
): Promise<{
  skipped: boolean;
  rows: string[];
  tslOk: boolean;
  directOom: boolean;
  tslOom: boolean;
}> {
  const { lowerFile } = await import("./lowering.ts");
  const { buildDownImage, downResults } = await import("./native-exec.ts");
  const { qemuRun } = await import("./qemu-run.ts");
  const { referenceOnV8, compareResults } = await import("./strmap-run.ts");
  const file = `${ROOT}/corpus/lower/pipe/region.ts`;
  const pages = Number(/^\/\/ memory-pages: (\d+)$/m.exec(readFileSync(file, "utf8"))![1]);
  const cases = Array.from({ length: 30 }, () => ({ fn: "churn", args: [4000, 16] }));
  const want = await referenceOnV8(file, cases);
  const rows: string[] = [];
  let tslOk = true;
  let directOom = true;
  let tslOom = false;
  const was = process.env.TMK_TEST_TSL;
  const wasClos = process.env.TMK_EMIT_CLOS;
  process.env.TMK_EMIT_CLOS = "1"; // region.ts keeps a closure, which the TSL route prints as a class
  try {
    for (const memory of ["leak", "manual"]) {
      for (const route of ["tsl", "direct"] as const) {
        if (fault !== undefined && route === "tsl") process.env.TMK_TEST_TSL = fault;
        else if (was === undefined) delete process.env.TMK_TEST_TSL;
        else process.env.TMK_TEST_TSL = was;
        const o = lowerFile(file, {
          memory,
          opt: 2,
          route,
          ...(route === "tsl" ? { classes: true } : {}),
        });
        const built = buildDownImage(o.tir!, o.meta as never, cases, pages, {
          noArenaReset: true,
          noDump: true,
        });
        const q = await qemuRun({
          name: `r6-kept/${memory}-${route}`,
          image: built.image.bytes,
          accel,
          timeoutMs: 120_000,
          ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
        });
        if (q.skipped)
          return { skipped: true, rows, tslOk: false, directOom: false, tslOom: false };
        const res = downResults(o.meta as never, cases, built.placements, q.lines);
        const oom = res.results.some((r) => (r.result as { trap?: number })?.trap === 14);
        const problems = [...res.problems, ...compareResults(res.results, want, cases, memory)];
        const done = res.results.filter(
          (r) => (r.result as { trap?: number })?.trap === undefined,
        ).length;
        rows.push(
          `${memory} ${route}: ${done}/${cases.length} cases${oom ? ", then out of memory" : ""}`,
        );
        if (route === "tsl") {
          if (problems.length > 0 || res.results.length !== cases.length) tslOk = false;
          if (oom) tslOom = true;
        } else if (!oom) directOom = false;
      }
    }
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_TSL;
    else process.env.TMK_TEST_TSL = was;
    if (wasClos === undefined) delete process.env.TMK_EMIT_CLOS;
    else process.env.TMK_EMIT_CLOS = wasClos;
  }
  return { skipped: false, rows, tslOk, directOom, tslOom };
}
