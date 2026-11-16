// Compiles and links on worker threads, so a suite's jobs aren't queued behind one another on the test process's event loop
// (SPEC 9.3, D45). At most one job per worker, and each job has a hard timeout: past it, its worker is terminated and replaced.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ImageOutput } from "../compiler/backend-aarch64/image.ts";
import type { LowerOptions } from "../compiler/host/tslc.ts";
import { jobEnv, type BuildJob, type RoutesJob, type SlimLower } from "./compile-worker.ts";
import type { BuiltImages } from "./dual-build.ts";
import type { PipeMode, PipeProgram } from "./pipe-tests.ts";
import type { LowerCase } from "./lower-exec.ts";
import type { DownImage, RcHarness } from "./native-exec.ts";
import { takeCpu } from "./cpu-budget.ts";
import { phase } from "./timing.ts";

const WORKERS = Math.min(4, availableParallelism());
/**
 * At most this many of the dual route's jobs at once in one process (R12): a routes job builds both routes and both images,
 * and four of them beside the test process put pipe-a box 3 at 2.81 GiB against the 3 GiB watchdog. MEASURED alone (R12):
 * 2.63 GiB in 119 s with three, 2.29 GiB in 136 s with two. Fewer at once, not a higher limit.
 */
export const ROUTES_AT_ONCE = 2;
const JOB_TIMEOUT_MS = 300_000;

export interface Built {
  o: SlimLower;
  cases: LowerCase[];
  built: {
    image: Pick<ImageOutput, "bytes" | "ranges" | "bulk">;
    placements: DownImage["placements"];
  } | null;
  ms?: { compileMs: number; imageMs: number };
}

interface Waiting {
  job: BuildJob | RoutesJob;
  resolve: (b: Built & { routes?: { p: PipeProgram; built: BuiltImages | null } }) => void;
  reject: (e: Error) => void;
}

interface Slot {
  w: Worker;
  busy: Waiting | null;
  timer: NodeJS.Timeout | null;
  /** The run's CPU token the job in hand holds (tools/cpu-budget.ts), given back when it's done. */
  give: (() => void) | null;
}

const slots: Slot[] = [];
const queue: Waiting[] = [];
let nextId = 1;

function spawnSlot(): Slot {
  const w = new Worker(new URL("./compile-worker.ts", import.meta.url), {
    execArgv: ["--no-warnings"],
    // Collected sooner: four workers that each let garbage grow toward a gigabyte put a nested milestone over its watchdog.
    resourceLimits: { maxOldGenerationSizeMb: 640 },
  });
  w.unref();
  const slot: Slot = { w, busy: null, timer: null, give: null };
  w.on(
    "message",
    (
      m: Built & {
        id: number;
        error?: string;
        compileMs: number;
        imageMs: number;
        routes?: { p: PipeProgram; built: BuiltImages | null };
      },
    ) => {
      const t = slot.busy;
      release(slot);
      if (t === null) return;
      if (m.error !== undefined) t.reject(new Error(m.error));
      else
        t.resolve({
          o: m.o,
          cases: m.cases ?? [],
          built: m.built ?? null,
          ms: m,
          ...(m.routes !== undefined ? { routes: m.routes } : {}),
        });
      pump();
    },
  );
  w.on("error", (e) => {
    replace(slot, e instanceof Error ? e : new Error(String(e)));
  });
  w.on("exit", () => {
    if (slot.busy !== null) replace(slot, new Error("a compile worker exited"));
  });
  return slot;
}

const IDLE_MS = 10_000;

/** A free worker waits a while for the next job, then goes, with everything it held. */
function release(slot: Slot): void {
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.give?.();
  slot.give = null;
  slot.busy = null;
  slot.w.unref();
  slot.timer = setTimeout(() => {
    if (slot.busy !== null) return;
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    void slot.w.terminate();
  }, IDLE_MS);
  slot.timer.unref();
}

function replace(slot: Slot, e: Error): void {
  const t = slot.busy;
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.give?.();
  slot.give = null;
  slot.busy = null;
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  void slot.w.terminate();
  t?.reject(e);
  pump();
}

/** Jobs given to a worker or holding a token on their way to one, and of those the dual route's. */
let started = 0;
let routesStarted = 0;
const isRoutes = (w: Waiting): boolean => (w.job as RoutesJob).kind === "routes";

/**
 * Starts what the limits allow: WORKERS jobs at once, ROUTES_AT_ONCE of them the dual route's, each holding one of the
 * run's CPU tokens from before its worker has it until it's done, so a job waiting for a token isn't on a worker's clock.
 */
function pump(): void {
  while (started < WORKERS) {
    const at = queue.findIndex((w) => !isRoutes(w) || routesStarted < ROUTES_AT_ONCE);
    if (at < 0) return;
    const t = queue.splice(at, 1)[0]!;
    const routes = isRoutes(t);
    started++;
    if (routes) routesStarted++;
    void takeCpu().then((give) => dispatch(t, give, routes));
  }
}

function dispatch(t: Waiting, give: () => void, routes: boolean): void {
  let slot = slots.find((s) => s.busy === null);
  if (slot === undefined) {
    slot = spawnSlot();
    slots.push(slot);
  }
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.busy = t;
  let ended = false;
  slot.give = () => {
    if (ended) return;
    ended = true;
    give();
    started--;
    if (routes) routesStarted--;
    // after this tick: the job's own handler runs pump() itself, and the next one shouldn't start inside release()
    queueMicrotask(pump);
  };
  slot.w.ref(); // a job in hand keeps the process alive
  const held = slot;
  slot.timer = setTimeout(() => {
    replace(held, new Error(`compiling ${t.job.file}: over ${JOB_TIMEOUT_MS} ms`));
  }, JOB_TIMEOUT_MS);
  slot.w.postMessage(t.job);
}

/** Lowers a program and links its test image, on a worker. `built` is null if it has diagnostics or a fallback left. */
export function lowerAndBuild(req: {
  file: string;
  lower: LowerOptions;
  cases?: LowerCase[];
  pages?: number | undefined;
  harness?: RcHarness;
  stackBytes?: number | undefined;
  noFallback?: boolean;
}): Promise<Built> {
  const done = new Promise<Built>((resolve, reject) => {
    const env = jobEnv();
    const job: BuildJob = {
      id: nextId++,
      file: req.file,
      lower: req.lower,
      harness: req.harness ?? {},
      env,
      ...(req.cases !== undefined ? { cases: req.cases } : {}),
      ...(req.pages !== undefined ? { pages: req.pages } : {}),
      ...(req.stackBytes !== undefined ? { stackBytes: req.stackBytes } : {}),
      ...(req.noFallback === true ? { noFallback: true } : {}),
    };
    queue.push({ job, resolve, reject });
    pump();
  });
  // Here, and not in the worker's message handler, so the time goes to the suite that asked.
  return done.then((b) => {
    phase("compile", b.ms?.compileMs ?? 0);
    phase("image", b.ms?.imageMs ?? 0);
    return b;
  });
}

/**
 * Both routes of one program of the dual route (tools/dual-build.ts), and their images, on a worker (T2): with this process's
 * TMK_* and TSL_* as they are now, the printer's injected bug included. What it gives is what bothRoutes gives in the test
 * process, with each route's image built as runRoute built it.
 */
export function bothRoutesOnWorker(req: {
  file: string;
  mode: PipeMode;
  level: 0 | 2;
  fault: string | undefined;
  classes: boolean;
  bulkBytes: number;
  auto?: boolean;
}): Promise<{ p: PipeProgram; built: BuiltImages | null }> {
  const done = new Promise<Built & { routes?: { p: PipeProgram; built: BuiltImages | null } }>(
    (resolve, reject) => {
      const env = jobEnv();
      // The printer's bug as bothRoutes puts it in: TMK_TEST_EMIT for the TSL route alone (dual-build.ts).
      const job: RoutesJob = {
        id: nextId++,
        kind: "routes",
        file: req.file,
        mode: req.mode,
        level: req.level,
        ...(req.fault !== undefined ? { fault: req.fault } : {}),
        classes: req.classes,
        bulkBytes: req.bulkBytes,
        ...(req.auto === true ? { auto: true } : {}),
        env,
      };
      queue.push({ job, resolve, reject });
      pump();
    },
  );
  return done.then((b) => {
    phase("compile", b.ms?.compileMs ?? 0);
    return b.routes!;
  });
}
