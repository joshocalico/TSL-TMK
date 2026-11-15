// `tmk bench strmap`: strings, `Map` and `Set`, natively in `rc`, against the source on V8, and C where a comparison is fair
// (SPEC 8.4, D42). No gate: numbers only. It also says what a module pays for this: the runtime that's linked when it's
// used, and nothing when it isn't.
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { lowerFile } from "./lowering.ts";
import type { FuncBuilder } from "../compiler/tir/build.ts";
import { buildC, buildImageFor, median, type Work } from "./bench-alloc.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { buildDownImage, type DownMetaLike } from "./native-exec.ts";
import type { Driver } from "./native-driver.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

const OUT = buildPath("bench/strmap");
const HOOK = join(ROOT, "tools/ts-hook.mjs");
const ARENA_BYTES = 96 * 1024 * 1024;
const FILE = join(ROOT, "bench/strmap/strmap_lowered.ts");

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

export interface Row {
  name: string;
  n: number;
  what: string;
  ms: number;
  v8ms: number | null;
  cms: number | null;
}

export interface StrmapBench {
  skipped: string | null;
  host: { loadStart: number[]; loadEnd: number[]; cpus: number };
  params: { warm: number; iter: number; processes: number };
  rows: Row[];
  sizes: { name: string; imageBytes: number; codeFuncs: number; hash: string }[];
  errors: string[];
}

const WORK: { fn: string; n: number; what: string; c?: number }[] = [
  { fn: "concatWork", n: 100000, what: "s += one char, 100,000 times", c: 0 },
  { fn: "concatSmall", n: 100000, what: "short concat, 100,000 times" },
  { fn: "splitJoinWork", n: 20000, what: "join, split and join 20,000 words" },
  { fn: "intText", n: 100000, what: "String(i), 100,000 integers" },
  { fn: "numTextShort", n: 20000, what: "String(i * 0.25), 20,000 short decimals" },
  { fn: "numTextRandom", n: 5000, what: "String(random double), 5,000" },
  { fn: "textNum", n: 20000, what: "Number(short text), 20,000" },
  { fn: "mapMix", n: 100000, what: "Map<number, number> get/set/delete mix, 100,000", c: 1 },
  { fn: "mapStrMix", n: 100000, what: "Map<string, number> mix over 500 keys, 100,000" },
  { fn: "wordCount", n: 20000, what: "word count over 20,000 words", c: 2 },
  { fn: "setDedupe", n: 100000, what: "Set<number> dedupe, 100,000" },
  { fn: "mapBuild", n: 1048576, what: "Map built to 2^20 entries, full and not yet grown" },
  { fn: "mapBuild", n: 1048577, what: "one more: the difference is one growth, in one set" },
];

export async function benchStrmap(opts: { quick?: boolean }): Promise<StrmapBench> {
  const processes = opts.quick === true ? 1 : 3;
  const warm = opts.quick === true ? 2 : 5;
  const iter = opts.quick === true ? 5 : 31;
  const out: StrmapBench = {
    skipped: null,
    host: { loadStart: loadavg(), loadEnd: [], cpus: cpus().length },
    params: { warm, iter, processes },
    rows: [],
    sizes: [],
    errors: [],
  };
  if (!hvfAvailable().ok) {
    out.skipped = "HVF is unavailable, and performance runs are HVF only (SPEC 8.2)";
    return out;
  }
  mkdirSync(OUT, { recursive: true });
  const lo = lowerFile(FILE, { memory: "rc" });
  if (lo.tir === null || lo.fallbackDiags.length > 0) {
    out.errors.push(`didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 400)}`);
    return out;
  }
  const cBlob = buildC(join(ROOT, "bench/strmap/strmap.c"), OUT);
  for (const w of WORK) {
    const work: Work = {
      name: w.fn,
      fn: w.fn,
      args: [w.n],
      which: w.c ?? 0,
      cArgs: [w.n, 0],
      ops: w.n,
      what: w.what,
    };
    const useC = w.c !== undefined ? cBlob : null;
    // 512 MiB: a 2^20-entry Map<number, number> bounded by an exported `n` has f64 keys and values (SPEC 4.5), and while
    // it moves it holds its old table and its new one.
    const image = buildImageFor(
      lo.tir,
      work,
      warm,
      iter,
      useC,
      lo.meta!.strings,
      setup,
      512 * 1024 * 1024,
    );
    const tsl: number[] = [];
    const c: number[] = [];
    let rt = "";
    let rc = "";
    for (let p = 0; p < processes; p++) {
      const r = await qemuRun({
        name: `bench-strmap/${w.fn}-${p}`,
        image,
        accel: "hvf",
        timeoutMs: 280_000,
        memory: "512M",
      });
      if (!r.ok) {
        out.errors.push(`${w.fn} #${p}: ${r.status} ${r.why.slice(0, 300)}`);
        continue;
      }
      const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
      for (const l of r.lines) {
        const parts = l.split(" ");
        if (parts[0] === "TMK:B")
          (parts[1] === "tsl" ? tsl : c).push(
            median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)),
          );
        if (parts[0] === "TMK:R") {
          if (parts[1] === "tsl") rt = parts[2]!;
          else rc = parts[2]!;
        }
      }
    }
    const v8: number[] = [];
    let last = "";
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
        { timeoutMs: 280_000, label: "bench-strmap on V8", cwd: ROOT },
      );
      if (!r.ok) {
        out.errors.push(`V8 ${w.fn}: ${r.why} ${r.stderr.slice(0, 300)}`);
        continue;
      }
      const j = JSON.parse(r.stdout) as { ms: number; last: number };
      v8.push(j.ms);
      last = String(j.last);
    }
    if (rt !== "" && last !== "") {
      const native = Number(BigInt.asIntN(32, BigInt(`0x${rt}`)));
      if (native !== (Number(last) | 0)) out.errors.push(`${w.fn}: native ${native}, V8 ${last}`);
    }
    if (
      rc !== "" &&
      rt !== "" &&
      BigInt.asIntN(32, BigInt(`0x${rc}`)) !== BigInt.asIntN(32, BigInt(`0x${rt}`))
    ) {
      out.errors.push(`${w.fn}: C gave ${rc}, native ${rt}`);
    }
    if (tsl.length > 0) {
      out.rows.push({
        name: w.fn,
        n: w.n,
        what: w.what,
        ms: median(tsl),
        v8ms: v8.length > 0 ? median(v8) : null,
        cms: c.length > 0 ? median(c) : null,
      });
    }
  }
  // What's linked. The first module uses none of this: its tirhash is pinned from before any of it existed.
  const sample = (name: string, text: string): void => {
    const f = join(OUT, `${name}.ts`);
    writeFileSync(f, text);
    const o = lowerFile(f, { memory: "rc" });
    if (o.tir === null) {
      out.errors.push(`${name}: ${JSON.stringify(o.diags)}`);
      return;
    }
    // With a call to it, as an image only holds what its driver can reach.
    const arg: unknown =
      name === "nothing" ? [1] : name.includes("numbers") || name === "strings_text" ? 1 : "a b";
    const built = buildDownImage(o.tir, o.meta as DownMetaLike, [{ fn: "f", args: [arg] }]);
    out.sizes.push({
      name,
      imageBytes: built.image.bytes.length,
      codeFuncs: o.tir.funcs.length,
      hash: o.tirHash.slice(0, 12),
    });
  };
  sample(
    "nothing",
    `export function f(a: number[]): number { let t = 0; for (const x of a) t += x; return t; }\n`,
  );
  sample("strings", `export function f(a: string): string { return a + "!"; }\n`);
  sample("strings_text", `export function f(a: number): string { return String(a); }\n`);
  sample(
    "map_numbers",
    `export function f(a: number): number { const m = new Map<number, number>(); m.set(a, 1); return m.size; }\n`,
  );
  sample(
    "map_strings",
    `export function f(a: string): number { const m = new Map<string, number>(); m.set(a, 1); return m.size; }\n`,
  );
  sample(
    "everything",
    `export function f(a: string): string { const m = new Map<string, number>(); for (const w of a.split(" ")) m.set(w, Number(w)); return [...m.keys()].join(",") + String(m.size / 3) + a.toLowerCase(); }\n`,
  );
  out.host.loadEnd = loadavg();
  return out;
}

export function strmapText(r: StrmapBench): string {
  if (r.skipped !== null) return `SKIP ${r.skipped}`;
  const lines = [
    `host: ${r.host.cpus} CPUs, load start ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")}, end ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")}`,
    `${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}; native in rc under HVF, against the source on V8, and C at clang -O2 where shown`,
  ];
  for (const x of r.rows) {
    const v = x.v8ms === null ? "-" : `V8 ${x.v8ms.toFixed(3)} ms (${(x.ms / x.v8ms).toFixed(2)}x)`;
    const c = x.cms === null ? "" : `, C ${x.cms.toFixed(3)} ms (${(x.ms / x.cms).toFixed(2)}x)`;
    lines.push(`${x.name.padEnd(14)} ${x.ms.toFixed(3).padStart(10)} ms  ${v}${c}  ${x.what}`);
  }
  for (const s of r.sizes)
    lines.push(
      `size ${s.name.padEnd(14)} ${String(s.imageBytes).padStart(9)} bytes of image, ${s.codeFuncs} functions, tirhash ${s.hash}`,
    );
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}

/** Whether copy-on-write pays for arrays: the write test on real writes, against what it would save on read-only copies. */
export interface CowBench {
  host: { loadStart: number[]; loadEnd: number[] };
  rows: { fn: string; n: number; plain: number; probed: number }[];
  errors: string[];
  sites: { slices: number; spreads: number; programs: number };
}

export async function benchCow(opts: { quick?: boolean }): Promise<CowBench> {
  const out: CowBench = {
    host: { loadStart: loadavg(), loadEnd: [] },
    rows: [],
    errors: [],
    sites: { slices: 0, spreads: 0, programs: 0 },
  };
  const file = join(ROOT, "bench/strmap/cow_arrays.ts");
  const warm = opts.quick === true ? 2 : 5;
  const iter = opts.quick === true ? 5 : 31;
  const plain = lowerFile(file, { memory: "rc" });
  const probed = lowerFile(file, { memory: "rc", rc: { cowProbe: true } });
  if (plain.tir === null || probed.tir === null) {
    out.errors.push("didn't lower");
    return out;
  }
  const jobs = [
    ["writesFill", 4096],
    ["writesSort", 1500],
    ["writesRefs", 1000],
    ["pushes", 4096],
    ["slice16", 20000],
    ["slice256", 2000],
    ["slice4096", 200],
    ["spreadRefs", 500],
    ["headerOnly", 20000],
  ] as const;
  for (const [fn, n] of jobs) {
    const work: Work = { name: fn, fn, args: [n], which: 0, cArgs: [n, 0], ops: n, what: fn };
    const times = async (m: typeof plain): Promise<number> => {
      const image = buildImageFor(m.tir!, work, warm, iter, null, m.meta!.strings, setup);
      const got: number[] = [];
      for (let p = 0; p < 3; p++) {
        const r = await qemuRun({
          name: `bench-cow/${fn}-${p}`,
          image,
          accel: "hvf",
          timeoutMs: 200_000,
        });
        if (!r.ok) {
          out.errors.push(`${fn}: ${r.status} ${r.why.slice(0, 200)}`);
          continue;
        }
        const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
        for (const l of r.lines) {
          const parts = l.split(" ");
          if (parts[0] === "TMK:B")
            got.push(median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)));
        }
      }
      return median(got);
    };
    out.rows.push({ fn, n, plain: await times(plain), probed: await times(probed) });
  }
  out.host.loadEnd = loadavg();
  return out;
}
