// The test process's compiler, off its one thread (SPEC 9.3, D45): each worker keeps typescript.js and its parsed library files
// loaded, as a batch of compiles in one process always has, and lowers a program and builds its image for whichever job asks.
// Each answer depends only on what the job says: lowerFile's output is a function of the file, its options and the injected bug.
import { parentPort } from "node:worker_threads";
import type { LowerOptions, LowerOutput } from "../compiler/host/tslc.ts";
import type { LowerCase } from "./lower-exec.ts";
import { lowerFile } from "./lowering.ts";
import { buildDownImage, type DownMetaLike, type RcHarness } from "./native-exec.ts";
import { bothRoutesBuilt } from "./dual-build.ts";
import type { PipeMode } from "./pipe-tests.ts";

/**
 * What a job takes from its parent's environment: every TMK_* and TSL_* variable, as the parent has them when it asks (T2).
 * The injected bugs (TSL_TEST_PATCH, TMK_TEST_*), the optimiser's level and switches, the printer's (TMK_EMIT_*, TMK_R*_OFF)
 * and the run's store: what a build in the test process itself would read. A list of some of them was how T1 found
 * TMK_TEST_EMIT and TMK_EMIT_* missing, which would have let an injected printer bug vanish on a worker.
 */
export const passedOn = (k: string): boolean => /^(TMK_|TSL_)/.test(k);

export function jobEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (passedOn(k) && v !== undefined) env[k] = v;
  return env;
}

/** The worker's environment made the job's: its TMK_* and TSL_* exactly the parent's, nothing left from an earlier job. */
function takeEnv(env: Record<string, string>): void {
  for (const k of Object.keys(process.env))
    if (passedOn(k) && env[k] === undefined) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

export interface BuildJob {
  id: number;
  file: string;
  lower: LowerOptions;
  /** The cases to build in, or none: the random programs' are every `run` export, three times, then `digest`. */
  cases?: LowerCase[];
  pages?: number;
  harness: RcHarness;
  ramBytes?: number;
  stackBytes?: number;
  env: Record<string, string>;
  noFallback?: boolean; // a function left in JS means there's no image to build
}

/** One item of the dual route (tools/dual-build.ts): both routes of a program, and their images. */
export interface RoutesJob {
  id: number;
  kind: "routes";
  file: string;
  mode: PipeMode;
  level: 0 | 2;
  fault?: string;
  classes: boolean;
  bulkBytes: number;
  env: Record<string, string>;
}

/** What a test needs back: no Wasm, and of the TIR only the names of its globals, for reading counters. */
export type SlimLower = Omit<LowerOutput, "wasm" | "glue" | "tirText">;

function slim(o: LowerOutput): SlimLower {
  const { wasm: _w, glue: _g, tirText: _t, ...rest } = o;
  return {
    ...rest,
    tir:
      o.tir === null
        ? null
        : {
            sigs: [],
            funcs: [],
            traps: [],
            externs: o.tir.externs,
            globals: o.tir.globals.map((g) => ({ ...g, bytes: undefined }) as never),
          },
  };
}

function roundCases(o: LowerOutput): LowerCase[] {
  const exportsOf = Object.keys(o.meta!.exports)
    .filter((k) => k.startsWith("run"))
    .sort();
  const cases: LowerCase[] = [];
  for (let round = 0; round < 3; round++) {
    for (const fn of exportsOf) cases.push({ fn, args: [round + 1] });
    cases.push({ fn: "digest", args: [] });
  }
  return cases;
}

function routes(job: RoutesJob): void {
  try {
    takeEnv(job.env);
    const t0 = performance.now();
    const r = bothRoutesBuilt(job.file, job.mode, job.level, job.fault, job.classes, job.bulkBytes);
    const buffers =
      r.built === null
        ? []
        : [r.built.direct.image.bytes.buffer, r.built.tsl.image.bytes.buffer].filter(
            (b, i, all) => all.indexOf(b) === i,
          );
    parentPort!.postMessage(
      { id: job.id, routes: r, compileMs: performance.now() - t0, imageMs: 0 },
      buffers as ArrayBuffer[],
    );
  } catch (e) {
    parentPort!.postMessage({
      id: job.id,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}

parentPort?.on("message", (job: BuildJob | RoutesJob) => {
  if ("kind" in job && job.kind === "routes") {
    routes(job);
    return;
  }
  build(job as BuildJob);
});

function build(job: BuildJob): void {
  try {
    takeEnv(job.env);
    const t0 = performance.now();
    const o = lowerFile(job.file, job.lower);
    const t1 = performance.now();
    if (
      o.tir === null ||
      o.diags.length > 0 ||
      (job.noFallback === true && o.fallbackDiags.length > 0)
    ) {
      parentPort!.postMessage({ id: job.id, o: slim(o), compileMs: t1 - t0, imageMs: 0 });
      return;
    }
    const cases = job.cases ?? roundCases(o);
    const built = buildDownImage(
      o.tir,
      o.meta as DownMetaLike,
      cases,
      job.pages,
      job.harness,
      job.ramBytes,
      job.stackBytes,
    );
    const image = {
      bytes: built.image.bytes,
      ranges: built.image.ranges,
      ...(built.image.bulk !== undefined ? { bulk: built.image.bulk } : {}),
    };
    parentPort!.postMessage(
      {
        id: job.id,
        o: slim(o),
        cases,
        built: { image, placements: built.placements },
        compileMs: t1 - t0,
        imageMs: performance.now() - t1,
      },
      [image.bytes.buffer as ArrayBuffer],
    );
  } catch (e) {
    parentPort!.postMessage({
      id: job.id,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
