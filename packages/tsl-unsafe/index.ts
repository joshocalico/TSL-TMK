// @tsl/unsafe: the host's simulation of raw memory (SPEC 3.5, 3.8, Appendix A). Scalars live in simulated
// bytes. An object can't live in bytes, so a reference through a Ptr occupies its bytes as a handle into a
// table here, and an object placed in a slot stays on the JS side, keyed by that slot. Natively all of this
// is real memory operations with no overhead, and element descriptors are compile-time constants.
import {
  arrayCtorOf,
  hostAddress,
  hostAttachTail,
  hostSetTailMaker,
  hostTailOf,
  hostReadScalar,
  hostView,
  hostWriteScalar,
  layoutOf,
  TslTrap,
  type ArrayOf,
  type bool,
  type MmioDesc,
  type MmioRef,
  type RegMap,
  type ScalarDesc,
  type u64,
  type u32,
  type usize,
} from "@tsl/core";

// --- simulated memory regions
interface Region {
  base: number;
  mem: DataView;
}
const regions: Region[] = []; // in the order mapped: the first that holds an address is the one it's in
// R8: the same regions sorted by base, searched by bisection, while no two overlap (they never have: each family of
// regions takes fresh addresses). A program that churns tails maps thousands of them, and a scan of every one at every
// access was most of a printed program's time on the host (frag.ts on JSC: 65 s, 61% of it here).
const sorted: Region[] = [];
let overlapping = false;
let last: Region | null = null;

/** Maps a zeroed simulated region. Tests and host page sources call this. */
export function hostMapMemory(base: number, size: number): DataView {
  const mem = new DataView(new ArrayBuffer(size));
  const r = { base, mem };
  regions.push(r);
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.base < base) lo = mid + 1;
    else hi = mid;
  }
  const before = sorted[lo - 1];
  const after = sorted[lo];
  if (
    (before !== undefined && before.base + before.mem.byteLength > base) ||
    (after !== undefined && after.base < base + size)
  )
    overlapping = true;
  sorted.splice(lo, 0, r);
  return mem;
}

function find(a: number): Region {
  const l = last;
  if (l !== null && !overlapping && a >= l.base && a < l.base + l.mem.byteLength) return l;
  if (overlapping) {
    for (const r of regions) if (a >= r.base && a < r.base + r.mem.byteLength) return r;
  } else {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = sorted[mid]!;
      if (a < r.base) hi = mid - 1;
      else if (a >= r.base + r.mem.byteLength) lo = mid + 1;
      else {
        last = r;
        return r;
      }
    }
  }
  // Natively, an access near address 0 faults as a null dereference (SPEC 3.10).
  throw new TslTrap(a < 4096 ? 6 : 2);
}

export function viewAt<T extends object>(cls: new () => T, addr: u64): T {
  const a = Number(addr);
  const r = find(a);
  return hostView(cls, r.mem, a - r.base, a);
}

export function bytesAt(addr: u64, len: usize): Uint8Array {
  const a = Number(addr);
  const r = find(a);
  return new Uint8Array(r.mem.buffer as ArrayBuffer, a - r.base, len);
}

let nextStatic = 0x7000_0000;

export function staticView<T extends object>(cls: new () => T, align: usize = 16): T {
  const l = layoutOf(cls as never);
  const a = Math.max(align, l.align);
  nextStatic = Math.ceil(nextStatic / a) * a;
  const base = nextStatic;
  nextStatic += l.size;
  return hostView(cls, hostMapMemory(base, l.size), 0, base);
}

export function addrOf(s: object): u64 {
  const a = hostAddress(s);
  if (a === undefined) throw new TslTrap(11);
  return BigInt(a);
}

// --- MMIO, function addresses and assembly: typecheck only until the kernel uses them
interface MmioBus {
  read(addr: number, width: number): number | bigint;
  write(addr: number, width: number, v: number | bigint): void;
}
let bus: MmioBus | null = null;
export const hostSetBus = (b: MmioBus): void => {
  bus = b;
};

export function mmioAt<R extends RegMap>(d: MmioDesc<R>, base: u64): MmioRef<MmioDesc<R>> {
  const out: Record<string, unknown> = {};
  for (const [n, x] of Object.entries(d.regs)) {
    const a = Number(base) + x.offset;
    out[n] = {
      read: () => bus!.read(a, x.width),
      write: (v: number | bigint) => bus!.write(a, x.width, v),
    };
  }
  return out as MmioRef<MmioDesc<R>>;
}

const fnAddrs = new Map<unknown, bigint>();
let nextFn = 0x4000_0000n;
export function fnAddr(f: (...args: never[]) => unknown): u64 {
  let a = fnAddrs.get(f);
  if (a === undefined) {
    a = nextFn;
    nextFn += 0x100n;
    fnAddrs.set(f, a);
  }
  return a;
}

const stubs = new WeakMap<object, (...a: unknown[]) => unknown>();
export function asmFn<F extends (...args: never[]) => unknown>(_body: TemplateStringsArray): F {
  const f = (...a: unknown[]): unknown => {
    const s = stubs.get(f);
    if (s === undefined) throw new TslTrap(12);
    return s(...a);
  };
  return f as unknown as F;
}
export function hostStub<F extends (...args: never[]) => unknown>(f: F, impl: F): void {
  stubs.set(f, impl as unknown as (...a: unknown[]) => unknown);
}
export function setLogSink(_sink: (bytes: Uint8Array) => void): void {}

// --- element descriptors
export type Elem<T> = {
  readonly size: usize;
  readonly align: usize;
  readonly __elem?: T;
};
interface ElemOps<T> extends Elem<T> {
  read(m: DataView, at: number): T;
  write(m: DataView, at: number, v: T): void;
  desc?: ScalarDesc;
}
export type ElemOf<T> = Elem<T> | ((() => T) & { readonly desc: unknown });

const objects: unknown[] = [null];
const handleOf = new Map<unknown, number>([[null, 0]]);

function objectElem<T>(size: usize): ElemOps<T> {
  return {
    size,
    align: 8,
    read: (m, at) => objects[m.getUint32(at, true)] as T,
    write: (m, at, v) => {
      let h = handleOf.get(v);
      if (h === undefined) {
        h = objects.length;
        objects.push(v);
        handleOf.set(v, h);
      }
      m.setUint32(at, h, true);
    },
  };
}

/** A stored reference: 8 bytes. */
export const ref = <T>(): Elem<T> => objectElem<T>(8);
/** An object in place. Natively sizeOf(T), known to tslc; here a simulated stride (SPEC 3.5, divergence 6). */
export const inlineOf = <T>(): Elem<T> => objectElem<T>(16);

function opsOf<T>(e: ElemOf<T>): ElemOps<T> {
  if (typeof e !== "function") return e as ElemOps<T>;
  const d = e.desc as ScalarDesc;
  return {
    size: d.size,
    align: d.size,
    desc: d,
    read: (m, at) => hostReadScalar(m, at, d) as T,
    write: (m, at, v) => {
      hostWriteScalar(m, at, d, v as number | bigint);
    },
  };
}

export const elemSize = <T>(e: ElemOf<T>): usize => opsOf(e).size;

export class Ptr<T> {
  readonly addr: u64;
  private readonly e: ElemOps<T>;

  constructor(e: ElemOps<T>, addr: u64) {
    this.e = e;
    this.addr = addr;
  }

  // R8: where the pointer is, found without making a pair at every access (a host-side cost, nothing natively).
  private region(): Region {
    const a = Number(this.addr);
    const r = find(a);
    if (a + this.e.size > r.base + r.mem.byteLength) throw new TslTrap(2);
    return r;
  }

  add(n: usize): Ptr<T> {
    return new Ptr(this.e, this.addr + BigInt(n * this.e.size));
  }

  read(): T {
    const r = this.region();
    return this.e.read(r.mem, Number(this.addr) - r.base);
  }

  write(v: T): void {
    const r = this.region();
    this.e.write(r.mem, Number(this.addr) - r.base, v);
  }

  cast<U>(e: ElemOf<U>): Ptr<U> {
    return new Ptr(opsOf(e), this.addr);
  }
}

export const ptrAt = <T>(e: ElemOf<T>, addr: u64): Ptr<T> => new Ptr(opsOf(e), addr);

export function sliceOf<T>(e: ElemOf<T>, addr: u64, n: usize): ArrayOf<T> {
  const ops = opsOf(e);
  const a = Number(addr);
  const r = find(a);
  if (ops.desc === undefined) throw new TypeError("sliceOf needs a scalar element");
  const C = arrayCtorOf(ops.desc);
  return new C(r.mem.buffer as ArrayBuffer, a - r.base, n) as ArrayOf<T>;
}

export function copyBytes(dst: u64, src: u64, n: usize): void {
  if (n === 0) return;
  bytesAt(dst, n).set(bytesAt(src, n));
}

// --- generational objects: a slot is [next free slot: u64][generation: u32][owner: u32][object]
const placed = new WeakMap<object, { slot: u64; gen: number }>();
const atSlot = new Map<bigint, object>();

function poison(o: object): void {
  for (const k of Object.keys(o)) {
    Object.defineProperty(o, k, {
      get() {
        throw new TslTrap(5);
      },
      set() {
        throw new TslTrap(5);
      },
    });
  }
}

export function placeObject<T extends object>(slot: u64, gen: number, item: T): T {
  placed.set(item, { slot, gen });
  atSlot.set(slot, item);
  return item;
}

// --- tails (D69). On the host a tail lives in simulated memory, so tailAddr has an address to give and ptrAt and copyBytes
// reach it; it's still a typed array the object holds. Nothing gives one back: a host test's memory is the host's.
const TAIL_CHUNK = 0x10_0000;
let tailNext = 0x6_0000_0000;
let tailEnd = tailNext;
let tailMem: DataView | null = null;
let tailBase = 0;
const tailAt = new WeakMap<object, number>();
hostSetTailMaker((desc, n) => {
  const bytes = Math.ceil((n * desc.size) / 8) * 8;
  if (tailMem === null || tailNext + bytes > tailEnd) {
    const size = Math.max(bytes, TAIL_CHUNK);
    tailNext = tailEnd;
    tailMem = hostMapMemory(tailNext, size);
    tailBase = tailNext;
    tailEnd = tailNext + size;
  }
  const at = tailNext;
  tailNext += bytes;
  const a = new (arrayCtorOf(desc))(tailMem!.buffer as ArrayBuffer, at - tailBase, n);
  tailAt.set(a, at);
  return a;
});

/** Where an object's tail's element 0 is (D69). */
export function tailAddr(item: object): u64 {
  const t = hostTailOf(item);
  const at = t === undefined ? undefined : tailAt.get(t);
  if (at === undefined) throw new TslTrap(11);
  return BigInt(at);
}

// On the host an object's bytes are a simulated value (SPEC 3.10, divergence 6): its fixed part is taken as 16, as
// inlineOf's stride is, and each tail element as 8, so what's made and what's freed agree.
const hostTailBytes = (n: number): usize => 16 + 8 * n;

/** The bytes an object of T with a tail of n elements takes (D69). */
export function tailBytes<T>(_e: ElemOf<T>, n: usize): usize {
  if (n > 0xffffffff) throw new TslTrap(14);
  return hostTailBytes(n);
}

/** The bytes an object takes, its tail's included (D69). */
export function objectBytes(item: object): usize {
  const t = hostTailOf(item);
  return t === undefined ? 16 : hostTailBytes(t.length);
}

/**
 * placeObject for a class with a tail (D69): the moved object, given a tail of n zeroed elements, in a slot of
 * tailBytes(…, n). A `@tsl.tailed` parameter is the one way such an object is moved. `keep` (R4): natively, the tail's
 * first `keep` elements are left as they are, not zeroed, for the caller to write before anything reads them (more than n
 * traps 2); on the host the whole tail is zeroed, which the caller can't tell, as it writes them first.
 */
export function placeTail<T extends object>(
  slot: u64,
  gen: number,
  n: usize,
  item: T,
  keep: usize = 0,
): T {
  if (keep > n) throw new TslTrap(2);
  hostAttachTail(n, item);
  return placeObject(slot, gen, item);
}

/**
 * Whether tslc's `rc` expansion places every count of T's objects (3.5, D74): natively a constant, true for a class an
 * `rc` package declares, so `@tsl/gc` checks nothing where a counted reference can't be stale. On the host it's false, so
 * every count operation is checked there, as the poisoning build checks every use.
 */
export function countedExactly<_T>(): boolean {
  return false;
}

/**
 * Closed-world release dispatch for `@tsl/gc` (3.5, D70, R1d). Natively the set is every top-level function a program
 * names as an `Rc` store's release function (`new Rc<T>(f)`), numbered from 1 in the order the program shows them:
 * `releaseIndex(f)` is f's number, found by comparing code addresses, once, when its store registers, and
 * `callRelease(i, item, at, op)` is a comparison of `i` with each number in turn, each arm a direct call of that function
 * (which the inliner may inline), and trap 18 for a number that's none of them. So freeing and the cycle collector's
 * visits make no indirect call. On the host it's a list of the functions seen, and a call through it.
 */
const hostReleases: ((item: never, at: usize, op: never) => usize)[] = [];
export function releaseIndex<F extends (item: never, at: usize, op: never) => usize>(f: F): u32 {
  let i = hostReleases.indexOf(f);
  if (i < 0) i = hostReleases.push(f) - 1;
  return i + 1;
}
/**
 * R17: whether `f` is a release function whose body is `return 0;` and nothing else, which freeing may skip calling: natively
 * a comparison of its code address with each such function's in the closed set; on the host always false, so the host
 * calls it, which does nothing and gives 0 all the same.
 */
export function releaseIsEmpty<F extends (item: never, at: usize, op: never) => usize>(
  _f: F,
): boolean {
  return false;
}
export function callRelease<O>(i: u32, item: object, at: usize, op: O): usize {
  const f = hostReleases[i - 1] as ((item: object, at: usize, op: O) => usize) | undefined;
  if (f === undefined) throw new TslTrap(18);
  return f(item, at, op);
}

/**
 * The type graph's facts for `@tsl/gc`'s cycle collector (3.5, D41, R1c). Natively each is a constant tslc works out
 * over the whole program: `cycleGroup<T>()` is T's component in the graph of classes and their fields, 0 if T can't be in
 * a cycle or the collector is off, and `cyclesLinked()` is whether any counted class can be. The host can't see T, so it
 * reads a table by class name that whoever runs the program passes in `TSL_CYCLE_GROUPS` (the test harness gives it what
 * tslc computes); with none, nothing is in a cycle and cycles leak, which is safe. `cycleGroup<T>()` on the host is
 * `HOST_GROUP_UNKNOWN` while there's a table, so the library asks the object's store (`cycleGroupOf`, at its first make).
 */
let hostCycleTable: Record<string, number> | null = null;
function cycleTable(): Record<string, number> {
  if (hostCycleTable === null) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const text = env?.TSL_CYCLE_GROUPS;
    hostCycleTable =
      text !== undefined && text !== "" ? (JSON.parse(text) as Record<string, number>) : {};
  }
  return hostCycleTable;
}
export const HOST_GROUP_UNKNOWN = 0xffff_ffff;
export function cycleGroup<_T>(): u32 {
  return Object.keys(cycleTable()).length > 0 ? HOST_GROUP_UNKNOWN : 0;
}
export function cycleGroupOf<T extends object>(item: T): u32 {
  return cycleTable()[(item as { constructor: { name: string } }).constructor.name] ?? 0;
}
export function cyclesLinked(): boolean {
  return Object.keys(cycleTable()).length > 0;
}

export function objectAt<T extends object>(slot: u64): T {
  const o = atSlot.get(slot);
  if (o === undefined) throw new TslTrap(5);
  return o as T;
}

export function slotOf(item: object): u64 {
  const p = placed.get(item);
  if (p === undefined) throw new TslTrap(5);
  return p.slot;
}

/**
 * slotOf for a reference known live (R1f): `@tsl/gc`'s count operations on a class whose every count tslc placed
 * (`countedExactly`, D74), which can't be stale. Natively the slot's address with no check; here, slotOf's lookup.
 */
export function slotOfLive(item: object): u64 {
  return slotOf(item);
}

export function genOf(item: object): number {
  const p = placed.get(item);
  if (p === undefined) throw new TslTrap(5);
  return p.gen;
}

/** Any later access to a removed object traps on the host. Natively, a no-op (SPEC 3.10, divergence 5). */
// `manual` (SPEC 3.5): on the host a freed object is poisoned, so any use traps with code 5, as does freeing it
// twice. Natively a use after free is a real bug (SPEC 3.10, divergence 8).
const freed = new WeakSet<object>();

export function unsafeFree(item: object): void {
  if (freed.has(item) || placed.has(item)) throw new TslTrap(5);
  freed.add(item);
  poison(item);
}

/**
 * Where a `leak` or `manual` package's escaping allocations get their pages: zeroed runs, or 0n when there are
 * none. A JS object needs no pages, so on the host this only checks that it's given a function.
 */
export function setPageSource(source: (pages: usize) => u64): void {
  if (typeof source !== "function") throw new TslTrap(5);
  registered = source;
}

let registered: ((pages: usize) => u64) | null = null;
const HOST_PAGE_CHUNK = 0x100_0000;
let hostPagesNext = 0x2_0000_0000;
let hostPagesEnd = hostPagesNext;

/**
 * Pages from the registered source, or 0n when it has none (`@tsl/std`, SPEC 3.5). On the host, with none registered, they
 * come from simulated regions as they're needed, as a test image's come from its RAM: there's no limit but the host's.
 */
export function sourcePages(pages: usize): u64 {
  if (registered !== null) return registered(pages);
  const bytes = pages * 4096;
  if (hostPagesNext + bytes > hostPagesEnd) {
    const size = Math.max(bytes, HOST_PAGE_CHUNK);
    hostPagesNext = hostPagesEnd;
    hostMapMemory(hostPagesNext, size);
    hostPagesEnd = hostPagesNext + size;
  }
  const at = hostPagesNext;
  hostPagesNext += bytes;
  return BigInt(at);
}

/**
 * R6: whether tslc placed `o` in a lowered `leak` or `manual` package's per-call region, which the export call gives back
 * whole when it returns (SPEC 3.5, 4.5). Never on the host, which has no region (its collector frees everything), nor in a
 * package written by hand, where tslc places nothing there. For a library that keeps memory beside an object, as
 * `@tsl/jsrt`'s `JsArray` keeps its buffer, so that memory goes where the object does.
 */
export function inCallRegion(_o: object): bool {
  return false;
}

/** R6: whether `addr` is in the per-call region (inCallRegion's, for an address): never on the host. */
export function addrInCallRegion(_addr: u64): bool {
  return false;
}

/**
 * R6: `bytes` from the per-call region, not zeroed, given back when the export call returns: only for memory kept beside an
 * object `inCallRegion` said is there. R13: in a lowered `strict` package the region is the caller's call arena, which
 * `@tsl/jsrt`'s `JsArenaArray` takes every buffer from. On the host, simulated memory of its own that nothing gives back
 * (a host test's memory is the host's, as a tail's is), aligned to 8, as the arena's allocations are.
 */
export function callRegionBytes(bytes: usize): u64 {
  const n = Math.ceil(bytes / 8) * 8;
  if (regionNext + n > regionEnd) {
    const size = Math.max(n, REGION_CHUNK);
    regionNext = regionEnd;
    hostMapMemory(regionNext, size);
    regionEnd = regionNext + size;
  }
  const at = regionNext;
  regionNext += n;
  return BigInt(at);
}

// R13: the host's simulated call arena, at addresses no other family of regions takes
const REGION_CHUNK = 0x10_0000;
let regionNext = 0x8_0000_0000;
let regionEnd = regionNext;

export function retireObject(item: object): void {
  const p = placed.get(item);
  if (p !== undefined) atSlot.delete(p.slot);
  placed.delete(item);
  retired.add(item);
  poison(item);
}

const retired = new WeakSet<object>();

/**
 * Traps 5 if this is a reference to an object that's been removed, and does nothing to anything else. For a library about
 * to hand a value it read from memory to a closure, whose parameter nothing checks (SPEC 3.5).
 */
export function checkLive<T>(x: T): void {
  if (typeof x === "object" && x !== null && retired.has(x)) throw new TslTrap(5);
}

let runFreedHook: ((addr: u64, pages: usize) => void) | null = null;

/** Who a `Heap` tells about a run of whole pages it's been given back: nobody without `@tsl/std` (SPEC 3.5, D43). */
export function pageRunFreed(addr: u64, pages: usize): void {
  if (runFreedHook !== null) runFreedHook(addr, pages);
}

/** `@tsl/std`'s, at the top level: tslc binds pageRunFreed to it at compile time, and no other program has a call there. */
export function onPageRunFreed(hook: (addr: u64, pages: usize) => void): boolean {
  runFreedHook = hook;
  return true;
}

const keyIds = new WeakMap<object, number>();
let nextKeyId = 1;

/**
 * A key's hash, chosen by its type: its value for an integer, its own `hashKey()` for a class with one, and its identity
 * for any other class. A float isn't a key (TSL2003). The value can depend on an address, which is why this is unsafe:
 * what's built with it must show nothing that depends on it (SPEC 3.5, 3.8).
 */
export function keyHash<K>(k: K): number {
  if (typeof k === "bigint") return Number(BigInt.asUintN(32, k ^ (k >> 32n)));
  if (typeof k === "number") return k >>> 0;
  const o = k as { hashKey?: () => number };
  if (typeof o.hashKey === "function") return o.hashKey();
  let id = keyIds.get(k as object);
  if (id === undefined) {
    id = nextKeyId++;
    keyIds.set(k as object, id);
  }
  return id;
}

/** Whether two keys are one key: `===`, or a class's own `sameKey`. */
export function keySame<K>(a: K, b: K): boolean {
  const o = a as { sameKey?: (x: K) => boolean } | null;
  if (typeof a === "object" && o !== null && typeof o.sameKey === "function") return o.sameKey(b);
  return a === b;
}
