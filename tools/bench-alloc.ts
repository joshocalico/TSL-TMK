// `tmk bench alloc`: Vec.push, Slab.add and remove, and field access through a stored reference, natively under
// HVF, against hand-written C in the same image and timing loop, as `tmk bench native` does it. The check's own
// cost comes from the same TIR with every gen.chk replaced by the plain mask. No gate is defined: numbers only.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { buildImage, type ImageOutput } from "../compiler/backend-aarch64/image.ts";
import { checkFile, compileTyped } from "./lowering.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { ROOT } from "./corpus.ts";
import { Driver } from "./native-driver.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

const OUT = buildPath("bench/alloc");
const LLVM = "/opt/homebrew/opt/llvm/bin";
const LLD = "/opt/homebrew/opt/lld@22/bin/ld.lld";
const POOL_FOR_C = 0; // from the arena start

export interface Work {
  name: string;
  fn: string;
  args: number[];
  which: number;
  cArgs: number[]; // n0, p1
  ops: number; // the operations one run performs, for per-op numbers
  what: string;
  // After each call, untimed, the call arena rewound as a native caller rewinds it between export calls (4.5): for work
  // whose temporaries the direct route puts in the arena, which 121 calls would otherwise run out of (strkeys' maps).
  arenaReset?: boolean;
}

const WORK: Work[] = [
  {
    name: "vec_push",
    fn: "vecPush",
    args: [100000],
    which: 0,
    cArgs: [100000, 0],
    ops: 100000,
    what: "Vec.push, from empty, through growth",
  },
  {
    name: "slab_add_remove",
    fn: "slabCycle",
    args: [40, 2000],
    which: 1,
    cArgs: [40, 2000],
    ops: 160000,
    what: "Slab.add or remove, with a reference array",
  },
  {
    name: "stored_ref_walk",
    fn: "walkList",
    args: [4096, 40],
    which: 2,
    cArgs: [4096, 40],
    ops: 163840,
    what: "a list step: load a reference, check it, read a field",
  },
];

export function buildC(
  source = join(ROOT, "bench/alloc/alloc.c"),
  OUT_DIR = OUT,
): Uint8Array | null {
  const clang = join(LLVM, "clang");
  if (!existsSync(clang) || !existsSync(LLD)) return null;
  mkdirSync(OUT_DIR, { recursive: true });
  const obj = join(OUT_DIR, "alloc.o");
  const elf = join(OUT_DIR, "alloc.elf");
  const bin = join(OUT_DIR, "alloc.bin");
  execFileSync(
    clang,
    [
      "--target=aarch64-none-elf",
      "-O2",
      "-ffreestanding",
      "-fno-stack-protector",
      "-fno-exceptions",
      "-fno-asynchronous-unwind-tables",
      "-ffp-contract=off",
      "-c",
      source,
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

/** The same program with its generation checks taken out: what they cost, and nothing else. */
function withoutChecks(m: Module): Module {
  return {
    ...m,
    funcs: m.funcs.map((f) => ({
      ...f,
      blocks: f.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((ins) =>
          ins.op === "gen.chk"
            ? { ...ins, op: "ref.addr", ops: ins.ops.filter((o) => o.t === "v") }
            : ins,
        ),
      })),
    })),
  };
}

export function buildImageFor(...a: Parameters<typeof buildImageOutFor>): Uint8Array {
  return buildImageOutFor(...a).bytes;
}

/** buildImageFor's image with its function ranges and symbols, for `tmk profile`. */
export function buildImageOutFor(
  m: Module,
  w: Work,
  warm: number,
  iter: number,
  cBlob: Uint8Array | null,
  strings: Record<string, number>,
  setup?: (main: FuncBuilder, drv: Driver) => void,
  ramBytes = 256 * 1024 * 1024,
): ImageOutput {
  const drv = new Driver(m);
  drv.globals.push({ name: "__ticks", size: iter * 8 * 2, align: 8, section: "data" });
  drv.globals.push({ name: "__last", size: 8, align: 8, section: "data" });
  const sig = drv.sigOf(w.fn);
  const emit = (which: "tsl" | "c", phase: number): string => {
    const name = `__run_${which}`;
    const b = new FuncBuilder(name, [], []);
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
    const call = (): number => {
      if (which === "tsl") {
        const r = b.call(
          w.fn,
          w.args.map((a, i) => drv.leafConst(b, sig.params[i]!, a)),
          sig.rets,
        );
        const t = sig.rets[0]!;
        // A result that isn't proved to fit an i32 is an f64 (SPEC 4.5): its low 32 bits, as JS's `| 0` gives them.
        if (t === "f64") return b.op("zext.i64", [b.op("js.toint32", [r[0]!], "i32")], "i64");
        return t === "i32" ? b.op("zext.i64", [r[0]!], "i64") : r[0]!;
      }
      const base = b.load("ptr", b.global("__mem_base"));
      const pool = b.op("bitcast.i64", [b.at0(base, POOL_FOR_C)], "i64");
      const code = b.global("__c_blob");
      const args = [
        b.i64(w.which),
        pool,
        b.i64(w.cArgs[0]!),
        b.i64(w.cArgs[1]!),
        b.i64(0),
        b.i64(0),
      ];
      return b.raw(
        "call.indirect",
        [
          { t: "sig", id: m.sigs.length },
          { t: "v", id: code },
          ...args.map((id) => ({ t: "v" as const, id })),
        ],
        ["i64"],
      )[0]!;
    };
    const reset = (): void => {
      if (w.arenaReset === true) b.call("__arena_reset", []);
    };
    loop(warm, () => {
      call();
      reset();
    });
    const ticks = b.global("__ticks");
    const last = b.global("__last");
    loop(iter, (idx) => {
      const t0 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      const r = call();
      const t1 = b.intrinsic("native.counter", [], ["i64"])[0]!;
      b.store(
        "i64",
        b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, phase * iter * 8),
        b.op("sub.i64", [t1, t0], "i64"),
      );
      b.store("i64", last, r);
      reset();
    });
    drv.puts(b, `TMK:B ${which}`);
    loop(iter, (idx) => {
      b.call("__rt_sp", []);
      b.call("__rt_dec", [
        b.load("i64", b.gep(ticks, b.op("bitcast.ix", [idx], "ix"), 8, phase * iter * 8)),
      ]);
    });
    b.call("__rt_nl", []);
    drv.puts(b, `TMK:R ${which} `);
    b.call("__rt_hex64", [b.load("i64", last)]);
    b.call("__rt_nl", []);
    b.ret();
    drv.funcs.push(b.finish());
    return name;
  };
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
  setup?.(main, drv);
  for (const r of runs) main.call(r, []);
  main.ret();
  drv.funcs.push(main.finish());
  drv.trapMessages(strings);
  const extraSigs = [{ params: ["i64", "i64", "i64", "i64", "i64", "i64"], rets: ["i64"] }];
  return buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    extraSigs: extraSigs as never,
    ramBytes,
  });
}

export function median(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
}

export interface AllocBench {
  skipped: string | null;
  host: {
    loadStart: number[];
    loadEnd: number[];
    cpus: number;
    clang: string;
    warning: string | null;
  };
  params: { warm: number; iter: number; processes: number };
  rows: Record<
    string,
    {
      what: string;
      ops: number;
      nativeMs: number;
      noCheckMs: number | null;
      cMs: number | null;
      nsPerOp: number;
      cNsPerOp: number | null;
      ratioC: number | null;
      checkCost: number | null;
      agree: string;
    }
  >;
  errors: string[];
}

export async function benchAlloc(opts: { quick?: boolean }): Promise<AllocBench> {
  const processes = opts.quick === true ? 1 : 5;
  const warm = opts.quick === true ? 2 : 20;
  const iter = opts.quick === true ? 5 : 101;
  const clang = spawnSync(join(LLVM, "clang"), ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const out: AllocBench = {
    skipped: null,
    host: {
      loadStart: loadavg(),
      loadEnd: [],
      cpus: cpus().length,
      clang: clang.stdout?.split("\n")[0] ?? "?",
      warning: null,
    },
    params: { warm, iter, processes },
    rows: {},
    errors: [],
  };
  if (!hvfAvailable().ok) {
    out.skipped = "HVF is unavailable, and performance runs are HVF only (SPEC 8.2)";
    return out;
  }
  mkdirSync(OUT, { recursive: true });
  const { typed, diags } = checkFile(join(ROOT, "bench/alloc/alloc.ts"));
  if (typed === null) throw new Error(JSON.stringify(diags));
  const o = compileTyped(typed);
  const cBlob = buildC();
  if (cBlob === null) out.errors.push("no clang or ld.lld: no C to compare with");
  const runAll = async (
    image: Uint8Array,
    name: string,
  ): Promise<{ tsl: number[]; c: number[]; rt: string; rc: string }> => {
    const res = { tsl: [] as number[], c: [] as number[], rt: "", rc: "" };
    for (let p = 0; p < processes; p++) {
      const r = await qemuRun({
        name: `bench-alloc/${name}-${p}`,
        image,
        accel: "hvf",
        timeoutMs: 180_000,
      });
      if (!r.ok) {
        out.errors.push(`${name} #${p}: ${r.status} ${r.why.slice(0, 400)}`);
        continue;
      }
      const freq = Number(r.lines.find((l) => l.startsWith("TMK:F "))!.slice(6));
      for (const l of r.lines) {
        const parts = l.split(" ");
        if (parts[0] === "TMK:B") {
          (parts[1] === "tsl" ? res.tsl : res.c).push(
            median(parts.slice(2).map((x) => (Number(x) / freq) * 1000)),
          );
        }
        if (parts[0] === "TMK:R") {
          if (parts[1] === "tsl") res.rt = parts[2]!;
          else res.rc = parts[2]!;
        }
      }
    }
    return res;
  };
  for (const w of WORK) {
    const withC = await runAll(buildImageFor(o.tir, w, warm, iter, cBlob, o.meta.strings), w.name);
    const noChk = await runAll(
      buildImageFor(withoutChecks(o.tir), w, warm, iter, null, o.meta.strings),
      `${w.name}-nochk`,
    );
    if (withC.rt !== withC.rc && cBlob !== null) {
      out.errors.push(
        `${w.name}: native and C computed different results: ${withC.rt} / ${withC.rc}`,
      );
    }
    if (noChk.rt !== withC.rt)
      out.errors.push(`${w.name}: taking the checks out changed the result`);
    const nm = median(withC.tsl);
    const cm = withC.c.length > 0 ? median(withC.c) : null;
    const nc = noChk.tsl.length > 0 ? median(noChk.tsl) : null;
    out.rows[w.name] = {
      what: w.what,
      ops: w.ops,
      nativeMs: nm,
      noCheckMs: nc,
      cMs: cm,
      nsPerOp: (nm * 1e6) / w.ops,
      cNsPerOp: cm !== null ? (cm * 1e6) / w.ops : null,
      ratioC: cm !== null ? nm / cm : null,
      checkCost: nc !== null ? nm / nc : null,
      agree: withC.rt,
    };
  }
  out.host.loadEnd = loadavg();
  const peak = Math.max(out.host.loadStart[0]!, out.host.loadEnd[0]!);
  out.host.warning =
    peak > cpus().length * 0.5
      ? `load ${peak.toFixed(1)} on ${cpus().length} CPUs: these numbers are rough`
      : null;
  return out;
}

export function allocText(r: AllocBench): string {
  if (r.skipped !== null) return `SKIP ${r.skipped}`;
  const f = (x: number | null | undefined, d = 3): string =>
    x === null || x === undefined ? "-" : x.toFixed(d);
  const lines = [
    `host: ${r.host.clang}, ${r.host.cpus} CPUs, load start ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")}, end ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")}`,
  ];
  if (r.host.warning !== null) lines.push(`WARNING: ${r.host.warning}`);
  lines.push(
    `${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}; CNTVCT_EL0 under HVF; clang -O2 -ffp-contract=off`,
  );
  lines.push(
    "workload              native ms  no-check ms   C ms  native/C  check cost  native ns/op  C ns/op",
  );
  for (const [n, x] of Object.entries(r.rows)) {
    lines.push(
      `${n.padEnd(20)} ${f(x.nativeMs).padStart(10)} ${f(x.noCheckMs).padStart(11)} ${f(x.cMs).padStart(7)} ${f(x.ratioC, 2).padStart(8)}x ${f(x.checkCost, 3).padStart(10)}x ${f(x.nsPerOp, 2).padStart(12)} ${f(x.cNsPerOp, 2).padStart(8)}`,
    );
  }
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}
