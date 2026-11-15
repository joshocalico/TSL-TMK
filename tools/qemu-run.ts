// Runs a guest under QEMU over serial (SPEC 8.2). Serial sentinels are the source of truth, not the
// exit code. Only processes this harness started are ever signalled: each QEMU leads its own process
// group, its pid is tracked here, and every kill names that group and nothing else.
import { takeCpu } from "./cpu-budget.ts";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { phase } from "./timing.ts";
import { buildPath } from "./build-dir.ts";

export const QEMU = "/opt/homebrew/bin/qemu-system-aarch64";
const DEFAULT_TIMEOUT_MS = 20_000;
// The record of what this harness started: one file per harness process, named by its pid, so a harness only ever
// reaps what one that has died left behind, and harnesses can run at once (SPEC 8.2).
const PID_DIR = buildPath("logs/qemu-pids");
const PID_FILE = join(PID_DIR, `${process.pid}.pids`);
const TERM_GRACE_MS = 2_000;
const DONE_GRACE_MS = 2_000;

export type Accel = "hvf" | "tcg";

export interface QemuOptions {
  name: string; // the test's name: its log is build/logs/<name>.log
  image: string | Uint8Array; // a path, or bytes to put in the run's own scratch directory
  accel: Accel;
  timeoutMs?: number;
  memory?: string; // default 256M
  monitor?: boolean; // a Unix-socket monitor in the scratch directory
  drives?: string[]; // writable images: each run gets its own copy, so jobs can't collide
  logDir?: string;
  bulk?: BulkLayout; // the RAM channel (SPEC 8.2): guest RAM is a file in the run's scratch directory
  extraArgs?: string[]; // more QEMU options, after the usual ones (`tmk profile`'s `-d exec`)
  onSpawn?: (info: { pid: number | null; monitorPath: string | null }) => void; // told once QEMU has started
}

/** Where a test image reports in RAM, from ImageOutput. */
export interface BulkLayout {
  ramBytes: number;
  offset: number;
  bytes: number;
}

export type QemuStatus =
  | "done"
  | "fatal"
  | "panic"
  | "timeout"
  | "no-done"
  | "skip"
  | "bad-channel";

export interface QemuResult {
  name: string;
  accel: Accel;
  status: QemuStatus;
  ok: boolean; // TMK:DONE seen, with no TMK:FATAL or TMK:PANIC, and any RAM channel read back whole
  skipped: boolean; // HVF unavailable: this is never a pass
  why: string;
  serial: string;
  lines: string[];
  exitCode: number | null;
  signal: string | null;
  killedByHarness: boolean;
  ms: number; // start of QEMU to its exit
  firstOutputMs: number | null;
  markMs: Record<string, number>; // a line's prefix, from opts.marks, to when it was first seen
  scratch: string | null; // kept on failure
  log: string;
  pid: number | null;
}

// --- tracking

const live = new Set<number>();
const liveMarker = new Map<number, string>();
let hooked = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone. `live` only ever holds our own children's pids, so there's nothing else to hit.
  }
}

/** Kills every QEMU this process started. Never looks at any other process on the host. */
export function killAll(): void {
  for (const pid of live) killGroup(pid, "SIGKILL");
  live.clear();
  liveMarker.clear();
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(130);
    });
  }
}

/** Is this pid still a process? Used by the harness's own tests on pids it started. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Is a harness still running? A pid that exists but isn't ours to signal counts as running: when in doubt, leave it. */
function ownerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills what one record names, if it's still a QEMU on that run's scratch path or image. */
function reapRecord(file: string, keep: Set<number>): number {
  let reaped = 0;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  for (const line of text.split("\n")) {
    const [pidText, marker] = line.split("\t");
    const pid = Number(pidText);
    if (!(pid > 0) || marker === undefined || marker === "" || keep.has(pid)) continue;
    const ps = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (ps.stdout.includes("qemu-system-aarch64") && ps.stdout.includes(marker)) {
      killGroup(pid, "SIGKILL");
      reaped++;
    }
  }
  return reaped;
}

/**
 * Before a suite: a QEMU left by a harness that was killed outright. Only the records of harnesses that are no longer
 * running are considered (each harness has its own, by its pid), and in them only a pid whose command line still names that
 * run's scratch path or image. A live harness's QEMUs are never touched, so harnesses can share a build directory.
 */
export function reapOrphans(dir = PID_DIR): number {
  if (!existsSync(dir)) return 0;
  let reaped = 0;
  for (const name of readdirSync(dir)) {
    const owner = Number(/^(\d+)\.pids$/.exec(name)?.[1]);
    if (!(owner > 0)) continue;
    const file = join(dir, name);
    if (owner === process.pid && dir === PID_DIR) {
      // Ours: what we started and is finished is gone already; keep the record to what's running.
      reaped += reapRecord(file, live);
      writeFileSync(file, [...live].map((p) => `${p}\t${liveMarker.get(p) ?? ""}\n`).join(""));
      continue;
    }
    if (ownerRunning(owner)) continue;
    reaped += reapRecord(file, new Set());
    rmSync(file, { force: true });
  }
  return reaped;
}

/** After a gate job: the QEMUs its harness left, if it was killed before it could kill them, from its own build directory. */
export function reapJobDir(buildDir: string): number {
  // And its parts', each with a build directory of its own under the job's (opt-tests.ts faultsInParts).
  const parts = join(buildDir, "parts");
  let n = 0;
  if (existsSync(parts))
    for (const d of readdirSync(parts)) n += reapOrphans(join(parts, d, "logs/qemu-pids"));
  return n + reapOrphans(join(buildDir, "logs/qemu-pids"));
}

export function liveCount(): number {
  return live.size;
}

// --- hvf availability, by the only test that counts

let hvfCache: { ok: boolean; why: string } | null = null;

/** For the harness's own test of the skip path. */
export function setHvfOverride(v: { ok: boolean; why: string } | null): void {
  hvfCache = v;
}

export function hvfAvailable(): { ok: boolean; why: string } {
  if (hvfCache !== null) return hvfCache;
  const sys = spawnSync("/usr/sbin/sysctl", ["-n", "kern.hv_support"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (sys.stdout?.trim() !== "1") hvfCache = { ok: false, why: "kern.hv_support is not 1" };
  else hvfCache = { ok: true, why: "" };
  return hvfCache;
}

// --- the RAM channel (SPEC 8.2)

/** The guest's checksum over the channel, a word at a time. What's past the end is zero, because the guest never wrote it. */
export function channelSum(buf: Uint8Array, n: number): number {
  let h = 2166136261 | 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < n; i += 4) h = Math.imul(h ^ view.getInt32(i, true), 16777619);
  return h >>> 0;
}

/**
 * Reads what the guest left in RAM. Serial's TMK:BULK says how much and its checksum, and it has the last word: with it,
 * anything short, long or changed is a failed run. Without it the guest didn't finish, and what's there up to the first zero is
 * the cases it got through, for the harness to say which one it stopped in.
 */
export function readChannel(
  ramFile: string,
  layout: BulkLayout,
  serialLines: string[],
  done = serialLines.includes("TMK:DONE"),
): { text: Buffer; lines: string[]; problem: string | null } {
  const empty = { text: Buffer.alloc(0), lines: [] };
  const trailer = serialLines.find((l) => l.startsWith("TMK:BULK "));
  let fd: number;
  try {
    fd = openSync(ramFile, "r");
  } catch (e) {
    return { ...empty, problem: `the RAM channel can't be read: ${String(e)}` };
  }
  try {
    const start = layout.offset;
    const size = fstatSync(fd).size;
    const have = Math.max(0, Math.min(layout.bytes, size - start));
    let n: number;
    let problem: string | null = null;
    let want: { n: number; sum: number } | null = null;
    if (trailer !== undefined) {
      const m = /^TMK:BULK (\d+) ([0-9a-f]+)$/.exec(trailer);
      if (m === null) return { ...empty, problem: `a bad trailer: ${trailer}` };
      want = { n: Number(m[1]), sum: Number.parseInt(m[2]!, 16) };
      n = want.n;
      if (n > have) return { ...empty, problem: `the guest reports ${n} bytes, past the channel` };
    } else n = have;
    // Up to the next word's end, for the checksum.
    const buf = Buffer.alloc(want !== null ? Math.ceil(n / 4) * 4 + 4 : 0);
    if (want !== null) readAll(fd, buf, start);
    let text: Buffer;
    if (want !== null) {
      text = buf.subarray(0, n);
      if (channelSum(buf, n) !== want.sum) {
        problem = `the RAM channel's checksum is ${channelSum(buf, n).toString(16)}, and the guest reported ${want.sum.toString(16)}`;
      } else if (text.includes(0)) problem = "the RAM channel has a zero byte in it";
      else if (n < have && buf[n] !== 0) problem = "the RAM channel has more in it than reported";
    } else {
      text = readToZero(fd, start, have);
      if (done) problem = "TMK:DONE with no TMK:BULK: the guest never said what it reported";
    }
    return { text, lines: splitLines(text), problem };
  } finally {
    closeSync(fd);
  }
}

function readAll(fd: number, buf: Buffer, at: number): void {
  let done = 0;
  while (done < buf.length) {
    const k = readSync(fd, buf, done, buf.length - done, at + done);
    if (k <= 0) break;
    done += k;
  }
}

function readToZero(fd: number, at: number, limit: number): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < limit; off += CHUNK) {
    const b = Buffer.alloc(Math.min(CHUNK, limit - off));
    readAll(fd, b, at + off);
    const z = b.indexOf(0);
    if (z >= 0) {
      parts.push(b.subarray(0, z));
      break;
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

const MEM_PREFIX = Buffer.from("TMK:M ");

/**
 * The channel's lines, without making a string of each line of a memory dump: a run of those is one `TMK:MR <from> <to>`, a byte range
 * of the channel that only what reads guest memory decodes. A dump is most of what there is, and it's why a test held gigabytes.
 */
function splitLines(text: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    if (text.compare(MEM_PREFIX, 0, 6, at, Math.min(at + 6, text.length)) === 0) {
      const from = at;
      let e = text.indexOf(10, at);
      while (e >= 0 && e + 1 < text.length) {
        const n = e + 1;
        if (text.compare(MEM_PREFIX, 0, 6, n, Math.min(n + 6, text.length)) !== 0) break;
        e = text.indexOf(10, n);
      }
      const end = e < 0 ? text.length : e + 1;
      out.push(`TMK:MR ${from} ${end}`);
      at = end;
      continue;
    }
    let e = text.indexOf(10, at);
    if (e < 0) e = text.length;
    out.push(text.toString("latin1", at, e));
    at = e + 1;
  }
  return out;
}

const channels = new WeakMap<string[], Buffer>();

/** The bytes a run's `TMK:MR` lines point into. */
export function channelOf(lines: string[]): Buffer | undefined {
  return channels.get(lines);
}

// --- one run

export function qemuArgs(
  opts: QemuOptions,
  imagePath: string,
  drives: string[],
  monitorPath: string | null,
  ramFile = "",
): string[] {
  const total = opts.bulk !== undefined ? opts.bulk.offset + opts.bulk.bytes : null;
  const args = [
    "-M",
    total !== null ? "virt,gic-version=3,memory-backend=ram0" : "virt,gic-version=3",
    "-accel",
    opts.accel,
    "-cpu",
    opts.accel === "hvf" ? "host" : "max",
    ...(total !== null
      ? ["-object", `memory-backend-file,id=ram0,size=${total},mem-path=${ramFile},share=on`]
      : []),
    "-m",
    total !== null ? `${total}B` : (opts.memory ?? "256M"),
    "-smp",
    "1",
    "-display",
    "none",
    "-nographic",
    "-monitor",
    monitorPath === null ? "none" : `unix:${monitorPath},server,nowait`,
    "-serial",
    "stdio",
    "-no-reboot",
    "-global",
    "virtio-mmio.force-legacy=false",
    // Counting instructions (`TMK_ICOUNT=1`, TCG only): one instruction a nanosecond of guest time, so a benchmark's
    // time in the guest's own clock is its instruction count (pipe-dispatch's append measurement).
    ...(process.env.TMK_ICOUNT === "1" && opts.accel === "tcg"
      ? ["-icount", "shift=0,align=off"]
      : []),
  ];
  drives.forEach((d, i) => {
    args.push(
      "-drive",
      `if=none,file=${d},format=raw,id=d${i}`,
      "-device",
      `virtio-blk-device,drive=d${i}`,
    );
  });
  args.push("-kernel", imagePath, ...(opts.extraArgs ?? []));
  return args;
}

/**
 * Runs an image, holding one of the run's CPU tokens while it does (R12, tools/cpu-budget.ts): taken before QEMU starts, so
 * the wait for one is never on the run's own time limit.
 */
export async function qemuRun(
  opts: QemuOptions & { marks?: string[]; onLine?: (l: string) => void },
): Promise<QemuResult> {
  const give = await takeCpu();
  try {
    return await qemuRunNow(opts);
  } finally {
    give();
  }
}

function qemuRunNow(
  opts: QemuOptions & { marks?: string[]; onLine?: (l: string) => void },
): Promise<QemuResult> {
  hookExit();
  const logDir = opts.logDir ?? buildPath("logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${opts.name.replace(/[^\w.-]+/g, "_")}.${opts.accel}.log`);
  const base = {
    name: opts.name,
    accel: opts.accel,
    log,
  };
  if (opts.accel === "hvf" && !hvfAvailable().ok) {
    return Promise.resolve({
      ...base,
      status: "skip" as const,
      ok: false,
      skipped: true,
      why: `HVF unavailable: ${hvfAvailable().why}`,
      serial: "",
      lines: [],
      exitCode: null,
      signal: null,
      killedByHarness: false,
      ms: 0,
      firstOutputMs: null,
      markMs: {},
      scratch: null,
      pid: null,
    });
  }
  const scratch = mkdtempSync(join(tmpdir(), "tmk-qemu-"));
  let imagePath: string;
  if (typeof opts.image === "string") imagePath = opts.image;
  else {
    imagePath = join(scratch, "image.bin");
    writeFileSync(imagePath, opts.image);
  }
  const drives = (opts.drives ?? []).map((d, i) => {
    const copy = join(scratch, `drive${i}.img`);
    spawnSync("/bin/cp", [d, copy]);
    return copy;
  });
  const monitorPath = opts.monitor === true ? join(scratch, "monitor.sock") : null;
  const ramFile = join(scratch, "ram.bin");
  const args = qemuArgs(opts, imagePath, drives, monitorPath, ramFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const marks = opts.marks ?? [];
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(QEMU, args, {
      detached: true, // its own process group, so a kill reaches anything it started and nothing else
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid ?? null;
    if (pid !== null) {
      live.add(pid);
      liveMarker.set(pid, imagePath);
      mkdirSync(PID_DIR, { recursive: true });
      appendFileSync(PID_FILE, `${pid}\t${imagePath}\n`);
    }
    opts.onSpawn?.({ pid, monitorPath });
    const logStream = createWriteStream(log);
    // Buffers, joined once. `+=` on a string per read made a rope of millions of tiny pieces, which was native-f's growth (SPEC M5).
    const serialChunks: Buffer[] = [];
    let stderr = "";
    let partial = "";
    let lines: string[] = [];
    let firstOutputMs: number | null = null;
    const markMs: Record<string, number> = {};
    let sawDone = false;
    let sawFatal = false;
    let timedOut = false;
    let killed = false;
    let doneTimer: NodeJS.Timeout | null = null;
    let termTimer: NodeJS.Timeout | null = null;
    const hardKill = (): void => {
      killed = true;
      if (pid !== null) killGroup(pid, "SIGKILL");
    };
    const softKill = (): void => {
      killed = true;
      if (pid !== null) killGroup(pid, "SIGTERM");
      termTimer = setTimeout(hardKill, TERM_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      softKill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const now = performance.now() - started;
      if (firstOutputMs === null) firstOutputMs = now;
      const text = d.toString("latin1");
      serialChunks.push(d);
      logStream.write(d);
      partial += text;
      const parts = partial.split("\n");
      partial = parts.pop()!;
      for (const raw of parts) {
        const line = raw.replace(/\r$/, "");
        lines.push(line);
        opts.onLine?.(line);
        for (const m of marks) if (markMs[m] === undefined && line.startsWith(m)) markMs[m] = now;
        if (line === "TMK:DONE" && !sawDone) {
          sawDone = true;
          // QEMU should leave by itself after PSCI off. It gets 2 s to do it.
          doneTimer = setTimeout(softKill, DONE_GRACE_MS);
        }
        if (line.startsWith("TMK:FATAL") || line.startsWith("TMK:PANIC")) sawFatal = true;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    let closed = false;
    const finish = (code: number | null, signal: string | null, spawnError?: string): void => {
      if (closed) return;
      closed = true;
      const ms = performance.now() - started;
      const serialBytes = serialChunks.reduce((a, c) => a + c.length, 0);
      phase("qemu", ms, serialBytes);
      phase(`qemu ${opts.accel}`, ms, serialBytes);
      clearTimeout(timer);
      if (doneTimer !== null) clearTimeout(doneTimer);
      if (termTimer !== null) clearTimeout(termTimer);
      if (pid !== null) {
        // The group may outlive its leader; this empties it.
        killGroup(pid, "SIGKILL");
        live.delete(pid);
        liveMarker.delete(pid);
      }
      if (partial.length > 0) lines.push(partial);
      const channel = opts.bulk !== undefined ? readChannel(ramFile, opts.bulk, lines) : null;
      // What's in it is in the log now. A failed run keeps its scratch directory, and this is up to all the guest's RAM.
      if (channel !== null) rmSync(ramFile, { force: true });
      if (channel !== null) {
        // After what serial said, in the log too, so a log has everything a run reported.
        logStream.write(channel.text);
        lines = lines.slice(0, 1).concat(channel.lines, lines.slice(1));
        channels.set(lines, channel.text);
        phase("channel", 0, channel.text.length);
      }
      logStream.end();
      let status: QemuStatus;
      let why = "";
      if (timedOut) {
        status = "timeout";
        why = `over the ${timeoutMs} ms limit. Last serial lines:\n${lines.slice(-40).join("\n")}`;
      } else if (lines.some((l) => l.startsWith("TMK:PANIC"))) {
        status = "panic";
        why = lines.find((l) => l.startsWith("TMK:PANIC"))!;
      } else if (sawFatal) {
        status = "fatal";
        why = lines.find((l) => l.startsWith("TMK:FATAL"))!;
      } else if (!sawDone) {
        status = "no-done";
        why = `no TMK:DONE: exit ${code ?? signal ?? "?"} ${spawnError ?? ""} ${stderr.slice(0, 800)}\n${lines.slice(-40).join("\n")}`;
      } else if (channel !== null && channel.problem !== null) {
        status = "bad-channel";
        why = channel.problem;
      } else status = "done";
      const ok = status === "done";
      if (ok) rmSync(scratch, { recursive: true, force: true });
      resolve({
        ...base,
        status,
        ok,
        skipped: false,
        why,
        serial: Buffer.concat(serialChunks).toString("latin1"),
        lines,
        exitCode: code,
        signal,
        killedByHarness: killed,
        ms,
        firstOutputMs,
        markMs,
        scratch: ok ? null : scratch,
        pid,
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

export function imageExists(path: string): boolean {
  return existsSync(path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const image = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  if (image === undefined) {
    console.error(
      "usage: qemu-run <image> [--accel hvf|tcg|both] [--timeout s] [--memory 256M] [--monitor]",
    );
    process.exit(2);
  }
  const accel = flag("--accel") ?? "hvf";
  const accels: Accel[] = accel === "both" ? ["hvf", "tcg"] : [accel as Accel];
  let bad = 0;
  for (const a of accels) {
    const opts: QemuOptions = { name: image.replace(/.*\//, ""), image, accel: a };
    const t = flag("--timeout");
    if (t !== undefined) opts.timeoutMs = Number(t) * 1000;
    const mem = flag("--memory");
    if (mem !== undefined) opts.memory = mem;
    if (argv.includes("--monitor")) opts.monitor = true;
    const r = await qemuRun(opts);
    process.stdout.write(r.serial);
    console.error(
      `${r.ok ? "PASS" : r.skipped ? "SKIP" : "FAIL"} ${a} ${r.status} ${r.ms.toFixed(1)} ms ${r.why}`,
    );
    if (!r.ok) bad++;
    if (r.scratch !== null) console.error(`scratch kept: ${r.scratch}`);
  }
  process.exit(bad === 0 ? 0 : 1);
}
