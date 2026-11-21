// Seconds per box and per suite, in build/milestones/*.json (SPEC 8.3, D45). A suite is one call of a test function; what runs
// inside it adds to its phases, whichever job of its pool that happens in. Nothing here decides a result.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";

export interface PhaseTotal {
  n: number;
  ms: number;
  bytes?: number;
}

export interface SuiteTiming {
  name: string;
  seconds: number;
  counts: Record<string, number>;
  phases: Record<string, PhaseTotal>;
  cpuSeconds: number; // this process's user and system time over the suite, whatever else was running
  ok?: boolean;
  summary?: string; // a suite's own line, when it has one: "32/32 programs, 333 cases, ..."
}

export interface MemorySample {
  at: string;
  seconds: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface BoxTiming {
  box: string;
  seconds: number;
  suites: SuiteTiming[];
  nested?: MilestoneTiming;
}

export interface MilestoneTiming {
  milestone: string;
  seconds: number;
  cpuSeconds: number;
  host: { load: number[]; cpus: number; node: string };
  boxes: BoxTiming[];
  memory: {
    peakRss: number;
    peakAt: string;
    peak: MemorySample | null;
    samples: MemorySample[];
  };
}

const current = new AsyncLocalStorage<SuiteTiming>();
let milestone: MilestoneRecorder | null = null;
let looseSuites: SuiteTiming[] = [];

/** Adds to the phase of whichever suite is running: QEMU's wall clock, a child's, a compile. */
export function phase(name: string, ms: number, bytes?: number): void {
  const s = current.getStore();
  if (s === undefined) return;
  const p = (s.phases[name] ??= { n: 0, ms: 0 });
  p.n++;
  p.ms += ms;
  if (bytes !== undefined) p.bytes = (p.bytes ?? 0) + bytes;
}

/** A synchronous stretch of this process's own thread, which nothing else of the suite can use meanwhile. */
export function timedSync<T>(name: string, f: () => T): T {
  const t = performance.now();
  try {
    return f();
  } finally {
    phase(name, performance.now() - t);
  }
}

// Not what a suite did, but how long or how large: these differ from run to run on their own.
const NOT_COUNTS = /ms$|ns$|ticks$|peak|bytes|seconds|frequency|^code$|^signal$|^budget$|^pid$/i;

/**
 * What a suite says it did, whatever shape its result has: its numbers, a native suite's agreement per accelerator,
 * and how many rows and failures it has. The before and after of `tmk` runs are compared on these.
 */
export function countsOf(
  r: unknown,
  prefix = "",
  out: Record<string, number> = {},
): Record<string, number> {
  if (r === null || typeof r !== "object") return out;
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (typeof v === "number") {
      if (!NOT_COUNTS.test(k)) out[key] = v;
    } else if (typeof v === "boolean") {
      if (k === "skipped" && v) out[key] = 1;
    } else if (Array.isArray(v)) {
      if (k === "agreement") {
        for (const a of v as { accel: string }[]) {
          countsOf({ ...a, accel: undefined }, `${a.accel}.`, out);
        }
      } else if (k !== "failures" || v.length > 0) out[`${key}.length`] = v.length;
    } else if (v !== null && typeof v === "object" && prefix === "") {
      const vals = Object.values(v as Record<string, unknown>);
      // A Record of tallies, as corpusRun returns.
      if (vals.length > 0 && vals.every((x) => x !== null && typeof x === "object")) {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          countsOf(v2, `${key}.${k2}.`, out);
        }
      }
    }
  }
  return out;
}

function describeArg(a: unknown): string | null {
  if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return String(a);
  if (Array.isArray(a) && a.every((x) => typeof x === "string" || typeof x === "number"))
    return `[${a.join(",")}]`;
  if (a !== null && typeof a === "object" && !("node" in a)) {
    // Options, as a test passes them. A compiler's own objects are neither small nor printable.
    const vals = Object.values(a);
    if (vals.length <= 8 && vals.every((v) => v === null || typeof v !== "object")) {
      return JSON.stringify(a);
    }
    if (vals.length <= 4 && vals.every((v) => v !== null && typeof v === "object")) {
      return `{${Object.entries(a)
        .map(([k, v]) => `${k}:${describeArg(v) ?? "?"}`)
        .join(",")}}`;
    }
    // A compiler's module that says which program it is (TypedModule's repo-relative `file`): named by that, so a suite
    // per compile is one per program. Without it every compile of a level shared one name, and since a fast one isn't
    // kept (run, below), which programs' counts a run kept depended on time: two runs of the same tree kept different
    // programs under the same name and `tmk gate --sample` couldn't compare them (opt-a box 4's compileTyped at -O0).
    const file = (a as { file?: unknown }).file;
    if (typeof file === "string" && file !== "") return file;
  }
  return null;
}

function run<R>(name: string, f: () => R): R {
  if (milestone === null || current.getStore() !== undefined) return f();
  const s: SuiteTiming = { name, seconds: 0, counts: {}, phases: {}, cpuSeconds: 0 };
  const t = performance.now();
  const c = process.cpuUsage();
  const end = (r?: unknown): void => {
    s.seconds = (performance.now() - t) / 1000;
    const u = process.cpuUsage(c);
    s.cpuSeconds = (u.user + u.system) / 1e6;
    if (r === undefined) return;
    s.counts = Array.isArray(r) ? { length: r.length } : countsOf(r);
    if (r !== null && typeof r === "object" && "ok" in r) s.ok = (r as { ok: unknown }).ok === true;
    if (r !== null && typeof r === "object" && "summary" in r) {
      s.summary = String((r as { summary: unknown }).summary).slice(0, 400);
    }
  };
  milestone.running = name;
  const box = looseSuites;
  box.push(s);
  const r = current.run(s, f);
  if (r instanceof Promise) {
    return r.then(
      (v: unknown) => {
        end(v);
        return v;
      },
      (e: unknown) => {
        end();
        throw e;
      },
    ) as R;
  }
  end(r);
  // A synchronous helper of a test module isn't worth a line unless it took real time.
  if (s.seconds < 0.05) box.splice(box.indexOf(s), 1);
  return r;
}

/** Runs one suite. Inside another suite it only adds to that one, so a suite is never counted twice. */
export function suite<T>(name: string, f: () => T): T {
  return run(name, f);
}

/** The same, for a function called with its own arguments, naming the suite from them. */
export function timedFn<A extends unknown[], R>(name: string, f: (...a: A) => R): (...a: A) => R {
  return (...a: A): R => {
    if (milestone === null) return f(...a);
    const text = a.map(describeArg).filter((x) => x !== null && x !== "");
    return run(text.length > 0 ? `${name}(${text.join(", ")})` : name, () => f(...a));
  };
}

/** A module's exported functions, each timed as a suite. Used as `const T = timedModule("strmap", await import(...))`. */
export function timedModule<M extends object>(prefix: string, mod: M): M {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mod)) {
    out[k] =
      typeof v === "function" && !/^[A-Z]/.test(k)
        ? timedFn(`${prefix}.${k}`, v as (...a: unknown[]) => unknown)
        : v;
  }
  return out as M;
}

// --- one milestone

export class MilestoneRecorder {
  name: string;
  started = performance.now();
  cpu = process.cpuUsage();
  lastBox = performance.now();
  boxes: BoxTiming[] = [];
  samples: MemorySample[] = [];
  peakRss = 0;
  peakAt = "";
  peak: MemorySample | null = null;
  running = "";
  private timer: NodeJS.Timeout;
  host: { load: number[]; cpus: number; node: string };

  constructor(name: string, load: number[], cpus: number) {
    this.name = name;
    this.host = { load, cpus, node: process.version };
    this.timer = setInterval(() => {
      this.sample();
    }, 1000);
    this.timer.unref();
  }

  sample(at?: string): MemorySample {
    const m = process.memoryUsage();
    const s = {
      at: at ?? this.running,
      seconds: (performance.now() - this.started) / 1000,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    };
    if (m.rss > this.peakRss) {
      this.peakRss = m.rss;
      this.peakAt = s.at;
      this.peak = s;
    }
    return s;
  }

  /** A box's report closes it: its time is what ran since the box before, and its suites are those that finished in it. */
  closeBox(box: string, nested?: MilestoneTiming): void {
    const now = performance.now();
    const done = looseSuites;
    looseSuites = [];
    this.boxes.push({
      box,
      seconds: (now - this.lastBox) / 1000,
      suites: done,
      ...(nested !== undefined ? { nested } : {}),
    });
    this.samples.push(this.sample(box.slice(0, 80)));
    this.lastBox = now;
  }

  finish(): MilestoneTiming {
    clearInterval(this.timer);
    const u = process.cpuUsage(this.cpu);
    return {
      milestone: this.name,
      seconds: (performance.now() - this.started) / 1000,
      cpuSeconds: (u.user + u.system) / 1e6,
      host: this.host,
      boxes: this.boxes,
      memory: {
        peakRss: this.peakRss,
        peakAt: this.peakAt,
        peak: this.peak,
        samples: this.samples,
      },
    };
  }
}

export function startMilestone(name: string, load: number[], cpus: number): MilestoneRecorder {
  milestone = new MilestoneRecorder(name, load, cpus);
  looseSuites = [];
  return milestone;
}

/** The timing a nested milestone left behind, as long as it's this run's. */
export function readNested(path: string, sinceMs: number): MilestoneTiming | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { timing?: MilestoneTiming; at?: number };
    if (j.at === undefined || j.at < sinceMs) return undefined;
    return j.timing;
  } catch {
    return undefined;
  }
}

// --- the summary

export interface FlatRow {
  where: string;
  name: string;
  seconds: number;
  counts: Record<string, number>;
  phases: Record<string, PhaseTotal>;
}

/** Every suite of a milestone and of those nested under it, with where it ran. */
export function flatten(t: MilestoneTiming, out: FlatRow[] = []): FlatRow[] {
  t.boxes.forEach((b, i) => {
    for (const s of b.suites) {
      out.push({
        where: `${t.milestone} box ${i + 1}`,
        name: s.name,
        seconds: s.seconds,
        counts: s.counts,
        phases: s.phases,
      });
    }
    if (b.nested !== undefined) flatten(b.nested, out);
  });
  return out;
}

/** Slowest first: a box's own time and every suite's, down through nested milestones. */
export function summaryText(t: MilestoneTiming, top = 20): string {
  const lines: string[] = [];
  const own = (b: BoxTiming): number => b.seconds - (b.nested?.seconds ?? 0);
  const boxes: { where: string; box: string; s: number }[] = [];
  const walk = (m: MilestoneTiming): void => {
    m.boxes.forEach((b) => {
      boxes.push({ where: m.milestone, box: b.box, s: own(b) });
      if (b.nested !== undefined) walk(b.nested);
    });
  };
  walk(t);
  boxes.sort((a, b) => b.s - a.s);
  lines.push(`TIME ${t.milestone} ${t.seconds.toFixed(1)} s, slowest boxes first:`);
  for (const b of boxes.slice(0, top))
    lines.push(`TIME ${b.s.toFixed(1).padStart(8)} s ${b.where}: ${b.box.slice(0, 90)}`);
  lines.push("TIME slowest suites first:");
  for (const r of flatten(t)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, top)) {
    const p = r.phases.qemu;
    lines.push(
      `TIME ${r.seconds.toFixed(1).padStart(8)} s ${r.where}: ${r.name.slice(0, 90)}${p !== undefined ? ` (${p.n} boots)` : ""}`,
    );
  }
  return lines.join("\n");
}
