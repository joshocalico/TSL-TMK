// `tmk bench maps`: the worst single operation on a growing `Map` and `Set`, natively in `rc`, by the counter around each call
// (SPEC 3.5, 8.4, D47), and what the incremental move costs in throughput. No gate on a time: QEMU can't gate one, and the
// counter is 24 MHz, so a figure under 42 ns is a tick. A step count is what tests pin; this says what it comes to.
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { buildPath } from "./build-dir.ts";
import { ROOT } from "./corpus.ts";
import { lowerFile } from "./lowering.ts";
import { Driver } from "./native-driver.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";

const FILE = join(ROOT, "bench/maps/growth_lowered.ts");
const ARENA_BYTES = 64 * 1024 * 1024;

export interface WorstRow {
  name: string;
  what: string;
  n: number;
  /** The slowest single call, in microseconds, and which call it was. */
  worstUs: number;
  worstAt: number;
  /** The mean call, in nanoseconds. */
  meanNs: number;
  /** Calls over 10 µs and over 100 µs. */
  over10us: number;
  over100us: number;
}

export interface ThroughputRow {
  name: string;
  what: string;
  n: number;
  ms: number;
}

export interface MapsBench {
  skipped: string | null;
  host: { loadStart: number[]; loadEnd: number[]; cpus: number };
  worst: WorstRow[];
  throughput: ThroughputRow[];
  errors: string[];
}

const PER_OP: { name: string; reset: string; resetArg: number | null; op: string; what: string }[] =
  [
    {
      name: "map-num",
      reset: "resetNum",
      resetArg: null,
      op: "putNum",
      what: "Map<number, number>, set of a new key",
    },
    {
      name: "map-churn",
      reset: "resetNum",
      resetArg: null,
      op: "churnNum",
      what: "Map<number, number>, set and delete every other",
    },
    {
      name: "map-str",
      reset: "resetStr",
      resetArg: -1,
      op: "putStr",
      what: "Map<string, number>, set of a new key",
    },
    {
      name: "set-num",
      reset: "resetSet",
      resetArg: null,
      op: "addSet",
      what: "Set<number>, add of a new key",
    },
  ];

const THROUGHPUT: { fn: string; n: number; what: string }[] = [
  { fn: "buildAndRead", n: 1 << 20, what: "build a Map to 2^20 entries and read each" },
  { fn: "mixWork", n: 1_000_000, what: "set, get and delete over a window of 64, 10^6 times" },
];

/** One image per scenario, so one's garbage doesn't time another's growth. */
function imageFor(
  m: Module,
  strings: Record<string, number>,
  body: (b: FuncBuilder, drv: Driver) => void,
): Uint8Array {
  const drv = new Driver(m);
  const main = new FuncBuilder("__tmk_main", [], []);
  drv.puts(main, "TMK:F ");
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  drv.pageRange();
  drv.arenaUse();
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  const mid = main.at0(base, ARENA_BYTES);
  main.call("__arena_use", [base, mid]);
  drv.usePageRange(main, mid, limit);
  main.call("__init", []);
  body(main, drv);
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(strings);
  return buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: 1024 * 1024 * 1024,
  }).bytes;
}

function loop(b: FuncBuilder, n: number, body: (idx: number) => void): void {
  const head = b.block(["i64"]);
  const inner = b.block();
  const next = b.block();
  b.br(head, [b.i64(0)]);
  b.at(head);
  const idx = head.params[0]!;
  b.brif(b.op("icmp.ult.i64", [idx, b.i64(n)], "i32"), inner, next);
  b.at(inner);
  body(idx);
  b.br(head, [b.op("add.i64", [idx, b.i64(1)], "i64")]);
  b.at(next);
}

function callNum(b: FuncBuilder, drv: Driver, fn: string, arg: number | null): void {
  const sig = drv.sigOf(fn);
  const args = arg === null ? [] : [b.op("sitofp.f64", [arg], "f64")];
  b.call(fn, args.slice(0, sig.params.length), sig.rets);
}

export async function benchMaps(opts: { n?: number; quick?: boolean }): Promise<MapsBench> {
  const n = opts.n ?? (opts.quick === true ? (1 << 16) + 1 : (1 << 20) + 1);
  const out: MapsBench = {
    skipped: null,
    host: { loadStart: loadavg(), loadEnd: [], cpus: cpus().length },
    worst: [],
    throughput: [],
    errors: [],
  };
  if (!hvfAvailable().ok) {
    out.skipped = "HVF is unavailable, and performance runs are HVF only (SPEC 8.2)";
    return out;
  }
  const lo = lowerFile(FILE, { memory: "rc" });
  if (lo.tir === null || lo.fallbackDiags.length > 0) {
    out.errors.push(`didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 400)}`);
    return out;
  }
  const m = lo.tir;
  const strings = lo.meta!.strings;
  for (const s of PER_OP) {
    const image = imageFor(m, strings, (b, drv) => {
      const g = (name: string): number => {
        drv.globals.push({ name, size: 8, align: 8, section: "data" });
        return b.global(name);
      };
      const worst = g("__w_max");
      const at = g("__w_at");
      const sum = g("__w_sum");
      const o10 = g("__w_o10");
      const o100 = g("__w_o100");
      const freq = b.intrinsic("native.frequency", [], ["i64"])[0]!;
      callNum(b, drv, s.reset, s.resetArg === null ? null : b.i64(n + 1));
      loop(b, n, (idx) => {
        const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        callNum(b, drv, s.op, idx);
        const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        const d = b.op("sub.i64", [t1, t0], "i64");
        b.store("i64", sum, b.op("add.i64", [b.load("i64", sum), d], "i64"));
        const big = b.op("icmp.ugt.i64", [d, b.load("i64", worst)], "i32");
        b.store("i64", worst, b.op("select.i64", [big, d, b.load("i64", worst)], "i64"));
        b.store("i64", at, b.op("select.i64", [big, idx, b.load("i64", at)], "i64"));
        // Over 10 µs is d * 10^5 > the ticks in a second, and over 100 µs d * 10^4.
        const a = b.op(
          "zext.i64",
          [b.op("icmp.ugt.i64", [b.op("mul.i64", [d, b.i64(100_000)], "i64"), freq], "i32")],
          "i64",
        );
        const c = b.op(
          "zext.i64",
          [b.op("icmp.ugt.i64", [b.op("mul.i64", [d, b.i64(10_000)], "i64"), freq], "i32")],
          "i64",
        );
        b.store("i64", o10, b.op("add.i64", [b.load("i64", o10), a], "i64"));
        b.store("i64", o100, b.op("add.i64", [b.load("i64", o100), c], "i64"));
      });
      drv.puts(b, "TMK:W");
      for (const x of [worst, at, sum, o10, o100]) {
        b.call("__rt_sp", []);
        b.call("__rt_dec", [b.load("i64", x)]);
      }
      b.call("__rt_nl", []);
    });
    const r = await qemuRun({
      name: `bench-maps/${s.name}`,
      image,
      accel: "hvf",
      timeoutMs: 280_000,
      memory: "1024M",
    });
    if (!r.ok) {
      out.errors.push(`${s.name}: ${r.status} ${r.why.slice(0, 300)}`);
      continue;
    }
    const f = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
    const w = r.lines.find((l) => l.startsWith("TMK:W "));
    if (w === undefined) {
      out.errors.push(`${s.name}: no result line`);
      continue;
    }
    const [mx, wat, total, a, c] = w.slice(6).trim().split(" ").map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    out.worst.push({
      name: s.name,
      what: s.what,
      n,
      worstUs: (mx / f) * 1e6,
      worstAt: wat,
      meanNs: (total / f / n) * 1e9,
      over10us: a,
      over100us: c,
    });
  }
  for (const t of opts.quick === true ? [] : THROUGHPUT) {
    const reps = 7;
    const image = imageFor(m, strings, (b, drv) => {
      drv.puts(b, "TMK:T");
      loop(b, reps, () => {
        const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        callNum(b, drv, t.fn, b.i64(t.n));
        const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
        b.call("__rt_sp", []);
        b.call("__rt_dec", [b.op("sub.i64", [t1, t0], "i64")]);
      });
      b.call("__rt_nl", []);
    });
    const r = await qemuRun({
      name: `bench-maps/${t.fn}`,
      image,
      accel: "hvf",
      timeoutMs: 280_000,
      memory: "1024M",
    });
    if (!r.ok) {
      out.errors.push(`${t.fn}: ${r.status} ${r.why.slice(0, 300)}`);
      continue;
    }
    const f = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
    const line = r.lines.find((l) => l.startsWith("TMK:T "));
    if (line === undefined) {
      out.errors.push(`${t.fn}: no result line`);
      continue;
    }
    // The first is a cold heap: the median of the rest.
    const ms = line
      .slice(6)
      .trim()
      .split(" ")
      .map((x) => (Number(x) / f) * 1000)
      .slice(1)
      .sort((x, y) => x - y);
    out.throughput.push({ name: t.fn, what: t.what, n: t.n, ms: ms[ms.length >> 1]! });
  }
  out.host.loadEnd = loadavg();
  const dir = buildPath("bench/maps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

export function printMaps(r: MapsBench): void {
  if (r.skipped !== null) {
    console.log(`bench maps: SKIPPED: ${r.skipped}`);
    return;
  }
  for (const w of r.worst)
    console.log(
      `${w.name.padEnd(10)} n=${w.n}: worst ${w.worstUs.toFixed(1)} µs at call ${w.worstAt}, mean ${w.meanNs.toFixed(0)} ns, over 10 µs ${w.over10us}, over 100 µs ${w.over100us}  (${w.what})`,
    );
  for (const t of r.throughput)
    console.log(`${t.name.padEnd(12)} ${t.ms.toFixed(2)} ms  (${t.what})`);
  for (const e of r.errors) console.log(`ERROR ${e}`);
  console.log(
    `load ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")} to ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")} on ${r.host.cpus} CPUs`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nArg = process.argv.indexOf("--n");
  const r = await benchMaps({
    ...(nArg > 0 ? { n: Number(process.argv[nArg + 1]) } : {}),
    quick: process.argv.includes("--quick"),
  });
  printMaps(r);
}
