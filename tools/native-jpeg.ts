// The down-lowered Moire JPEG decoder as a native image (SPEC M5, native-a): no JS anywhere in its
// path, results reported by SHA-256 over serial and pinned against V8's own decode.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildImage, type ImageOutput } from "../compiler/backend-aarch64/image.ts";
import { lowerFile } from "./lowering.ts";
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { FIXTURES, LARGE, makeLarge, PINNED, VENDOR } from "./bench-jpeg.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import { Driver } from "./native-driver.ts";
import { CaseBuilder, type DownMetaLike } from "./native-exec.ts";
import { type Accel, qemuRun, type QemuResult } from "./qemu-run.ts";

export const JPEG_RAM = 1024 * 1024 * 1024;
export const JPEG_MEMORY = "1G";

export interface Reference {
  name: string;
  path: string;
  size: { width: number; height: number } | null;
  decodes: { maxEdge: number | null; width: number; height: number; sha: string }[];
}

export async function referenceHashes(): Promise<Reference[]> {
  const large = makeLarge();
  const dirs = [FIXTURES, ...(large !== null ? [dirname(large)] : [])];
  const r = await guardedRun(
    process.execPath,
    [
      "--import",
      join(ROOT, "tools/ts-hook.mjs"),
      "--no-warnings",
      join(ROOT, "bench/jpeg/hashes.ts"),
      JSON.stringify({ source: VENDOR, dirs }),
    ],
    { timeoutMs: 300_000, label: "reference hashes on V8", cwd: ROOT },
  );
  if (!r.ok) throw new Error(`reference hashes: ${r.why} ${r.stderr.slice(0, 800)}`);
  return JSON.parse(r.stdout) as Reference[];
}

interface Lowered {
  m: Module;
  meta: DownMetaLike;
}

let cached: Lowered | null = null;

/** Lowers with no fallback: anything that would stay JS is a hard error here (SPEC 4.5). */
export function lowerJpeg(): Lowered {
  if (cached !== null) return cached;
  const o = lowerFile(VENDOR);
  if (o.fallbackDiags.length > 0) {
    throw new Error(
      `--no-fallback: ${o.fallbackDiags.map((d) => `${d.fn}: ${d.blocker}`).join("; ")}`,
    );
  }
  if (o.tir === null) throw new Error(`jpeg.ts doesn't compile: ${JSON.stringify(o.diags)}`);
  cached = { m: o.tir, meta: o.meta as unknown as DownMetaLike };
  return cached;
}

/**
 * R13: a call of one of the decoder's exports by the module's own signature: through the TSL route with classes (forced, or
 * `auto`'s in `strict`) an object it takes or gives is a TSL reference, an i64 in TIR, where the direct route's is a ptr.
 * Its arguments and result are ptrs here either way.
 */
export function callJpeg(drv: Driver, b: FuncBuilder, name: string, args: number[]): number {
  const sig = drv.sigOf(name);
  const typed = args.map((a, i) =>
    sig.params[i] === "i64" && i >= 2 ? b.op("bitcast.i64", [a], "i64") : a,
  );
  const r = b.call(name, typed, [sig.rets[0] === "i64" ? "i64" : "ptr"])[0]!;
  return sig.rets[0] === "i64" ? b.op("bitcast.ptr", [r], "ptr") : r;
}

interface RetFields {
  rgbaOff: number;
  widthOff: number;
  widthF64: boolean;
  heightOff: number;
  heightF64: boolean;
}

function retFields(meta: DownMetaLike, id: string): RetFields {
  const h = meta.heap[id]!;
  const field = (n: string): { off: number; ty: { rep?: string } } => {
    const f = h.fields!.find((x) => x.name === n);
    if (f === undefined) throw new Error(`no field ${n} in the decoder's result`);
    return f;
  };
  return {
    rgbaOff: field("rgba").off,
    widthOff: field("width").off,
    widthF64: field("width").ty.rep === "f64",
    heightOff: field("height").off,
    heightF64: field("height").ty.rep === "f64",
  };
}

function printDim(drv: Driver, b: FuncBuilder, r: number, off: number, isF64: boolean): void {
  const at = b.at0(r, off);
  if (isF64) b.call("__rt_putf64", [b.load("f64", at)]);
  else b.call("__rt_dec", [b.op("sext.i64", [b.load("i32", at)], "i64")]);
  void drv;
}

/** The arena provider for this image: init data below, a separate arena for results above it. */
function setupArena(b: FuncBuilder): void {
  b.call("__arena_use", [
    b.load("ptr", b.global("__mem_base")),
    b.load("ptr", b.global("__mem_limit")),
  ]);
  b.call("__init", []);
  b.call("__arena_use", [
    b.load("ptr", b.global("__arena_top")),
    b.load("ptr", b.global("__mem_limit")),
  ]);
}

export interface PlannedCase {
  fixture: number;
  variant: number; // index in Reference.decodes, or -1 for jpegSize
}

export function buildCheckImage(fixtures: Reference[]): {
  image: ImageOutput;
  plan: PlannedCase[];
} {
  const { m, meta } = lowerJpeg();
  const drv = new Driver(m);
  const list: { run: string; after: string }[] = [];
  const plan: PlannedCase[] = [];
  const ret = retFields(meta, meta.exports.decodeJpeg!.ret.id!);
  const optDesc = meta.exports.decodeJpeg!.params[1]!;
  const sizeHeap = meta.heap[meta.exports.jpegSize!.ret.id!]!;
  fixtures.forEach((fx, fi) => {
    const bytes = new Uint8Array(readFileSync(fx.path));
    const blob = drv.blob(bytes);
    fx.decodes.forEach((d, di) => {
      const i = plan.length;
      plan.push({ fixture: fi, variant: di });
      const run = new FuncBuilder(`__case_${i}`, [], []);
      run.call("__arena_reset", []);
      const cb = new CaseBuilder(run, drv, meta, i, []);
      const opts =
        d.maxEdge === null ? run.iconst("ptr", 0) : cb.toHeap(optDesc, { maxEdge: d.maxEdge });
      const r = callJpeg(drv, run, "decodeJpeg", [run.global(blob), run.ix(bytes.length), opts]);
      const p = run.load("ptr", run.at0(r, ret.rgbaOff));
      const n = run.load("ix", run.at0(r, ret.rgbaOff + 8));
      run.call("__rt_sha256", [p, n]);
      drv.puts(run, `TMK:J ${i} `);
      printDim(drv, run, r, ret.widthOff, ret.widthF64);
      run.call("__rt_sp", []);
      printDim(drv, run, r, ret.heightOff, ret.heightF64);
      run.call("__rt_sp", []);
      run.call("__rt_sha_print", []);
      run.call("__rt_nl", []);
      run.ret();
      drv.funcs.push(run.finish());
      list.push({ run: `__case_${i}`, after: "__after" });
    });
    const i = plan.length;
    plan.push({ fixture: fi, variant: -1 });
    const run = new FuncBuilder(`__case_${i}`, [], []);
    run.call("__arena_reset", []);
    const r = callJpeg(drv, run, "jpegSize", [run.global(blob), run.ix(bytes.length)]);
    drv.puts(run, `TMK:S ${i} `);
    const widthF = sizeHeap.fields!.find((f) => f.name === "width")!;
    const heightF = sizeHeap.fields!.find((f) => f.name === "height")!;
    const isNull = run.op("icmp.eq.ptr", [r, run.iconst("ptr", 0)], "i32");
    const none = run.block();
    const some = run.block();
    const done = run.block();
    run.brif(isNull, none, some);
    run.at(none);
    drv.puts(run, "null");
    run.br(done);
    run.at(some);
    printDim(drv, run, r, widthF.off, widthF.ty.rep === "f64");
    run.call("__rt_sp", []);
    printDim(drv, run, r, heightF.off, heightF.ty.rep === "f64");
    run.br(done);
    run.at(done);
    run.call("__rt_nl", []);
    run.ret();
    drv.funcs.push(run.finish());
    list.push({ run: `__case_${i}`, after: "__after" });
  });
  const after = new FuncBuilder("__after", [], []);
  after.ret();
  drv.funcs.push(after.finish());
  drv.arenaUse();
  drv.main(list, setupArena);
  drv.trapMessages(meta.strings);
  return {
    image: buildImage({
      module: m,
      driverFuncs: drv.funcs,
      driverGlobals: drv.globals,
      ramBytes: JPEG_RAM,
    }),
    plan,
  };
}

export interface CheckResult {
  accel: Accel;
  run: QemuResult;
  fixtures: number;
  cases: number;
  agreed: number;
  pinned: number;
  failures: string[];
}

export async function checkNative(
  accel: Accel,
  refs: Reference[],
  timeoutMs = 300_000,
): Promise<CheckResult> {
  const { image, plan } = buildCheckImage(refs);
  const run = await qemuRun({
    name: "jpeg/check",
    image: image.bytes,
    accel,
    memory: JPEG_MEMORY,
    timeoutMs,
  });
  const failures: string[] = [];
  let agreed = 0;
  if (!run.ok && !run.skipped) failures.push(`${run.status}: ${run.why.slice(0, 1500)}`);
  const seen = new Map<number, string[]>();
  for (const l of run.lines) {
    if (l.startsWith("TMK:J ") || l.startsWith("TMK:S ")) {
      const parts = l.split(" ");
      seen.set(Number(parts[1]), parts.slice(2));
    } else if (l.startsWith("TMK:C ") && l.split(" ")[2] === "T") {
      const parts = l.split(" ");
      failures.push(`case ${parts[1]} trapped: ${parts.slice(3).join(" ")}`);
    }
  }
  plan.forEach((c, i) => {
    const fx = refs[c.fixture]!;
    const got = seen.get(i);
    if (got === undefined) {
      if (!run.skipped) failures.push(`${fx.name} case ${i}: no result`);
      return;
    }
    if (c.variant < 0) {
      const want = fx.size === null ? "null" : `${fx.size.width} ${fx.size.height}`;
      if (got.join(" ") === want) agreed++;
      else failures.push(`${fx.name} jpegSize: ${got.join(" ")}, V8 gave ${want}`);
      return;
    }
    const d = fx.decodes[c.variant]!;
    const want = `${d.width} ${d.height} ${d.sha}`;
    if (got.join(" ") === want) agreed++;
    else failures.push(`${fx.name} maxEdge=${d.maxEdge}: ${got.join(" ")}, V8 gave ${want}`);
  });
  let pinned = 0;
  for (const fx of refs) {
    const pin = PINNED[fx.name];
    if (pin === undefined) continue;
    if (fx.decodes[0]!.sha.startsWith(pin)) pinned++;
    else failures.push(`${fx.name}: V8's hash ${fx.decodes[0]!.sha} isn't M2's pin ${pin}`);
  }
  return { accel, run, fixtures: refs.length, cases: plan.length, agreed, pinned, failures };
}

export { LARGE };

// --- corrupt input, natively (SPEC 4.6): never crashes, and either matches V8 or traps

export interface CorruptResult {
  total: number;
  matched: number;
  matchedError: number;
  trapped: number;
  trapCodes: Record<string, number>;
  mismatched: string[];
  crashed: string[];
}

export async function corruptNative(accel: Accel): Promise<CorruptResult> {
  const total = 200;
  const r = await guardedRun(
    process.execPath,
    [
      "--import",
      join(ROOT, "tools/ts-hook.mjs"),
      "--no-warnings",
      join(ROOT, "bench/jpeg/corrupt-ref.ts"),
      JSON.stringify({ source: VENDOR, dir: FIXTURES, seed: 20261103, total }),
    ],
    { timeoutMs: 300_000, label: "corrupt reference on V8", cwd: ROOT },
  );
  if (!r.ok) throw new Error(`corrupt reference: ${r.why} ${r.stderr.slice(0, 500)}`);
  const refs = JSON.parse(r.stdout) as {
    bytes: string;
    ok?: string;
    threw?: string;
    message?: string;
  }[];
  const { m, meta } = lowerJpeg();
  const drv = new Driver(m);
  const ret = retFields(meta, meta.exports.decodeJpeg!.ret.id!);
  const list: { run: string; after: string }[] = [];
  refs.forEach((c, i) => {
    const bytes = new Uint8Array(Buffer.from(c.bytes, "hex"));
    const blob = drv.blob(bytes);
    const run = new FuncBuilder(`__case_${i}`, [], []);
    run.call("__arena_reset", []);
    const res = callJpeg(drv, run, "decodeJpeg", [
      run.global(blob),
      run.ix(bytes.length),
      run.iconst("ptr", 0),
    ]);
    const p = run.load("ptr", run.at0(res, ret.rgbaOff));
    const n = run.load("ix", run.at0(res, ret.rgbaOff + 8));
    run.call("__rt_sha256", [p, n]);
    drv.puts(run, `TMK:J ${i} `);
    printDim(drv, run, res, ret.widthOff, ret.widthF64);
    run.call("__rt_sp", []);
    printDim(drv, run, res, ret.heightOff, ret.heightF64);
    run.call("__rt_sp", []);
    run.call("__rt_sha_print", []);
    run.call("__rt_nl", []);
    run.ret();
    drv.funcs.push(run.finish());
    list.push({ run: `__case_${i}`, after: "__after" });
  });
  const after = new FuncBuilder("__after", [], []);
  after.ret();
  drv.funcs.push(after.finish());
  drv.arenaUse();
  drv.main(list, setupArena);
  drv.trapMessages(meta.strings);
  const image = buildImage({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: JPEG_RAM,
  });
  const run = await qemuRun({
    name: "jpeg/corrupt",
    image: image.bytes,
    accel,
    memory: JPEG_MEMORY,
    timeoutMs: 300_000,
  });
  const out: CorruptResult = {
    total,
    matched: 0,
    matchedError: 0,
    trapped: 0,
    trapCodes: {},
    mismatched: [],
    crashed: [],
  };
  if (!run.ok) out.crashed.push(`${run.status}: ${run.why.slice(0, 800)}`);
  const got = new Map<number, { ok?: string; code?: number; msg?: string }>();
  for (const l of run.lines) {
    const parts = l.split(" ");
    if (parts[0] === "TMK:J") got.set(Number(parts[1]), { ok: parts.slice(2).join(" ") });
    if (parts[0] === "TMK:C" && parts[2] === "T") {
      got.set(Number(parts[1]), {
        code: Number(parts[3]),
        msg: Buffer.from(parts.slice(4).join(" "), "latin1").toString("utf8"),
      });
    }
  }
  refs.forEach((c, i) => {
    const g = got.get(i);
    if (g === undefined) {
      out.crashed.push(`case ${i}: no result`);
      return;
    }
    if (g.ok !== undefined) {
      if (g.ok === c.ok) out.matched++;
      else
        out.mismatched.push(`case ${i}: native ${g.ok}, V8 ${c.ok ?? `threw ${c.message ?? ""}`}`);
      return;
    }
    if (g.code! >= 100000) {
      if (c.threw !== undefined && g.msg === `${c.threw}: ${c.message ?? ""}`) out.matchedError++;
      else
        out.mismatched.push(
          `case ${i}: native threw ${g.msg ?? ""}, V8 ${c.ok ?? c.message ?? ""}`,
        );
      return;
    }
    out.trapped++;
    out.trapCodes[String(g.code)] = (out.trapCodes[String(g.code)] ?? 0) + 1;
  });
  return out;
}
