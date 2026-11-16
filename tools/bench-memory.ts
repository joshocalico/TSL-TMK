// `tmk bench memory`: a list-heavy lowered program natively in `leak` against V8, and the same structure by hand in
// `manual` TSL against C, as `tmk bench alloc` measures it (SPEC 8.4, D38). No gate: numbers only.
import { loadavg, cpus } from "node:os";
import { join } from "node:path";
import { checkFile, compileTyped, lowerFile } from "./lowering.ts";
import type { FuncBuilder } from "../compiler/tir/build.ts";
import type { Module } from "../compiler/tir/ir.ts";
import { buildC, buildImageFor, median, type Work } from "./bench-alloc.ts";
import { buildDownImage, rcStatLines, type DownMetaLike } from "./native-exec.ts";
import { ROOT } from "./corpus.ts";
import { guardedRun } from "./guarded-run.ts";
import type { Driver } from "./native-driver.ts";
import { hvfAvailable, qemuRun } from "./qemu-run.ts";
import { buildPath } from "./build-dir.ts";

const OUT = buildPath("bench/memory");
const HOOK = join(ROOT, "tools/ts-hook.mjs");
const ARENA_BYTES = 96 * 1024 * 1024;

export interface MemoryBench {
  skipped: string | null;
  host: { loadStart: number[]; loadEnd: number[]; cpus: number; warning: string | null };
  params: { warm: number; iter: number; processes: number; nodes: number };
  rows: {
    name: string;
    ms: number;
    versus: string;
    versusMs: number | null;
    ratio: number | null;
  }[];
  errors: string[];
  // with classes forced, a benchmark the TSL route can't print yet, and why (R2: cycles' closures as values)
  notPrinted?: string[];
  // `rc`, from a build with counters, over the same work.
  rc: {
    name: string;
    allocs: number;
    incs: number;
    decs: number;
    incsNoElision: number;
    decsNoElision: number;
    blockBytesPerObject: number;
    objectBytes: number;
  }[];
  // The cycle collector (SPEC 3.5, D41): its steps against all the work, from a build with counters.
  cycles: {
    name: string;
    allocs: number;
    steps: number;
    ccSteps: number;
    freed: number;
    scans: number;
    fruitless: number;
    evicted: number;
    fullDrains: number;
    tirhashSameAsOff: boolean;
  }[];
}

export const pagesSetup =
  (lowered: boolean, pages = true) =>
  (main: FuncBuilder, drv: Driver): void => {
    // R12: a `strict` build has no page source, only the call arena
    if (pages) drv.pageRange();
    if (lowered) drv.arenaUse();
    const base = main.load("ptr", main.global("__mem_base"));
    const limit = main.load("ptr", main.global("__mem_limit"));
    const mid = main.at0(base, ARENA_BYTES);
    if (lowered) main.call("__arena_use", [base, mid]);
    if (pages) drv.usePageRange(main, mid, limit);
    if (lowered) main.call("__init", []);
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

/**
 * `classes`: only the phase-2 comparison (D62's rulings): `leak`'s list and churn programs, `manual`'s list, and the arrays
 * program in both (D66), straight to
 * TIR and printed as TSL classes that tslc compiles and places, each against the source on V8, same images otherwise.
 */
/** HVF, or TCG counting instructions when `TMK_ICOUNT=1` (qemu-run.ts): then each time is an instruction count. */
function benchAccel(): "hvf" | "tcg" {
  return process.env.TMK_ICOUNT === "1" ? "tcg" : "hvf";
}

export async function benchMemory(opts: {
  quick?: boolean;
  classes?: boolean;
  strings?: boolean; // with classes: only strings (D67), bench/strmap/str_lowered.ts's functions, each in leak and manual (R10: rc with `rc`)
  exceptions?: boolean; // with classes: only exceptions (D68), bench/exc/exc_cost.ts's functions, each in leak and manual
  maps?: boolean; // with classes: only maps (D72, strkeys), number, object and string keys, each in leak and manual
  rcTsl?: boolean; // only rc as TSL proper (D74, R1b): its list and churn, and the direct route's with cycles off, side by side
  rc?: boolean; // with classes: only lowered rc programs (R2), each straight to TIR and printed in an rc package tslc counts
  boundary?: boolean; // with classes: only exported functions taking and giving objects (R5), in leak and manual
  closures?: boolean; // with classes: only closure values (R6), the cycles benchmark in leak and manual, closures printed
  typedArrays?: boolean; // with classes: only typed arrays made in functions (R9), in leak and manual
  strict?: boolean; // with classes: only objects in strict (R12), bench/memory/strict_lowered.ts, the arena reset each call
  strictArrays?: boolean; // with classes: arrays and typed arrays in strict (R13), the arena array and R9's views, reset each call
  reshapes?: boolean; // with classes: R14's trusted reshapes, `auto`'s build against the direct route, strict, leak and manual
}): Promise<MemoryBench> {
  const processes = opts.quick === true ? 1 : 3;
  const warm = opts.quick === true ? 2 : 20;
  const iter = opts.quick === true ? 5 : 101;
  const nodes = 20000;
  const out: MemoryBench = {
    skipped: null,
    host: { loadStart: loadavg(), loadEnd: [], cpus: cpus().length, warning: null },
    params: { warm, iter, processes, nodes },
    rows: [],
    errors: [],
    rc: [],
    cycles: [],
  };
  if (!hvfAvailable().ok) {
    out.skipped = "HVF is unavailable, and performance runs are HVF only (SPEC 8.2)";
    return out;
  }
  // R12: off for `strict` builds, which have no page source
  let pageSource = true;
  const native = async (
    name: string,
    m: Module,
    w: Work,
    cBlob: Uint8Array | null,
    strings: Record<string, number>,
    lowered: boolean,
  ): Promise<{ tsl: number[]; c: number[]; rt: string; rc: string }> => {
    const res = { tsl: [] as number[], c: [] as number[], rt: "", rc: "" };
    // TMK_BENCH_RAM_MIB: a bigger guest, for work that keeps everything it makes in `leak` (pipe-h's throws).
    const mib = Number(process.env.TMK_BENCH_RAM_MIB ?? 256);
    const image = buildImageFor(
      m,
      w,
      warm,
      iter,
      cBlob,
      strings,
      pagesSetup(lowered, pageSource),
      mib * 1024 * 1024,
    );
    for (let p = 0; p < processes; p++) {
      const r = await qemuRun({
        name: `bench-memory/${name}-${p}`,
        image,
        ...(mib !== 256 ? { memory: `${mib}M` } : {}),
        accel: benchAccel(),
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
  const baseWork = (which: number, fn: string, what: string): Work => ({
    name: fn,
    fn,
    args: [nodes],
    which,
    cArgs: [nodes, 0],
    ops: nodes,
    what,
  });

  const onV8 = async (file: string, fn: string): Promise<{ ms: number[]; last: string }> => {
    const ms: number[] = [];
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
          fn,
          String(nodes),
          String(warm),
          String(iter),
        ],
        { timeoutMs: 120_000, label: "bench-memory on V8", cwd: ROOT },
      );
      if (!r.ok) {
        out.errors.push(`V8: ${r.why} ${r.stderr.slice(0, 300)}`);
        continue;
      }
      const j = JSON.parse(r.stdout) as { ms: number; last: number };
      ms.push(j.ms);
      last = String(j.last);
    }
    return { ms, last };
  };
  const lowered = async (
    label: string,
    file: string,
    fn: string,
    memory: string,
    v8: { ms: number[]; last: string },
    versus: string,
    cBlob: Uint8Array | null = null,
    cWhich = 0,
    cycles?: boolean,
    route?: { route: "direct" | "tsl" | "auto"; classes?: boolean },
    arenaReset = false,
  ): Promise<number | null> => {
    const lo = lowerFile(file, {
      memory,
      ...(cycles !== undefined ? { cycles } : {}),
      ...(route !== undefined ? route : {}),
    });
    if (lo.tir === null || lo.fallbackDiags.length > 0) {
      out.errors.push(`${label} didn't lower: ${JSON.stringify(lo.fallbackDiags).slice(0, 400)}`);
      return null;
    }
    const w = baseWork(0, fn, label);
    w.cArgs = [nodes, 0];
    w.arenaReset = arenaReset;
    const wc: Work = cBlob !== null ? { ...w, which: cWhich } : w;
    const n = await native(
      label.replace(/[^a-z]/gi, "-"),
      lo.tir,
      wc,
      cBlob,
      lo.meta!.strings,
      true,
    );
    if (
      n.rt !== "" &&
      v8.last !== "" &&
      BigInt.asIntN(32, BigInt(`0x${n.rt}`)) !== BigInt(v8.last)
    ) {
      out.errors.push(`${label} and V8 computed different results: ${n.rt} / ${v8.last}`);
    }
    if (cBlob !== null && n.rc !== "" && n.rt !== n.rc) {
      out.errors.push(`${label}: native and C computed different results: ${n.rt} / ${n.rc}`);
    }
    if (n.tsl.length === 0) return null;
    const a = median(n.tsl);
    const b = v8.ms.length > 0 ? median(v8.ms) : null;
    out.rows.push({ name: label, ms: a, versus, versusMs: b, ratio: b !== null ? a / b : null });
    if (cBlob !== null && n.c.length > 0) {
      const c = median(n.c);
      out.rows.push({
        name: `${label}, the C`,
        ms: c,
        versus: "(C at clang -O2, a free list)",
        versusMs: a,
        ratio: c / a,
      });
    }
    return a;
  };

  // 1. A lowered list, natively, against V8: leak and rc.
  const file = join(ROOT, "bench/memory/list_lowered.ts");
  const listV8 = await onV8(file, "listWork");
  if (opts.classes === true) {
    const churn = join(ROOT, "bench/memory/churn_lowered.ts");
    const churnV8 = await onV8(churn, "churnWork");
    const both = async (
      what: string,
      f: string,
      fn: string,
      memory: string,
      v8: typeof listV8,
      reset = false,
    ) => {
      const d = await lowered(
        `${what}, direct`,
        f,
        fn,
        memory,
        v8,
        "the source on V8",
        null,
        0,
        undefined,
        {
          route: "direct",
        },
        reset,
      );
      let t: number | null = null;
      try {
        t = await lowered(
          `${what}, TSL classes`,
          f,
          fn,
          memory,
          v8,
          "the source on V8",
          null,
          0,
          undefined,
          {
            route: "tsl",
            classes: true,
          },
          reset,
        );
      } catch (e) {
        if (!(e instanceof Error) || e.constructor.name !== "EmitUnsupported") throw e;
        (out.notPrinted ??= []).push(`${what}: ${e.message}`);
      }
      if (d !== null && t !== null)
        out.rows.push({
          name: `${what}: TSL classes against direct`,
          ms: t,
          versus: "direct",
          versusMs: d,
          ratio: t / d,
        });
    };
    if (opts.reshapes === true) {
      // R14 (pile item 9): the reshapes `auto` trusts, `auto`'s own build against the direct route, each benchmark only
      // where `auto` takes it reshaped: bench/reshape/reshape_lowered.ts's one function per kind, and the benchmarks a
      // trusted reshape touches, in `strict`, `leak` and `manual`, the arena reset after each call (D36).
      const { lowerFile: lowerPlain } = await import("../compiler/host/tslc.ts");
      const benches: [string, string, string][] = [
        ["operand", "bench/reshape/reshape_lowered.ts", "operandWork"],
        ["logical", "bench/reshape/reshape_lowered.ts", "logicalWork"],
        ["arm", "bench/reshape/reshape_lowered.ts", "armWork"],
        ["sequence", "bench/reshape/reshape_lowered.ts", "sequenceWork"],
        ["acyclic", "bench/memory/acyclic_lowered.ts", "acyclicWork"],
        ["arrays", "bench/memory/vec_lowered.ts", "vecWork"],
        ["typed arrays", "bench/memory/typed_lowered.ts", "typedWork"],
      ];
      for (const memory of ["strict", "leak", "manual"]) {
        pageSource = memory !== "strict";
        for (const [what, rel, fn] of benches) {
          if (
            process.env.TMK_BENCH_ONLY !== undefined &&
            !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
          )
            continue;
          const f = join(ROOT, rel);
          let shape = "";
          try {
            const a = lowerPlain(f, { memory: memory as never, route: "auto" });
            if (a.tsl === undefined || a.tsl.file === "" || a.tsl.stats.restructured === 0)
              continue;
            shape = a.tsl.stats.classes === true ? "classes" : "phase 1";
          } catch {
            continue;
          }
          const v8 = await onV8(f, fn);
          const label = `reshaped ${what} (${fn}), ${memory}, ${shape}`;
          const d = await lowered(
            `${label}, direct`,
            f,
            fn,
            memory,
            v8,
            "the source on V8",
            null,
            0,
            undefined,
            { route: "direct" },
            true,
          );
          const t = await lowered(
            `${label}, auto`,
            f,
            fn,
            memory,
            v8,
            "the source on V8",
            null,
            0,
            undefined,
            { route: "auto" },
            true,
          );
          if (d !== null && t !== null)
            out.rows.push({
              name: `${label}: auto against direct`,
              ms: t,
              versus: "direct",
              versusMs: d,
              ratio: t / d,
            });
        }
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.strictArrays === true) {
      // R13: arrays (@tsl/jsrt's arena array, its buffers the call arena's) and typed arrays made in functions (R9's layout
      // classes and tails, in the call arena) printed in `strict`, against the direct route, the arena reset after each call
      // as a native caller resets it (D36): the arrays benchmark and the typed arrays one, each in `strict`.
      pageSource = false;
      const benches: [string, string, string][] = [
        ["arrays", "bench/memory/vec_lowered.ts", "vecWork"],
        ["typed arrays", "bench/memory/typed_lowered.ts", "typedWork"],
      ];
      for (const [what, rel, fn] of benches) {
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
        )
          continue;
        const f = join(ROOT, rel);
        await both(`strict ${what} (${fn})`, f, fn, "strict", await onV8(f, fn), true);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.strict === true) {
      // R12: objects printed as classes in `strict` (pile item 7), against the direct route, the call arena reset after
      // each call as a native caller resets it (D36).
      const f = join(ROOT, "bench/memory/strict_lowered.ts");
      pageSource = false;
      for (const fn of ["vecWork", "localWork", "bodyWork"]) {
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
        )
          continue;
        await both(`strict objects ${fn}`, f, fn, "strict", await onV8(f, fn), true);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.exceptions === true) {
      // Exceptions, desugared by the printer (D68): bench/exc/exc_cost.ts's calls that can throw and don't, `try` and
      // `try`/`finally` nothing throws through, and throws caught 1, 10 and 100 frames up, in leak and manual.
      const exc = join(ROOT, "bench/exc/exc_cost.ts");
      for (const fn of [
        "callsPlain",
        "callsRisky",
        "tryNoThrow",
        "tryFinallyNoThrow",
        "throw1",
        "throw10",
        "throw100",
      ]) {
        // TMK_BENCH_ONLY: a pattern of the functions to run (pipe-h measured the throws alone).
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
        )
          continue;
        const v8 = await onV8(exc, fn);
        // R11: with --rc, `rc`'s cell: exceptions counted by tslc's expansion (forced through the TSL route)
        for (const memory of opts.rc === true ? ["rc"] : ["leak", "manual"])
          await both(`lowered exceptions ${fn}, native ${memory}`, exc, fn, memory, v8);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.maps === true) {
      // Maps, printed as @tsl/jsrt's JsMap and JsSet (D72): number keys and object keys with no strings (strkeys), each
      // judged on its own, then the two benchmarks with string keys, maps' (growth_lowered.ts, a program with a string-keyed
      // map, whose throughput functions have number keys) and strmap's (its maps without its number text).
      const benches: [string, string, string][] = [
        ["number keys", "bench/maps/num_lowered.ts", "numWork"],
        ["object keys", "bench/maps/obj_lowered.ts", "objWork"],
        ["maps' build and read", "bench/maps/growth_lowered.ts", "buildAndRead"],
        ["maps' mix", "bench/maps/growth_lowered.ts", "mixWork"],
        ["strmap's string-keyed mix", "bench/strmap/strmap_lowered.ts", "mapStrMix"],
        ["strmap's word count", "bench/strmap/strmap_lowered.ts", "wordCount"],
        ["strmap's number-keyed mix", "bench/strmap/strmap_lowered.ts", "mapMix"],
        ["strmap's set", "bench/strmap/strmap_lowered.ts", "setDedupe"],
      ];
      for (const [what, rel, fn] of benches) {
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
        )
          continue;
        // R10: with --rc, only the string-keyed ones, in `rc`, their strings the program's own JsStr (emit-rcstr.ts)
        if (opts.rc === true && !/str|word/i.test(what)) continue;
        const f = join(ROOT, rel);
        const v8 = await onV8(f, fn);
        for (const memory of opts.rc === true ? ["rc"] : ["leak", "manual"])
          await both(`lowered maps, ${what} (${fn}), native ${memory}`, f, fn, memory, v8, true);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.closures === true) {
      // Closure values printed as environment classes in leak and manual (R6: with the per-call region freeing them as the
      // direct route's call arena does), the cycles benchmark, whose closures are the only ones a benchmark has.
      const f = join(ROOT, "bench/memory/cycles_lowered.ts");
      const v8 = await onV8(f, "cycleWork");
      const was = process.env.TMK_EMIT_CLOS;
      process.env.TMK_EMIT_CLOS = "1";
      try {
        for (const memory of ["leak", "manual"])
          await both(
            `lowered cycles (cycleWork), native ${memory}`,
            f,
            "cycleWork",
            memory,
            v8,
            true,
          );
      } finally {
        if (was === undefined) delete process.env.TMK_EMIT_CLOS;
        else process.env.TMK_EMIT_CLOS = was;
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.typedArrays === true) {
      // Typed arrays made in functions (R9): a constant-length scratch array (a layout class's, on the stack) and arrays of
      // a length known at run time (a tail, in the per-call region), against the direct route's stack and call arena.
      const f = join(ROOT, "bench/memory/typed_lowered.ts");
      const v8 = await onV8(f, "typedWork");
      for (const memory of ["leak", "manual"])
        await both(
          `lowered typed arrays (typedWork), native ${memory}`,
          f,
          "typedWork",
          memory,
          v8,
        );
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.boundary === true) {
      // Exported functions taking and giving objects and arrays (R5): the TSL route's classes in D36's listed layout, which
      // is TSL's own since R6, against the direct route's own, in a hot loop of calls, in leak and manual.
      const f = join(ROOT, "bench/memory/boundary_lowered.ts");
      const v8 = await onV8(f, "boundaryWork");
      // R8: with --rc, `rc`'s cell: counted objects crossing, each export's result one count the caller lets go of
      for (const memory of opts.rc === true ? ["rc"] : ["leak", "manual"])
        await both(
          `lowered boundary (boundaryWork), native ${memory}`,
          f,
          "boundaryWork",
          memory,
          v8,
        );
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.rc === true && opts.strings !== true) {
      // Lowered `rc` programs (R2): the direct route's counts (down-rc.ts, D39) against the printed classes counted by tslc's
      // expansion onto @tsl/gc (D74), each with the collector on, as `auto` builds them. TMK_BENCH_ONLY picks by name.
      const cyclesFile = join(ROOT, "bench/memory/cycles_lowered.ts");
      const rcBenches: [string, string, string, boolean][] = [
        ["list", file, "listWork", false],
        ["churn", churn, "churnWork", false],
        ["cycles", cyclesFile, "cycleWork", false],
        ["arrays", join(ROOT, "bench/memory/vec_lowered.ts"), "vecWork", false],
        ["acyclic", join(ROOT, "bench/memory/acyclic_lowered.ts"), "acyclicWork", false],
        ["number-keyed maps", join(ROOT, "bench/maps/num_lowered.ts"), "numWork", true],
        ["object-keyed maps", join(ROOT, "bench/maps/obj_lowered.ts"), "objWork", true],
      ];
      for (const [what, f, fn, reset] of rcBenches) {
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(what)
        )
          continue;
        const v8 = f === file ? listV8 : f === churn ? churnV8 : await onV8(f, fn);
        await both(`lowered ${what} (${fn}), native rc`, f, fn, "rc", v8, reset);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    if (opts.strings === true) {
      // Strings, printed as @tsl/jsrt's JsString (D67): strmap's string work without its maps and number text.
      const str = join(ROOT, "bench/strmap/str_lowered.ts");
      for (const fn of ["appendWork", "joinSmall", "subWork", "scanWork", "splitJoin"]) {
        if (
          process.env.TMK_BENCH_ONLY !== undefined &&
          !new RegExp(process.env.TMK_BENCH_ONLY).test(fn)
        )
          continue;
        const v8 = await onV8(str, fn);
        // R10: with --rc, `rc`'s cell: strings printed as the program's own JsStr, counted by tslc's expansion
        for (const memory of opts.rc === true ? ["rc"] : ["leak", "manual"])
          await both(`lowered strings ${fn}, native ${memory}`, str, fn, memory, v8);
      }
      out.host.loadEnd = loadavg();
      return out;
    }
    await both("lowered list, native leak", file, "listWork", "leak", listV8);
    await both("lowered churn, native leak", churn, "churnWork", "leak", churnV8);
    await both("lowered list, native manual", file, "listWork", "manual", listV8);
    // Arrays, printed as @tsl/jsrt's JsArray (D66).
    const vec = join(ROOT, "bench/memory/vec_lowered.ts");
    const vecV8 = await onV8(vec, "vecWork");
    await both("lowered arrays, native leak", vec, "vecWork", "leak", vecV8);
    await both("lowered arrays, native manual", vec, "vecWork", "manual", vecV8);
    out.host.loadEnd = loadavg();
    return out;
  }
  if (opts.rcTsl === true) {
    const churnFile = join(ROOT, "bench/memory/churn_lowered.ts");
    const churnV8 = await onV8(churnFile, "churnWork");
    const cBlob = buildC(join(ROOT, "bench/memory/list.c"), OUT);
    // R1c (D41): the cycles benchmark, every object garbage in a cycle, which only a collector frees
    const cyclesFile = join(ROOT, "bench/memory/cycles_lowered.ts");
    const cyclesV8 = await onV8(cyclesFile, "cycleWork");
    const pairs = [
      ["list", file, "listWork", listV8, "bench/memory/rc/list_rc.ts", 0, "C with a free list"],
      ["churn", churnFile, "churnWork", churnV8, "bench/memory/rc/churn_rc.ts", 2, "C churn"],
      [
        "cycles",
        cyclesFile,
        "cycleWork",
        cyclesV8,
        "bench/memory/rc/cycles_rc.ts",
        0,
        "C with a free list",
      ],
    ] as const;
    for (const [what, f, fn, v8, tslPath, which, versus] of pairs) {
      // the direct route's with its collector on (D41), and for an acyclic program, off as well
      const on = await lowered(
        `direct rc ${what}, cycles on`,
        f,
        fn,
        "rc",
        v8,
        "the source on V8",
        null,
        0,
        true,
      );
      const d =
        what === "cycles"
          ? null
          : await lowered(
              `direct rc ${what}, cycles off`,
              f,
              fn,
              "rc",
              v8,
              "the source on V8",
              null,
              0,
              false,
            );
      const { typed, diags } = checkFile(join(ROOT, tslPath));
      if (typed === null) {
        out.errors.push(`${tslPath}: ${JSON.stringify(diags).slice(0, 400)}`);
        continue;
      }
      const o = compileTyped(typed);
      const r = await native(
        `TSL-rc-${what}`,
        o.tir,
        baseWork(which, "listCycle", what),
        what === "cycles" ? null : cBlob,
        o.meta.strings,
        false,
      );
      if (r.rc !== "" && r.rt !== r.rc)
        out.errors.push(`TSL rc ${what}: native and C differ: ${r.rt} / ${r.rc}`);
      if (r.tsl.length === 0) continue;
      const t = median(r.tsl);
      out.rows.push({
        name: `TSL rc, ${what}`,
        ms: t,
        versus,
        versusMs: r.c.length > 0 ? median(r.c) : null,
        ratio: r.c.length > 0 ? t / median(r.c) : null,
      });
      if (on !== null)
        out.rows.push({
          name: `TSL rc ${what} against direct, cycles on`,
          ms: t,
          versus: "direct, cycles on",
          versusMs: on,
          ratio: t / on,
        });
      if (d !== null)
        out.rows.push({
          name: `TSL rc ${what} against direct`,
          ms: t,
          versus: "direct, cycles off",
          versusMs: d,
          ratio: t / d,
        });
    }
    out.host.loadEnd = loadavg();
    return out;
  }
  await lowered("lowered list, native leak", file, "listWork", "leak", listV8, "the source on V8");
  await lowered("lowered list, native rc", file, "listWork", "rc", listV8, "the source on V8");
  await lowered(
    "lowered list, rc, cycles off",
    file,
    "listWork",
    "rc",
    listV8,
    "the source on V8",
    null,
    0,
    false,
  );
  // A churn program: rc against leak, V8 and C.
  const churnFile = join(ROOT, "bench/memory/churn_lowered.ts");
  const churnV8 = await onV8(churnFile, "churnWork");
  const cChurn = buildC(join(ROOT, "bench/memory/list.c"), OUT);
  await lowered(
    "lowered churn, native leak",
    churnFile,
    "churnWork",
    "leak",
    churnV8,
    "the source on V8",
  );
  await lowered(
    "lowered churn, native rc",
    churnFile,
    "churnWork",
    "rc",
    churnV8,
    "the source on V8",
    cChurn,
    2,
  );
  await lowered(
    "lowered churn, rc, cycles off",
    churnFile,
    "churnWork",
    "rc",
    churnV8,
    "the source on V8",
    null,
    0,
    false,
  );
  // Real cycles, where they fit with the collector off, and no cycles at all.
  const cyclesFile = join(ROOT, "bench/memory/cycles_lowered.ts");
  const cyclesV8 = await onV8(cyclesFile, "cycleWork");
  await lowered("cycles, native rc", cyclesFile, "cycleWork", "rc", cyclesV8, "the source on V8");
  await lowered(
    "cycles, rc, cycles off",
    cyclesFile,
    "cycleWork",
    "rc",
    cyclesV8,
    "the source on V8",
    null,
    0,
    false,
  );
  const acyclicFile = join(ROOT, "bench/memory/acyclic_lowered.ts");
  const acyclicV8 = await onV8(acyclicFile, "acyclicWork");
  await lowered(
    "acyclic, native rc",
    acyclicFile,
    "acyclicWork",
    "rc",
    acyclicV8,
    "the source on V8",
  );
  await lowered(
    "acyclic, rc, cycles off",
    acyclicFile,
    "acyclicWork",
    "rc",
    acyclicV8,
    "the source on V8",
    null,
    0,
    false,
  );
  for (const [label, path, fn] of [
    ["list", file, "listWork"],
    ["churn", churnFile, "churnWork"],
    ["cycles", cyclesFile, "cycleWork"],
    ["acyclic", acyclicFile, "acyclicWork"],
  ] as const) {
    const same =
      lowerFile(path, { memory: "rc", cycles: true }).tirHash ===
      lowerFile(path, { memory: "rc", cycles: false }).tirHash;
    const lo = lowerFile(path, { memory: "rc", rc: { account: true, cycles: true } });
    if (lo.tir === null) continue;
    const reps = 8;
    const built = buildDownImage(
      lo.tir,
      lo.meta as DownMetaLike,
      Array.from({ length: reps }, () => ({ fn, args: [nodes] })),
      undefined,
      { stats: true },
    );
    const r = await qemuRun({
      name: `bench-memory/cc-${label}`,
      image: built.image.bytes,
      accel: benchAccel(),
      timeoutMs: 180_000,
    });
    if (!r.ok) {
      out.errors.push(`${label} collector counters: ${r.status} ${r.why.slice(0, 300)}`);
      continue;
    }
    const s = rcStatLines(lo.tir, r.lines)
      .filter((x) => x !== undefined)
      .at(-1);
    if (s !== undefined) {
      out.cycles.push({
        name: label,
        allocs: s.allocs!,
        steps: s.steps!,
        ccSteps: s.cc_steps ?? 0,
        freed: s.cc_freed ?? 0,
        scans: s.cc_scans ?? 0,
        fruitless: s.cc_fruitless ?? 0,
        evicted: s.cc_evicted ?? 0,
        fullDrains: s.full_drains!,
        tirhashSameAsOff: same,
      });
    }
  }
  // What the counts come to.
  for (const [label, path, fn, objectBytes] of [
    ["list", file, "listWork", 16],
    ["churn", churnFile, "churnWork", 16],
  ] as const) {
    const counted = async (elide: boolean): Promise<Record<string, number> | null> => {
      const lo = lowerFile(path, { memory: "rc", rc: { account: true, elide } });
      if (lo.tir === null) return null;
      const built = buildDownImage(
        lo.tir,
        lo.meta as DownMetaLike,
        [{ fn, args: [nodes] }],
        undefined,
        { stats: true },
      );
      const r = await qemuRun({
        name: `bench-memory/rc-${label}`,
        image: built.image.bytes,
        accel: benchAccel(),
        timeoutMs: 180_000,
      });
      if (!r.ok) {
        out.errors.push(`${label} counters: ${r.status} ${r.why.slice(0, 300)}`);
        return null;
      }
      return rcStatLines(lo.tir, r.lines)[0] ?? null;
    };
    const on = await counted(true);
    const off = await counted(false);
    if (on !== null && off !== null) {
      out.rc.push({
        name: label,
        allocs: on.allocs!,
        incs: on.incs!,
        decs: on.decs!,
        incsNoElision: off.incs!,
        decsNoElision: off.decs!,
        blockBytesPerObject: on.live_objects! > 0 ? on.live_bytes! / on.live_objects! : Number.NaN,
        objectBytes,
      });
    }
  }

  // 2. The same structure by hand in manual TSL, and in leak TSL, against C.
  const cBlob = buildC(join(ROOT, "bench/memory/list.c"), OUT);
  if (cBlob === null) out.errors.push("no clang or ld.lld: no C to compare with");
  for (const [name, path, which, versus] of [
    ["TSL manual, with frees", "bench/memory/manual/list_manual.ts", 0, "C with a free list"],
    ["TSL leak, no frees", "bench/memory/leak/list_leak.ts", 1, "C, a bump allocator"],
    // rc as TSL proper (D74), beside the direct route's lowered rc rows above
    ["TSL rc, list", "bench/memory/rc/list_rc.ts", 0, "C with a free list"],
    ["TSL rc, churn", "bench/memory/rc/churn_rc.ts", 2, "C churn"],
  ] as const) {
    const { typed, diags } = checkFile(join(ROOT, path));
    if (typed === null) {
      out.errors.push(`${path}: ${JSON.stringify(diags).slice(0, 400)}`);
      continue;
    }
    const o = compileTyped(typed);
    const r = await native(
      name.replace(/[^a-z]/gi, "-"),
      o.tir,
      baseWork(which, "listCycle", name),
      cBlob,
      o.meta.strings,
      false,
    );
    if (r.rc !== "" && r.rt !== r.rc) {
      out.errors.push(`${name}: native and C computed different results: ${r.rt} / ${r.rc}`);
    }
    if (r.tsl.length > 0) {
      const a = median(r.tsl);
      const b = r.c.length > 0 ? median(r.c) : null;
      out.rows.push({
        name,
        ms: a,
        versus,
        versusMs: b,
        ratio: b !== null ? a / b : null,
      });
    }
  }
  out.host.loadEnd = loadavg();
  const peak = Math.max(out.host.loadStart[0]!, out.host.loadEnd[0]!);
  out.host.warning =
    peak > cpus().length * 0.5
      ? `load ${peak.toFixed(1)} on ${cpus().length} CPUs: these numbers are rough`
      : null;
  return out;
}

export function memoryText(r: MemoryBench): string {
  if (r.skipped !== null) return `SKIP ${r.skipped}`;
  const lines = [
    `host: ${r.host.cpus} CPUs, load start ${r.host.loadStart.map((x) => x.toFixed(1)).join(" ")}, end ${r.host.loadEnd.map((x) => x.toFixed(1)).join(" ")}`,
  ];
  if (r.host.warning !== null) lines.push(`WARNING: ${r.host.warning}`);
  lines.push(
    `${r.params.nodes} nodes built, walked 4 times; ${r.params.processes} processes, warm-up ${r.params.warm} discarded, median of ${r.params.iter}; native under HVF`,
  );
  for (const x of r.rows) {
    lines.push(
      `${x.name.padEnd(28)} ${x.ms.toFixed(3).padStart(9)} ms   ${x.versus}: ${x.versusMs === null ? "-" : `${x.versusMs.toFixed(3)} ms, ${x.ratio!.toFixed(2)}x`}`,
    );
  }
  for (const x of r.rc) {
    const on = x.incs + x.decs;
    const off = x.incsNoElision + x.decsNoElision;
    lines.push(
      `rc ${x.name}: ${x.allocs} allocations, ${x.incs} incs and ${x.decs} decs with elision, ${x.incsNoElision} and ${x.decsNoElision} without: ${(100 - (100 * on) / Math.max(off, 1)).toFixed(1)}% of counts removed, ${(on / Math.max(x.allocs, 1)).toFixed(1)} counts per allocation, ${x.objectBytes} bytes of object in ${Number.isNaN(x.blockBytesPerObject) ? "?" : x.blockBytesPerObject} of block`,
    );
  }
  for (const x of r.cycles) {
    lines.push(
      `collector, ${x.name}, 8 calls: ${x.allocs} allocations, ${x.steps} steps of freeing and collecting, ${x.ccSteps} of them the collector's (${((100 * x.ccSteps) / Math.max(x.steps, 1)).toFixed(1)}%), ${x.freed} objects freed as cycles, ${x.scans} scans, ${x.fruitless} of them fruitless, ${x.evicted} candidates that didn't fit, ${x.fullDrains} full drains. ${x.tirhashSameAsOff ? "On is the same module as off, byte for byte" : "No change to a block: 16 bytes of header, as before"}`,
    );
  }
  for (const x of r.notPrinted ?? []) lines.push(`not printable through the TSL route yet: ${x}`);
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  return lines.join("\n");
}
