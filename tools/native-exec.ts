// The native configuration of the corpus: builds one image per program with its cases in it, runs it
// under QEMU, and rebuilds the same JS values the other configurations return (SPEC 8.1).
import { FuncBuilder } from "../compiler/tir/build.ts";
import type { RcStrLayout, StrLayout } from "../compiler/host/types.ts";
import type { Module } from "../compiler/tir/ir.ts";
import {
  buildImage,
  type ImageInput,
  type ImageOutput,
} from "../compiler/backend-aarch64/image.ts";
/** What links a case image: the bare-metal Image unless given (macos-arm64 passes hosted.ts's buildHostedObject). */
export type ImageLinker = (inp: ImageInput) => ImageOutput;
import type { BulkFault } from "../compiler/backend-aarch64/rt-tir.ts";
import { arrayDigest, canon, checkPin, decodeArg, isTypedArray, type Json } from "./canon.ts";
import type { CaseResult } from "./corpus-exec.ts";
import { Driver, type Leaf } from "./native-driver.ts";
import {
  ERROR_NAMES,
  strictCanon,
  thrownFromDesc,
  unescapeUnits,
  type LowerCase,
  type LowerCaseResult,
  type ThrownDesc,
} from "./lower-exec.ts";
import { channelOf } from "./qemu-run.ts";
import { timedSync } from "./timing.ts";

export const DEFAULT_RAM = 256 * 1024 * 1024;
/** How much a test image can report through the RAM channel (SPEC 8.2). Untouched pages cost nothing. */
export const BULK_BYTES = 512 * 1024 * 1024;
/** `TMK_CHANNEL=serial` puts everything back on the PL011, to compare or to debug. Nothing else depends on which. */
export const bulkFor = (): number => (process.env.TMK_CHANNEL === "serial" ? 0 : BULK_BYTES);
const ARENA_BYTES = 96 * 1024 * 1024;

// --- serial

export interface CaseLines {
  leaves: string[] | null;
  trap: { code: number; message: string } | null;
  thrown: string | null; // an exception that reached the caller, described by the module (D36, D49)
  arrays: Map<number, string>;
  placed: Map<number, bigint>;
  memory: { addr: number; hex: string }[];
  memoryRanges: [number, number][]; // the same, as byte ranges of the RAM channel
  channel: Buffer | undefined;
  finished: boolean;
}

export function parseSerial(lines: string[]): CaseLines[] {
  const channel = channelOf(lines);
  const out: CaseLines[] = [];
  const at = (i: number): CaseLines => {
    let c = out[i];
    if (c === undefined) {
      c = {
        leaves: null,
        trap: null,
        thrown: null,
        arrays: new Map(),
        placed: new Map(),
        memory: [],
        memoryRanges: [],
        channel,
        finished: false,
      };
      out[i] = c;
    }
    return c;
  };
  let current = 0;
  for (const line of lines) {
    if (line.startsWith("TMK:MR ")) {
      const parts = line.split(" ");
      at(current).memoryRanges.push([Number(parts[1]), Number(parts[2])]);
      continue;
    }
    if (line.startsWith("TMK:M ")) {
      const parts = line.split(" ");
      at(current).memory.push({ addr: Number.parseInt(parts[1]!, 16), hex: parts[2]! });
      continue;
    }
    if (line.startsWith("TMK:E ")) {
      const i = Number(line.slice(6));
      at(i).finished = true;
      current = i + 1;
      continue;
    }
    if (!line.startsWith("TMK:C ")) continue;
    const parts = line.split(" ");
    const i = Number(parts[1]);
    current = i;
    const c = at(i);
    switch (parts[2]) {
      case "R":
        c.leaves = parts.slice(3).filter((x) => x !== "");
        break;
      case "T":
        // Serial is bytes, and a message is UTF-8.
        c.trap = {
          code: Number(parts[3]),
          message: Buffer.from(parts.slice(4).join(" "), "latin1").toString("utf8"),
        };
        break;
      case "A":
        c.arrays.set(Number(parts[3]), parts[4] ?? "");
        break;
      case "X":
        c.thrown = Buffer.from(parts.slice(3).join(" "), "latin1").toString("utf8");
        break;
      case "P":
        c.placed.set(Number(parts[3]), BigInt(`0x${parts[4]!}`));
        break;
    }
  }
  return out;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesOf(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function leafBits(h: string): bigint {
  return BigInt(`0x${h}`);
}

const f64Of = (bits: bigint): number => {
  const d = new DataView(new ArrayBuffer(8));
  d.setBigUint64(0, bits);
  return d.getFloat64(0);
};
const f32Of = (bits: bigint): number => {
  const d = new DataView(new ArrayBuffer(4));
  d.setUint32(0, Number(bits));
  return d.getFloat32(0);
};

// --- TSL proper: scalars, value records and tagged unions flatten to leaves (SPEC M1, step 7)

interface TslDesc {
  k: string;
  name?: string;
  elem?: string;
  fields?: { name: string; ty: TslDesc; slots: number[] }[];
  tag?: string;
  variants?: {
    tag: unknown;
    leaf: number;
    fields: { name: string; ty: TslDesc; slots: number[] }[];
  }[];
  nslots?: number;
  slotTypes?: string[];
}
interface TslMeta {
  exports: Record<string, { params: TslDesc[]; ret: TslDesc }>;
  strings: Record<string, number>;
}

function tslToLeaves(
  d: TslDesc,
  v: unknown,
  out: (Leaf | { place: unknown })[],
  meta: TslMeta,
): void {
  switch (d.k) {
    case "scalar": {
      const name = d.name!;
      if (name === "bool") out.push(v === true ? 1 : 0);
      else if (name === "u64" || name === "i64") out.push(BigInt(v as bigint));
      else if (name === "f64" || name === "f32") out.push(v as number);
      else if (name === "usize") out.push(v as number);
      else out.push((v as number) | 0);
      return;
    }
    case "enum":
    case "nums":
      out.push((v as number) | 0);
      return;
    case "strs": {
      const n = meta.strings[v as string];
      if (n === undefined) throw new TypeError(`unknown literal ${String(v)}`);
      out.push(n);
      return;
    }
    case "arr":
      out.push({ place: v });
      out.push((v as Uint8Array).length);
      return;
    case "rec":
      for (const f of d.fields!)
        tslToLeaves(f.ty, (v as Record<string, unknown>)[f.name], out, meta);
      return;
    case "union": {
      const o = v as Record<string, unknown>;
      const variant = d.variants!.find((x) => x.tag === o[d.tag!]);
      if (variant === undefined) throw new TypeError(`unknown tag ${String(o[d.tag!])}`);
      const slots: (Leaf | { place: unknown } | null)[] = Array.from(
        { length: d.nslots! },
        () => null,
      );
      for (const f of variant.fields) {
        const leaves: (Leaf | { place: unknown })[] = [];
        tslToLeaves(f.ty, o[f.name], leaves, meta);
        f.slots.forEach((s, i) => {
          slots[s] = leaves[i]!;
        });
      }
      out.push(variant.leaf);
      for (let i = 0; i < d.nslots!; i++) {
        out.push(slots[i] ?? (d.slotTypes![i] === "i64" ? 0n : 0));
      }
      return;
    }
    default:
      throw new TypeError(`no value of type ${d.k} crosses from JS`);
  }
}

function tslFromLeaves(d: TslDesc, leaves: bigint[], at: number, meta: TslMeta): [unknown, number] {
  const signed32 = (x: bigint): number => Number(BigInt.asIntN(32, x));
  switch (d.k) {
    case "scalar": {
      const x = leaves[at]!;
      switch (d.name) {
        case "bool":
          return [BigInt.asUintN(32, x) !== 0n, at + 1];
        case "u64":
          return [BigInt.asUintN(64, x), at + 1];
        case "i64":
          return [BigInt.asIntN(64, x), at + 1];
        case "u32":
          return [Number(BigInt.asUintN(32, x)), at + 1];
        case "usize":
          return [Number(x), at + 1];
        case "f64":
          return [f64Of(x), at + 1];
        case "f32":
          return [f32Of(x), at + 1];
        default:
          return [signed32(x), at + 1];
      }
    }
    case "enum":
    case "nums":
      return [signed32(leaves[at]!), at + 1];
    case "strs": {
      const n = signed32(leaves[at]!);
      for (const [s, k] of Object.entries(meta.strings)) if (k === n) return [s, at + 1];
      return [undefined, at + 1];
    }
    case "rec": {
      const o: Record<string, unknown> = {};
      let p = at;
      for (const f of d.fields!) {
        const [v, next] = tslFromLeaves(f.ty, leaves, p, meta);
        o[f.name] = v;
        p = next;
      }
      return [o, p];
    }
    case "union": {
      const tag = signed32(leaves[at]!);
      const variant = d.variants!.find((x) => x.leaf === tag)!;
      const o: Record<string, unknown> = { [d.tag!]: variant.tag };
      for (const f of variant.fields) {
        const sub = f.slots.map((s) => leaves[at + 1 + s]!);
        o[f.name] = tslFromLeaves(f.ty, sub, 0, meta)[0];
      }
      return [o, at + 1 + d.nslots!];
    }
    default:
      return [undefined, at];
  }
}

interface TslCase {
  fn: string;
  args: unknown[];
  expect?: unknown;
  trap?: number;
}

export function buildTslImage(
  m: Module,
  meta: TslMeta,
  cases: TslCase[],
  pages?: number,
  bulkBytes = 0,
  link: ImageLinker = buildImage,
): ImageOutput {
  return timedSync("image", () => buildTslImage0(m, meta, cases, pages, bulkBytes, link));
}

function buildTslImage0(
  m: Module,
  meta: TslMeta,
  cases: TslCase[],
  pages: number | undefined,
  bulkBytes: number,
  link: ImageLinker,
): ImageOutput {
  const drv = new Driver(m, bulkBytes > 0);
  const list: { run: string; after: string }[] = [];
  cases.forEach((c, i) => {
    const sig = drv.sigOf(c.fn);
    const desc = meta.exports[c.fn]!;
    const args = c.args.map(decodeArg);
    const run = new FuncBuilder(`__case_${i}`, [], []);
    const after = new FuncBuilder(`__after_${i}`, [], []);
    const base = run.load("ptr", run.global("__mem_base"));
    const baseA = after.load("ptr", after.global("__mem_base"));
    let top = 0;
    const leaves: (Leaf | { place: unknown })[] = [];
    desc.params.forEach((d, pi) => {
      tslToLeaves(d, args[pi], leaves, meta);
    });
    const vals: number[] = [];
    const placed = new Map<unknown, number>();
    leaves.forEach((leaf, li) => {
      const t = sig.params[li]!;
      if (typeof leaf === "object") {
        const a = leaf.place as ArrayBufferView;
        let off = placed.get(a);
        if (off === undefined) {
          off = Math.ceil(top / 8) * 8;
          top = off + a.byteLength;
          placed.set(a, off);
          const to = run.at0(base, off);
          if (a.byteLength > 0) {
            const blob = drv.blob(bytesOf(a));
            run.intrinsic("mem.copy", [to, run.global(blob), run.ix(a.byteLength)]);
          }
        }
        vals.push(run.at0(base, off));
      } else vals.push(drv.leafConst(run, t, leaf));
    });
    const rets = run.call(c.fn, vals, sig.rets);
    drv.printCaseHead(run, i, "R");
    rets.forEach((r, ri) => {
      drv.printLeaf(run, sig.rets[ri]!, r);
      run.call("__rt_sp", []);
    });
    run.call("__rt_nl", []);
    run.ret();
    args.forEach((a, ai) => {
      if (!isTypedArray(a)) return;
      drv.printCaseHead(after, i, "A");
      drv.puts(after, `${ai} `);
      const off = placed.get(a);
      if (off !== undefined && a.byteLength > 0) {
        after.call("__rt_hexbytes", [after.at0(baseA, off), after.ix(a.byteLength)]);
      }
      after.call("__rt_nl", []);
    });
    after.ret();
    drv.funcs.push(run.finish(), after.finish());
    list.push({ run: `__case_${i}`, after: `__after_${i}` });
  });
  const hasModes = m.funcs.some((f) => f.name === "__page_source_use");
  if (hasModes) drv.pageRange();
  drv.main(list, (b) => {
    if (!hasModes) return;
    // The default for a test image, and a program's own setPageSource replaces it (SPEC 3.5). -1 registers nothing.
    if (pages === -1) return;
    const base = b.load("ptr", b.global("__mem_base"));
    const limit = b.load("ptr", b.global("__mem_limit"));
    drv.usePageRange(b, b.at0(base, ARENA_BYTES), limit, pages);
  });
  drv.trapMessages(meta.strings);
  return link({
    module: m,
    driverFuncs: drv.funcs,
    driverGlobals: drv.globals,
    ramBytes: DEFAULT_RAM,
    bulkBytes,
  });
}

export function tslResults(
  meta: TslMeta,
  cases: TslCase[],
  serial: string[],
): { results: CaseResult[]; problems: string[] } {
  return timedSync("results", () => tslResults0(meta, cases, serial));
}

function tslResults0(
  meta: TslMeta,
  cases: TslCase[],
  serial: string[],
): { results: CaseResult[]; problems: string[] } {
  const parsed = parseSerial(serial);
  const problems: string[] = [];
  const results: CaseResult[] = [];
  cases.forEach((c, i) => {
    const got = parsed[i];
    if (got?.finished !== true) {
      problems.push(`case ${i} (${c.fn}) never finished`);
      return;
    }
    const args = c.args.map(decodeArg);
    const retDesc = meta.exports[c.fn]!.ret;
    let result: Json;
    let pin: string | null = null;
    if (got.trap !== null) result = { trap: got.trap.code };
    else {
      const leaves = (got.leaves ?? []).map(leafBits);
      const value = retDesc.k === "void" ? undefined : tslFromLeaves(retDesc, leaves, 0, meta)[0];
      result = canon(retDesc as Parameters<typeof canon>[0], value);
    }
    const arrays: Json[] = [];
    args.forEach((a, ai) => {
      if (!isTypedArray(a)) return;
      const hex = got.arrays.get(ai) ?? "";
      if (a.byteLength > 0) bytesOf(a).set(hexToBytes(hex));
      arrays.push([ai, arrayDigest(a)]);
    });
    if (got.trap === null) {
      const value = result;
      pin = checkPin(c, value, args, retDesc as Parameters<typeof canon>[0]);
    }
    results.push({ fn: c.fn, result, arrays, pin });
  });
  return { results, problems };
}

// --- down-lowered code: arguments built in the arena, results read back from a snapshot of it

interface DownDesc {
  k: string;
  rep?: string;
  of?: DownDesc;
  nul?: string;
  off?: number;
  elem?: string;
  written?: boolean;
  id?: string;
  long?: boolean;
}
interface HeapDesc {
  k: "obj" | "vec";
  size?: number;
  slot?: number;
  elem?: DownDesc;
  written: boolean;
  long?: boolean;
  rcDesc?: number;
  holes?: boolean;
  place?: string; // R5: a printed export that places one (D36's header, JsArray's own)
  // R8: in `rc` through the TSL route, the exports that add a count to one and give one back (for an object, `place` takes no
  // argument and gives a new one at one count, the caller's)
  retain?: string;
  release?: string;
  tuple?: number;
  map?: {
    kind: "map" | "set";
    make: string;
    put: string;
    size: string;
    has: string;
    iter: string;
    step: string;
    key: string;
    val: string;
    keyDesc: DownDesc;
    valDesc: DownDesc;
  };
  fields?: { name: string; off: number; ty: DownDesc; optional: boolean }[];
  /** A `Map` or `Set`'s layout, which isn't the ABI: only this harness's reader of a dump uses it (SPEC 4.5, D47). */
  internal?: { name: string; off: number; ty: DownDesc; optional: boolean }[];
  variants?: { tag: string; value: unknown; fields: string[] }[];
}
export interface DownMetaLike {
  exports: Record<string, { params: DownDesc[]; ret: DownDesc; fallback?: boolean }>;
  heap: Record<string, HeapDesc>;
  strings: Record<string, number>;
  traps: Record<string, string>;
  memory?: "leak" | "manual" | "rc";
  exc?: { describe: string; uncaught: number; release?: string };
  // R7: a Map or Set crossing an export through the TSL route is a JsMap or JsSet (compiler/host/down.ts's DownMeta)
  tslMaps?: {
    kinds: Record<string, "map" | "set">;
    layout: { fields: Record<string, number>; setMap: number };
  };
  // R8: `rc` through the TSL route: what stands for the direct route's __rc_collect, and the live and freeing-step counts
  rcTsl?: { collect: string; live: string; steps: string };
  // R10: `rc` through the TSL route, its strings the program's own JsStr: their layout, and the pair that counts one
  rcStr?: { layout: RcStrLayout; retain: string; release: string };
}

/** Natively, a result's count is the caller's, and so is the count on each thing it placed (SPEC 4.5, D36). */
export interface RcHarness {
  /** Prints the runtime's counters after each case, and needs a build with `account`. */
  stats?: boolean;
  /** Leaves exceptions to the trap path, as a caller that doesn't ask for them gets (D36). */
  excTrap?: boolean;
  /** Runs every free that's pending after each case. Only test builds do: the release build keeps it deferred. */
  collect?: boolean;
  /** Extra serial, from code run in the driver: a test's own measurement. */
  /** Leaves out the arena and module-state dump for a case whose result and arguments are all scalars. */
  noDump?: boolean;
  /**
   * R8: `rc` through the TSL route: after each case's counts are given back (and collected, with `collect`), prints
   * `TMK:RL <case> <live objects> <freeing steps>` from the module's `__rc_live` and `__rc_steps`.
   */
  tslLive?: boolean;
  /**
   * R8: for each case, read the count of what it returns before letting go of it: `TMK:RC <case> <count>`, the count word
   * of a counted object's slot (16 bytes before it, @tsl/gc's prefix), which the caller's one count should make 1.
   */
  tslResultCount?: boolean;
  /**
   * R6: never rewinds the arena between cases, as a caller that leaves it to the module may: a lowered module's exports give
   * the per-call region back as they return (tools/r6-tests.ts's keptRun), where the direct route's call arena keeps it.
   */
  noArenaReset?: boolean;
  /** Registers this hash key first, as a caller with entropy would (SPEC 4.5, D42). */
  hashKey?: [number, number];
  /** Bytes for the RAM channel (SPEC 8.2). Tests ask for it. A benchmark or `tmk lower --target aarch64` has none, and stays as it was. */
  bulkBytes?: number;
  /** The channel or the guest going wrong on purpose, to show the harness notices (`tools/channel-tests.ts`). */
  channelFault?: {
    bulk?: BulkFault;
    wrongLeaf?: number; // this case reports its first result with its low bit flipped
    crash?: number; // this case takes a fault nothing can catch
    hang?: number; // this case never returns
  };
}

const ARRAY: Record<
  string,
  {
    new (b: ArrayBuffer, o: number, n: number): ArrayBufferView & { length: number };
    BYTES_PER_ELEMENT: number;
  }
> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
} as never;

/** What the guest was given for one case, in the order it reports addresses. */
interface Placement {
  args: unknown[];
  regions: { value: ArrayBufferView; index: number; size: number }[];
  objects: { value: unknown; index: number; desc: HeapDesc }[];
}

export class CaseBuilder {
  b: FuncBuilder;
  drv: Driver;
  meta: DownMetaLike;
  index: number;
  placed = 0;
  regionOf = new Map<
    ArrayBufferLike,
    {
      at: number;
      base: number;
      index: number;
      size: number;
      value: ArrayBufferView;
      to: number;
      long: boolean;
    }
  >();
  objects = new Map<unknown, number>();
  out: Placement;
  kept: { at: number; arr: boolean; release?: string }[] = []; // `rc`: the caller's counts, to let go of after the case

  constructor(b: FuncBuilder, drv: Driver, meta: DownMetaLike, index: number, args: unknown[]) {
    this.out = { args, regions: [], objects: [] };
    this.b = b;
    this.drv = drv;
    this.meta = meta;
    this.index = index;
  }

  report(addr: number): number {
    const n = this.placed++;
    const b = this.b;
    this.drv.printCaseHead(b, this.index, "P");
    this.drv.puts(b, `${n} `);
    b.call("__rt_hex64", [b.op("bitcast.i64", [addr], "i64")]);
    b.call("__rt_nl", []);
    return n;
  }

  collect(d: DownDesc, v: unknown, seen: Set<unknown>): void {
    if (v === null || v === undefined) return;
    if (d.k === "opt") {
      this.collect(d.of!, v, seen);
      return;
    }
    if (d.k === "arr") {
      const a = v as ArrayBufferView;
      const had = this.regionOf.get(a.buffer);
      if (had !== undefined) had.long ||= d.long === true;
      else {
        this.regionOf.set(a.buffer, {
          at: -1,
          base: a.byteOffset,
          index: 0,
          size: 0,
          value: a,
          to: a.byteOffset + a.byteLength,
          long: d.long === true,
        });
      }
      return;
    }
    if (d.k === "ref") {
      if (seen.has(v)) return;
      seen.add(v);
      const h = this.meta.heap[d.id!]!;
      if (h.k === "vec") {
        const list = v as unknown[];
        for (let i = 0; i < list.length; i++) this.collect(h.elem!, list[i], seen);
        return;
      }
      if (h.map !== undefined) {
        const mp = h.map;
        if (v instanceof Map) {
          for (const [k, x] of v as Map<unknown, unknown>) {
            this.collect(mp.keyDesc, k, seen);
            this.collect(mp.valDesc, x, seen);
          }
        } else for (const k of v as Set<unknown>) this.collect(mp.keyDesc, k, seen);
        return;
      }
      if (h.tuple !== undefined) {
        h.fields!.forEach((f, i) => {
          this.collect(f.ty, (v as unknown[])[i], seen);
        });
        return;
      }
      for (const f of h.fields!) this.collect(f.ty, (v as Record<string, unknown>)[f.name], seen);
    }
  }

  placeRegions(): void {
    const b = this.b;
    for (const [, r] of this.regionOf) {
      const a = r.value;
      const start = a.byteOffset - (a.byteOffset % 8);
      r.base = start;
      r.size = r.to - start;
      const size = r.size;
      const at =
        r.long && this.meta.memory === "rc"
          ? b.call("__rc_new", [b.ix(size), b.i32(0)], ["ptr"])[0]!
          : b.call(r.long ? this.longAlloc() : "__alloc", [b.ix(size)], ["ptr"])[0]!;
      r.at = at;
      if (r.long && this.meta.memory === "rc") this.keep(at, true);
      if (size > 0) {
        const blob = this.drv.blob(new Uint8Array(a.buffer as ArrayBuffer, start, size));
        b.intrinsic("mem.copy", [at, b.global(blob), b.ix(size)]);
      }
      r.index = this.report(at);
      this.out.regions.push({ value: a, index: r.index, size });
    }
  }

  keep(at: number, arr: boolean, release?: string): void {
    const b = this.b;
    const slot = this.kept.length;
    this.kept.push({ at: slot, arr, ...(release !== undefined ? { release } : {}) });
    b.store("ptr", b.at0(b.global(`__rc_kept_${this.index}`), slot * 8), at);
  }

  /** What a memory mode keeps, it keeps past the arena's reset, so a caller puts it there too (SPEC 4.5). */
  longAlloc(): string {
    return this.meta.memory === "manual" ? "__heap_alloc" : "__leak_alloc";
  }

  addrOf(a: ArrayBufferView): number {
    const r = this.regionOf.get(a.buffer)!;
    return this.b.at0(r.at, a.byteOffset - r.base);
  }

  writeLeaf(at: number, off: number, d: DownDesc, v: unknown): void {
    const b = this.b;
    const here = (extra = 0): number => b.at0(at, off + extra);
    switch (d.k) {
      case "num":
        if (d.rep === "f64") b.store("f64", here(), this.drv.leafConst(b, "f64", v as number));
        else b.store("i32", here(), b.i32((v as number) | 0));
        return;
      case "bool":
        // A byte, by TSL's layout (R6, D36).
        b.store("i8", here(), b.op("trunc.i8", [b.i32(v === true ? 1 : 0)], "i8"));
        return;
      case "str":
        b.store("i32", here(), b.i32(this.str(v)));
        return;
      case "string":
        if (v === null || v === undefined) return;
        {
          const p = this.placeString(v as string);
          b.store("ptr", here(), p);
          // R10: through the TSL route, the module's own retain for strings, which takes and gives a reference (i64)
          const rs = this.meta.rcStr;
          if (this.meta.memory === "rc" && rs !== undefined)
            b.call(rs.retain, [b.op("bitcast.i64", [p], "i64")], ["i64"]);
          else if (this.meta.memory === "rc") b.call("__rc_retain", [p]);
        }
        return;
      case "opt":
        if (v === null || v === undefined) return; // the slot is already zero
        b.store("i8", here(), b.op("trunc.i8", [b.i32(1)], "i8")); // a `bool` flag (R6)
        this.writeLeaf(at, off + d.off!, d.of!, v);
        return;
      case "arr":
        if (v === null || v === undefined) return;
        b.store("ptr", here(), this.addrOf(v as ArrayBufferView));
        b.store("ix", here(8), b.ix((v as Uint8Array).length));
        if (this.meta.memory === "rc" && d.long === true) {
          b.call("__rc_retain_arr", [this.addrOf(v as ArrayBufferView)]);
        }
        return;
      case "ref":
        if (v === null || v === undefined) return;
        {
          const to = this.toHeap(d, v);
          b.store("ptr", here(), to);
          const th = this.meta.heap[d.id!]!;
          if (this.meta.memory === "rc" && th.long === true) {
            // R8: through the TSL route, the module's own retain for the class, which takes and gives a reference (i64)
            if (th.retain !== undefined)
              b.call(th.retain, [b.op("bitcast.i64", [to], "i64")], ["i64"]);
            else b.call("__rc_retain", [to]);
          }
        }
        return;
    }
  }

  /** A string argument: the caller places it, in UTF-16, and holds a count on it across the call (SPEC 4.5, D36). */
  placeString(v: string): number {
    const b = this.b;
    // Printed as JsString (D67), the three string functions take and give TSL references, i64s in TIR.
    const abs = this.drv.sigOf("__str_place").rets[0] === "i64";
    const p = abs
      ? b.op("bitcast.ptr", [b.call("__str_place", [b.ix(v.length)], ["i64"])[0]!], "ptr")
      : b.call("__str_place", [b.ix(v.length)], ["ptr"])[0]!;
    // R10: through the TSL route a placed string is given back by the module's own release, as an object is (R8)
    if (this.meta.memory === "rc") this.keep(p, false, this.meta.rcStr?.release);
    if (v.length > 0) {
      const bytes = new Uint8Array(v.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < v.length; i++) view.setUint16(i * 2, v.charCodeAt(i), true);
      const units = abs
        ? b.op(
            "bitcast.ptr",
            [b.call("__str_units", [b.op("bitcast.i64", [p], "i64")], ["i64"])[0]!],
            "ptr",
          )
        : b.call("__str_units", [p], ["ptr"])[0]!;
      b.intrinsic("mem.copy", [units, b.global(this.drv.blob(bytes)), b.ix(v.length * 2)]);
    }
    return p;
  }

  /** A `Map` or `Set` argument: built by the exports its type has for that (SPEC 4.5, D36). */
  placeMap(h: HeapDesc, v: unknown): number {
    const b = this.b;
    const mp = h.map!;
    // Each call typed by the module's own signature: through the TSL route a map is a JsMap or JsSet, an i64 (R7)
    const makeRet = this.drv.sigOf(mp.make).rets[0] ?? "ptr";
    const made = b.call(mp.make, [], [makeRet])[0]!;
    const m = makeRet === "i64" ? b.op("bitcast.ptr", [made], "ptr") : made;
    const putParams = this.drv.sigOf(mp.put).params;
    this.objects.set(v, m);
    if (this.meta.memory === "rc") this.keep(m, false);
    const n = this.report(m);
    this.out.objects.push({ value: v, index: n, desc: h });
    const types: string[] = [];
    const entries: [unknown, unknown][] =
      v instanceof Map
        ? [...(v as Map<unknown, unknown>).entries()]
        : [...(v as Set<unknown>).values()].map((k) => [k, undefined] as [unknown, unknown]);
    for (const [k, x] of entries) {
      const args: number[] = [putParams[0] === "i64" ? b.op("bitcast.i64", [m], "i64") : m];
      this.toLeaves(mp.keyDesc, k, args, putParams.length > 0 ? putParams : types);
      if (mp.kind === "map")
        this.toLeaves(mp.valDesc, x, args, putParams.length > 0 ? putParams : types);
      b.call(mp.put, args, []);
    }
    return m;
  }

  str(v: unknown): number {
    const n = this.meta.strings[v as string];
    if (n === undefined) throw new TypeError(`a string this program doesn't know: ${String(v)}`);
    return n;
  }

  toHeap(d: DownDesc, v: unknown): number {
    const b = this.b;
    const seen = this.objects.get(v);
    if (seen !== undefined) return seen;
    const h = this.meta.heap[d.id!]!;
    if (h.map !== undefined) return this.placeMap(h, v);
    if (h.k === "vec") {
      const list = v as unknown[];
      const vecNew =
        h.long === true
          ? this.meta.memory === "manual"
            ? "__vec_new_heap"
            : this.meta.memory === "rc"
              ? "__vec_new_rc"
              : "__vec_new_leak"
          : "__vec_new";
      const rcVec = h.long === true && this.meta.memory === "rc";
      // Printed through the TSL route (R5): the module's own export places it, a JsArray whose header is D36's.
      const hdr =
        h.place !== undefined
          ? b.op("bitcast.ptr", [b.call(h.place, [b.ix(list.length)], ["i64"])[0]!], "ptr")
          : b.call(
              vecNew,
              rcVec
                ? [b.ix(list.length), b.ix(h.slot!), b.i32(h.rcDesc ?? 0)]
                : [b.ix(list.length), b.ix(h.slot!)],
              ["ptr"],
            )[0]!;
      this.objects.set(v, hdr);
      if (rcVec) this.keep(hdr, false, h.release);
      const n = this.report(hdr);
      this.out.objects.push({ value: v, index: n, desc: h });
      const data = b.load("ptr", hdr);
      for (let i = 0; i < list.length; i++) this.writeLeaf(data, i * h.slot!, h.elem!, list[i]);
      return hdr;
    }
    const rcObj = h.long === true && this.meta.memory === "rc";
    // D36's size is TSL's since R6, which can be under 8 (or 0); an object is allocated with at least 8, as the module's are.
    const bytes = Math.max(8, h.size!);
    // R8: through the TSL route in `rc`, the module's own placing export, a new counted object at one count, the caller's
    const at = rcObj
      ? h.place !== undefined
        ? b.op("bitcast.ptr", [b.call(h.place, [], ["i64"])[0]!], "ptr")
        : b.call("__rc_new", [b.ix(bytes), b.i32(h.rcDesc ?? 0)], ["ptr"])[0]!
      : b.call(h.long === true ? this.longAlloc() : "__alloc", [b.ix(bytes)], ["ptr"])[0]!;
    b.intrinsic("mem.fill", [at, b.i32(0), b.ix(h.size!)]);
    this.objects.set(v, at);
    if (rcObj) this.keep(at, false, h.release);
    const n = this.report(at);
    this.out.objects.push({ value: v, index: n, desc: h });
    for (const f of h.fields!) {
      const fv =
        h.tuple !== undefined
          ? (v as unknown[])[Number(f.name)]
          : (v as Record<string, unknown>)[f.name];
      this.writeLeaf(at, f.off, f.ty, fv);
    }
    return at;
  }

  toLeaves(d: DownDesc, v: unknown, out: number[], types: string[]): void {
    const b = this.b;
    switch (d.k) {
      case "num":
        if (d.rep === "f64") out.push(this.drv.leafConst(b, "f64", v as number));
        else out.push(b.i32((v as number) | 0));
        return;
      case "bool":
        out.push(b.i32(v === true ? 1 : 0));
        return;
      case "str":
        out.push(b.i32(this.str(v)));
        return;
      case "string": {
        // Printed as @tsl/jsrt's JsString (D67), a string is a TSL reference, an i64 in TIR, where the direct route's is a ptr.
        const want = types[out.length] === "i64" ? "i64" : "ptr";
        if (v === null || v === undefined) out.push(b.iconst(want, 0));
        else {
          const p = this.placeString(v as string);
          out.push(want === "i64" ? b.op("bitcast.i64", [p], "i64") : p);
        }
        return;
      }
      case "opt": {
        const missing = v === null || v === undefined;
        out.push(b.i32(missing ? 0 : 1));
        const of = d.of!;
        const zero =
          of.k === "bool" ? false : of.k === "str" ? Object.keys(this.meta.strings)[0] : 0;
        this.toLeaves(of, missing ? zero : v, out, types);
        return;
      }
      case "arr":
        if (v === null || v === undefined) {
          out.push(b.iconst("ptr", 0), b.ix(0));
          return;
        }
        out.push(this.addrOf(v as ArrayBufferView), b.ix((v as Uint8Array).length));
        return;
      case "ref": {
        // Printed through the TSL route (R5), a reference is a TSL reference, an i64 in TIR, where the direct route's is
        // a ptr: in `leak` and `manual` the same address (D36), typed by the module's own signature.
        const want = types[out.length] === "i64" ? "i64" : "ptr";
        const p = v === null || v === undefined ? b.iconst("ptr", 0) : this.toHeap(d, v);
        out.push(want === "i64" ? b.op("bitcast.i64", [p], "i64") : p);
        return;
      }
    }
  }
}

function hasWritten(d: DownDesc, meta: DownMetaLike, seen = new Set<string>()): boolean {
  if (d.k === "arr") return d.written === true;
  if (d.k === "opt") return hasWritten(d.of!, meta, seen);
  if (d.k === "ref") {
    if (seen.has(d.id!)) return false;
    seen.add(d.id!);
    const h = meta.heap[d.id!]!;
    if (h.k === "vec") return hasWritten(h.elem!, meta, seen);
    return (h.internal ?? h.fields!).some((f) => hasWritten(f.ty, meta, seen));
  }
  return false;
}

export interface DownImage {
  image: ImageOutput;
  placements: Placement[];
}

/** Whether a case can hand back or be given anything in memory, so the long-lived pages need reading. */
function touchesMemory(d: DownDesc): boolean {
  return (
    d.k === "arr" ||
    d.k === "ref" ||
    d.k === "fn" ||
    d.k === "string" ||
    (d.k === "opt" && touchesMemory(d.of!))
  );
}

function countedResult(d: DownDesc, meta: DownMetaLike): "ref" | "arr" | null {
  if (d.k === "arr") return d.long === true ? "arr" : null;
  if (d.k === "fn" || d.k === "string") return "ref";
  if (d.k === "ref") return meta.heap[d.id!]!.long === true ? "ref" : null;
  return null;
}

/** `pages` limits the page source, so a test can run out of memory (SPEC 3.10, divergence 4). */
export function buildDownImage(
  m: Module,
  meta: DownMetaLike,
  cases: LowerCase[],
  pages?: number,
  rcHarness: RcHarness = {},
  ramBytes: number = DEFAULT_RAM,
  stackBytes?: number,
  link: ImageLinker = buildImage,
): DownImage {
  return timedSync("image", () =>
    buildDownImage0(m, meta, cases, pages, rcHarness, ramBytes, stackBytes, link),
  );
}

function buildDownImage0(
  m: Module,
  meta: DownMetaLike,
  cases: LowerCase[],
  pages?: number,
  rcHarness: RcHarness = {},
  ramBytes: number = DEFAULT_RAM,
  stackBytes?: number,
  link: ImageLinker = buildImage,
): DownImage {
  const drv = new Driver(m, (rcHarness.bulkBytes ?? 0) > 0);
  drv.strLayout = (meta as { strLayout?: StrLayout }).strLayout ?? null;
  drv.rcStrLayout = meta.rcStr?.layout ?? null;
  const list: { run: string; after: string }[] = [];
  const placements: Placement[] = [];
  const isRc = meta.memory === "rc";
  const statNames = m.globals
    .filter((g) => g.name.startsWith("__rc_s_"))
    .map((g) => g.name)
    .sort();
  const userGlobals = m.globals.filter(
    (g) =>
      !g.name.startsWith("__rc_") &&
      !g.name.startsWith("__rt_") &&
      ![
        "__arena_top",
        "__arena_base",
        "__trap_args",
        "__page_source",
        "__leak_cur",
        "__leak_end",
        "__heap_heads",
        "__heap_cur",
        "__heap_end",
        "__opt_keep", // the optimiser's: a word loads it kept write to, which nothing reads (SPEC D46)
      ].includes(g.name),
  );
  cases.forEach((c, i) => {
    const sig = drv.sigOf(c.fn);
    const desc = meta.exports[c.fn]!;
    const args = c.args.map(decodeArg);
    const run = new FuncBuilder(`__case_${i}`, [], []);
    // A native caller owns the arena's lifetime: everything from the last case goes here (SPEC 4.5).
    if (rcHarness.noArenaReset !== true) run.call("__arena_reset", []);
    const cb = new CaseBuilder(run, drv, meta, i, args);
    const seen = new Set<unknown>();
    desc.params.forEach((d, pi) => {
      cb.collect(d, args[pi], seen);
    });
    cb.placeRegions();
    const leaves: number[] = [];
    desc.params.forEach((d, pi) => {
      cb.toLeaves(d, args[pi], leaves, sig.params);
    });
    // R8: through the TSL route in `rc`, a mark that the arguments are all placed and filled in. A case that trapped while
    // placing them (out of memory) leaves what it placed held, as any trap leaves counts (4.5): a half-built object can
    // have a null where its class has none, which its release function doesn't expect.
    const placedMark = isRc && meta.rcTsl !== undefined ? `__rc_placed_${i}` : null;
    if (placedMark !== null) {
      drv.globals.push({ name: placedMark, size: 8, align: 8, section: "data" });
      run.store("i64", run.global(placedMark), run.i64(1));
    }
    if (rcHarness.channelFault?.crash === i) {
      run.store("i32", run.iconst("ptr", 0x20000000), run.i32(1));
    }
    if (rcHarness.channelFault?.hang === i) {
      const spin = run.block();
      const next = run.block();
      run.br(spin);
      run.at(spin);
      run.brif(run.i32(1), spin, next);
      run.at(next);
    }
    const rets = run.call(c.fn, leaves, sig.rets);
    const owned = isRc ? countedResult(desc.ret, meta) : null;
    if (owned !== null) {
      drv.globals.push({ name: `__rc_ret_${i}`, size: 8, align: 8, section: "data" });
      // through the TSL route a reference is an i64 (R8)
      const r0 = sig.rets[0] === "i64" ? run.op("bitcast.ptr", [rets[0]!], "ptr") : rets[0]!;
      run.store("ptr", run.global(`__rc_ret_${i}`), r0);
    }
    if (meta.exc !== undefined) {
      // The caller took exceptions (D36): one reaching it is described and given back, and the case is over.
      const thrown = run.block();
      const fine = run.block();
      run.brif(run.call("__exc_pending", [], ["i32"])[0]!, thrown, fine);
      run.at(thrown);
      // Printed as TSL with exceptions desugared by the printer (D68), the value is a class reference, an i64, as is the
      // description, a JsString: each call is typed by the module's own signature.
      const takeRet = drv.sigOf("__exc_take").rets[0] ?? "ptr";
      const d = run.call("__exc_take", [], [takeRet])[0]!;
      const descRet = drv.sigOf(meta.exc.describe).rets[0] ?? "ptr";
      const t0 = run.call(meta.exc.describe, [d], [descRet])[0]!;
      const text = descRet === "i64" ? run.op("bitcast.ptr", [t0], "ptr") : t0;
      drv.printCaseHead(run, i, "X");
      drv.putString(run, text);
      run.call("__rt_nl", []);
      if (isRc && meta.exc.release !== undefined) {
        // R11: through the TSL route in `rc`, the module's own pair: the thrown value's `__exc_release`, which takes it
        // over (a null one, undefined thrown, has no count), and the description's, a string's (4.5's ABI in `rc`)
        const some = run.block();
        const done = run.block();
        run.brif(run.op("icmp.ne.i64", [d, run.iconst("i64", 0)], "i32"), some, done);
        run.at(some);
        run.call(meta.exc.release, [d]);
        run.br(done);
        run.at(done);
        if (meta.rcStr?.release !== undefined) run.call(meta.rcStr.release, [t0]);
      } else if (isRc) {
        run.call("__rc_release", [d]);
        run.call("__rc_release", [text]);
      }
      run.ret();
      run.at(fine);
    }
    drv.printCaseHead(run, i, "R");
    rets.forEach((r, ri) => {
      if (rcHarness.channelFault?.wrongLeaf === i && ri === 0) {
        const t = sig.rets[ri]!;
        const w = t === "f64" ? run.op("bitcast.i64", [r], "i64") : r;
        const wt = t === "f64" ? "i64" : t;
        const flipped = run.op(`xor.${wt}`, [w, run.iconst(wt, 1)], wt);
        drv.printLeaf(run, wt, flipped);
      } else drv.printLeaf(run, sig.rets[ri]!, r);
      run.call("__rt_sp", []);
    });
    run.call("__rt_nl", []);
    run.ret();
    const after = new FuncBuilder(`__after_${i}`, [], []);
    const quiet = rcHarness.noDump === true && ![...desc.params, desc.ret].some(touchesMemory);
    const baseVal = after.load("ptr", after.global("__arena_base"));
    const topVal = after.load("ptr", after.global("__arena_top"));
    if (!quiet) after.call("__rt_dump", [baseVal, topVal]);
    if (meta.memory !== undefined && [...desc.params, desc.ret].some(touchesMemory)) {
      after.call("__rt_dump", [
        after.load("ptr", after.global("__range_start")),
        after.load("ptr", after.global("__range_cur")),
      ]);
    }
    for (const g of quiet ? [] : userGlobals) {
      if (g.size === 0) continue;
      const a = after.global(g.name);
      after.call("__rt_dump", [a, after.at0(a, g.size)]);
    }
    if (isRc) {
      // The caller lets go of its result and of what it placed. A trapped case has no result (SPEC 4.5, D36).
      if (owned !== null) {
        const r = after.load("ptr", after.global(`__rc_ret_${i}`));
        const rel =
          desc.ret.k === "ref"
            ? meta.heap[desc.ret.id!]!.release
            : desc.ret.k === "string"
              ? meta.rcStr?.release
              : undefined;
        if (rel !== undefined) {
          // R8: the module's own release (which takes its argument over), for a result that isn't null
          const some = after.block();
          const done = after.block();
          const ri = after.op("bitcast.i64", [r], "i64");
          after.brif(after.op("icmp.ne.i64", [ri, after.iconst("i64", 0)], "i32"), some, done);
          after.at(some);
          if (rcHarness.tslResultCount === true) {
            drv.puts(after, `TMK:RC ${i} `);
            // the count is the word's low 32 bits; above them, a class in a cycle keeps the collector's state (D41)
            const word = after.load("i64", after.at0(r, -16));
            after.call("__rt_dec", [after.op("and.i64", [word, after.i64(0xffffffff)], "i64")]);
            after.call("__rt_nl", []);
          }
          after.call(rel, [ri]);
          after.br(done);
          after.at(done);
        } else after.call(owned === "arr" ? "__rc_release_arr" : "__rc_release", [r]);
      }
      if (cb.kept.length > 0) {
        drv.globals.push({
          name: `__rc_kept_${i}`,
          size: cb.kept.length * 8,
          align: 8,
          section: "data",
        });
      }
      let keptDone: ReturnType<typeof after.block> | null = null;
      if (placedMark !== null && cb.kept.length > 0) {
        const go = after.block();
        keptDone = after.block();
        const mark = after.load("i64", after.global(placedMark));
        after.brif(after.op("icmp.ne.i64", [mark, after.i64(0)], "i32"), go, keptDone);
        after.at(go);
      }
      cb.kept.forEach((k) => {
        const kept = after.load("ptr", after.at0(after.global(`__rc_kept_${i}`), k.at * 8));
        if (k.release !== undefined) {
          // R8: the module's own release takes a reference that isn't null; a case that trapped while placing its
          // arguments left the rest of its list zero
          const ki = after.op("bitcast.i64", [kept], "i64");
          const some = after.block();
          const done = after.block();
          after.brif(after.op("icmp.ne.i64", [ki, after.iconst("i64", 0)], "i32"), some, done);
          after.at(some);
          after.call(k.release, [ki]);
          after.br(done);
          after.at(done);
        } else after.call(k.arr ? "__rc_release_arr" : "__rc_release", [kept]);
      });
      if (keptDone !== null) {
        after.br(keptDone);
        after.at(keptDone);
      }
      if (rcHarness.collect === true) after.call(meta.rcTsl?.collect ?? "__rc_collect", []);
      if (rcHarness.tslLive === true && meta.rcTsl !== undefined) {
        drv.puts(after, `TMK:RL ${i}`);
        for (const f of [meta.rcTsl.live, meta.rcTsl.steps]) {
          after.call("__rt_sp", []);
          after.call("__rt_dec", [after.op("bitcast.i64", [after.call(f, [], ["ix"])[0]!], "i64")]);
        }
        after.call("__rt_nl", []);
      }
      if (rcHarness.stats === true) {
        drv.puts(after, `TMK:RS ${i}`);
        for (const name of statNames) {
          after.call("__rt_sp", []);
          after.call("__rt_dec", [after.load("i64", after.global(name))]);
        }
        after.call("__rt_nl", []);
      }
    }
    after.ret();
    drv.funcs.push(run.finish(), after.finish());
    list.push({ run: `__case_${i}`, after: `__after_${i}` });
    placements.push(cb.out);
  });
  drv.arenaUse();
  if (meta.memory !== undefined) drv.pageRange();
  drv.main(list, (b) => {
    // The runtime is the arena provider in this phase (SPEC 4.5).
    const base = b.load("ptr", b.global("__mem_base"));
    const limit = b.load("ptr", b.global("__mem_limit"));
    if (meta.memory === undefined) b.call("__arena_use", [base, limit]);
    else {
      // A memory mode has both: the arena for what's bounded, and pages for what isn't.
      const mid = b.at0(base, ARENA_BYTES);
      b.call("__arena_use", [base, mid]);
      drv.usePageRange(b, mid, limit, pages);
    }
    if (rcHarness.hashKey !== undefined && m.funcs.some((f) => f.name === "__hash_key_use")) {
      b.call("__hash_key_use", [b.i32(rcHarness.hashKey[0]), b.i32(rcHarness.hashKey[1])]);
    }
    if (meta.exc !== undefined && rcHarness.excTrap !== true) b.call("__exc_catch_use", [b.i32(1)]);
    if (meta.exc !== undefined) {
      // Recursion past this throws RangeError, as V8's does past its own (D49): the stack, less a margin to throw in.
      const stack = stackBytes ?? 8 * 1024 * 1024;
      const margin = Math.min(256 * 1024, stack >> 2);
      const sp = b.op("bitcast.i64", [b.intrinsic("native.sp", [], ["ptr"])[0]!], "i64");
      const lim = b.op("sub.i64", [sp, b.i64(stack - margin - 4096)], "i64");
      b.call("__exc_stack_use", [b.op("bitcast.ptr", [lim], "ptr")]);
    }
    b.call("__init", []);
  });
  drv.trapMessages(meta.strings);
  return {
    image: link({
      module: m,
      driverFuncs: drv.funcs,
      driverGlobals: drv.globals,
      ramBytes,
      bulkBytes: rcHarness.bulkBytes ?? 0,
      ...(rcHarness.channelFault?.bulk !== undefined
        ? { bulkFault: rcHarness.channelFault.bulk }
        : {}),
      ...(stackBytes !== undefined ? { stackBytes } : {}),
    }),
    placements,
  };
}

/** The counters of a build with `account`, one line per case. */
export function rcStatLines(meta: Module, serial: string[]): Record<string, number>[] {
  const names = meta.globals
    .filter((g) => g.name.startsWith("__rc_s_"))
    .map((g) => g.name.slice("__rc_s_".length))
    .sort();
  const out: Record<string, number>[] = [];
  for (const line of serial) {
    if (!line.startsWith("TMK:RS ")) continue;
    const parts = line.split(" ");
    const i = Number(parts[1]);
    const rec: Record<string, number> = {};
    names.forEach((n, k) => {
      rec[n] = Number(parts[k + 2]);
    });
    out[i] = rec;
  }
  return out;
}

/** A sparse view of guest memory, as the snapshot left it, by 4 KiB page. Unreported bytes were zero. */
const PAGE = 4096;

function nibble(c: number): number {
  return c <= 57 ? c - 48 : c - 87;
}

class GuestMem {
  pages = new Map<number, Uint8Array>();
  constructor(
    chunks: { addr: number; hex: string }[],
    channel?: Buffer,
    ranges: [number, number][] = [],
  ) {
    if (channel !== undefined) {
      for (const [from, to] of ranges) this.fromChannel(channel, from, to);
    }
    for (const c of chunks) {
      const n = c.hex.length >> 1;
      for (let i = 0; i < n; i++) {
        const a = c.addr + i;
        const key = a - (a % PAGE);
        let p = this.pages.get(key);
        if (p === undefined) {
          p = new Uint8Array(PAGE);
          this.pages.set(key, p);
        }
        p[a - key] = (nibble(c.hex.charCodeAt(i * 2)) << 4) | nibble(c.hex.charCodeAt(i * 2 + 1));
      }
    }
  }
  /** Lines of `TMK:M <16 hex digits> <hex>\\n`, a byte range of the channel. */
  fromChannel(b: Buffer, from: number, to: number): void {
    let at = from;
    while (at < to) {
      let addr = 0;
      for (let i = at + 6; i < at + 22; i++) addr = addr * 16 + nibble(b[i]!);
      let q = at + 23;
      let a = addr;
      let key = a - (a % PAGE);
      let p = this.pages.get(key);
      while (q + 1 < to && b[q] !== 10) {
        if (a - key >= PAGE || p === undefined) {
          key = a - (a % PAGE);
          p = this.pages.get(key);
          if (p === undefined) {
            p = new Uint8Array(PAGE);
            this.pages.set(key, p);
          }
        }
        p[a - key] = (nibble(b[q]!) << 4) | nibble(b[q + 1]!);
        a++;
        q += 2;
      }
      at = q + 1;
    }
  }
  bytes(addr: number, n: number): Uint8Array {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const a = addr + i;
      const key = a - (a % PAGE);
      const at = a - key;
      const k = Math.min(n - i, PAGE - at);
      const p = this.pages.get(key);
      if (p !== undefined) out.set(p.subarray(at, at + k), i);
      i += k;
    }
    return out;
  }
  u8(addr: number): number {
    return this.bytes(addr, 1)[0]!;
  }
  u32(addr: number): number {
    return new DataView(this.bytes(addr, 4).buffer).getUint32(0, true);
  }
  i32(addr: number): number {
    return new DataView(this.bytes(addr, 4).buffer).getInt32(0, true);
  }
  f64(addr: number): number {
    return new DataView(this.bytes(addr, 8).buffer).getFloat64(0, true);
  }
}

/** A closure in a result: a native caller has an address, and strictCanon only says it's a function. */
const aFunction = (): void => undefined;

class CaseReader {
  mem: GuestMem;
  meta: DownMetaLike;
  stringOf = new Map<number, string>();
  jsOf = new Map<string | number, unknown>();
  regions: { at: number; size: number; value: ArrayBufferView; base: number }[] = [];
  /**
   * macos-arm64 (tools/macho-tests.ts): the guest's addresses are above 4 GiB, so a stored reference is read as its low 48
   * bits (D53's format). Unset, as on bare metal (RAM below 4 GiB), a reference is read as its low 32 bits, as it always was.
   */
  wide: boolean;

  constructor(mem: GuestMem, meta: DownMetaLike, wide = false) {
    this.mem = mem;
    this.meta = meta;
    this.wide = wide;
    for (const [s, n] of Object.entries(meta.strings)) this.stringOf.set(n, s);
  }
  /** A stored reference's address. */
  ptr(at: number): number {
    if (!this.wide) return this.mem.u32(at);
    return this.mem.u32(at) + (this.mem.u32(at + 4) & 0xffff) * 2 ** 32;
  }
  nullish(nul: string | undefined): null | undefined {
    return nul === "null" ? null : undefined;
  }
  readLeaf(at: number, d: DownDesc): unknown {
    const m = this.mem;
    switch (d.k) {
      case "num":
        if (d.rep === "f64") return m.f64(at);
        return d.rep === "u32" ? m.u32(at) : m.i32(at);
      case "bool":
        return m.u8(at) !== 0; // a byte, by TSL's layout (R6, D36)
      case "str":
        return this.stringOf.get(m.i32(at));
      case "string": {
        const p = this.ptr(at);
        return p === 0 ? this.nullish(d.nul) : this.readString(p);
      }
      case "opt":
        return m.u8(at) === 0 ? this.nullish(d.nul) : this.readLeaf(at + d.off!, d.of!);
      case "arr": {
        const p = this.ptr(at);
        if (p === 0) return this.nullish(d.nul);
        return this.arrayOut(d, p, m.u32(at + 8));
      }
      case "ref": {
        const p = this.ptr(at);
        return p === 0 ? this.nullish(d.nul) : this.fromHeap(d, p);
      }
      case "fn":
        return this.ptr(at) === 0 ? this.nullish(d.nul) : aFunction;
      default:
        return undefined;
    }
  }
  /**
   * A run-time string: [len: u32][hash: u32][off: i64], with its units at p + off (SPEC 4.5, D36); or, printed as
   * @tsl/jsrt's JsString (D67), a JsFlat or a JsView as the build's `strLayout` says, told apart by the class id at p.
   */
  readString(p: number): string {
    const m = this.mem;
    const word = (at: number): number =>
      Number(BigInt.asIntN(64, (BigInt(m.u32(at + 4)) << 32n) | BigInt(m.u32(at))));
    const L = (this.meta as { strLayout?: StrLayout }).strLayout;
    const R = this.meta.rcStr?.layout;
    let len: number;
    let at: number;
    if (R !== undefined) {
      // R10: the program's own JsStr in `rc`: its own units where its buffer is null, its buffer's from its start otherwise
      len = m.u32(p + R.len);
      const buf = word(p + R.buf);
      at = buf === 0 ? p + R.units : buf + R.bufUnits + 2 * m.u32(p + R.start);
    } else if (L === undefined) {
      len = m.u32(p);
      at = p + word(p + 8);
    } else {
      const id = m.u32(p);
      if (id === L.flat.id) {
        len = m.u32(p + L.flat.len);
        at = p + L.flat.units;
      } else if (id === L.view.id) {
        len = m.u32(p + L.view.len);
        at = word(p + L.view.addr);
      } else
        throw new Error(
          `a string at 0x${p.toString(16)} has class id ${id}, neither JsFlat's nor JsView's`,
        );
    }
    let s = "";
    for (let i = 0; i < len; i++) {
      const b = m.bytes(at + i * 2, 2);
      s += String.fromCharCode(b[0]! | (b[1]! << 8));
    }
    return s;
  }
  arrayOut(d: DownDesc, p: number, len: number): unknown {
    const Arr = ARRAY[d.elem!]!;
    for (const r of this.regions) {
      if (p >= r.at && p + len * Arr.BYTES_PER_ELEMENT <= r.at + r.size) {
        return new Arr(r.value.buffer as ArrayBuffer, r.base + (p - r.at), len);
      }
    }
    const key = `${p}:${len}:${d.elem!}`;
    const hit = this.jsOf.get(key);
    if (hit !== undefined) return hit;
    const bytes = this.mem.bytes(p, len * Arr.BYTES_PER_ELEMENT);
    const out = new Arr(bytes.buffer as ArrayBuffer, 0, len);
    this.jsOf.set(key, out);
    return out;
  }
  fromHeap(d: DownDesc, p: number): unknown {
    const hit = this.jsOf.get(p);
    if (hit !== undefined) return hit;
    const h = this.meta.heap[d.id!]!;
    if (h.k === "vec") {
      const out: unknown[] = [];
      this.jsOf.set(p, out);
      this.fillVec(h, out, p);
      return out;
    }
    if (h.map !== undefined) {
      const made: Map<unknown, unknown> | Set<unknown> =
        h.map.kind === "map" ? new Map() : new Set();
      this.jsOf.set(p, made);
      this.fillMap(h, made, p, d.id);
      return made;
    }
    if (h.tuple !== undefined) {
      const made: unknown[] = Array.from({ length: h.tuple });
      this.jsOf.set(p, made);
      h.fields!.forEach((f) => {
        made[Number(f.name)] = this.readLeaf(p + f.off, f.ty);
      });
      return made;
    }
    const out: Record<string, unknown> = {};
    this.jsOf.set(p, out);
    this.fillObj(h, out, p);
    return out;
  }
  /**
   * A map's entries from a dump, in insertion order, by the runtime's own layout (compiler/rt/map.ts), which this reader is
   * the one user of: a native caller has the accessors in DownMeta's `map` (SPEC 4.5, D47). A chain of 0 is a deleted entry.
   * During a move, what's been moved comes first, then what hasn't, still in the old table, then what came after.
   */
  fillMap(
    h: HeapDesc,
    out: Map<unknown, unknown> | Set<unknown>,
    p: number,
    id?: number | string,
  ): void {
    const m = this.mem;
    const tm = (this.meta as DownMetaLike).tslMaps;
    if (tm !== undefined && id !== undefined && tm.kinds[String(id)] !== undefined) {
      this.fillJsMap(h, out, p, tm.kinds[String(id)]!, tm.layout);
      return;
    }
    const fieldOf = (hd: HeapDesc, name: string): { off: number; ty: DownDesc } =>
      (hd.internal ?? hd.fields!).find((x) => x.name === name)!;
    type V = { data: number; len: number; slot: number; elem: DownDesc };
    const vec = (hd: HeapDesc, at: number, name: string): V => {
      const f = fieldOf(hd, name);
      const vp = this.ptr(at + f.off);
      const vh = this.meta.heap[f.ty.id!]!;
      return { data: this.ptr(vp), len: m.u32(vp + 8), slot: vh.slot!, elem: vh.elem! };
    };
    const num = (name: string): number => {
      const f = fieldOf(h, name);
      return this.readLeaf(p + f.off, f.ty) as number;
    };
    const isMap = h.map!.kind === "map";
    const table = (hd: HeapDesc, at: number): { keys: V; vals: V | null; chain: V } => ({
      keys: vec(hd, at, "keys"),
      vals: isMap ? vec(hd, at, "vals") : null,
      chain: vec(hd, at, "chain"),
    });
    const now = table(h, p);
    const link = (t: { chain: V }, i: number): number =>
      this.readLeaf(t.chain.data + i * t.chain.slot, t.chain.elem) as number;
    out.clear();
    const take = (t: { keys: V; vals: V | null }, i: number): void => {
      const k = this.readLeaf(t.keys.data + i * t.keys.slot, t.keys.elem);
      if (out instanceof Map)
        out.set(k, this.readLeaf(t.vals!.data + i * t.vals!.slot, t.vals!.elem));
      else out.add(k);
    };
    const oldF = fieldOf(h, "old");
    const op = this.ptr(p + oldF.off);
    if (op === 0) {
      for (let i = 0; i < now.keys.len; i++) if (link(now, i) !== 0) take(now, i);
      return;
    }
    const old = table(this.meta.heap[oldF.ty.id!]!, op);
    const [mv, end, to, base] = [num("mv"), num("end"), num("to"), num("base")];
    for (let i = 0; i < to; i++) if (link(now, i) !== 0) take(now, i);
    for (let i = mv; i < end; i++) if (link(old, i) > 0) take(old, i);
    for (let i = base; i < now.keys.len; i++) if (link(now, i) !== 0) take(now, i);
  }
  /**
   * R7: a map the TSL route made, a JsMap (or a JsSet holding one in place), read from a dump by JsMap's layout as tslc laid
   * it out (DownMeta's tslMaps), in the order JsMap's own cursor gives (ex-jsrt-map.ts's advance): its table from 0, and
   * during a move, where the move has got to, what's still in the old table from there, then what came after the move
   * began. An entry whose chain word is 0 is deleted; in the old table, one at or past 2^31 has moved.
   */
  fillJsMap(
    h: HeapDesc,
    out: Map<unknown, unknown> | Set<unknown>,
    p0: number,
    kind: "map" | "set",
    lay: { fields: Record<string, number>; setMap: number },
  ): void {
    const m = this.mem;
    const p = kind === "set" ? p0 + lay.setMap : p0;
    const F = lay.fields;
    const mp = h.map!;
    const slotOf = (d: DownDesc): number =>
      d.k === "num" ? (d.rep === "f64" ? 8 : 4) : d.k === "bool" ? 1 : 8;
    // A JsArray held in place in the JsMap (tslc's jsMapLayout checks it): its buffer's address at 0 and its length at 8,
    // D36's header
    const arr = (field: string): { data: number; len: number } => {
      const a = p + F[field]!;
      return { data: this.ptr(a), len: m.u32(a + 8) };
    };
    const keys = arr("keys");
    const vals = kind === "map" ? arr("vals") : null;
    const chain = arr("chain");
    const ks = slotOf(mp.keyDesc);
    const vs = kind === "map" ? slotOf(mp.valDesc) : 0;
    out.clear();
    const take = (k: { data: number }, v: { data: number } | null, i: number): void => {
      const key = this.readLeaf(k.data + i * ks, mp.keyDesc);
      if (out instanceof Map) out.set(key, this.readLeaf(v!.data + i * vs, mp.valDesc));
      else out.add(key);
    };
    const live = (c: { data: number }, i: number): number => m.u32(c.data + i * 4);
    const moving = m.u8(p + F.moving!) !== 0;
    const used = keys.len;
    // A table no dump could hold is a layout read wrong: said, not walked
    if (used > 1 << 24 || chain.len < used)
      throw new Error(
        `a JsMap at ${p} read as ${used} keys and ${chain.len} chain words (R7's tslMaps layout)`,
      );
    if (!moving) {
      for (let i = 0; i < used; i++) if (live(chain, i) !== 0) take(keys, vals, i);
      return;
    }
    const [mv, end, to, base] = ["mv", "end", "to", "base"].map((n) => m.u32(p + F[n]!)) as [
      number,
      number,
      number,
      number,
    ];
    const okeys = arr("okeys");
    const ovals = kind === "map" ? arr("ovals") : null;
    const ochain = arr("ochain");
    let pos = 0;
    for (; pos < used; pos++) {
      if (pos === to && pos < base) break;
      if (live(chain, pos) !== 0) take(keys, vals, pos);
    }
    if (pos === to && pos < base) {
      for (let i = mv; i < end; i++) {
        const c = live(ochain, i);
        if (c !== 0 && c < 0x80000000) take(okeys, ovals, i);
      }
      for (pos = base; pos < used; pos++) if (live(chain, pos) !== 0) take(keys, vals, pos);
    }
  }

  fillObj(h: HeapDesc, out: Record<string, unknown>, p: number): void {
    const names = this.variantFields(h, p);
    for (const f of h.fields!) {
      if (names !== null && !names.includes(f.name)) continue;
      const v = this.readLeaf(p + f.off, f.ty);
      if (v === undefined && f.optional) {
        delete out[f.name];
        continue;
      }
      out[f.name] = v;
    }
  }
  variantFields(h: HeapDesc, p: number): string[] | null {
    if (h.variants === undefined || h.variants.length === 0) return null;
    const tagName = h.variants[0]!.tag;
    const tag = h.fields!.find((f) => f.name === tagName);
    if (tag === undefined) return null;
    const value = this.readLeaf(p + tag.off, tag.ty);
    return h.variants.find((v) => v.value === value)?.fields ?? null;
  }
  fillVec(h: HeapDesc, out: unknown[], p: number): void {
    const m = this.mem;
    const data = this.ptr(p);
    const len = m.u32(p + 8);
    out.length = len;
    for (let i = 0; i < len; i++) {
      const at = data + i * h.slot!;
      if (h.holes === true && m.u32(at) === 0 && h.elem!.nul === undefined) {
        delete out[i];
        continue;
      }
      out[i] = this.readLeaf(at, h.elem!);
    }
  }
  fromLeaves(d: DownDesc, r: string[], at: number): [unknown, number] {
    const bits = (i: number): bigint => leafBits(r[i]!);
    const i32 = (i: number): number => Number(BigInt.asIntN(32, bits(i)));
    const u32 = (i: number): number => Number(BigInt.asUintN(32, bits(i)));
    // A reference leaf: its low 32 bits, or 48 with `wide` (macos-arm64)
    const ref = (i: number): number => (this.wide ? Number(BigInt.asUintN(48, bits(i))) : u32(i));
    switch (d.k) {
      case "num":
        if (d.rep === "f64") return [f64Of(bits(at)), at + 1];
        return [d.rep === "u32" ? u32(at) : i32(at), at + 1];
      case "bool":
        return [i32(at) !== 0, at + 1];
      case "str":
        return [this.stringOf.get(i32(at)), at + 1];
      case "string":
        return [ref(at) === 0 ? this.nullish(d.nul) : this.readString(ref(at)), at + 1];
      case "opt": {
        const [v, next] = this.fromLeaves(d.of!, r, at + 1);
        return [i32(at) === 0 ? this.nullish(d.nul) : v, next];
      }
      case "arr":
        if (ref(at) === 0) return [this.nullish(d.nul), at + 2];
        return [this.arrayOut(d, ref(at), Number(bits(at + 1))), at + 2];
      case "ref":
        return [ref(at) === 0 ? this.nullish(d.nul) : this.fromHeap(d, ref(at)), at + 1];
      case "fn":
        return [ref(at) === 0 ? this.nullish(d.nul) : aFunction, at + 1];
      default:
        return [undefined, at];
    }
  }
}

/** The serial message of a lowered throw back to JS's text: a non-integer float comes as bits. */
function throwResult(code: number, message: string, meta: DownMetaLike): unknown {
  if (meta.exc !== undefined && code === meta.exc.uncaught) {
    const prefix = "$uncaught: ";
    return thrownFromDesc(
      JSON.parse(
        unescapeUnits(message.startsWith(prefix) ? message.slice(prefix.length) : message),
      ) as ThrownDesc,
    );
  }
  const site = meta.traps[String(code)];
  if (site === undefined) return { trap: code };
  const { ctor } = JSON.parse(site) as { ctor: string };
  const prefix = `${ctor}: `;
  const text = (message.startsWith(prefix) ? message.slice(prefix.length) : message)
    .replace(/\{([0-9a-f]{16})\}/g, (_, h: string) => String(f64Of(BigInt(`0x${h}`))))
    .replace(/\{u([0-9a-f]{4})\}/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replaceAll("\\n", "\n");
  return { threw: ERROR_NAMES.has(ctor) ? ctor : "Error", message: text };
}

export function downResults(
  meta: DownMetaLike,
  cases: LowerCase[],
  placements: Placement[],
  serial: string[],
  wide = false, // macos-arm64: references read as 48 bits (CaseReader's `wide`)
): { results: LowerCaseResult[]; problems: string[] } {
  return timedSync("results", () => downResults0(meta, cases, placements, serial, wide));
}

function downResults0(
  meta: DownMetaLike,
  cases: LowerCase[],
  placements: Placement[],
  serial: string[],
  wide: boolean,
): { results: LowerCaseResult[]; problems: string[] } {
  const parsed = parseSerial(serial);
  const problems: string[] = [];
  const results: LowerCaseResult[] = [];
  cases.forEach((c, i) => {
    const got = parsed[i];
    if (got?.finished !== true) {
      problems.push(`case ${i} (${c.fn}) never finished`);
      return;
    }
    const args = placements[i]!.args;
    const desc = meta.exports[c.fn]!;
    const reader = new CaseReader(
      new GuestMem(got.memory, got.channel, got.memoryRanges),
      meta,
      wide,
    );
    const place = placements[i]!;
    for (const r of place.regions) {
      const at = Number(got.placed.get(r.index) ?? 0n);
      const start = r.value.byteOffset - (r.value.byteOffset % 8);
      reader.regions.push({ at, size: r.size, value: r.value, base: start });
    }
    for (const o of place.objects) reader.jsOf.set(Number(got.placed.get(o.index) ?? 0n), o.value);
    // Copied back into JS only where the program writes through them, as the Wasm glue does.
    if (desc.params.some((d) => hasWritten(d, meta))) {
      for (const r of reader.regions) {
        const bytes = reader.mem.bytes(r.at, r.size);
        new Uint8Array(r.value.buffer as ArrayBuffer, r.base, r.size).set(bytes);
      }
    }
    for (const o of place.objects) {
      if (!o.desc.written) continue;
      const p = Number(got.placed.get(o.index) ?? 0n);
      if (o.desc.k === "vec") reader.fillVec(o.desc, o.value as unknown[], p);
      else if (o.desc.map !== undefined) {
        reader.fillMap(
          o.desc,
          o.value as Map<unknown, unknown>,
          p,
          Object.keys(meta.heap).find((k) => meta.heap[k] === o.desc),
        );
      } else reader.fillObj(o.desc, o.value as Record<string, unknown>, p);
    }
    let result: unknown;
    try {
      if (got.trap !== null) result = throwResult(got.trap.code, got.trap.message, meta);
      else if (got.thrown !== null)
        result = thrownFromDesc(JSON.parse(unescapeUnits(got.thrown)) as ThrownDesc);
      else {
        const r = reader.fromLeaves(desc.ret, got.leaves ?? [], 0)[0];
        result = { value: strictCanon(desc.ret.k === "void" ? undefined : r) };
      }
    } catch (e) {
      problems.push(`case ${i}: reading the result: ${String(e)}`);
      result = { missing: true };
    }
    results.push({ fn: c.fn, result, args: strictCanon(args) });
  });
  return { results, problems };
}
