// `tmk bench std`: @tsl/std's Vec, Map and Set, natively and on V8, against @tsl/alloc, the lowered `rc` runtime, V8's own
// built-ins and C where a comparison is fair (SPEC 8.4, D43). No gate: numbers only. It also says what a module pays.
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { checkFile, compileTyped, lowerFile } from "./lowering.ts";
import type { Module } from "../compiler/tir/ir.ts";
import type { FuncBuilder } from "../compiler/tir/build.ts";
import { buildC, buildImageFor, median, type Work } from "./bench-alloc.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { buildTslImage } from "./native-exec.ts";
import type { Driver } from "./native-driver.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

const OUT = buildPath("bench/std");
const HOOK = join(ROOT, "tools/ts-hook.mjs");
const ARENA_BYTES = 96 * 1024 * 1024;
const STD = join(ROOT, "bench/std/std_side.ts");
const ALLOC = join(ROOT, "bench/std/alloc_side.ts");
const LOWERED = join(ROOT, "bench/std/lowered.ts");
const STRMAP = join(ROOT, "bench/strmap/strmap_lowered.ts");

const tslSetup = (main: FuncBuilder, drv: Driver): void => {
  drv.pageRange();
  const base = main.load("ptr", main.global("__mem_base"));
  const limit = main.load("ptr", main.global("__mem_limit"));
  drv.usePageRange(main, base, limit);
};

const loweredSetup = (main: FuncBuilder, drv: Driver): void => {
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

interface RowSpec {
  fn: string;
  n: number;
  what: string;
  alloc: boolean;
  lowered: string; // where the rc and V8 side is
  c: { file: string; which: number } | null;
}

const ROWS: RowSpec[] = [
  {
    fn: "vecPushRead",
    n: 100000,
    what: "push 100,000 u32s and read them back",
    alloc: true,
    lowered: LOWERED,
    c: { file: "bench/std/vec.c", which: 0 },
  },
  {
    fn: "mapMix",
    n: 100000,
    what: "Map of integers, get/set/delete mix, 100,000",
    alloc: false,
    lowered: STRMAP,
    c: { file: "bench/strmap/strmap.c", which: 1 },
  },
  {
    fn: "setDedupe",
    n: 100000,
    what: "Set of integers, 100,000 adds over 500 values",
    alloc: false,
    lowered: LOWERED,
    c: null,
  },
  {
    fn: "wordCount",
    n: 20000,
    what: "word count over 20,000 words, Map with string keys",
    alloc: false,
    lowered: STRMAP,
    c: { file: "bench/strmap/strmap.c", which: 2 },
  },
  {
    fn: "sortWork",
    n: 100000,
    what: "sort 100,000 integers: std's heapsort against rc's merge sort and V8's TimSort",
    alloc: false,
    lowered: LOWERED,
    c: null,
  },
];

export interface StdRow {
  fn: string;
  n: number;
  what: string;
  std: number | null;
  stdOnV8: number | null;
  alloc: number | null;
  rc: number | null;
  v8: number | null;
  c: number | null;
}

export interface StdBench {
  skipped: string | null;
  host: { loadStart: number[]; loadEnd: number[]; cpus: number };
  params: { warm: number; iter: number; processes: number };
  rows: StdRow[];
  sizes: { name: string; imageBytes: number; funcs: number; hash: string }[];
  errors: string[];
}

function tslModule(file: string): { tir: Module; strings: Record<string, number> } | string {
  const c = checkFile(file);
  if (c.typed === null) return JSON.stringify(c.diags).slice(0, 400);
  const o = compileTyped(c.typed);
  return { tir: o.tir, strings: o.meta.strings };
}

export async function benchStd(opts: { quick?: boolean }): Promise<StdBench> {
  const processes = opts.quick === true ? 1 : 3;
  const warm = opts.quick === true ? 2 : 5;
  const iter = opts.quick === true ? 5 : 31;
  const out: StdBench = {
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
  const std = tslModule(STD);
  const alloc = tslModule(ALLOC);
  if (typeof std === "string" || typeof alloc === "string") {
    out.errors.push(`didn't compile: ${String(std)} ${String(alloc)}`);
    return out;
  }
  const lowered = new Map<string, ReturnType<typeof lowerFile>>();
  for (const f of [LOWERED, STRMAP]) {
    const lo = lowerFile(f, { memory: "rc" });
    if (lo.tir === null || lo.fallbackDiags.length > 0) {
      out.errors.push(`${f} didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 400)}`);
      return out;
    }
    lowered.set(f, lo);
  }
  const native = async (
    name: string,
    m: Module,
    strings: Record<string, number>,
    w: RowSpec,
    setup: (main: FuncBuilder, drv: Driver) => void,
    cBlob: Uint8Array | null,
  ): Promise<{ ms: number | null; c: number | null; result: string }> => {
    const work: Work = {
      name: w.fn,
      fn: w.fn,
      args: [w.n],
      which: w.c?.which ?? 0,
      cArgs: [w.n, 0],
      ops: w.n,
      what: w.what,
    };
    const image = buildImageFor(m, work, warm, iter, cBlob, strings, setup);
    const tsl: number[] = [];
    const c: number[] = [];
    let result = "";
    for (let p = 0; p < processes; p++) {
      const r = await qemuRun({
        name: `bench-std/${name}-${w.fn}-${p}`,
        image,
        accel: "hvf",
        timeoutMs: 280_000,
      });
      if (!r.ok) {
        out.errors.push(`${name} ${w.fn} #${p}: ${r.status} ${r.why.slice(0, 300)}`);
        continue;
      }
      const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
      for (const l of r.lines) {
        const parts = l.split(" ");
        if (parts[0] === "TMK:B")
          (parts[1] === "tsl" ? tsl : c).push(
            median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)),
          );
        if (parts[0] === "TMK:R" && parts[1] === "tsl") result = parts[2]!;
        if (parts[0] === "TMK:R" && parts[1] === "c" && result !== "") {
          const same =
            BigInt.asIntN(32, BigInt(`0x${parts[2]!}`)) ===
            BigInt.asIntN(32, BigInt(`0x${result}`));
          if (!same) out.errors.push(`${name} ${w.fn}: C gave ${parts[2]!}, native ${result}`);
        }
      }
    }
    return {
      ms: tsl.length > 0 ? median(tsl) : null,
      c: c.length > 0 ? median(c) : null,
      result,
    };
  };
  const onV8 = async (file: string, w: RowSpec): Promise<{ ms: number | null; last: string }> => {
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
          file,
          w.fn,
          String(w.n),
          String(warm),
          String(iter),
        ],
        { timeoutMs: 280_000, label: "bench-std on V8", cwd: ROOT },
      );
      if (!r.ok) {
        out.errors.push(`V8 ${w.fn}: ${r.why} ${r.stderr.slice(0, 300)}`);
        continue;
      }
      const j = JSON.parse(r.stdout) as { ms: number; last: number };
      v8.push(j.ms);
      last = String(j.last);
    }
    return { ms: v8.length > 0 ? median(v8) : null, last };
  };
  const sameInt = (hex: string, dec: string): boolean =>
    hex === "" ||
    dec === "" ||
    BigInt.asIntN(32, BigInt(`0x${hex}`)) === BigInt.asIntN(32, BigInt(dec));
  for (const w of ROWS) {
    const cBlob = w.c !== null ? buildC(join(ROOT, w.c.file), join(OUT, `c-${w.fn}`)) : null;
    const s = await native("std", std.tir, std.strings, w, tslSetup, cBlob);
    const a = w.alloc ? await native("alloc", alloc.tir, alloc.strings, w, tslSetup, null) : null;
    const lo = lowered.get(w.lowered)!;
    const rc = await native("rc", lo.tir!, lo.meta!.strings, w, loweredSetup, null);
    const v8 = await onV8(w.lowered, w);
    const sv8 = await onV8(STD, { ...w, n: Math.min(w.n, 20000) });
    if (!sameInt(s.result, v8.last))
      out.errors.push(`${w.fn}: std ${s.result}, V8's own ${v8.last}`);
    if (a !== null && a.result !== s.result)
      out.errors.push(`${w.fn}: alloc ${a.result}, std ${s.result}`);
    if (!sameInt(rc.result, v8.last))
      out.errors.push(`${w.fn}: rc ${rc.result}, V8's own ${v8.last}`);
    out.rows.push({
      fn: w.fn,
      n: w.n,
      what: w.what,
      std: s.ms,
      stdOnV8: sv8.ms === null ? null : (sv8.ms * w.n) / Math.min(w.n, 20000),
      alloc: a?.ms ?? null,
      rc: rc.ms,
      v8: v8.ms,
      c: s.c,
    });
  }
  // What's linked. The first module uses none of this, and its tirhash doesn't move: box 5 of native-g.
  const sample = (name: string, text: string): void => {
    const dir = buildPath("bench/std/samples");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsl.json"), "{}\n");
    const f = join(dir, `${name}.ts`);
    writeFileSync(f, text);
    const c = checkFile(f);
    if (c.typed === null) {
      out.errors.push(`${name}: ${JSON.stringify(c.diags).slice(0, 300)}`);
      return;
    }
    const o = compileTyped(c.typed);
    const built = buildTslImage(o.tir, o.meta as never, [{ fn: "f", args: [1] }] as never);
    out.sizes.push({
      name,
      imageBytes: built.bytes.length,
      funcs: o.tir.funcs.length,
      hash: o.tirHash,
    });
  };
  const core = `import { u32, toU32 } from "@tsl/core";`;
  sample(
    "no_std",
    `${core}\nclass A { x: u32 = 1; }\nexport function f(a: u32): u32 { const o = new A(); return o.x + toU32(a); }\n`,
  );
  sample(
    "alloc_vec",
    `import { Heap, Vec } from "@tsl/alloc";\nimport type { u64, usize } from "@tsl/core";\n${core}\nfunction none(_n: usize): u64 { return 0n; }\nconst h = new Heap(none);\nexport function f(a: u32): u32 { using v = new Vec(u32, h); v.push(a); return toU32(v.length); }\n`,
  );
  sample(
    "std_vec",
    `import { Vec } from "@tsl/std";\n${core}\nexport function f(a: u32): u32 { using v = new Vec(u32); v.push(a); return toU32(v.length); }\n`,
  );
  sample(
    "std_map",
    `import { ExactMap } from "@tsl/std";\n${core}\nexport function f(a: u32): u32 { using m = new ExactMap(u32, u32); m.set(a, a); return m.get(a); }\n`,
  );
  sample(
    "std_str",
    `import { Str } from "@tsl/std";\nimport { lit } from "@tsl/core";\n${core}\nexport function f(a: u32): u32 { const s = Str.of(lit("abc")); const r = toU32(s.length) + a; s.free(); return r; }\n`,
  );
  sample(
    "std_all",
    `import { ExactMap, Set, Slab, Str, StrBuilder, Vec, ref } from "@tsl/std";\nimport { lit } from "@tsl/core";\n${core}\nclass N { v: u32 = 1; }\nconst ns = new Slab<N>();\nexport function f(a: u32): u32 { using v = new Vec(ref<N>()); v.push(ns.add(new N())); using s = new Set(u32); s.add(a); using m = new ExactMap(ref<Str>(), u32); const k = Str.of(lit("a b")); m.set(k, a); using b = new StrBuilder(); b.append(k); b.appendU32(a); const d = b.finish(); using parts = new Vec(ref<Str>()); d.split(32, parts); v.sortInPlace(() => 0); return toU32(parts.length) + m.get(k); }\n`,
  );
  out.host.loadEnd = loadavg();
  return out;
}

export function stdText(r: StdBench): string {
  if (r.skipped !== null) return `SKIP ${r.skipped}`;
  const fmt = (x: number | null, base: number | null, name: string): string => {
    if (x === null) return `${name} -`;
    if (base === null || x === base) return `${name} ${x.toFixed(3)} ms`;
    return `${name} ${x.toFixed(3)} ms (std is ${(base / x).toFixed(2)}x)`;
  };
  const lines = [
    `host: ${r.host.cpus} CPUs, load start ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")}, end ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")}`,
    `${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}, under HVF; on V8 with simulated memory it's scaled from a smaller run where the row's n is above 20,000`,
  ];
  for (const x of r.rows) {
    lines.push(
      `${x.fn.padEnd(12)} ${fmt(x.std, null, "std")}; ${fmt(x.alloc, x.std, "alloc")}; ${fmt(x.rc, x.std, "rc")}; ${fmt(x.v8, x.std, "V8")}; ${fmt(x.c, x.std, "C")}; ${fmt(x.stdOnV8, x.std, "std on V8")}  [${x.what}]`,
    );
  }
  for (const s of r.sizes)
    lines.push(
      `size ${s.name.padEnd(10)} ${String(s.imageBytes).padStart(8)} bytes, ${s.funcs} functions, tirhash ${s.hash.slice(0, 12)}`,
    );
  for (const e of r.errors) lines.push(`ERROR ${e.slice(0, 400)}`);
  return lines.join("\n");
}
