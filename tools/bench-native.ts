// `tmk bench native` (SPEC 8.4, M5, gate G2): native under HVF against V8 and Wasm for JPEG, native
// against clang -O2 for the M5 set, and cold start. Native times come from CNTVCT_EL0 in the guest,
// never PMCCNTR (SPEC 5.10). Each configuration runs in fresh processes, warm-up discarded, median of
// at least 101, over 5 processes. Performance runs are HVF only (SPEC 8.2).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { buildImage, type ImageOutput } from "../compiler/backend-aarch64/image.ts";
import { checkFile, compileTyped } from "./lowering.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import { WORKLOADS, type Workload } from "../bench/native/workloads.ts";
import { benchJpeg, buildJpeg, FIXTURES, makeLarge, PINNED, VENDOR } from "./bench-jpeg.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { Driver } from "./native-driver.ts";
import { callJpeg, JPEG_MEMORY, JPEG_RAM, lowerJpeg } from "./native-jpeg.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

const OUT = buildPath("bench/native");
const LLVM = "/opt/homebrew/opt/llvm/bin";
const LLD = "/opt/homebrew/opt/lld@22/bin/ld.lld";
const HOOK = join(ROOT, "tools/ts-hook.mjs");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function spread(xs: number[]): { median: number; low: number; high: number } {
  return { median: median(xs), low: Math.min(...xs), high: Math.max(...xs) };
}

// --- JPEG images

export interface Fix {
  name: string;
  path: string;
  warm: number;
  iter: number;
}

export function buildJpegBench(fixtures: Fix[]): ImageOutput {
  const { m, meta } = lowerJpeg();
  const drv = new Driver(m);
  const maxIter = Math.max(...fixtures.map((f) => f.iter));
  drv.globals.push({ name: "__ticks", size: maxIter * 8, align: 8, section: "data" });
  const funcs: string[] = [];
  fixtures.forEach((fx, i) => {
    const bytes = new Uint8Array(readFileSync(fx.path));
    const blob = drv.blob(bytes);
    const b = new FuncBuilder(`__bench_${i}`, [], []);
    const decodeOnce = (): void => {
      b.call("__arena_reset", []);
      callJpeg(drv, b, "decodeJpeg", [b.global(blob), b.ix(bytes.length), b.iconst("ptr", 0)]);
    };
    const loop = (n: number, body: (idx: number) => void): void => {
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
    };
    loop(fx.warm, () => {
      decodeOnce();
    });
    const ticks = b.global("__ticks");
    loop(fx.iter, (idx) => {
      b.call("__arena_reset", []);
      const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      callJpeg(drv, b, "decodeJpeg", [b.global(blob), b.ix(bytes.length), b.iconst("ptr", 0)]);
      const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      const at = b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, 0);
      b.store("i64", at, b.op("sub.i64", [t1, t0], "i64"));
    });
    drv.puts(b, `TMK:B ${fx.name}`);
    loop(fx.iter, (idx) => {
      b.call("__rt_sp", []);
      const at = b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, 0);
      b.call("__rt_dec", [b.load("i64", at)]);
    });
    b.call("__rt_nl", []);
    b.ret();
    drv.funcs.push(b.finish());
    funcs.push(`__bench_${i}`);
  });
  const nop = new FuncBuilder("__after", [], []);
  nop.ret();
  drv.funcs.push(nop.finish());
  drv.arenaUse();
  const main = new FuncBuilder("__tmk_main", [], []);
  main.call("__arena_use", [
    main.load("ptr", main.global("__mem_base")),
    main.load("ptr", main.global("__mem_limit")),
  ]);
  main.call("__init", []);
  main.call("__arena_use", [
    main.load("ptr", main.global("__arena_top")),
    main.load("ptr", main.global("__mem_limit")),
  ]);
  drv.puts(main, "TMK:F ");
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  for (const f of funcs) main.call(f, []);
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(meta.strings);
  return buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: JPEG_RAM,
  });
}

/** First decode with nothing warm: QEMU start to this line is the cold-start number. */
function buildJpegCold(path: string): ImageOutput {
  const { m, meta } = lowerJpeg();
  const drv = new Driver(m);
  const bytes = new Uint8Array(readFileSync(path));
  const blob = drv.blob(bytes);
  const main = new FuncBuilder("__tmk_main", [], []);
  const t00 = main.intrinsic("native.counter", [], ["i64"])[0]!;
  main.call("__arena_use", [
    main.load("ptr", main.global("__mem_base")),
    main.load("ptr", main.global("__mem_limit")),
  ]);
  main.call("__init", []);
  main.call("__arena_use", [
    main.load("ptr", main.global("__arena_top")),
    main.load("ptr", main.global("__mem_limit")),
  ]);
  const t0 = main.intrinsic("native.counter", [], ["i64"])[0]!;
  main.call(
    "decodeJpeg",
    [main.global(blob), main.ix(bytes.length), main.iconst("ptr", 0)],
    ["ptr"],
  );
  const t1 = main.intrinsic("native.counter", [], ["i64"])[0]!;
  drv.puts(main, "TMK:COLD ");
  main.call("__rt_dec", [main.op("sub.i64", [t1, t0], "i64")]);
  main.call("__rt_sp", []);
  main.call("__rt_dec", [main.op("sub.i64", [t0, t00], "i64")]);
  main.call("__rt_sp", []);
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  main.ret();
  drv.funcs.push(main.finish());
  drv.arenaUse();
  drv.trapMessages(meta.strings);
  return buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: JPEG_RAM,
  });
}

// --- the M5 set

function buildCBlob(): Uint8Array | null {
  const clang = join(LLVM, "clang");
  if (!existsSync(clang) || !existsSync(LLD)) return null;
  mkdirSync(OUT, { recursive: true });
  const obj = join(OUT, "bench.o");
  const elf = join(OUT, "bench.elf");
  const bin = join(OUT, "bench.bin");
  execFileSync(
    clang,
    [
      "--target=aarch64-none-elf",
      "-O2",
      "-ffreestanding",
      "-fno-stack-protector",
      "-fno-exceptions",
      "-fno-asynchronous-unwind-tables",
      // JS has no fused multiply: without this, clang's default gives different results from the TSL.
      "-ffp-contract=off",
      "-c",
      join(ROOT, "bench/native/bench.c"),
      "-o",
      obj,
    ],
    { timeout: 60_000 },
  );
  execFileSync(LLD, ["-T", join(ROOT, "bench/native/link.ld"), "-o", elf, obj], {
    timeout: 60_000,
  });
  execFileSync(join(LLVM, "llvm-objcopy"), ["-O", "binary", elf, bin], { timeout: 60_000 });
  return new Uint8Array(readFileSync(bin));
}

function clangVersion(): string {
  const r = spawnSync(join(LLVM, "clang"), ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.stdout?.split("\n")[0] ?? "?";
}

interface MicroCompiled {
  tirPath: string;
  glue: string;
  wasm: string;
  image: ImageOutput;
}

function buildMicro(
  w: Workload,
  warm: number,
  iter: number,
  cBlob: Uint8Array | null,
): MicroCompiled {
  const source = join(ROOT, "corpus/pos", `${w.program}.ts`);
  const { typed, diags } = checkFile(source);
  if (typed === null) throw new Error(`${w.program}: ${JSON.stringify(diags)}`);
  const o = compileTyped(typed);
  const base = join(OUT, w.name);
  writeFileSync(`${base}.wasm`, o.wasm);
  writeFileSync(`${base}.glue.mjs`, o.glue);
  writeFileSync(`${base}.tir`, o.tirText);
  const drv = new Driver(o.tir);
  const args = w.args();
  drv.globals.push({ name: "__ticks", size: iter * 8 * 2, align: 8, section: "data" });
  // Each array argument: a pristine copy in the image, and the working copy the call may overwrite.
  const blobs = new Map<number, { blob: string; bytes: number }>();
  args.forEach((a, i) => {
    if (typeof a === "number") return;
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    blobs.set(i, { blob: drv.blob(bytes), bytes: bytes.length });
  });
  const sig = drv.sigOf(w.fn);
  // A: lay out the working arrays from the arena start.
  const offs = new Map<number, number>();
  let top = 0;
  for (const [i, b] of blobs) {
    offs.set(i, top);
    top += Math.ceil(b.bytes / 64) * 64;
  }
  const emit = (which: "tsl" | "c", phase: number): string => {
    const name = `__run_${which}`;
    const b = new FuncBuilder(name, [], []);
    const base0 = b.load("ptr", b.global("__mem_base"));
    const addr = (i: number): number => b.at0(base0, offs.get(i)!);
    const restoreAll = (only: number[]): void => {
      for (const i of only) {
        const bb = blobs.get(i)!;
        b.intrinsic("mem.copy", [addr(i), b.global(bb.blob), b.ix(bb.bytes)]);
      }
    };
    restoreAll([...blobs.keys()]);
    const call = (): number[] => {
      if (which === "tsl") {
        const vals: number[] = [];
        let p = 0;
        args.forEach((a, i) => {
          if (typeof a === "number") {
            vals.push(drv.leafConst(b, sig.params[p]!, a));
            p++;
          } else {
            vals.push(addr(i), b.ix(a.length));
            p += 2;
          }
        });
        return b.call(w.fn, vals, sig.rets);
      }
      // c_bench(which, p0, n0, p1, n1, x), by the AAPCS, which the internal convention follows here.
      const ptr = (i: number): number => b.op("bitcast.i64", [addr(i)], "i64");
      let c: number[];
      switch (w.cIndex) {
        case 0:
          c = [ptr(0), b.i64((args[0] as Uint8Array).length), ptr(1), b.i64(32), b.i64(0)];
          break;
        case 1:
          c = [
            ptr(0),
            b.i64((args[0] as Uint8Array).length),
            b.i64(0),
            b.i64(0),
            b.i64(args[1] as number),
          ];
          break;
        case 2:
          c = [ptr(0), b.i64((args[0] as Int32Array).length), b.i64(0), b.i64(0), b.i64(0)];
          break;
        case 3:
          c = [
            b.i64(args[0] as number),
            b.i64(args[1] as number),
            b.i64(args[2] as number),
            b.i64(0),
            b.i64(0),
          ];
          break;
        case 4:
          c = [ptr(0), b.i64(0), ptr(1), ptr(2), b.i64(args[3] as number)];
          break;
        default:
          c = [ptr(0), b.i64((args[0] as Uint8Array).length), b.i64(0), b.i64(0), b.i64(0)];
          break;
      }
      const target = b.global("__c_blob");
      return b.raw(
        "call.indirect",
        [
          { t: "sig", id: o.tir.sigs.length },
          { t: "v", id: target },
          { t: "v", id: b.i64(w.cIndex) },
          ...c.map((id) => ({ t: "v" as const, id })),
        ],
        ["i64"],
      );
    };
    const loop = (n: number, body: (idx: number) => void): void => {
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
    };
    const lastRet = b.global("__last");
    loop(warm, () => {
      restoreAll(w.restore);
      call();
    });
    const ticks = b.global("__ticks");
    loop(iter, (idx) => {
      restoreAll(w.restore);
      const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      const r = call();
      const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      b.store(
        "i64",
        b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, phase * iter * 8),
        b.op("sub.i64", [t1, t0], "i64"),
      );
      if (r.length > 0) {
        const v = r[0]!;
        const t = which === "c" ? "i64" : sig.rets[0]!;
        const asI64 = t === "i32" ? b.op("zext.i64", [v], "i64") : t === "i64" ? v : b.i64(0);
        b.store("i64", lastRet, asI64);
      } else b.store("i64", lastRet, b.i64(0));
    });
    drv.puts(b, `TMK:B ${which}`);
    loop(iter, (idx) => {
      b.call("__rt_sp", []);
      b.call("__rt_dec", [
        b.load("i64", b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, phase * iter * 8)),
      ]);
    });
    b.call("__rt_nl", []);
    // What it computed, so an optimiser can't have skipped it, and the configurations can be compared.
    drv.puts(b, `TMK:R ${which} `);
    b.call("__rt_hex64", [b.load("i64", lastRet)]);
    args.forEach((a, i) => {
      if (typeof a === "number") return;
      b.call("__rt_sp", []);
      b.call("__rt_sha256", [addr(i), b.ix(a.byteLength)]);
      b.call("__rt_sha_print", []);
    });
    b.call("__rt_nl", []);
    b.ret();
    drv.funcs.push(b.finish());
    return name;
  };
  drv.globals.push({ name: "__last", size: 8, align: 8, section: "data" });
  const runs = [emit("tsl", 0)];
  if (cBlob !== null) {
    drv.globals.push({
      name: "__c_blob",
      size: cBlob.length,
      align: 4096,
      section: "data",
      bytes: cBlob,
    });
    runs.push(emit("c", 1));
  }
  const main = new FuncBuilder("__tmk_main", [], []);
  drv.puts(main, "TMK:F ");
  main.call("__rt_dec", [main.intrinsic("native.frequency", [], ["i64"])[0]!]);
  main.call("__rt_nl", []);
  for (const r of runs) main.call(r, []);
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(o.meta.strings);
  const extraSigs = [
    { params: ["i64", "i64", "i64", "i64", "i64", "i64"] as const, rets: ["i64"] as const },
  ];
  const image = buildImage({
    module: o.tir,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    extraSigs: extraSigs as never,
    ramBytes: 256 * 1024 * 1024,
  });
  return { tirPath: `${base}.tir`, glue: `${base}.glue.mjs`, wasm: `${base}.wasm`, image };
}

export interface NativeBench {
  host: {
    loadStart: number[];
    loadEnd: number[];
    cpus: number;
    git: string;
    node: string;
    clang: string;
    warning: string | null;
  };
  skipped: string | null;
  params: { warm: number; iter: number; processes: number };
  jpeg: Record<
    string,
    {
      native: ReturnType<typeof spread> | null;
      v8: number | null;
      wasm: number | null;
      wasmOpt: number | null;
      jsc: number | null;
    }
  >;
  jpegRatio: { v8Geomean: number; wasmGeomean: number; worstV8: number };
  large: { native: number | null; v8: number | null; wasm: number | null } | null;
  cold: {
    qemuToDecodeMs: ReturnType<typeof spread>;
    guestDecodeMs: ReturnType<typeof spread>;
    firstOutputMs: ReturnType<typeof spread> | null;
    v8FirstDecodeMs: number | null;
    wasmFirstDecodeMs: number | null;
    wasmOptFirstDecodeMs: number | null;
    v8ProcessMs: ReturnType<typeof spread> | null;
    wasmProcessMs: ReturnType<typeof spread> | null;
  } | null;
  micro: Record<
    string,
    {
      native: number;
      c: number | null;
      v8: number | null;
      wasm: number | null;
      ratioC: number | null;
      agree: string | null;
    }
  >;
  s4: { median: number | null; verdict: string; ratios: Record<string, number> };
  sizes: {
    jpegCodeBytes: number;
    jpegFileBytes: number;
    jpegDataBytes: number;
    microCodeBytes: Record<string, number>;
  };
  errors: string[];
}

export async function benchNative(
  opts: { quick?: boolean; label?: string } = {},
): Promise<NativeBench> {
  mkdirSync(OUT, { recursive: true });
  const quick = opts.quick === true;
  const processes = quick ? 2 : 5;
  const warm = quick ? 20 : 200;
  const iter = quick ? 21 : 101;
  const errors: string[] = [];
  const load0 = loadavg();
  const hvf = hvfAvailable();
  const names = Object.keys(PINNED);
  let git = "no commits yet";
  try {
    git = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: ROOT,
    }).trim();
  } catch {
    // This repo has no commits yet, and that's reported as it is.
  }
  const out: NativeBench = {
    host: {
      loadStart: load0,
      loadEnd: [],
      cpus: cpus().length,
      git,
      node: process.version,
      clang: clangVersion(),
      warning: null,
    },
    skipped: hvf.ok ? null : `HVF unavailable: ${hvf.why}. Performance tests are HVF only.`,
    params: { warm, iter, processes },
    jpeg: {},
    jpegRatio: { v8Geomean: 0, wasmGeomean: 0, worstV8: 0 },
    large: null,
    cold: null,
    micro: {},
    s4: { median: null, verdict: "not measured", ratios: {} },
    sizes: { jpegCodeBytes: 0, jpegFileBytes: 0, jpegDataBytes: 0, microCodeBytes: {} },
    errors,
  };
  if (!hvf.ok) return out;

  // JPEG, native.
  const fixtures: Fix[] = names.map((name) => ({ name, path: join(FIXTURES, name), warm, iter }));
  const jpegImage = buildJpegBench(fixtures);
  out.sizes.jpegCodeBytes = jpegImage.codeBytes;
  out.sizes.jpegFileBytes = jpegImage.bytes.length;
  out.sizes.jpegDataBytes = jpegImage.dataBytes;
  const ticks: Record<string, number[]> = {};
  for (let p = 0; p < processes; p++) {
    const r = await qemuRun({
      name: `bench/jpeg-${p}`,
      image: jpegImage.bytes,
      accel: "hvf",
      memory: JPEG_MEMORY,
      timeoutMs: 180_000,
    });
    if (!r.ok) {
      errors.push(`native JPEG #${p}: ${r.status} ${r.why.slice(0, 600)}`);
      continue;
    }
    const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
    for (const l of r.lines) {
      if (!l.startsWith("TMK:B ")) continue;
      const parts = l.split(" ");
      const ms = parts.slice(2).map((x) => (Number(x) / freq) * 1000);
      (ticks[parts[1]!] ??= []).push(median(ms));
    }
  }

  // JPEG, V8 and Wasm, by the M2 bench with the same counts.
  const j = await benchJpeg({ quick });
  for (const n of names) {
    const row = j.fixtures[n] ?? {};
    out.jpeg[n] = {
      native: ticks[n] !== undefined ? spread(ticks[n]!) : null,
      v8: row.v8?.median ?? null,
      wasm: row["wasm-v8"]?.median ?? null,
      wasmOpt: row["wasm-opt-v8"]?.median ?? null,
      jsc: row.jsc?.median ?? null,
    };
  }
  errors.push(...j.errors);
  let lv = 0;
  let lw = 0;
  let worst = 0;
  let count = 0;
  for (const n of names) {
    const x = out.jpeg[n]!;
    if (x.native === null || x.v8 === null || x.wasm === null) continue;
    lv += Math.log(x.native.median / x.v8);
    lw += Math.log(x.native.median / x.wasm);
    worst = Math.max(worst, x.native.median / x.v8);
    count++;
  }
  if (count > 0)
    out.jpegRatio = {
      v8Geomean: Math.exp(lv / count),
      wasmGeomean: Math.exp(lw / count),
      worstV8: worst,
    };

  // The large fixture, with counts M2 also reduced for it.
  const large = makeLarge();
  if (large !== null && !quick) {
    const lw2 = 10;
    const li2 = 21;
    const img = buildJpegBench([{ name: "large", path: large, warm: lw2, iter: li2 }]);
    const r = await qemuRun({
      name: "bench/jpeg-large",
      image: img.bytes,
      accel: "hvf",
      memory: JPEG_MEMORY,
      timeoutMs: 180_000,
    });
    if (r.ok) {
      const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
      const parts = r.lines.find((l) => l.startsWith("TMK:B "))!.split(" ");
      out.large = {
        native: median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)),
        v8: j.large?.v8?.median ?? null,
        wasm: j.large?.["wasm-v8"]?.median ?? null,
      };
    } else errors.push(`native large: ${r.status} ${r.why.slice(0, 400)}`);
  }

  // Cold start: QEMU start to first decode done, against the first decode on V8 and Wasm.
  const coldImage = buildJpegCold(join(FIXTURES, "tower-portrait.jpg"));
  const coldWall: number[] = [];
  const coldGuest: number[] = [];
  const firstOut: number[] = [];
  for (let p = 0; p < 7; p++) {
    const r = await qemuRun({
      name: `bench/jpeg-cold-${p}`,
      image: coldImage.bytes,
      accel: "hvf",
      memory: JPEG_MEMORY,
      timeoutMs: 30_000,
      marks: ["TMK:COLD"],
    });
    if (!r.ok) {
      errors.push(`native cold #${p}: ${r.status} ${r.why.slice(0, 400)}`);
      continue;
    }
    coldWall.push(r.markMs["TMK:COLD"]!);
    if (r.firstOutputMs !== null) firstOut.push(r.firstOutputMs);
    const parts = r.lines.find((l) => l.startsWith("TMK:COLD"))!.split(" ");
    coldGuest.push((Number(parts[1]) / Number(parts[3])) * 1000);
  }
  // The same fixture in a whole fresh Node process, spawn to exit, for a like-for-like wall figure.
  const b = buildJpeg();
  const runTs = join(ROOT, "bench/jpeg/run.ts");
  const first = [
    { name: "tower-portrait.jpg", path: join(FIXTURES, "tower-portrait.jpg"), warm: 0, iter: 0 },
  ];
  const wallOf = async (nodeArgs: string[], job: object): Promise<number[]> => {
    const ms: number[] = [];
    for (let p = 0; p < 5; p++) {
      const r = await guardedRun(
        process.execPath,
        [...nodeArgs, runTs, JSON.stringify({ ...job, fixtures: first, coldOnly: true })],
        {
          timeoutMs: 60_000,
          label: "cold process",
          cwd: ROOT,
        },
      );
      if (r.ok) ms.push(r.ms);
    }
    return ms;
  };
  const v8Wall = await wallOf(["--import", HOOK, "--no-warnings"], { source: VENDOR });
  const wasmWall = await wallOf(["--no-warnings"], { source: VENDOR, glue: b.glue, wasm: b.wasm });
  if (coldWall.length > 0) {
    out.cold = {
      qemuToDecodeMs: spread(coldWall),
      guestDecodeMs: spread(coldGuest),
      firstOutputMs: firstOut.length > 0 ? spread(firstOut) : null,
      v8FirstDecodeMs: j.cold.v8?.median ?? null,
      wasmFirstDecodeMs: j.cold["wasm-v8"]?.median ?? null,
      wasmOptFirstDecodeMs: j.cold["wasm-opt-v8"]?.median ?? null,
      v8ProcessMs: v8Wall.length > 0 ? spread(v8Wall) : null,
      wasmProcessMs: wasmWall.length > 0 ? spread(wasmWall) : null,
    };
  }

  // The M5 set.
  const cBlob = buildCBlob();
  if (cBlob === null) errors.push("no clang or ld.lld: nothing to measure S4 against");
  for (const w of WORKLOADS) {
    const built = buildMicro(w, warm, iter, cBlob);
    out.sizes.microCodeBytes[w.name] = built.image.codeBytes;
    const nat: number[] = [];
    const cs: number[] = [];
    let natResult = "";
    let cResult = "";
    for (let p = 0; p < processes; p++) {
      const r = await qemuRun({
        name: `bench/${w.name}-${p}`,
        image: built.image.bytes,
        accel: "hvf",
        timeoutMs: 120_000,
      });
      if (!r.ok) {
        errors.push(`${w.name} #${p}: ${r.status} ${r.why.slice(0, 500)}`);
        continue;
      }
      const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
      for (const l of r.lines) {
        const parts = l.split(" ");
        if (parts[0] === "TMK:B") {
          const ms = median(parts.slice(2).map((x) => (Number(x) / freq) * 1000));
          (parts[1] === "tsl" ? nat : cs).push(ms);
        }
        if (parts[0] === "TMK:R") {
          if (parts[1] === "tsl") natResult = parts.slice(2).join(" ");
          else cResult = parts.slice(2).join(" ");
        }
      }
    }
    const jsMs = async (
      nodeArgs: string[],
      job: object,
    ): Promise<{ ms: number[]; digest: string }> => {
      const ms: number[] = [];
      let digest = "";
      for (let p = 0; p < processes; p++) {
        const r = await guardedRun(
          process.execPath,
          [
            ...nodeArgs,
            join(ROOT, "bench/native/micro.ts"),
            JSON.stringify({ ...job, warm, iter }),
          ],
          {
            timeoutMs: 120_000,
            label: `${w.name} js #${p}`,
            cwd: ROOT,
          },
        );
        if (!r.ok) {
          errors.push(`${w.name} js: ${r.why} ${r.stderr.slice(0, 300)}`);
          continue;
        }
        const o = JSON.parse(r.stdout) as { median: number; digest: string };
        ms.push(o.median);
        digest = o.digest;
      }
      return { ms, digest };
    };
    const source = join(ROOT, "corpus/pos", `${w.program}.ts`);
    const v8 = await jsMs(["--import", HOOK, "--no-warnings"], { name: w.name, source });
    const wasm = await jsMs(["--no-warnings"], {
      name: w.name,
      source,
      glue: built.glue,
      wasm: built.wasm,
    });
    if (natResult !== cResult && cBlob !== null)
      errors.push(`${w.name}: native and C computed different results: ${natResult} / ${cResult}`);
    const nm = nat.length > 0 ? median(nat) : Number.NaN;
    const cm = cs.length > 0 ? median(cs) : null;
    out.micro[w.name] = {
      native: nm,
      c: cm,
      v8: v8.ms.length > 0 ? median(v8.ms) : null,
      wasm: wasm.ms.length > 0 ? median(wasm.ms) : null,
      ratioC: cm !== null ? nm / cm : null,
      agree: natResult,
    };
  }
  const ratios: Record<string, number> = {};
  for (const [k, v] of Object.entries(out.micro)) if (v.ratioC !== null) ratios[k] = v.ratioC;
  const list = Object.values(ratios);
  if (list.length > 0) {
    const s = [...list].sort((a, b) => a - b);
    const med =
      s.length % 2 === 1 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
    out.s4 = {
      median: med,
      ratios,
      verdict:
        med <= 2
          ? "<= 2x: proceed"
          : med <= 4
            ? "2x to 4x: one optimisation pass, then proceed and record"
            : "> 4x: stop and report; the spec's response is a re-plan",
    };
  }
  const end = loadavg();
  out.host.loadEnd = end;
  const peak = Math.max(load0[0]!, end[0]!);
  out.host.warning =
    peak > cpus().length * 0.5
      ? `load ${peak.toFixed(1)} on ${cpus().length} CPUs: these numbers are rough`
      : null;
  writeFileSync(
    join(OUT, `result${opts.label !== undefined ? `-${opts.label}` : ""}.json`),
    JSON.stringify(out, null, 2),
  );
  return out;
}

export function nativeText(r: NativeBench): string {
  const f = (x: number | null | undefined, d = 3): string =>
    x === null || x === undefined ? "-" : x.toFixed(d);
  const lines: string[] = [];
  if (r.skipped !== null) return `SKIP ${r.skipped}`;
  lines.push(
    `host: ${r.host.node}, ${r.host.clang}, git ${r.host.git}, ${r.host.cpus} CPUs, load start ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")}, end ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")}`,
  );
  if (r.host.warning !== null) lines.push(`WARNING: ${r.host.warning}`);
  lines.push(
    `${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}; native by CNTVCT_EL0 under HVF; ms`,
  );
  for (const [n, x] of Object.entries(r.jpeg)) {
    lines.push(
      `${n.padEnd(20)} native ${f(x.native?.median)} [${f(x.native?.low)}..${f(x.native?.high)}]  V8 ${f(x.v8)}  Wasm ${f(x.wasm)}  wasm-opt ${f(x.wasmOpt)}  JSC ${f(x.jsc)}  native/V8 ${x.native !== null && x.v8 !== null ? (x.native.median / x.v8).toFixed(3) : "-"}x`,
    );
  }
  lines.push(
    `JPEG native against V8: geomean ${r.jpegRatio.v8Geomean.toFixed(3)}x, worst ${r.jpegRatio.worstV8.toFixed(3)}x; against Wasm: ${r.jpegRatio.wasmGeomean.toFixed(3)}x`,
  );
  if (r.large !== null)
    lines.push(
      `4000x3000 (reduced counts, as M2): native ${f(r.large.native, 1)} V8 ${f(r.large.v8, 1)} Wasm ${f(r.large.wasm, 1)}`,
    );
  if (r.cold !== null) {
    lines.push(
      `cold start, tower-portrait: QEMU start to first decode done ${f(r.cold.qemuToDecodeMs.median, 1)} ms [${f(r.cold.qemuToDecodeMs.low, 1)}..${f(r.cold.qemuToDecodeMs.high, 1)}], of which the decode ${f(r.cold.guestDecodeMs.median, 2)} ms in the guest`,
    );
    lines.push(
      `  first decode in-process: native ${f(r.cold.guestDecodeMs.median, 2)}, V8 ${f(r.cold.v8FirstDecodeMs, 2)}, Wasm ${f(r.cold.wasmFirstDecodeMs, 2)} (incl. compile), wasm-opt ${f(r.cold.wasmOptFirstDecodeMs, 2)}; whole fresh Node process to exit: V8 ${f(r.cold.v8ProcessMs?.median, 1)}, Wasm ${f(r.cold.wasmProcessMs?.median, 1)}`,
    );
  }
  lines.push("M5 set, median ms: native, clang -O2, V8, Wasm, native/clang");
  for (const [n, x] of Object.entries(r.micro)) {
    lines.push(
      `${n.padEnd(14)} ${f(x.native).padStart(9)} ${f(x.c).padStart(9)} ${f(x.v8).padStart(9)} ${f(x.wasm).padStart(9)}  ${f(x.ratioC, 2)}x`,
    );
  }
  lines.push(`S4/G2: median native/clang ${f(r.s4.median, 3)}x: ${r.s4.verdict}`);
  lines.push(
    `sizes: JPEG image ${r.sizes.jpegFileBytes} bytes in the file, ${r.sizes.jpegCodeBytes} code; M5 images, code: ${Object.entries(
      r.sizes.microCodeBytes,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}
