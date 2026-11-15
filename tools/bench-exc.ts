// `tmk bench exc` (SPEC 8.4, D49): what exceptions cost natively in `rc`, against V8 running the same source. A call that can
// throw against one that can't, a `try` and a `try`/`finally` that nothing throws through, a throw caught 1, 10 and 100
// frames up, at -O0 and -O2; and the code each takes. No gate: numbers only, with the host's load, as M5 reports them.
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { buildImageFor, median, type Work } from "./bench-alloc.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { lowerFile } from "./lowering.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { Driver } from "./native-driver.ts";
import { buildImage } from "../compiler/backend-aarch64/image.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";

const HOOK = join(ROOT, "tools/ts-hook.mjs");
const FILE = join(ROOT, "bench/exc/exc_cost.ts");
const ARENA_BYTES = 96 * 1024 * 1024;

const V8_RUN = `
const [file, fn, n, warm, iter] = process.argv.slice(1);
const m = await import(file);
for (let i = 0; i < +warm; i++) m[fn](+n);
const times = [];
let last = 0;
for (let i = 0; i < +iter; i++) {
  const t0 = performance.now();
  last = m[fn](+n);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ ms: times[times.length >> 1], last }));
`;

export const EXC_WORK: { fn: string; n: number; what: string }[] = [
  { fn: "callsPlain", n: 100000, what: "a call that can't throw" },
  { fn: "callsRisky", n: 100000, what: "a call that can throw, and doesn't" },
  { fn: "tryNoThrow", n: 100000, what: "the same in a try/catch" },
  { fn: "tryFinallyNoThrow", n: 100000, what: "the same in a try/finally" },
  { fn: "throw1", n: 10000, what: "throw and catch, 1 frame up" },
  { fn: "throw10", n: 10000, what: "throw and catch, 10 frames up" },
  { fn: "throw100", n: 1000, what: "throw and catch, 100 frames up" },
];

export interface ExcBench {
  skipped: string | null;
  host: { loadStart: number[]; loadEnd: number[]; cpus: number };
  params: { warm: number; iter: number; processes: number };
  rows: {
    fn: string;
    what: string;
    n: number;
    v8NsPerOp: number | null;
    o0NsPerOp: number | null;
    o2NsPerOp: number | null;
    ratioO2: number | null;
  }[];
  code: { fn: string; o0Bytes: number; o2Bytes: number }[];
  errors: string[];
}

const setup = (main: FuncBuilder, drv: Driver): void => {
  drv.pageRange();
  drv.arenaUse();
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  const mid = main.at0(base, ARENA_BYTES);
  main.call("__arena_use", [base, mid]);
  drv.usePageRange(main, mid, limit);
  main.call("__init", []);
};

export async function benchExc(opts: { quick?: boolean }): Promise<ExcBench> {
  const processes = opts.quick === true ? 1 : 3;
  const warm = opts.quick === true ? 2 : 10;
  const iter = opts.quick === true ? 5 : 31;
  const out: ExcBench = {
    skipped: null,
    host: { loadStart: loadavg(), loadEnd: [], cpus: cpus().length },
    params: { warm, iter, processes },
    rows: [],
    code: [],
    errors: [],
  };
  if (!hvfAvailable().ok) {
    out.skipped = "HVF is unavailable, and performance runs are HVF only (SPEC 8.2)";
    return out;
  }
  const levels = [0, 2] as const;
  const mods = levels.map((l) => lowerFile(FILE, { memory: "rc", opt: l }));
  for (const [i, lo] of mods.entries()) {
    if (lo.tir === null || lo.fallbackDiags.length > 0) {
      out.errors.push(
        `-O${levels[i]} didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 300)}`,
      );
      return out;
    }
  }
  // The code each export's own function takes: its wrapper's callee, where it has one (D36).
  const sizes = mods.map((lo) => {
    // A main that calls each export, so the image linker keeps them.
    const main = new FuncBuilder("__tmk_main", [], []);
    for (const w of EXC_WORK) {
      const f = lo.tir!.funcs.find((x) => x.name === w.fn)!;
      main.call(
        w.fn,
        f.params.map((p) => main.iconst(f.types[p]!, 0)),
        f.rets,
      );
    }
    main.ret();
    const drv = new Driver(lo.tir!);
    drv.trapMessages(lo.meta!.strings);
    const img = buildImage({
      module: lo.tir!,
      driverFuncs: [...drv.funcs, main.finish()],
      driverGlobals: drv.globals,
      ramBytes: 64 * 1024 * 1024,
    });
    const by = new Map<string, number>();
    for (const r of img.ranges) by.set(r.name, r.to - r.from);
    return by;
  });
  for (const w of EXC_WORK) {
    const size = (by: Map<string, number>): number => by.get(`${w.fn}$x`) ?? by.get(w.fn) ?? 0;
    out.code.push({ fn: w.fn, o0Bytes: size(sizes[0]!), o2Bytes: size(sizes[1]!) });
  }
  for (const w of EXC_WORK) {
    const v8: number[] = [];
    let v8Last = "";
    for (let p = 0; p < processes; p++) {
      const r = await guardedRun(
        process.execPath,
        [
          "--import",
          HOOK,
          "--no-warnings",
          "--input-type=module",
          "-e",
          V8_RUN,
          "--",
          FILE,
          w.fn,
          String(w.n),
          String(warm),
          String(iter),
        ],
        { timeoutMs: 120_000, label: `bench-exc ${w.fn} on V8`, cwd: ROOT },
      );
      if (!r.ok) {
        out.errors.push(`${w.fn} on V8: ${r.why}`);
        continue;
      }
      const j = JSON.parse(r.stdout) as { ms: number; last: number };
      v8.push(j.ms);
      v8Last = String(j.last);
    }
    const nat: (number | null)[] = [];
    for (const [i, lo] of mods.entries()) {
      const work: Work = {
        name: w.fn,
        fn: w.fn,
        args: [w.n],
        which: 0,
        cArgs: [0, 0],
        ops: w.n,
        what: w.what,
      };
      const image = buildImageFor(lo.tir!, work, warm, iter, null, lo.meta!.strings, setup);
      const ms: number[] = [];
      for (let p = 0; p < processes; p++) {
        const r = await qemuRun({
          name: `bench-exc/${w.fn}-O${levels[i]}-${p}`,
          image,
          accel: "hvf",
          timeoutMs: 180_000,
        });
        if (!r.ok) {
          out.errors.push(`${w.fn} -O${levels[i]}: ${r.status} ${r.why.slice(0, 200)}`);
          continue;
        }
        const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
        for (const l of r.lines) {
          const parts = l.split(" ");
          if (parts[0] === "TMK:B")
            ms.push(median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)));
          if (
            parts[0] === "TMK:R" &&
            v8Last !== "" &&
            BigInt.asIntN(32, BigInt(`0x${parts[2]}`)) !== BigInt(v8Last)
          )
            out.errors.push(`${w.fn} -O${levels[i]}: ${parts[2]} where V8 gave ${v8Last}`);
        }
      }
      nat.push(ms.length > 0 ? median(ms) : null);
    }
    const ns = (ms: number | null): number | null => (ms === null ? null : (ms * 1e6) / w.n);
    const v8ms = v8.length > 0 ? median(v8) : null;
    out.rows.push({
      fn: w.fn,
      what: w.what,
      n: w.n,
      v8NsPerOp: ns(v8ms),
      o0NsPerOp: ns(nat[0] ?? null),
      o2NsPerOp: ns(nat[1] ?? null),
      ratioO2: nat[1] != null && v8ms !== null ? nat[1] / v8ms : null,
    });
  }
  out.host.loadEnd = loadavg();
  return out;
}

export function excText(b: ExcBench): string {
  if (b.skipped !== null) return `SKIPPED: ${b.skipped}`;
  const f = (x: number | null, d = 2): string => (x === null ? "-" : x.toFixed(d));
  const lines = [
    `tmk bench exc: ${b.params.processes} processes, median of ${b.params.iter} after ${b.params.warm}; load ${b.host.loadStart.map((x) => x.toFixed(1)).join(" ")} -> ${b.host.loadEnd.map((x) => x.toFixed(1)).join(" ")} on ${b.host.cpus} CPUs`,
    "work                                         ns/op V8   -O0     -O2   -O2/V8",
  ];
  for (const r of b.rows) {
    lines.push(
      `${`${r.fn} (${r.what})`.padEnd(44)} ${f(r.v8NsPerOp).padStart(8)} ${f(r.o0NsPerOp).padStart(7)} ${f(r.o2NsPerOp).padStart(7)} ${f(r.ratioO2).padStart(7)}`,
    );
  }
  lines.push("code bytes, the export's own function, -O0 / -O2:");
  for (const c of b.code) lines.push(`  ${c.fn.padEnd(20)} ${c.o0Bytes} / ${c.o2Bytes}`);
  for (const e of b.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}
