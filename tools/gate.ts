// `tmk gate`, and every milestone as a view (SPEC 8.3, D51). The registry's units run once each, in one pool of jobs, longest
// first: each job a process of its own, with its own build directory, under the 3 GiB watchdog. A unit that can't depend
// on the optimiser's level runs once for every level, and its trace proves it each time. A unit that measures runs in a quiet
// phase first, with nothing else running. Then each milestone's boxes are read off the jobs' records, in their places.
// Every run writes a manifest: what it ran on, from where, and every result. Nothing is reused: there's no cache.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { buildPath } from "./build-dir.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { hvfAvailable, reapJobDir } from "./qemu-run.ts";
import {
  baselineNodes,
  decisionsByKey,
  EST,
  externalInputs,
  hashInputs,
  loadDef,
  measuresByKey,
  quotesToolByKey,
  metaOf,
  treeHash,
  type LevelKey,
} from "./registry.ts";
import {
  MILESTONE_NODE,
  otherVms,
  type Item,
  type JobRecord,
  type MilestoneDef,
} from "./tmk-common.ts";
import type { BoxTiming, MilestoneTiming, SuiteTiming } from "./timing.ts";

export interface Instance {
  milestone: string;
  level: LevelKey;
}

export interface JobSpec {
  key: string;
  /** What `--order` matches: a quick step's name, or the milestone and unit. */
  label: string;
  milestone: string;
  unit: string;
  places: number[];
  level: LevelKey;
  free: boolean;
  quiet: boolean;
  solo: boolean;
  /** The top milestone's own boxes ran in its main process, with no heap bound; all else as a nested milestone did. */
  heapBound: boolean;
  est: number;
  timeoutMs: number;
}

export interface JobOutcome {
  spec: JobSpec;
  ok: boolean;
  why: string;
  seconds: number;
  peakRss: number;
  record: JobRecord | null;
  trace: string[];
  /** The slices of heavy sweeps this job ran, when the gate runs a subset. */
  sweeps: string[];
  reaped: number;
  started: number;
  ended: number;
}

const instKey = (i: Instance): string => `${i.milestone}@${i.level}`;
const levelName = (l: LevelKey): string => (l === "unset" ? "no -O" : `-O${l}`);

/** Seconds each job took last time, for longest first. `tmk clean` removes it; then the registry's estimates serve. */
const DURATIONS = (): string => buildPath("gate/durations.json");

function durations(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DURATIONS(), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

// --- the plan: every instance a run needs, and every job, each once

export interface Plan {
  tops: Instance[];
  instances: Instance[];
  jobs: JobSpec[];
  defs: Map<string, MilestoneDef>;
}

export async function plan(tops: Instance[], opts: { quick: boolean }): Promise<Plan> {
  const defs = new Map<string, MilestoneDef>();
  const def = async (m: string): Promise<MilestoneDef> => {
    let d = defs.get(m);
    if (d === undefined) {
      d = await loadDef(m);
      defs.set(m, d);
    }
    return d;
  };
  const seen = new Map<string, Instance>();
  const jobs = new Map<string, JobSpec>();
  const known = durations();
  const topNames = new Set(tops.map((t) => t.milestone));
  const stepNames = (await import("./quick.ts")).steps(4).map((s) => s.name);
  const visit = async (inst: Instance): Promise<void> => {
    if (seen.has(instKey(inst))) return;
    seen.set(instKey(inst), inst);
    const d = await def(inst.milestone);
    for (const slot of d.slots) {
      if (slot.kind === "unit") {
        const meta = metaOf(inst.milestone, slot.id);
        const free = meta.free === true;
        const key = `${inst.milestone}/${slot.id}@${free ? "*" : inst.level}`;
        if (jobs.has(key)) continue;
        const base = `${inst.milestone}/${slot.id}`;
        const est =
          known[key] ??
          EST[key] ??
          known[`${base}@0`] ??
          known[`${base}@2`] ??
          EST[`${base}@0`] ??
          EST[`${base}@2`] ??
          60;
        jobs.set(key, {
          key,
          label:
            inst.milestone === "test"
              ? (stepNames[Number(slot.id) - 1] ?? key)
              : `${inst.milestone} ${slot.id}`,
          milestone: inst.milestone,
          unit: slot.id,
          places: slot.places,
          level: inst.level,
          free,
          quiet: meta.quiet === true,
          solo: meta.solo === true,
          heapBound: !topNames.has(inst.milestone) && inst.milestone !== "test",
          est,
          timeoutMs: meta.timeoutMs ?? Math.max(1_800_000, Math.ceil(est * 4) * 1000),
        });
      } else if (slot.kind === "nested" && !opts.quick) {
        await visit({ milestone: slot.milestone, level: slot.level ?? inst.level });
      } else if (slot.kind === "tier" && !opts.quick) {
        await visit({ milestone: "test", level: slot.level });
      }
    }
  };
  for (const t of tops) await visit(t);
  return { tops, instances: [...seen.values()], jobs: [...jobs.values()], defs };
}

// --- the pool

/**
 * Memory of everything this gate started, its jobs and their QEMUs, summed over the process tree; and (R12) the CPU they
 * use, in cores (ps's %cpu summed, a hundred a core), since the host's load average counts every thread that's ready,
 * V8's helper threads included, and so isn't how many cores the run keeps busy.
 */
function treeUse(root: number): { rss: number; cores: number } {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu="], {
    encoding: "utf8",
    timeout: 5000,
  });
  const parent = new Map<number, number>();
  const rss = new Map<number, number>();
  const cpu = new Map<number, number>();
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)/.exec(line);
    if (m === null) continue;
    parent.set(Number(m[1]), Number(m[2]));
    rss.set(Number(m[1]), Number(m[3]) * 1024);
    cpu.set(Number(m[1]), Number(m[4]));
  }
  let total = 0;
  let pct = 0;
  for (const [pid, kb] of rss) {
    let p: number | undefined = pid;
    for (let i = 0; i < 64 && p !== undefined && p > 1; i++) {
      if (p === root) {
        total += kb;
        pct += cpu.get(pid) ?? 0;
        break;
      }
      p = parent.get(p);
    }
  }
  return { rss: total, cores: Math.round(pct) / 100 };
}

export interface PoolOptions {
  parallel: number;
  failFast: boolean;
  order?: string;
  quick: boolean;
  innerJobs?: number;
  /** Where the jobs' directories go: build/jobs, or a sample's own. */
  jobsDir: string;
  /** A rotating subset of the heavy sweeps (tools/sweep.ts), by this key; none means every sweep whole. */
  sweepKey?: string;
  log: (line: string) => void;
}

export interface PoolStats {
  peakTreeRss: number;
  peakAt: string;
  samples: { t: number; rss: number; running: number; load: number; cores?: number }[];
  /** The most cores the run's processes used at once (R12), by ps's %cpu. */
  peakCores: number;
  quietSeconds: number;
  soloSeconds: number;
  seconds: number;
  /** The CPU budget's size and the most tokens held at once (R12). */
  cpuTokens?: number;
  cpuPeak?: number;
}

const safe = (key: string): string => key.replace(/[^\w.@*-]+/g, "_").replace(/\*/g, "any");

async function runJob(spec: JobSpec, o: PoolOptions, signal: AbortSignal): Promise<JobOutcome> {
  const dir = join(o.jobsDir, safe(spec.key));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const trace = join(dir, "level-trace.txt");
  const out = join(dir, "job.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMK_BUILD_DIR: dir,
    TMK_LEVEL_TRACE: trace,
    TMK_OPT_VERIFY: process.env.TMK_OPT_VERIFY ?? "1",
    TMK_SWEEP_LOG: join(dir, "sweep.txt"),
    // R12: its leaves' place in the CPU budget's queue, the longest job's first (tools/cpu-budget.ts)
    TMK_CPU_PRIO: String(Math.round(spec.est)),
  };
  if (o.sweepKey !== undefined) {
    env.TMK_SWEEP = "subset";
    env.TMK_SWEEP_KEY = o.sweepKey;
  } else {
    delete env.TMK_SWEEP;
    delete env.TMK_SWEEP_KEY;
  }
  // A unit that measures or times compiles makes everything itself: no build store (tools/store.ts).
  const meta = metaOf(spec.milestone, spec.unit);
  if (spec.quiet || spec.solo || meta.measures === true || meta.noStore === true)
    env.TMK_STORE = "off";
  if (spec.level === "unset") delete env.TMK_OPT;
  else env.TMK_OPT = spec.level;
  const argv = [
    ...(spec.heapBound ? MILESTONE_NODE : ["--no-warnings"]),
    join(ROOT, "tools/tmk.ts"),
    "job",
    spec.milestone,
    spec.unit,
    "--out",
    out,
    ...(o.quick ? ["--quick"] : []),
    ...(o.innerJobs !== undefined
      ? ["--jobs", String(o.innerJobs)]
      : metaOf(spec.milestone, spec.unit).jobs !== undefined
        ? ["--jobs", String(metaOf(spec.milestone, spec.unit).jobs)]
        : []),
  ];
  const started = Date.now();
  const r = await guardedRun(process.execPath, argv, {
    timeoutMs: spec.timeoutMs,
    label: spec.key,
    cwd: ROOT,
    env,
    signal,
  });
  const ended = Date.now();
  writeFileSync(join(dir, "job.log"), `${r.stdout}\n--- stderr\n${r.stderr}`);
  const reaped = reapJobDir(dir);
  let record: JobRecord | null = null;
  try {
    record = JSON.parse(readFileSync(out, "utf8")) as JobRecord;
  } catch {
    record = null;
  }
  const sweepFile = join(dir, "sweep.txt");
  const sweeps = existsSync(sweepFile)
    ? readFileSync(sweepFile, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
  const traceLines = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
  const whys: string[] = [];
  if (!r.ok) whys.push(r.why);
  if (record === null) whys.push("no record");
  else {
    for (const u of record.units) if (u.error !== null) whys.push(u.error.split("\n")[0]!);
    const bad = record.units.flatMap((u) => u.items).filter((i) => !i.ok);
    if (bad.length > 0) whys.push(`${bad.length} box${bad.length > 1 ? "es" : ""} failed`);
    if (record.liveQemu !== 0) whys.push(`${record.liveQemu} QEMU still tracked at its end`);
  }
  if (spec.free && traceLines.length > 0)
    whys.push(
      `declared level-free, but took the level from the environment: ${traceLines.slice(0, 3).join("; ")}`,
    );
  if (reaped > 0) whys.push(`${reaped} QEMU left behind, reaped`);
  return {
    spec,
    ok: whys.length === 0,
    why: whys.join("; "),
    seconds: (ended - started) / 1000,
    peakRss: r.peakRssBytes,
    record,
    trace: traceLines,
    sweeps,
    reaped,
    started,
    ended,
  };
}

export async function runPool(
  jobs: JobSpec[],
  o: PoolOptions,
): Promise<{ outcomes: Map<string, JobOutcome>; stats: PoolStats }> {
  const outcomes = new Map<string, JobOutcome>();
  const t0 = Date.now();
  const stats: PoolStats = {
    peakTreeRss: 0,
    peakCores: 0,
    peakAt: "",
    samples: [],
    quietSeconds: 0,
    soloSeconds: 0,
    seconds: 0,
  };
  const running = new Set<string>();
  // The run's CPU budget (R12): a token a core, for every leaf of every job (tools/cpu-budget.ts). Its socket is in the
  // environment every job, part and worker inherits.
  const { serveBudget } = await import("./cpu-budget.ts");
  const budget = await serveBudget();
  const hadSock = process.env.TMK_CPU_SOCK;
  process.env.TMK_CPU_SOCK = budget.path;
  o.log(`cpu budget: ${budget.size} tokens`);
  const sampler = setInterval(() => {
    const { rss, cores } = treeUse(process.pid);
    if (cores > stats.peakCores) stats.peakCores = cores;
    if (rss > stats.peakTreeRss) {
      stats.peakTreeRss = rss;
      stats.peakAt = [...running].join(", ");
    }
    stats.samples.push({
      t: Math.round((Date.now() - t0) / 1000),
      rss,
      running: running.size,
      load: loadavg()[0]!,
      cores,
    });
  }, 2000);
  sampler.unref();
  const re = o.order !== undefined ? new RegExp(o.order) : null;
  const stopAll = new AbortController();
  let stop = false;
  // Stopped from outside: every job's group is killed, and what their QEMUs were is reaped from their records, before this
  // process goes. Node's default for these signals runs no exit handlers, so nothing else would.
  const onSignal = (sig: NodeJS.Signals): void => {
    // Nothing more starts: without this the lanes went on starting jobs in the second and a half before exit, and those,
    // in groups of their own, could outlive it. guarded-run won't start one once the run is aborted, and kills each
    // child's group when this process exits.
    stop = true;
    stopAll.abort();
    setTimeout(() => {
      if (existsSync(o.jobsDir))
        for (const d of readdirSync(o.jobsDir)) reapJobDir(join(o.jobsDir, d));
      process.exit(sig === "SIGINT" ? 130 : 143);
    }, 1500);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, onSignal);
  const solo = jobs.filter((j) => j.solo);
  const quiet = jobs.filter((j) => j.quiet && !j.solo);
  const rest = jobs
    .filter((j) => !j.quiet && !j.solo)
    .sort((a, b) => {
      const pa = re !== null && re.test(a.label) ? 1 : 0;
      const pb = re !== null && re.test(b.label) ? 1 : 0;
      return pb - pa || b.est - a.est || a.key.localeCompare(b.key);
    });
  let done = 0;
  const total = jobs.length;
  const one = async (spec: JobSpec): Promise<void> => {
    running.add(spec.key);
    const r = await runJob(spec, o, stopAll.signal);
    running.delete(spec.key);
    outcomes.set(spec.key, r);
    done++;
    o.log(
      `${r.ok ? "ok  " : "FAIL"} ${r.seconds.toFixed(1).padStart(7)} s ${spec.key} ${spec.label.slice(0, 70)}${spec.quiet ? " (quiet)" : ""}${spec.solo ? " (solo)" : ""}${r.ok ? "" : `: ${r.why.slice(0, 300)}`} [${done}/${total}, ${running.size} running]`,
    );
    // --fail-fast: nothing more starts, and what's running is stopped; its QEMUs are reaped from its record.
    if (!r.ok && o.failFast && !stop) {
      stop = true;
      stopAll.abort();
    }
  };
  // First the units that need the host still, alone, one at a time.
  if (solo.length > 0) o.log(`solo phase: ${solo.map((q) => q.key).join(", ")}`);
  for (const s of solo) {
    if (stop) break;
    await one(s);
  }
  stats.soloSeconds = (Date.now() - t0) / 1000;
  // The quiet phase: the units that measure, with nothing else running. Each is about one core's work.
  if (quiet.length > 0 && !stop) {
    o.log(`quiet phase: ${quiet.map((q) => q.key).join(", ")}`);
    await Promise.all(quiet.map((q) => one(q)));
    stats.quietSeconds = (Date.now() - t0) / 1000 - stats.soloSeconds;
  }
  let next = 0;
  const lanes: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, o.parallel); w++) {
    lanes.push(
      (async () => {
        for (;;) {
          if (stop) return;
          const i = next++;
          if (i >= rest.length) return;
          await one(rest[i]!);
        }
      })(),
    );
  }
  await Promise.all(lanes);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(sig, onSignal);
  clearInterval(sampler);
  stats.cpuTokens = budget.size;
  stats.cpuPeak = budget.peak();
  await budget.close();
  if (hadSock === undefined) delete process.env.TMK_CPU_SOCK;
  else process.env.TMK_CPU_SOCK = hadSock;
  stats.seconds = (Date.now() - t0) / 1000;
  return { outcomes, stats };
}

// --- views: a milestone's boxes, in their places, from the jobs

export interface ViewBox {
  place: number;
  box: string;
  ok: boolean;
  detail: string;
  failures: string[];
  seconds: number;
  suites: SuiteTiming[];
  nested?: string;
}

export interface View {
  milestone: string;
  level: LevelKey;
  ok: boolean;
  boxes: ViewBox[];
  jobs: string[];
  seconds: number;
  peakRss: number;
}

export function evaluate(
  p: Plan,
  outcomes: Map<string, JobOutcome>,
  vms: { before: string[]; after: string[] },
): Map<string, View> {
  const views = new Map<string, View>();
  const jobFor = (m: string, unit: string, level: LevelKey): JobOutcome | undefined =>
    outcomes.get(`${m}/${unit}@${level}`) ?? outcomes.get(`${m}/${unit}@*`);
  const view = (inst: Instance): View => {
    const k = instKey(inst);
    const have = views.get(k);
    if (have !== undefined) return have;
    const def = p.defs.get(inst.milestone)!;
    const boxes: ViewBox[] = [];
    const jobs: string[] = [];
    for (const slot of def.slots) {
      if (slot.kind === "unit") {
        const j = jobFor(inst.milestone, slot.id, inst.level);
        if (j !== undefined) jobs.push(j.spec.key);
        const u = j?.record?.units.find((x) => x.id === slot.id);
        const timingBoxes = j?.record?.timing?.boxes ?? [];
        slot.places.forEach((place, i) => {
          const item: Item | undefined = u?.items[i];
          const tb: BoxTiming | undefined =
            item !== undefined ? timingBoxes.find((b) => b.box === item.box) : undefined;
          if (item !== undefined) {
            const extra =
              j !== undefined && j.spec.free && j.trace.length > 0
                ? ["declared level-free, and a level came from the environment"]
                : [];
            boxes.push({
              place,
              box: item.box,
              ok: item.ok && extra.length === 0,
              detail: item.detail,
              failures: [...item.failures, ...extra],
              seconds: tb?.seconds ?? 0,
              suites: tb?.suites ?? [],
            });
          } else {
            const why =
              j === undefined
                ? "not run"
                : (u?.error ??
                  (j.record === null ? `the job didn't finish: ${j.why}` : "no box reported"));
            boxes.push({
              place,
              box: `(box ${place} of ${inst.milestone}, unit ${slot.id})`,
              ok: false,
              detail: why.split("\n")[0]!.slice(0, 600),
              failures: [why.slice(0, 3000)],
              seconds: 0,
              suites: [],
            });
          }
        });
      } else if (slot.kind === "nested" || slot.kind === "tier") {
        const child: Instance =
          slot.kind === "nested"
            ? { milestone: slot.milestone, level: slot.level ?? inst.level }
            : { milestone: "test", level: slot.level };
        if (!views.has(instKey(child)) && !p.instances.some((x) => instKey(x) === instKey(child))) {
          boxes.push({
            place: Number(slot.id),
            box: slot.box,
            ok: false,
            detail: "not run (--quick)",
            failures: [],
            seconds: 0,
            suites: [],
          });
          continue;
        }
        const v = view(child);
        const passed = v.boxes.filter((b) => b.ok).length;
        const what = child.milestone === "test" ? "tmk test" : `milestone ${child.milestone}`;
        const unitWord = child.milestone === "test" ? "steps" : "boxes";
        boxes.push({
          place: Number(slot.id),
          box: slot.box,
          ok: v.ok,
          detail: `${v.ok ? "PASS" : "FAIL"} ${what} ${levelName(child.level)} (${passed}/${v.boxes.length} ${unitWord}); from ${v.jobs.length} jobs, ${v.seconds.toFixed(0)} s of work, their peak RSS ${(v.peakRss / 1024 ** 3).toFixed(2)} GiB`,
          failures: v.boxes
            .filter((b) => !b.ok)
            .map((b) => `FAIL ${b.box.slice(0, 200)}: ${b.detail.slice(0, 400)}`)
            .slice(0, 30),
          seconds: 0,
          suites: [],
          nested: instKey(child),
        });
      } else {
        // No QEMU of this milestone's jobs is left: each job's own count at its end, and what the gate reaped after it.
        const mine = def
          .units()
          .map((u) => jobFor(inst.milestone, u.id, inst.level))
          .filter((x): x is JobOutcome => x !== undefined);
        const tracked = mine.reduce((n, j) => n + (j.record?.liveQemu ?? 0), 0);
        const reaped = mine.reduce((n, j) => n + j.reaped, 0);
        const gone = vms.before.filter((v) => !vms.after.includes(v));
        const came = vms.after.filter((v) => !vms.before.includes(v));
        boxes.push({
          place: Number(slot.id),
          box: slot.box,
          ok: tracked === 0 && reaped === 0 && mine.every((j) => j.record !== null),
          detail: slot.observed
            ? `${tracked} tracked, over ${mine.length} jobs, ${reaped} reaped after them. Before: ${vms.before.join(", ") || "none"}. After: ${vms.after.join(", ") || "none"}. Gone: ${gone.join(", ") || "none"}. New: ${came.join(", ") || "none"}`
            : `${tracked} tracked, over ${mine.length} jobs, ${reaped} reaped after them`,
          failures: [],
          seconds: 0,
          suites: [],
        });
      }
    }
    boxes.sort((a, b) => a.place - b.place);
    const own = [...new Set(jobs)].map((k) => outcomes.get(k)!).filter((x) => x !== undefined);
    const nestedJobs = boxes
      .filter((b) => b.nested !== undefined)
      .flatMap((b) => views.get(b.nested!)?.jobs ?? []);
    const allJobs = [...new Set([...jobs, ...nestedJobs])];
    const all = allJobs.map((k) => outcomes.get(k)).filter((x): x is JobOutcome => x !== undefined);
    const v: View = {
      milestone: inst.milestone,
      level: inst.level,
      ok:
        boxes.every((b) => b.ok) &&
        (inst.milestone !== "test" || hvfAvailable().ok) &&
        own.length === new Set(jobs).size,
      boxes,
      jobs: allJobs,
      seconds: all.reduce((s, j) => s + j.seconds, 0),
      peakRss: all.reduce((m, j) => Math.max(m, j.peakRss), 0),
    };
    views.set(k, v);
    return v;
  };
  for (const t of p.tops) view(t);
  for (const i of p.instances) view(i);
  return views;
}

/** A milestone's timing, as its JSON has always had it: a box per place, with a nested milestone's own under its box. */
export function viewTiming(v: View, views: Map<string, View>, load: number[]): MilestoneTiming {
  return {
    milestone: v.milestone,
    seconds: v.seconds,
    cpuSeconds: 0,
    host: { load, cpus: cpus().length, node: process.version },
    boxes: v.boxes.map((b) => ({
      box: b.box,
      seconds: b.nested !== undefined ? (views.get(b.nested)?.seconds ?? 0) : b.seconds,
      suites: b.suites,
      ...(b.nested !== undefined && views.get(b.nested) !== undefined
        ? { nested: viewTiming(views.get(b.nested)!, views, load) }
        : {}),
    })),
    memory: { peakRss: v.peakRss, peakAt: "", peak: null, samples: [] },
  };
}

// --- a whole run

export interface GateRun {
  ok: boolean;
  manifestPath: string;
  views: Map<string, View>;
  outcomes: Map<string, JobOutcome>;
  plan: Plan;
}

export interface GateOptions {
  command: string;
  tops: Instance[];
  parallel: number;
  failFast: boolean;
  quick: boolean;
  order?: string;
  innerJobs?: number;
  /** Only these jobs, by key: `--changed` and `--sample`. The views are still evaluated, over what ran. */
  only?: Set<string>;
  selection?: unknown;
  /** `tmk gate` without --full: the rotating subset of the heavy sweeps, by this key (the UTC day unless given). */
  sweepKey?: string;
  print: "milestone" | "test" | "gate" | "none";
}

export async function runGate(o: GateOptions): Promise<GateRun> {
  const t0 = Date.now();
  const fromClean = !existsSync(join(ROOT, "build"));
  mkdirSync(buildPath("gate"), { recursive: true });
  const loadStart = loadavg();
  const vmsBefore = otherVms();
  const inputsBefore = hashInputs();
  const p = await plan(o.tops, { quick: o.quick });
  // The run's build store (tools/store.ts): its own directory, which every job and child inherits, removed at the end. A
  // run from clean makes everything it uses itself; TMK_STORE=off runs without one.
  const runId = new Date(t0).toISOString().replace(/[:.]/g, "-");
  const storeWanted = process.env.TMK_STORE !== "off";
  const storeAt = buildPath("store", runId);
  const storeWas = { dir: process.env.TMK_STORE, run: process.env.TMK_STORE_RUN };
  if (storeWanted) {
    rmSync(storeAt, { recursive: true, force: true });
    mkdirSync(storeAt, { recursive: true });
    process.env.TMK_STORE = storeAt;
    process.env.TMK_STORE_RUN = runId;
  }
  const jobs = o.only !== undefined ? p.jobs.filter((j) => o.only!.has(j.key)) : p.jobs;
  const say = (l: string): void => {
    if (o.print !== "none") console.log(l);
  };
  say(
    `${o.command}: ${jobs.length} jobs (${jobs.filter((j) => j.quiet).length} quiet, ${jobs.filter((j) => j.free).length} level-free) for ${p.instances.length} views, ${o.parallel} at a time${fromClean ? ", from clean" : ""}${o.sweepKey !== undefined ? `, heavy sweeps a rotating subset (key ${o.sweepKey}; --full for all)` : ", every sweep whole"}`,
  );
  const { outcomes, stats } = await runPool(jobs, {
    parallel: o.parallel,
    failFast: o.failFast,
    quick: o.quick,
    jobsDir: buildPath("jobs"),
    log: say,
    ...(o.order !== undefined ? { order: o.order } : {}),
    ...(o.innerJobs !== undefined ? { innerJobs: o.innerJobs } : {}),
    ...(o.sweepKey !== undefined ? { sweepKey: o.sweepKey } : {}),
  });
  const vmsAfter = otherVms();
  const loadEnd = loadavg();
  const { storeStats } = await import("./store.ts");
  const store = storeWanted ? storeStats(storeAt) : null;
  if (storeWanted) {
    rmSync(storeAt, { recursive: true, force: true });
    if (storeWas.dir === undefined) delete process.env.TMK_STORE;
    else process.env.TMK_STORE = storeWas.dir;
    if (storeWas.run === undefined) delete process.env.TMK_STORE_RUN;
    else process.env.TMK_STORE_RUN = storeWas.run;
  }
  const views = evaluate(p, outcomes, { before: vmsBefore, after: vmsAfter });
  const inputsAfter = hashInputs();
  const ranAll = o.only === undefined && jobs.every((j) => outcomes.has(j.key));
  const topViews = o.tops.map((t) => views.get(instKey(t))!);
  const ok =
    [...outcomes.values()].every((j) => j.ok) &&
    (store === null || store.mismatches.length === 0) &&
    (o.only !== undefined || topViews.every((v) => v.ok)) &&
    treeHash(inputsBefore) === treeHash(inputsAfter);
  // Durations for next time's longest first.
  const known = durations();
  for (const j of outcomes.values()) known[j.spec.key] = Math.round(j.seconds * 10) / 10;
  writeFileSync(DURATIONS(), JSON.stringify(known, null, 1));
  // Side files a box writes (a bench's text, the optimiser's faults), as the milestones left them: -O2's last.
  mkdirSync(buildPath("milestones"), { recursive: true });
  const order = (l: LevelKey): number => ["unset", "0", "1", "2"].indexOf(l);
  for (const j of [...outcomes.values()].sort(
    (a, b) => order(a.spec.level) - order(b.spec.level),
  )) {
    const side = join(buildPath("jobs"), safe(j.spec.key), "milestones");
    if (!existsSync(side)) continue;
    for (const f of readdirSync(side)) copyFileSync(join(side, f), buildPath("milestones", f));
  }
  // Each milestone's JSON, per level and, as before, under its own name for its last level.
  const at = Date.now();
  for (const v of [...views.values()].sort((a, b) => order(a.level) - order(b.level))) {
    if (v.milestone === "test") continue;
    const extras: Record<string, unknown> = {};
    for (const k of v.jobs) {
      const j = outcomes.get(k);
      if (j?.spec.milestone === v.milestone) Object.assign(extras, j.record?.extras ?? {});
    }
    const body = JSON.stringify(
      {
        ok: v.ok,
        seconds: v.seconds,
        at,
        level: v.level,
        timing: viewTiming(v, views, loadStart),
        items: v.boxes.map((b) => ({
          box: b.box,
          ok: b.ok,
          detail: b.detail,
          failures: b.failures,
        })),
        ...extras,
        vmsBefore,
        vmsAfter,
      },
      null,
      2,
    );
    writeFileSync(
      buildPath(
        "milestones",
        `${v.milestone}-${v.level === "unset" ? "default" : `O${v.level}`}.json`,
      ),
      body,
    );
    writeFileSync(buildPath("milestones", `${v.milestone}.json`), body);
  }
  const seconds = (Date.now() - t0) / 1000;
  const manifest = {
    format: "tmk-gate-manifest/1",
    command: o.command,
    tops: o.tops,
    ok,
    complete: ranAll,
    fromClean,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    seconds,
    parallel: o.parallel,
    host: {
      cpus: cpus().length,
      memBytes: totalmem(),
      loadStart,
      loadEnd,
      peakTreeRss: stats.peakTreeRss,
      peakAt: stats.peakAt,
      quietSeconds: stats.quietSeconds,
      soloSeconds: stats.soloSeconds,
      cpuTokens: stats.cpuTokens,
      cpuPeak: stats.cpuPeak,
      peakCores: stats.peakCores,
      peakLoad: Math.max(0, ...stats.samples.map((x) => x.load)),
      samples: stats.samples,
      vmsBefore,
      vmsAfter,
    },
    inputs: {
      tree: treeHash(inputsBefore),
      treeAtEnd: treeHash(inputsAfter),
      files: inputsBefore,
      external: externalInputs(),
    },
    matrix: {
      views: p.instances.map((i) => `${i.milestone} ${levelName(i.level)}`),
      levels: Object.fromEntries(
        [...new Set(p.instances.map((i) => i.milestone))].map((m) => [
          m,
          p.instances.filter((i) => i.milestone === m).map((i) => i.level),
        ]),
      ),
      hvf: hvfAvailable(),
      accelerators: hvfAvailable().ok ? ["hvf", "tcg"] : ["tcg"],
    },
    selection: o.selection ?? null,
    // What the build store did (tools/store.ts): reuses, what it made, the reuses made again and compared, and any mismatch.
    store:
      store === null
        ? { mode: "off" }
        : {
            mode: "run",
            verify: store.verify,
            byKind: store.byKind,
            mismatches: store.mismatches,
          },
    sweep:
      o.sweepKey !== undefined
        ? {
            mode: "subset",
            key: o.sweepKey,
            note: "full sweeps run nightly, a rotating subset at phase gates (owner, 2026-11-07)",
          }
        : { mode: "full" },
    jobs: [...outcomes.values()].map((j) => ({
      key: j.spec.key,
      milestone: j.spec.milestone,
      unit: j.spec.unit,
      places: j.spec.places,
      level: j.spec.level,
      free: j.spec.free,
      quiet: j.spec.quiet,
      solo: j.spec.solo,
      ok: j.ok,
      why: j.why,
      seconds: j.seconds,
      started: j.started - t0,
      peakRss: j.peakRss,
      trace: j.trace,
      sweeps: j.sweeps,
      reaped: j.reaped,
      liveQemu: j.record?.liveQemu ?? null,
      boxes: (j.record?.units ?? []).flatMap((u) =>
        u.items.map((it, i) => ({
          place: j.spec.places[i],
          box: it.box,
          ok: it.ok,
          detail: it.detail,
          failures: it.failures.length,
        })),
      ),
      errors: (j.record?.units ?? []).filter((u) => u.error !== null).map((u) => u.error),
      suites: (j.record?.timing?.boxes ?? []).flatMap((b, i) =>
        b.suites.map((s) => ({
          place: j.spec.places[i],
          box: b.box.slice(0, 60),
          name: s.name,
          counts: s.counts,
          seconds: s.seconds,
        })),
      ),
    })),
    views: [...views.values()].map((v) => ({
      milestone: v.milestone,
      level: v.level,
      ok: v.ok,
      passed: v.boxes.filter((b) => b.ok).length,
      total: v.boxes.length,
      boxes: v.boxes.map((b) => ({ place: b.place, box: b.box, ok: b.ok, detail: b.detail })),
    })),
  };
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, "-");
  const manifestPath = buildPath("gate", `manifest-${stamp}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  writeFileSync(buildPath("gate/manifest.json"), JSON.stringify(manifest, null, 1));
  if (o.print !== "none") printRun(o, p, views, outcomes, stats, seconds, manifestPath, ok);
  return { ok, manifestPath, views, outcomes, plan: p };
}

function printRun(
  o: GateOptions,
  p: Plan,
  views: Map<string, View>,
  outcomes: Map<string, JobOutcome>,
  stats: PoolStats,
  seconds: number,
  manifestPath: string,
  ok: boolean,
): void {
  const show = (v: View, full: boolean): void => {
    if (v.milestone === "test") {
      for (const b of v.boxes) {
        console.log(
          `${b.ok ? "PASS" : "FAIL"} ${b.seconds.toFixed(1).padStart(6)} s ${b.box}: ${b.detail}`,
        );
        if (!b.ok) for (const f of b.failures.slice(0, 6)) console.log(`     ${f.slice(0, 400)}`);
      }
      return;
    }
    for (const b of v.boxes) {
      if (!full && b.ok) continue;
      console.log(`${b.ok ? "PASS" : "FAIL"} ${b.box}\n     ${b.detail}`);
      for (const f of b.failures.slice(0, 20)) console.log(`     ${f.slice(0, 600)}`);
    }
  };
  const line = (v: View): string =>
    v.milestone === "test"
      ? `${v.ok ? "PASS" : "FAIL"} tmk test ${levelName(v.level)} (${v.boxes.filter((b) => b.ok).length}/${v.boxes.length} steps)`
      : `${v.ok ? "PASS" : "FAIL"} milestone ${v.milestone} ${levelName(v.level)} (${v.boxes.filter((b) => b.ok).length}/${v.boxes.length} boxes)`;
  const tops = new Set(o.tops.map(instKey));
  if (o.only === undefined) {
    // Under the top: each view's line, and any box of it that failed, deepest first.
    for (const i of [...p.instances].reverse()) {
      if (tops.has(instKey(i))) continue;
      const v = views.get(instKey(i))!;
      console.log(line(v));
      show(v, false);
    }
    for (const t of o.tops) show(views.get(instKey(t))!, true);
  }
  const slow = [...outcomes.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 15);
  console.log(
    `TIME ${seconds.toFixed(1)} s in all, the solo phase ${stats.soloSeconds.toFixed(1)} s, the quiet phase ${stats.quietSeconds.toFixed(1)} s; slowest jobs first:`,
  );
  for (const j of slow) console.log(`TIME ${j.seconds.toFixed(1).padStart(8)} s ${j.spec.key}`);
  console.log(
    `peak memory of everything the run started: ${(stats.peakTreeRss / 1024 ** 3).toFixed(2)} GiB; load ${loadavg()
      .map((x) => x.toFixed(1))
      .join(
        " ",
      )} on ${cpus().length} CPUs, at most ${Math.max(0, ...stats.samples.map((x) => x.load)).toFixed(1)}; the CPU budget ${stats.cpuTokens} tokens, at most ${stats.cpuPeak} held at once, at most ${stats.peakCores.toFixed(1)} cores busy`,
  );
  console.log(`manifest: ${manifestPath}`);
  const failedJobs = [...outcomes.values()].filter((j) => !j.ok);
  for (const j of failedJobs.slice(0, 30))
    console.log(
      `FAILED JOB ${j.spec.key}: ${j.why.slice(0, 400)} (${join(buildPath("jobs"), safe(j.spec.key))})`,
    );
  if (o.only === undefined)
    for (const t of o.tops) console.log(`${line(views.get(instKey(t))!)}, ${seconds.toFixed(1)} s`);
  else
    console.log(
      `${ok ? "PASS" : "FAIL"} ${o.command}: ${outcomes.size} jobs, ${failedJobs.length} failed, ${seconds.toFixed(1)} s`,
    );
}

// --- the gate's tops, `--changed`, `--sample`, and the manifest's checks

/** The milestones no other milestone runs: the gate is their views, with everything under them. */
export async function gateTops(): Promise<Instance[]> {
  const { MILESTONES } = await import("./registry.ts");
  const nested = new Set<string>();
  for (const m of MILESTONES) {
    const d = await loadDef(m);
    for (const s of d.slots) if (s.kind === "nested") nested.add(s.milestone);
  }
  const level = (process.env.TMK_OPT as LevelKey | undefined) ?? "unset";
  return MILESTONES.filter((m) => !nested.has(m)).map((m) => ({ milestone: m, level }));
}

export interface Baseline {
  at: string;
  tree: string;
  files: Record<string, string>;
  /** Each tools/ module's nodes' hashes (tools/deps.ts), so `--changed` can tell which declarations changed. */
  nodes?: Record<string, Record<string, string>>;
}

export const BASELINE = (): string => buildPath("gate/baseline.json");

export function writeBaseline(why: string): string {
  const files = hashInputs();
  mkdirSync(buildPath("gate"), { recursive: true });
  const b: Baseline & { why: string } = {
    at: new Date().toISOString(),
    tree: treeHash(files),
    files,
    nodes: baselineNodes(files),
    why,
  };
  writeFileSync(BASELINE(), JSON.stringify(b));
  return BASELINE();
}

export interface Selection {
  baseline: string | null;
  changed: string[];
  picked: { key: string; why: string }[];
  uncovered: string[];
}

/** The quick tier's steps that are always run by `--changed`: every kind of program, compiled and run once each. */
export const SMOKE = [
  "tsc, oxlint, oxfmt --check",
  "corpus",
  "corpus --neg",
  "native pos, HVF",
  "native trap, HVF",
  "native lower, HVF",
];

/**
 * What a change since the baseline can reach (SPEC 9.3, D51): each quick step a change reaches, the smoke set always, and, for a
 * change no step reaches at all, every gate unit that does reach it, at every level the gate runs it. Reaching is node by node
 * in the test code (tools/deps.ts: a declaration, a unit's own block, a module's own top-level code), and file by file
 * elsewhere. When in doubt it includes: no baseline, or a change to the harness, selects everything.
 */
export async function selectChanged(
  level: LevelKey,
  since?: string,
): Promise<{ tops: Instance[]; only: Set<string>; selection: Selection }> {
  const file = since ?? BASELINE();
  const base = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Baseline) : null;
  return selectFor(level, base, hashInputs(), base === null ? null : file);
}

/** The selection for a baseline and a tree's hashes: `--changed`'s, and what `tmk select` prints for a change by hand. */
export async function selectFor(
  level: LevelKey,
  base: Baseline | null,
  now: Record<string, string>,
  baseFile: string | null,
): Promise<{ tops: Instance[]; only: Set<string>; selection: Selection }> {
  const { fineReaches, fineUnitDeps, changesSince } = await import("./registry.ts");
  const ch =
    base === null
      ? { paths: ["(no baseline: everything)"], nodes: new Map<string, Set<string>>() }
      : changesSince(base, now);
  const changed = ch.paths;
  const quick = await plan([{ milestone: "test", level }], { quick: false });
  const tdef = quick.defs.get("test")!;
  const picked: { key: string; why: string }[] = [];
  const stepNames = (await import("./quick.ts")).steps(4).map((s) => s.name.replace(/^-O2: /, ""));
  // A change is covered when a quick step reaches it, other than through `data: ["*"]` (the static checks read everything).
  const covered = (p: string): boolean =>
    tdef.units().some((u) => {
      const d = fineUnitDeps(tdef, u);
      const one = {
        paths: [p],
        nodes: ch.nodes.has(p) ? new Map([[p, ch.nodes.get(p)!]]) : new Map(),
      };
      return fineReaches({ ...d, data: d.data.filter((x) => x !== "*") }, one).length > 0;
    });
  for (const j of quick.jobs) {
    const unit = tdef.units().find((u) => u.id === j.unit)!;
    const name = stepNames[Number(j.unit) - 1]!;
    if (base === null) picked.push({ key: j.key, why: "no baseline" });
    else {
      const hits = fineReaches(fineUnitDeps(tdef, unit), ch);
      if (hits.length > 0) picked.push({ key: j.key, why: hits.slice(0, 4).join(", ") });
      else if (SMOKE.includes(name)) picked.push({ key: j.key, why: "smoke" });
    }
  }
  const uncovered = base === null ? [] : changed.filter((p) => !covered(p));
  const tops: Instance[] = [{ milestone: "test", level }];
  if (uncovered.length > 0) {
    const gt = await gateTops();
    const g = await plan(gt, { quick: false });
    const un = {
      paths: uncovered,
      nodes: new Map([...ch.nodes].filter(([p]) => uncovered.includes(p))),
    };
    for (const j of g.jobs) {
      const def = g.defs.get(j.milestone)!;
      const unit = def.units().find((u) => u.id === j.unit)!;
      const hits = fineReaches(fineUnitDeps(def, unit), un);
      if (hits.length > 0)
        picked.push({ key: j.key, why: `no quick step reads ${hits.slice(0, 3).join(", ")}` });
    }
    if (picked.some((x) => !x.key.startsWith("test/"))) tops.push(...gt);
  }
  return {
    tops,
    only: new Set(picked.map((x) => x.key)),
    selection: { baseline: baseFile, changed, picked, uncovered },
  };
}

interface ManifestJob {
  key: string;
  ok: boolean;
  why: string;
  boxes: { place: number; box: string; ok: boolean; detail: string }[];
  suites: { box: string; name: string; counts: Record<string, number> }[];
}

export interface Manifest {
  format: string;
  command: string;
  tops: Instance[];
  ok: boolean;
  complete: boolean;
  fromClean: boolean;
  parallel: number;
  inputs: {
    tree: string;
    treeAtEnd: string;
    files: Record<string, string>;
    external: Record<string, string>;
  };
  matrix: { views: string[] };
  sweep?: { mode: string; key?: string };
  store?: { mode: string; mismatches: string[] };
  jobs: (ManifestJob & { milestone: string; unit: string; level: LevelKey; free: boolean })[];
  views: { milestone: string; level: LevelKey; ok: boolean; passed: number; total: number }[];
}

/** Checks a manifest against this tree, and against itself. Returns what doesn't match: nothing, for a good one. */
export async function verifyManifest(
  file: string,
): Promise<{ problems: string[]; notes: string[] }> {
  const { changedPaths } = await import("./registry.ts");
  const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const problems: string[] = [];
  const notes: string[] = [];
  if (m.format !== "tmk-gate-manifest/1") problems.push(`not a gate manifest: ${m.format}`);
  const now = hashInputs();
  const diff = changedPaths(m.inputs.files, now);
  if (diff.length > 0)
    problems.push(
      `the tree differs from the one it ran on in ${diff.length} files: ${diff.slice(0, 20).join(", ")}${diff.length > 20 ? ", ..." : ""}`,
    );
  if (treeHash(m.inputs.files) !== m.inputs.tree)
    problems.push("its tree hash isn't the hash of its files");
  if (m.inputs.tree !== m.inputs.treeAtEnd) problems.push("the tree changed while it ran");
  // The build store: everything it reused was made in this run, and none of the reuses made again differed.
  if (m.store !== undefined && m.store.mode === "run" && m.store.mismatches.length > 0)
    problems.push(
      `the build store had ${m.store.mismatches.length} mismatch(es): a reused build differed when made again`,
    );
  const ext = externalInputs();
  for (const [k, v] of Object.entries(m.inputs.external))
    if (ext[k] !== v) problems.push(`${k}: it ran with ${v}, here it's ${ext[k] ?? "absent"}`);
  if (!m.fromClean) problems.push("it didn't start from tmk clean");
  if (!m.complete)
    problems.push("it ran only some jobs (--changed or --sample), so it verifies nothing");
  if (!m.ok) problems.push("it failed");
  // Complete: every job its views need is there, by the registry as it is now, and passed.
  const p = await plan(m.tops, { quick: false });
  const have = new Map(m.jobs.map((j) => [j.key, j]));
  const missing = p.jobs.filter((j) => !have.has(j.key)).map((j) => j.key);
  const extra = m.jobs.filter((j) => !p.jobs.some((x) => x.key === j.key)).map((j) => j.key);
  if (missing.length > 0)
    problems.push(
      `jobs the registry needs and it doesn't have: ${missing.slice(0, 20).join(", ")}`,
    );
  if (extra.length > 0)
    problems.push(`jobs it has and the registry doesn't: ${extra.slice(0, 20).join(", ")}`);
  const failed = m.jobs.filter((j) => !j.ok);
  if (failed.length > 0)
    problems.push(
      `failed jobs: ${failed
        .map((j) => j.key)
        .slice(0, 20)
        .join(", ")}`,
    );
  // Each view's verdict is what its boxes say.
  for (const v of m.views)
    if (v.ok !== (v.passed === v.total))
      problems.push(`${v.milestone} ${v.level}: verdict and boxes disagree`);
  for (const j of m.jobs) {
    const boxesOk = j.boxes.every((b) => b.ok);
    if (j.ok && !boxesOk) problems.push(`${j.key}: passed with a failing box`);
  }
  notes.push(
    `${m.command}: ${m.jobs.length} jobs, ${m.views.length} views (${m.matrix.views.join("; ")}), ${m.parallel} at a time, tree ${m.inputs.tree.slice(0, 16)}`,
  );
  return { problems, notes };
}

/** A job's own directory, wherever the run put it: build/jobs/<job>/ or build/sample/<when>/<job>/. */
const jobDirs = (s: string): string =>
  s.replace(/build\/(?:jobs|sample\/[^/ ]+)\/[^/ ]+\//g, "build/<job>/");

/** What a result says, without what differs run to run: times, sizes, loads and rates, and where its job ran. */
/**
 * A measuring box's detail with every number taken out, thousands separators and decimals included; with the padding that
 * lines figures up as one space, as a figure's width moves its column; and with a `tirhash` taken out, as a benchmark's
 * hash is of a program it writes in its job's own directory, whose path the hash takes in (`native-f` box 12's size rows:
 * the same program at two paths hashes differently, MEASURED, pipe-split); and with a benchmark's line warning that the load
 * was high taken out, since whether the host was busy is a measurement as much as the load is (native-a box 14, opt-b).
 */
export function measuredDetail(s: string): string {
  // A benchmark's warning that the host was busy is a measurement too: the load (native-a box 14, opt-b).
  const quiet = s.replace(
    /\n?[ \t]*WARNING: load [\d.]+ on \d+ CPUs: these numbers are rough/g,
    "",
  );
  return normalizeDetail(quiet.replace(/(\d),(?=\d{3}\b)/g, "$1"))
    .replace(/tirhash [0-9a-f]+/g, "tirhash #")
    .replace(/\d+/g, "#")
    .replace(/#(?:[.e+-]*#)*/g, "#")
    .replace(/ {2,}/g, " ");
}

/**
 * Whether a box's detail is a benchmark's, by the header every `tmk bench` text starts with (`host: 10 CPUs, load …`): such
 * a box is measuring whatever its job's registry entry says, so its figures aren't compared, only its words (R1b; native-g
 * box 8 was the last flagged one at a time).
 */
export function isBenchmarkDetail(s: string): boolean {
  return /(?:^|\n|\| )[ \t]*host: \d+ CPUs\b/.test(s);
}

/**
 * What a speed box's detail asserts, each match of its registry's `decisions` in order (`AUTO_RC on`): compared in place of
 * its words, which carry a measurement whose lines come and go with the load (pipe-d box 26's "measured again in full").
 */
export function decisionDetail(s: string, decisions: RegExp): string {
  const re = new RegExp(
    decisions.source,
    decisions.flags.includes("g") ? decisions.flags : `${decisions.flags}g`,
  );
  return (s.match(re) ?? []).join(" | ");
}

/**
 * The counts a box's detail gives, each `n/m` (passed of run), in order: what's compared of a box that quotes a tool's
 * output (`quotesTool`), whose words carry its job's path and a cut that moves with it (native-c box 1, the clsid step).
 */
export function detailCounts(s: string): string {
  return (s.match(/\b\d+\/\d+\b/g) ?? []).join(" ");
}

export function normalizeDetail(s: string): string {
  return jobDirs(s)
    .replace(/load [\d. ,>-]+(?: on \d+ CPUs)?/g, "load #")
    .replace(
      /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*(?:ms|s|ns|µs|us|GiB|MiB|MB|KB|KiB|GB|bytes|%|x|Hz|ticks|ms\/op|ns\/op)\b/g,
      "#",
    )
    .replace(/\d+\.\d+/g, "#")
    .replace(/peak RSS [^;,)]*/g, "peak RSS #");
}

/**
 * Whether two box details say the same thing but for the order of what they list: the same items, split at `; ` and
 * `, `, as many times each (a set of programs, faults or rows a box gathers in whatever order its jobs finished, as
 * `native-f` box 11's did). Words that differ still differ. Both are normalised already.
 */
export function sameListedItems(a: string, b: string): boolean {
  const items = (s: string): string[] =>
    s
      .split("; ")
      .flatMap((x) => x.split(", "))
      .map((x) => x.trim())
      .sort();
  const x = items(a);
  const y = items(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * What two runs' suites say differently, as counts, for the suites both recorded. Which suites a record has depends on time:
 * one that took under 50 ms isn't kept (tools/timing.ts), so a suite in one list and not the other isn't a difference, and a
 * name both have is compared by the counts each run gave it, as many times as it ran. A box's verdict and detail are compared
 * apart, and they're what say a suite failed.
 */
/** A benchmark's own suite, as tools/timing.ts names it: `bench.benchAlloc({...})`. */
export function isBenchSuite(name: string): boolean {
  return name.startsWith("bench.");
}

/** What a benchmark's suite records that's a count, not a measurement. */
export const BENCH_COUNT = /(?:^|\.)(?:length|ops|warm|iter|processes|rounds|cases|programs)$/;

/**
 * An injected bug's run that says both how many cases `caught` it and how many by a wrong answer (`answers`, std-tests.ts's
 * faultRun): `caught` also counts cases that ran out of time, which depends on the host's load (at -O0 under load one image
 * timed out and 14 more cases counted, 17 against 3, native-g box 6), so the load-independent `answers` is compared, and of
 * `caught` only whether it's above zero, which is what the box asserts. A suite with one and not the other is as it was.
 */
export function loadFreeCounts(c: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...c };
  for (const k of Object.keys(c)) {
    if (!/(^|\.)caught$/.test(k)) continue;
    const answers = k.replace(/caught$/, "answers");
    if (answers in c) out[k] = c[k]! > 0 ? 1 : 0;
  }
  return out;
}

export function suiteCountDiffs(
  was: { name: string; counts: Record<string, number> }[],
  now: { name: string; counts: Record<string, number> }[],
): string[] {
  // A benchmark's figures are measurements, not counts, and a job's directory is where it ran. Inside a benchmark's own
  // suite (`bench.*`) every figure is a time or a ratio of times whatever it's called (`nsPerOp`, `checkCost`,
  // `jpeg.harbour.jpg.v8`), so only what's a count by its name is compared there: lengths, operations, iterations, errors.
  const counted = (name: string, c: Record<string, number>): string =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(loadFreeCounts(c))
          .filter(([k]) =>
            isBenchSuite(name)
              ? BENCH_COUNT.test(k)
              : !/median|mean|geomean|worst|ratio|load|rss|p99|max/i.test(k),
          )
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    );
  const byName = (list: typeof was): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const s of list) {
      const k = jobDirs(s.name);
      m.set(k, [...(m.get(k) ?? []), counted(k, s.counts)]);
    }
    return m;
  };
  const a = byName(was);
  const b = byName(now);
  const out: string[] = [];
  for (const [name, xs] of a) {
    const ys = b.get(name);
    if (ys === undefined) continue;
    // Each count the shorter list has must be one the longer has: a run kept fewer of them only by time.
    const [short, long] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
    const left = [...long];
    for (const x of short) {
      const i = left.indexOf(x);
      if (i >= 0) left.splice(i, 1);
      else {
        out.push(`${name}: was ${xs.join(", ")}; now ${ys.join(", ")}`);
        break;
      }
    }
  }
  return out;
}

export interface SampleRow {
  key: string;
  same: boolean;
  differences: string[];
  seconds: number;
}

/**
 * `tmk gate --sample N`: N of a manifest's jobs, picked at random, run again from scratch (each in a new directory), and
 * their verdicts, boxes and suite counts compared with what the manifest says. The tree has to be the manifest's.
 */
export async function sample(
  file: string,
  n: number,
  seed: number,
  parallel: number,
): Promise<{ rows: SampleRow[]; problems: string[] }> {
  const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const v = await verifyManifest(file);
  const blocking = v.problems.filter(
    (x) => x.startsWith("the tree differs") || x.includes("it ran with"),
  );
  if (blocking.length > 0) return { rows: [], problems: blocking };
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool_ = [...m.jobs];
  const picked: typeof m.jobs = [];
  while (picked.length < n && pool_.length > 0)
    picked.push(pool_.splice(Math.floor(rnd() * pool_.length), 1)[0]!);
  const p = await plan(m.tops, { quick: false });
  const specs = p.jobs.filter((j) => picked.some((x) => x.key === j.key));
  const dir = buildPath("sample", new Date().toISOString().replace(/[:.]/g, "-"));
  const { outcomes } = await runPool(specs, {
    parallel,
    failFast: false,
    quick: false,
    jobsDir: dir,
    log: (l) => console.log(l),
    ...(m.sweep?.mode === "subset" && m.sweep.key !== undefined ? { sweepKey: m.sweep.key } : {}),
  });
  const rows: SampleRow[] = [];
  for (const old of picked) {
    const now = outcomes.get(old.key);
    const differences: string[] = [];
    if (now === undefined) differences.push("didn't run");
    else {
      if (now.ok !== old.ok)
        differences.push(
          `verdict: was ${old.ok ? "pass" : "fail"}, now ${now.ok ? "pass" : "fail"} (${now.why})`,
        );
      const items = (now.record?.units ?? []).flatMap((u) => u.items);
      const measuring = measuresByKey(old.key);
      const quoting = quotesToolByKey(old.key);
      const decisions = decisionsByKey(old.key);
      old.boxes.forEach((b, i) => {
        const it = items[i];
        if (it === undefined) differences.push(`box ${b.place}: missing`);
        else {
          if (it.ok !== b.ok)
            differences.push(
              `box ${b.place}: was ${b.ok ? "PASS" : "FAIL"}, now ${it.ok ? "PASS" : "FAIL"}`,
            );
          // A measuring box's figures are what it measured this time: only its words are compared (SPEC 8.3, D51). A box
          // quoting a tool's output, whose path and cut vary, has its counts compared (`quotesTool`).
          const norm =
            measuring || isBenchmarkDetail(b.detail) || isBenchmarkDetail(it.detail)
              ? measuredDetail
              : normalizeDetail;
          if (decisions !== null) {
            if (decisionDetail(it.detail, decisions) !== decisionDetail(b.detail, decisions))
              differences.push(
                `box ${b.place} decisions: were "${decisionDetail(b.detail, decisions)}", now "${decisionDetail(it.detail, decisions)}"`,
              );
          } else if (quoting) {
            if (detailCounts(it.detail) !== detailCounts(b.detail))
              differences.push(
                `box ${b.place} counts: were "${detailCounts(b.detail)}", now "${detailCounts(it.detail)}"`,
              );
          } else if (
            norm(it.detail) !== norm(b.detail) &&
            !sameListedItems(norm(it.detail), norm(b.detail))
          )
            differences.push(
              `box ${b.place} detail: was "${norm(b.detail).slice(0, 200)}", now "${norm(it.detail).slice(0, 200)}"`,
            );
        }
      });
      const diffs = suiteCountDiffs(
        old.suites,
        (now.record?.timing?.boxes ?? []).flatMap((b) => b.suites),
      );
      if (diffs.length > 0)
        differences.push(`suite counts: ${diffs.slice(0, 3).join(" | ").slice(0, 600)}`);
    }
    rows.push({
      key: old.key,
      same: differences.length === 0,
      differences,
      seconds: now?.seconds ?? 0,
    });
  }
  return { rows, problems: [] };
}
