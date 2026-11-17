// `tmk profile` (SPEC 9.3): where a native program's time and instructions go, by function and by instruction, through
// either route, from the same image `tmk bench memory` times. No gate: numbers for finding a cost, not for judging one.
//
// Two ways to look, each in a QEMU this tool starts and stops itself, and no other:
// - `--time` (HVF): the program's counter sampled through the QEMU monitor (`info registers`) while the work loops. A
//   sample is a point in time, so a function's share of samples is its share of time, with a sampling error of about
//   sqrt(n) samples.
// - `--instructions` (TCG): exact. QEMU logs every translated block it runs (`-d exec,nochain`) and what's in each block
//   (`-d in_asm`), into a pipe this tool reads as it comes, so nothing is written to disk; a block's runs times its
//   instructions, at each of its addresses, is every instruction run there. A function's entries are the runs of the
//   block at its first instruction.
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode } from "../compiler/backend-aarch64/decode.ts";
import type { ImageOutput } from "../compiler/backend-aarch64/image.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { buildImageOutFor, type Work } from "./bench-alloc.ts";
import { pagesSetup } from "./bench-memory.ts";
import { checkFile, compileTyped, lowerFile } from "./lowering.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";

const RSS_LIMIT = 3 * 1024 ** 3; // this process's own watchdog (SPEC 8.2)
const MAX_SAMPLES = 100_000;
const MAX_TRACE_LINES = 2_000_000_000; // `--instructions` stops reading (and so QEMU) past this many log lines
// Where QEMU's loader can put the image in RAM: the one that puts the most samples in functions is it.
const BASES = [0x40000000, 0x40010000, 0x40080000, 0x40200000];

export interface ProfileOptions {
  // a TSL proper file (`--route tsl`), or ordinary TS lowered by the direct route (`--route direct`) or printed as TSL
  // classes that tslc compiles (`--route printed`, R2)
  file: string;
  fn: string; // an exported function taking one number
  route: "tsl" | "direct" | "printed";
  memory: string; // the direct route's memory mode
  cycles: boolean; // the direct route's collector
  n: number; // the argument
  args?: number[]; // R18: every argument, for a function of more than one (`--args 20,3`); `n` alone otherwise
  calls: number; // calls made while looking (`--time` makes more as it needs, up to its limit)
  warm: number; // `--instructions`: calls first, not counted (a second run, subtracted)
  mode: "time" | "instructions";
  samples: number; // `--time`: samples to take
  top: number; // hot addresses or blocks to show
  focus: RegExp | null; // only these functions' addresses and blocks
  annotate: RegExp | null; // these functions' every instruction, with what ran there
  perOps: number; // what a call's figures are divided by: the allocations a call makes, say
}

export interface ProfileFunc {
  name: string;
  share: number; // of all samples or instructions
  count: number; // samples, or instructions run
  entries: number | null; // `--instructions`: times entered
}

export interface ProfileResult {
  skipped: string | null;
  mode: "time" | "instructions";
  route: string;
  file: string;
  fn: string;
  total: number; // samples, or instructions run in the image's functions
  perCall: number | null; // `--instructions`: of the profiled function and what it calls, per call
  calls: number;
  funcs: ProfileFunc[];
  hot: { at: string; share: number; count: number; text: string[] }[];
  annotated: { name: string; lines: { count: number; text: string }[] }[];
  errors: string[];
}

function buildFor(o: ProfileOptions, calls: number): { img: ImageOutput; m: Module } {
  const w: Work = {
    name: o.fn,
    fn: o.fn,
    args: o.args ?? [o.n],
    which: 0,
    cArgs: [o.n, 0],
    ops: o.n,
    what: o.fn,
  };
  if (o.route === "tsl") {
    const { typed, diags } = checkFile(resolve(o.file));
    if (typed === null) throw new Error(`${o.file}: ${JSON.stringify(diags).slice(0, 400)}`);
    const c = compileTyped(typed);
    return {
      img: buildImageOutFor(c.tir, w, 0, calls, null, c.meta.strings, pagesSetup(false)),
      m: c.tir,
    };
  }
  const lo = lowerFile(resolve(o.file), {
    memory: o.memory,
    cycles: o.cycles,
    ...(o.route === "printed"
      ? { route: "tsl" as const, classes: true }
      : { route: "direct" as const }),
  });
  if (lo.tir === null || lo.fallbackDiags.length > 0)
    throw new Error(`${o.file} didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 400)}`);
  return {
    img: buildImageOutFor(lo.tir, w, 0, calls, null, lo.meta!.strings, pagesSetup(true)),
    m: lo.tir,
  };
}

/** The function an image offset is in, and the instruction's index in it. */
function locator(
  img: ImageOutput,
): (off: number) => { name: string; from: number; to: number } | null {
  const ranges = [...img.ranges].sort((a, b) => a.from - b.from);
  return (off) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid]!;
      if (off < r.from) hi = mid - 1;
      else if (off >= r.to) lo = mid + 1;
      else return r;
    }
    return null;
  };
}

function wordAt(img: ImageOutput, off: number): number {
  return new DataView(img.bytes.buffer, img.bytes.byteOffset).getUint32(off, true);
}

function disasm(img: ImageOutput, off: number, name: string, from: number): string {
  const w = wordAt(img, off);
  return `${name}+${(off - from) / 4}: ${decode(w, off) ?? `.word 0x${w.toString(16)}`}`;
}

function bestBase(pcs: number[], at: ReturnType<typeof locator>): number {
  let best = BASES[0]!;
  let bestHits = -1;
  for (const b of BASES) {
    const hits = pcs.filter((pc) => at(pc - b) !== null).length;
    if (hits > bestHits) {
      best = b;
      bestHits = hits;
    }
  }
  return best;
}

function rssGuard(): void {
  if (process.memoryUsage().rss > RSS_LIMIT) throw new Error("tmk profile: RSS above 3 GiB");
}

async function sampleTime(
  o: ProfileOptions,
  img: ImageOutput,
): Promise<{ pcs: number[]; why: string | null }> {
  let monitor: string | null = null;
  let pid: number | null = null;
  let ended = false;
  let stopped = false;
  const run = qemuRun({
    name: `profile/${o.route}-${o.fn}`,
    image: img.bytes,
    accel: "hvf",
    timeoutMs: 600_000,
    monitor: true,
    onSpawn: (i) => {
      monitor = i.monitorPath;
      pid = i.pid;
    },
  });
  const done = run.then((r) => {
    ended = true;
    return r;
  });
  const pcs: number[] = [];
  // the monitor's socket appears once QEMU is up: a bounded wait for it
  let sock: ReturnType<typeof createConnection> | null = null;
  for (let t = 0; t < 400 && sock === null && !ended; t++) {
    await new Promise((r) => setTimeout(r, 25));
    if (monitor === null) continue;
    sock = await new Promise<ReturnType<typeof createConnection> | null>((res) => {
      const c = createConnection(monitor!);
      c.once("connect", () => res(c));
      c.once("error", () => res(null));
    });
  }
  if (sock !== null) {
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("error", () => (ended = true));
    for (let k = 0; k < o.samples && k < MAX_SAMPLES && !ended; k++) {
      buf = "";
      sock.write("info registers\n");
      for (let t = 0; t < 200 && !/PC=([0-9a-f]+)/.test(buf) && !ended; t++)
        await new Promise((r) => setTimeout(r, 1));
      const m = /PC=([0-9a-f]+)/.exec(buf);
      if (m !== null) pcs.push(parseInt(m[1]!, 16));
      if (k % 1000 === 0) rssGuard();
    }
    sock.end();
  }
  if (!ended && pid !== null) {
    // enough samples: the rest of the calls aren't needed, so this QEMU (its own process group, started above) goes
    stopped = true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  const r = await done;
  // the guest finishing early is fine (it ran out of calls), and so is being stopped; anything else is a failure
  return { pcs, why: r.ok || stopped ? null : `${r.status}: ${r.why.slice(0, 300)}` };
}

async function traceInstructions(
  o: ProfileOptions,
  img: ImageOutput,
): Promise<{ execs: Map<number, number>; sizes: Map<number, number>; why: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), "tmk-profile-"));
  const fifo = join(dir, "trace");
  const mk = spawnSync("/usr/bin/mkfifo", [fifo]);
  if (mk.status !== 0) throw new Error(`mkfifo: ${mk.stderr}`);
  const execs = new Map<number, number>();
  const sizes = new Map<number, number>();
  let lines = 0;
  let stop: (() => void) | null = null;
  const stream = createReadStream(fifo, { highWaterMark: 1 << 20 });
  const reading = new Promise<void>((res) => {
    let tb = -1;
    let n = 0;
    let carry = "";
    const line = (l: string): void => {
      if (l.startsWith("Trace ")) {
        // Trace 0: 0x... [cs_base/pc/flags/cflags] name
        const j = l.indexOf("/", l.indexOf("["));
        const pc = parseInt(l.slice(j + 1, l.indexOf("/", j + 1)), 16);
        execs.set(pc, (execs.get(pc) ?? 0) + 1);
        return;
      }
      if (l.startsWith("IN:")) {
        tb = -1;
        n = 0;
        return;
      }
      if (l.startsWith("0x")) {
        const pc = parseInt(l.slice(2, l.indexOf(":")), 16);
        if (Number.isNaN(pc)) return;
        if (tb < 0) tb = pc;
        n++;
        sizes.set(tb, n);
      }
    };
    stream.on("data", (d) => {
      const parts = (carry + (d as Buffer).toString("latin1")).split("\n");
      carry = parts.pop()!;
      for (const l of parts) line(l);
      lines += parts.length;
      if (lines > MAX_TRACE_LINES) {
        stop?.();
        stream.destroy();
        res();
      }
      rssGuard();
    });
    stream.on("error", () => res());
    stream.on("close", () => {
      if (carry !== "") line(carry);
      res();
    });
  });
  const r = await qemuRun({
    name: `profile/${o.route}-${o.fn}-instructions`,
    image: img.bytes,
    accel: "tcg",
    timeoutMs: 1_800_000,
    extraArgs: ["-d", "exec,nochain,in_asm", "-D", fifo],
    onSpawn: (i) => {
      stop = () => {
        if (i.pid !== null) {
          try {
            process.kill(-i.pid, "SIGKILL"); // its own process group, started by qemuRun above
          } catch {}
        }
      };
    },
  });
  // QEMU is gone, so the pipe's other end is closed, unless QEMU never opened it: opening it to write, and closing it,
  // lets a reader stuck opening it see the end. Then a bounded wait.
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {}
  const late = await Promise.race([
    reading.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 30_000).unref()),
  ]);
  if (late) stream.destroy();
  rmSync(dir, { recursive: true, force: true });
  return {
    execs,
    sizes,
    why: late
      ? "the trace's pipe didn't close"
      : lines > MAX_TRACE_LINES
        ? "the trace went over its line limit"
        : r.ok
          ? null
          : `${r.status}: ${r.why.slice(0, 300)}`,
  };
}

export async function profile(o: ProfileOptions): Promise<ProfileResult> {
  const res: ProfileResult = {
    skipped: null,
    mode: o.mode,
    route: o.route,
    file: o.file,
    fn: o.fn,
    total: 0,
    perCall: null,
    calls: o.calls,
    funcs: [],
    hot: [],
    annotated: [],
    errors: [],
  };
  if (o.mode === "time" && !hvfAvailable().ok) {
    res.skipped = "HVF is unavailable, and time profiles are HVF only (SPEC 8.2)";
    return res;
  }
  const { img } = buildFor(o, o.calls + (o.mode === "instructions" ? o.warm : 0));
  const at = locator(img);
  const counts = new Map<number, number>(); // image offset to samples or instructions
  const entries = new Map<string, number>();
  if (o.mode === "time") {
    const { pcs, why } = await sampleTime(o, img);
    if (why !== null) res.errors.push(why);
    const base = bestBase(pcs, at);
    for (const pc of pcs) counts.set(pc - base, (counts.get(pc - base) ?? 0) + 1);
  } else {
    // With warm-up calls, two runs: `warm` calls, and `warm + calls`; the difference is the calls after the warm-up, so a
    // first call's growing of the heap isn't in a steady state's figures. The two images' code must be laid out alike.
    const runs: { img: ImageOutput; sign: number }[] = [{ img, sign: 1 }];
    if (o.warm > 0) {
      const w = buildFor(o, o.warm).img;
      const same =
        w.ranges.length === img.ranges.length &&
        w.ranges.every(
          (r, i) =>
            r.name === img.ranges[i]!.name &&
            r.from === img.ranges[i]!.from &&
            r.to === img.ranges[i]!.to,
        );
      if (!same)
        throw new Error(
          "tmk profile: the warm-up image's code is laid out differently, so the runs can't be subtracted",
        );
      runs.push({ img: w, sign: -1 });
    }
    for (const { img: im, sign } of runs) {
      const { execs, sizes, why } = await traceInstructions(o, im);
      if (why !== null) res.errors.push(why);
      const base = bestBase([...execs.keys()], at);
      for (const [pc, k] of execs) {
        const size = sizes.get(pc) ?? 1;
        for (let i = 0; i < size; i++) {
          const off = pc - base + i * 4;
          counts.set(off, (counts.get(off) ?? 0) + sign * k);
        }
        const f = at(pc - base);
        if (f !== null && f.from === pc - base)
          entries.set(f.name, (entries.get(f.name) ?? 0) + sign * k);
      }
    }
  }
  const byFunc = new Map<string, number>();
  let total = 0;
  for (const [off, k] of counts) {
    const f = at(off);
    const name = f?.name ?? "(outside the image's functions)";
    byFunc.set(name, (byFunc.get(name) ?? 0) + k);
    total += k;
  }
  res.total = total;
  if (o.mode === "instructions") {
    // the timed loop's own share is a few instructions a call; the setup's is before it
    const loop = [...byFunc].filter(([n]) => n.startsWith("__run_") || n === "__tmk_main");
    res.perCall = (total - loop.reduce((a, [, k]) => a + k, 0)) / o.calls;
  }
  res.funcs = [...byFunc]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      share: count / total,
      entries: entries.get(name) ?? null,
    }));
  const hot = [...counts]
    .filter(([off]) => {
      const f = at(off);
      return f !== null && (o.focus === null || o.focus.test(f.name));
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, o.top);
  res.hot = hot.map(([off, count]) => {
    const f = at(off)!;
    const text: string[] = [];
    for (let i = -2; i <= 2; i++) {
      const p = off + i * 4;
      if (p >= f.from && p < f.to)
        text.push(`${i === 0 ? ">" : " "} ${disasm(img, p, f.name, f.from)}`);
    }
    return { at: `${f.name}+${(off - f.from) / 4}`, share: count / total, count, text };
  });
  if (o.annotate !== null) {
    for (const r of [...img.ranges].sort((a, b) => a.from - b.from)) {
      if (!o.annotate.test(r.name)) continue;
      const lines: { count: number; text: string }[] = [];
      for (let p = r.from; p < r.to; p += 4)
        lines.push({ count: counts.get(p) ?? 0, text: disasm(img, p, r.name, r.from) });
      res.annotated.push({ name: r.name, lines });
    }
  }
  return res;
}

export function profileText(r: ProfileResult, perOps: number): string {
  if (r.skipped !== null) return `tmk profile: SKIPPED: ${r.skipped}\n`;
  const lines: string[] = [];
  const unit = r.mode === "time" ? "samples" : "instructions";
  lines.push(`${r.route} ${r.file} ${r.fn}: ${r.total} ${unit}, ${r.calls} calls`);
  if (r.perCall !== null)
    lines.push(
      `  per call: ${r.perCall.toFixed(0)} instructions${perOps > 1 ? `, ${(r.perCall / perOps).toFixed(2)} per op` : ""}`,
    );
  for (const f of r.funcs.slice(0, 40)) {
    const per =
      r.mode === "instructions"
        ? `  ${(f.count / r.calls / perOps).toFixed(2).padStart(9)}/op${f.entries !== null ? `  entries ${(f.entries / r.calls / perOps).toFixed(3)}/op, ${(f.count / f.entries).toFixed(1)} each` : ""}`
        : "";
    lines.push(`  ${(100 * f.share).toFixed(1).padStart(5)}%  ${f.name}${per}`);
  }
  if (r.hot.length > 0) lines.push(`hot ${r.mode === "time" ? "addresses" : "instructions"}:`);
  for (const h of r.hot) {
    lines.push(`  ${(100 * h.share).toFixed(2).padStart(6)}%  ${h.at}`);
    for (const t of h.text) lines.push(`           ${t}`);
  }
  for (const a of r.annotated) {
    lines.push(
      `${a.name}, ${r.mode === "time" ? "samples" : "runs per call"} at each instruction:`,
    );
    for (const l of a.lines) {
      const k = r.mode === "time" ? String(l.count) : (l.count / r.calls / perOps).toFixed(3);
      lines.push(`  ${k.padStart(10)}  ${l.text}`);
    }
  }
  for (const e of r.errors) lines.push(`ERROR: ${e}`);
  return lines.join("\n") + "\n";
}
