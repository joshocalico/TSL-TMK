// Runs a child with a wall-clock timeout and an RSS watchdog (SPEC 8.2). Each child gets its own
// process group, so a kill takes its descendants too. Also usable as a CLI:
//   node tools/guarded-run.ts --timeout 60 [--label name] -- cmd args...
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { phase } from "./timing.ts";

export const RSS_LIMIT_BYTES = 3 * 1024 ** 3;
const SAMPLE_MS = 500;

export interface GuardOptions {
  timeoutMs: number;
  label: string;
  cwd?: string;
  rssLimitBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Kills the child's group when it fires: `tmk gate --fail-fast` stopping the jobs still running. */
  signal?: AbortSignal;
}

export interface GuardResult {
  label: string;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  oom: boolean;
  peakRssBytes: number;
  ok: boolean;
  why: string;
}

/**
 * Sums RSS over each watched process group, so a helper can't hide from the limit behind its parent. One `ps` every SAMPLE_MS
 * for every child this process is guarding, not one per child (fix 6 of the test-speed round): the same period and the same
 * limit for each, from one listing of the host's processes.
 */
const watched = new Map<number, Set<(rss: number) => void>>();
let poller: NodeJS.Timeout | null = null;
let polling = false;

function watchGroup(pgid: number, f: (rss: number) => void): () => void {
  let set = watched.get(pgid);
  if (set === undefined) {
    set = new Set();
    watched.set(pgid, set);
  }
  set.add(f);
  if (poller === null) {
    poller = setInterval(poll, SAMPLE_MS);
    poller.unref();
  }
  return () => {
    const s = watched.get(pgid);
    s?.delete(f);
    if (s !== undefined && s.size === 0) watched.delete(pgid);
    if (watched.size === 0 && poller !== null) {
      clearInterval(poller);
      poller = null;
    }
  };
}

function poll(): void {
  if (polling || watched.size === 0) return;
  polling = true;
  const ps = spawn("ps", ["-A", "-o", "pgid=,rss="], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  ps.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  let finished = false;
  const done = (): void => {
    if (finished) return;
    finished = true;
    polling = false;
    const kb = new Map<number, number>();
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(line);
      if (m === null) continue;
      const g = Number(m[1]);
      if (watched.has(g)) kb.set(g, (kb.get(g) ?? 0) + Number(m[2]));
    }
    // A Set visits each callback once even if one removes itself while it runs.
    for (const [g, fs] of watched) for (const f of fs) f((kb.get(g) ?? 0) * 1024);
  };
  ps.on("error", done);
  ps.on("close", done);
}

/** What a child is, for the timing: its engine and the script it runs, without its job's arguments. */
/**
 * The children that are leaves for the CPU budget (R12): one process on one core that starts nothing that takes a token.
 * Each is a tool of this tree's that only computes: the corpus's and the lowering's compile batches, a reference engine's
 * or a printed package's run, the pins tools.
 */
const LEAVES = new Set([
  "corpus-compile.ts",
  "lower-compile.ts",
  "corpus-exec.ts",
  "lower-exec.ts",
  "printed-exec.ts",
  "pre-std-hashes.ts",
  "pre-strings-hashes.ts",
  "strict-hashes.ts",
  "mode-hashes.ts",
  "rc-off-hashes.ts",
  "opt-hashes.ts",
]);

export function isLeaf(args: string[]): boolean {
  const script = args.find((a) => a.endsWith(".ts") && !a.startsWith("{"));
  return script !== undefined && LEAVES.has(basename(script));
}

function childKind(cmd: string, args: string[]): string {
  const script = args.find((a) => /\.m?ts$/.test(a) || a.endsWith("/tsc"));
  return `${basename(cmd)} ${script !== undefined ? basename(script) : "-"}`;
}

export async function guardedRun(
  cmd: string,
  args: string[],
  opts: GuardOptions,
): Promise<GuardResult> {
  // A pure child's output, through the run's build store (tools/store.ts): run once in a run, a sixteenth run again and
  // compared. Only a complete, successful run is stored.
  const { childKey, storedAsync } = await import("./store.ts");
  const key = opts.signal?.aborted === true ? null : childKey(cmd, args, opts.env ?? process.env);
  // A leaf (a compile batch, a pins tool, a reference engine's run) holds one of the run's CPU tokens while it runs (R12,
  // tools/cpu-budget.ts), taken before its time limit starts; anything else (a job, a part) takes none itself.
  const run = async (): Promise<GuardResult> => {
    if (!isLeaf(args)) return guardedRun0(cmd, args, opts);
    const { withCpu } = await import("./cpu-budget.ts");
    return withCpu(() => guardedRun0(cmd, args, opts));
  };
  if (key === null) return run();
  const t = performance.now();
  const r = await storedAsync(
    "child",
    key,
    async () => {
      const g = await run();
      return { value: g, keep: g.ok };
    },
    `${childKind(cmd, args)} ${opts.label}`,
    (g) => ({ code: g.code, signal: g.signal, ok: g.ok, stdout: g.stdout }),
  );
  if (r.reused) phase(`stored ${childKind(cmd, args)}`, performance.now() - t);
  return r.value;
}

function guardedRun0(cmd: string, args: string[], opts: GuardOptions): Promise<GuardResult> {
  const limit = opts.rssLimitBytes ?? RSS_LIMIT_BYTES;
  const start = Date.now();
  // Asked to stop before it started: start nothing, as an abort would have killed it at once.
  if (opts.signal?.aborted === true)
    return Promise.resolve({
      label: opts.label,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      ms: 0,
      timedOut: false,
      oom: false,
      peakRssBytes: 0,
      ok: false,
      why: "aborted before it started",
    });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let oom = false;
    let peak = 0;
    let closed = false;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const unwatch =
      child.pid === undefined
        ? () => {}
        : watchGroup(child.pid, (rss) => {
            if (closed) return;
            peak = Math.max(peak, rss);
            if (rss > limit) {
              oom = true;
              killGroup();
            }
          });
    // A guard that outlives its parent would defeat the point.
    const onExit = (): void => {
      killGroup();
    };
    process.once("exit", onExit);
    const finish = (code: number | null, signal: string | null, spawnError?: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      unwatch();
      process.removeListener("exit", onExit);
      opts.signal?.removeEventListener("abort", onAbort);
      const ms = Date.now() - start;
      phase(`child ${childKind(cmd, args)}`, ms, stdout.length);
      let why = "";
      if (spawnError !== undefined) why = `could not start: ${spawnError}`;
      else if (timedOut) why = `killed: over the ${opts.timeoutMs} ms wall-clock limit`;
      else if (oom) why = `killed: RSS above ${limit} bytes`;
      else if (aborted) why = "killed: the run was stopped";
      else if (code !== 0) why = `exit ${code ?? signal ?? "?"}`;
      resolve({
        label: opts.label,
        code,
        signal,
        stdout,
        stderr,
        ms,
        timedOut,
        oom,
        peakRssBytes: peak,
        ok: code === 0 && !timedOut && !oom && !aborted,
        why,
      });
    };
    child.on("error", (e) => {
      finish(null, null, e.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

/** Runs tasks with at most `jobs` going at once, keeping results in order. */
export async function pool<T, R>(
  items: T[],
  jobs: number,
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, jobs); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await f(items[i]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const flags = sep >= 0 ? argv.slice(0, sep) : [];
  const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
  const flag = (name: string): string | undefined => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  if (cmd.length === 0) {
    console.error("usage: guarded-run [--timeout s] [--label name] -- cmd args...");
    process.exit(2);
  }
  const r = await guardedRun(cmd[0]!, cmd.slice(1), {
    timeoutMs: Number(flag("--timeout") ?? "60") * 1000,
    label: flag("--label") ?? cmd.join(" "),
  });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (!r.ok) console.error(`guarded-run: ${r.label}: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
