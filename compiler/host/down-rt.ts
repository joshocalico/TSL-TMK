// The runtime down-lowered code calls, in plain TIR: a bump arena and growable vectors. It uses only
// operations and intrinsics any target has, so nothing here is specific to Wasm (SPEC 4.3, 4.5).
import { assemble } from "../tir/asm.ts";
import type { Func, Global, Sig, TrapSite } from "../tir/ir.ts";

export const VEC_DATA = 0;
export const VEC_LEN = 8;
export const VEC_CAP = 16;
export const VEC_SIZE = 24;
export const TRAP_ARGS_SLOTS = 16;

const RT = `
func @__arena_start() -> () {
bb_e:
  %b = intrinsic mem.base
  %g = globaladdr @__arena_top
  store.ptr.na %g, %b
  ret
}
func @__arena_commit() -> () {
bb_e:
  %t = globaladdr @__arena_top
  %v = load.ptr.na %t
  %b = globaladdr @__arena_base
  store.ptr.na %b, %v
  ret
}
func @__arena_reset() -> () export {
bb_e:
  %b = globaladdr @__arena_base
  %v = load.ptr.na %b
  %t = globaladdr @__arena_top
  store.ptr.na %t, %v
  ret
}
func @__trap_args_addr() -> (ptr) export {
bb_e:
  %a = globaladdr @__trap_args
  ret %a
}
func @__alloc(%size: ix) -> (ptr) export {
bb_e:
  %limit = iconst.ix 2147483647
  %big = icmp.ugt.ix %size, %limit
  brif %big, bb_oom, bb_fits
bb_oom:
  trap t900001
bb_fits:
  %seven = iconst.ix 7
  %s1 = add.ix %size, %seven
  %mask = iconst.ix -8
  %s2 = and.ix %s1, %mask
  %g = globaladdr @__arena_top
  %top = load.ptr.na %g
  %new = gep %top, %s2, 1, 0
  %wrapped = icmp.ult.ptr %new, %top
  brif %wrapped, bb_oom2, bb_ok
bb_oom2:
  trap t900001
bb_ok:
  intrinsic mem.ensure %new
  store.ptr.na %g, %new
  ret %top
}
func @__vec_new(%len: ix, %slot: ix) -> (ptr) export {
bb_e:
  %hsize = iconst.ix 24
  %h = call @__alloc %hsize
  %four = iconst.ix 4
  %small = icmp.ult.ix %len, %four
  %cap = select.ix %small, %four, %len
  %bytes = mul.chk.u.ix %cap, %slot, t900001
  %d = call @__alloc %bytes
  %z = iconst.i32 0
  intrinsic mem.fill %d, %z, %bytes
  store.ptr.na %h, %d
  %zero = iconst.ix 0
  %lp = gep %h, %zero, 1, 8
  store.ix.na %lp, %len
  %cp = gep %h, %zero, 1, 16
  store.ix.na %cp, %cap
  ret %h
}
func @__vec_reserve(%v: ptr, %need: ix, %slot: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  %cp = gep %v, %zero, 1, 16
  %cap = load.ix.na %cp
  %enough = icmp.ule.ix %need, %cap
  brif %enough, bb_done, bb_grow
bb_done:
  ret
bb_grow:
  %two = iconst.ix 2
  %dbl = mul.chk.u.ix %cap, %two, t900001
  %small = icmp.ult.ix %dbl, %need
  %ncap = select.ix %small, %need, %dbl
  %bytes = mul.chk.u.ix %ncap, %slot, t900001
  %d = call @__alloc %bytes
  %z = iconst.i32 0
  intrinsic mem.fill %d, %z, %bytes
  %lp = gep %v, %zero, 1, 8
  %len = load.ix.na %lp
  %old = load.ptr.na %v
  %used = mul.ix %len, %slot
  intrinsic mem.copy %d, %old, %used
  store.ptr.na %v, %d
  store.ix.na %cp, %ncap
  ret
}
func @__vec_setlen(%v: ptr, %len: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  %lp = gep %v, %zero, 1, 8
  store.ix.na %lp, %len
  ret
}
`;

// --- memory modes (SPEC 3.5, 4.5): what's linked instead of a collector. A registered page source, a bump
// allocator over it for `leak`, and a size-class heap with no block headers for `manual`, in the shape of
// ex-heap.ts: callers pass the size back, and a run of whole pages isn't reused. Blocks are 16-byte aligned,
// which is all an object needs: aligning to the block's size wasted up to a whole block between sizes (MEASURED).
export const RT_SIGS: Sig[] = [{ params: ["ix"], rets: ["ptr"] }];

const RT_MEMORY = `
sig sig0 (ix) -> (ptr)
func @__page_source_use(%f: ptr) -> () export {
bb_e:
  %g = globaladdr @__page_source
  store.ptr.na %g, %f
  ret
}
func @__pages_get(%n: ix) -> (ptr) {
bb_e:
  %g = globaladdr @__page_source
  %f = load.ptr.na %g
  %z = iconst.ix 0
  %fi = bitcast.ix %f
  %none = icmp.eq.ix %fi, %z
  brif %none, bb_oom, bb_go
bb_go:
  %p = call.indirect sig0 %f, %n
  %pi = bitcast.ix %p
  %nul = icmp.eq.ix %pi, %z
  brif %nul, bb_oom, bb_ok
bb_ok:
  ret %p
bb_oom:
  trap t900001
}
func @__leak_alloc(%size: ix) -> (ptr) export {
bb_e:
  %limit = iconst.ix 2147483647
  %big = icmp.ugt.ix %size, %limit
  brif %big, bb_oom, bb_fits
bb_oom:
  trap t900001
bb_fits:
  %seven = iconst.ix 7
  %s1 = add.ix %size, %seven
  %mask = iconst.ix -8
  %s2 = and.ix %s1, %mask
  %eight = iconst.ix 8
  %tiny = icmp.ult.ix %s2, %eight
  %s = select.ix %tiny, %eight, %s2
  %gc = globaladdr @__leak_cur
  %cur = load.ptr.na %gc
  %ge = globaladdr @__leak_end
  %end = load.ptr.na %ge
  %next = gep %cur, %s, 1, 0
  %fits = icmp.ule.ptr %next, %end
  brif %fits, bb_bump, bb_more
bb_bump:
  store.ptr.na %gc, %next
  ret %cur
bb_more:
  %page = iconst.ix 4095
  %up = add.ix %s, %page
  %twelve = iconst.ix 12
  %n = lshr.ix %up, %twelve
  %run = call @__pages_get %n
  %used = gep %run, %s, 1, 0
  %bytes = shl.ix %n, %twelve
  %stop = gep %run, %bytes, 1, 0
  store.ptr.na %gc, %used
  store.ptr.na %ge, %stop
  ret %run
}
func @__heap_class(%size: ix) -> (i32) {
bb_e:
  %c0 = iconst.i32 0
  %s0 = iconst.ix 16
  br bb_loop(%c0, %s0)
bb_loop(%c: i32, %s: ix):
  %ok = icmp.ule.ix %size, %s
  brif %ok, bb_done, bb_next
bb_done:
  ret %c
bb_next:
  %one = iconst.i32 1
  %c2 = add.i32 %c, %one
  %eight = iconst.i32 8
  %all = icmp.eq.i32 %c2, %eight
  brif %all, bb_big, bb_step
bb_big:
  ret %c2
bb_step:
  %s2 = add.ix %s, %s
  br bb_loop(%c2, %s2)
}
func @__heap_alloc(%size: ix) -> (ptr) export {
bb_e:
  %c = call @__heap_class %size
  %eight = iconst.i32 8
  %big = icmp.eq.i32 %c, %eight
  brif %big, bb_run, bb_small
bb_run:
  %limit = iconst.ix 2147483647
  %huge = icmp.ugt.ix %size, %limit
  brif %huge, bb_oom, bb_pages
bb_oom:
  trap t900001
bb_pages:
  %page = iconst.ix 4095
  %up = add.ix %size, %page
  %twelve = iconst.ix 12
  %n = lshr.ix %up, %twelve
  %r = call @__pages_get %n
  ret %r
bb_small:
  %ci = zext.ix %c
  %heads = globaladdr @__heap_heads
  %hp = gep %heads, %ci, 8, 0
  %block = load.ptr.na %hp
  %z = iconst.ix 0
  %bi = bitcast.ix %block
  %empty = icmp.eq.ix %bi, %z
  brif %empty, bb_bump, bb_pop
bb_pop:
  %link = load.ptr.na %block
  store.ptr.na %hp, %link
  ret %block
bb_bump:
  %sixteen = iconst.ix 16
  %sz = shl.ix %sixteen, %ci
  %gc = globaladdr @__heap_cur
  %ge = globaladdr @__heap_end
  %cur = load.ix.na %gc
  %end = load.ix.na %ge
  %fifteen = iconst.ix 15
  %s1 = add.ix %cur, %fifteen
  %nm = iconst.ix -16
  %at = and.ix %s1, %nm
  %past = add.ix %at, %sz
  %fits = icmp.ule.ix %past, %end
  %live = icmp.ne.ix %cur, %z
  %both = and.i32 %fits, %live
  brif %both, bb_take, bb_page
bb_take:
  store.ix.na %gc, %past
  %ap = bitcast.ptr %at
  ret %ap
bb_page:
  %page1 = iconst.ix 1
  %run = call @__pages_get %page1
  %ri = bitcast.ix %run
  %after = add.ix %ri, %sz
  %whole = iconst.ix 4096
  %stop = add.ix %ri, %whole
  store.ix.na %gc, %after
  store.ix.na %ge, %stop
  ret %run
}
func @__heap_free(%p: ptr, %size: ix) -> () export {
bb_e:
  %c = call @__heap_class %size
  %eight = iconst.i32 8
  %big = icmp.eq.i32 %c, %eight
  brif %big, bb_done, bb_small
bb_done:
  ret
bb_small:
  %ci = zext.ix %c
  %heads = globaladdr @__heap_heads
  %hp = gep %heads, %ci, 8, 0
  %head = load.ptr.na %hp
  store.ptr.na %p, %head
  store.ptr.na %hp, %p
  ret
}
`;

/** Vectors in a mode's allocator. `reserve` gives the old buffer back only if it's told the buffer is its own. */
function vecFuncs(suffix: string, alloc: string, zeroed: boolean, free: boolean): string {
  const fill = (d: string, bytes: string): string =>
    zeroed ? "" : `  %z = iconst.i32 0\n  intrinsic mem.fill ${d}, %z, ${bytes}\n`;
  return `
func @__vec_new${suffix}(%len: ix, %slot: ix) -> (ptr) export {
bb_e:
  %hsize = iconst.ix 24
  %h = call @${alloc} %hsize
  %four = iconst.ix 4
  %small = icmp.ult.ix %len, %four
  %cap = select.ix %small, %four, %len
  %bytes = mul.chk.u.ix %cap, %slot, t900001
  %d = call @${alloc} %bytes
${fill("%d", "%bytes")}  store.ptr.na %h, %d
  %zero = iconst.ix 0
  %lp = gep %h, %zero, 1, 8
  store.ix.na %lp, %len
  %cp = gep %h, %zero, 1, 16
  store.ix.na %cp, %cap
  ret %h
}
func @__vec_reserve${suffix}(%v: ptr, %need: ix, %slot: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  %cp = gep %v, %zero, 1, 16
  %cap = load.ix.na %cp
  %enough = icmp.ule.ix %need, %cap
  brif %enough, bb_done, bb_grow
bb_done:
  ret
bb_grow:
  %two = iconst.ix 2
  %dbl = mul.chk.u.ix %cap, %two, t900001
  %small = icmp.ult.ix %dbl, %need
  %ncap = select.ix %small, %need, %dbl
  %bytes = mul.chk.u.ix %ncap, %slot, t900001
  %d = call @${alloc} %bytes
${fill("%d", "%bytes")}  %lp = gep %v, %zero, 1, 8
  %len = load.ix.na %lp
  %old = load.ptr.na %v
  %used = mul.ix %len, %slot
  intrinsic mem.copy %d, %old, %used
${free ? "  %was = mul.ix %cap, %slot\n  call @__heap_free %old, %was\n" : ""}  store.ptr.na %v, %d
  store.ix.na %cp, %ncap
  ret
}
`;
}

/** Linked only where a module has a memory mode, so `strict` modules don't change by a byte. */
export function memoryRtFuncs(): Func[] {
  const text =
    RT_MEMORY +
    vecFuncs("_leak", "__leak_alloc", true, false) +
    vecFuncs("_heap", "__heap_alloc", false, true) +
    vecFuncs("_heapk", "__heap_alloc", false, false);
  return assemble(text).funcs;
}

/** Pages from the registered source for `@tsl/std`'s global allocator: 0 when there are none, so `tryPush` can say so. */
const RT_STD = `
sig sig0 (ix) -> (ptr)
func @__pages_try(%n: ix) -> (ptr) {
bb_e:
  %g = globaladdr @__page_source
  %f = load.ptr.na %g
  %z = iconst.ix 0
  %fi = bitcast.ix %f
  %none = icmp.eq.ix %fi, %z
  brif %none, bb_none, bb_go
bb_go:
  %p = call.indirect sig0 %f, %n
  ret %p
bb_none:
  %q = bitcast.ptr %z
  ret %q
}
`;

export function stdRtFuncs(): Func[] {
  return assemble(RT_STD).funcs;
}

export function memoryRtGlobals(): Global[] {
  return [
    { name: "__page_source", size: 8, align: 8, section: "data" },
    { name: "__leak_cur", size: 8, align: 8, section: "data" },
    { name: "__leak_end", size: 8, align: 8, section: "data" },
    { name: "__heap_heads", size: 64, align: 8, section: "data" },
    { name: "__heap_cur", size: 8, align: 8, section: "data" },
    { name: "__heap_end", size: 8, align: 8, section: "data" },
  ];
}

export const RT_TRAPS: TrapSite[] = [{ id: 900001, kind: "memory", code: 14, loc: "runtime" }];

export function rtFuncs(): Func[] {
  // assemble's parser only needs trap ids to exist once the module is whole, which they will.
  return assemble(RT).funcs;
}

export function rtGlobals(): Global[] {
  return [
    { name: "__arena_top", size: 8, align: 8, section: "data" },
    { name: "__arena_base", size: 8, align: 8, section: "data" },
    { name: "__trap_args", size: TRAP_ARGS_SLOTS * 8, align: 8, section: "data" },
  ];
}

// --- `rc` (SPEC 3.5, 4.5, D39): a counted heap, per thread, with non-atomic counts. A block is
// [link: u64][count: u32][meta: u32][object]; `meta` is a descriptor's word index above a class byte. Small blocks are
// powers of two from 32 to 2048 bytes, one class to a page, so an interior pointer finds its block by a mask. A larger
// block is a run of 2^k pages. A live block's link is its weak cell, or 0; a dead one's is the pending queue.
//
// A decrement to zero queues the object, and does nothing else. Only an allocation frees, and only RC_BUDGET steps of
// freeing, where a step is one reference slot visited or one block given back, so a large drop costs each allocation
// the same. `__rc_cur` and `__rc_idx` are the one object being scanned, and how far, so a large array is many steps.
// `check` and `account` are test builds (SPEC 8.1): poison and a trap on a dead object, and counters. Neither is in
// release code: a release module has no __rc_s_ global and no __rc_chk function.
export const RC_BUDGET = 32;
export const RC_CYCLES_DEFAULT = true; // SPEC 3.5, D41: from the measurements in M5's Phase E
export const RC_DESC_LEAF = 0;
export const RC_DESC_WEAK = 1;
export const RC_DESC_VEC_LEAF = 3; // a vector of scalars: only its buffer to give back
export const RC_SMALL_MAX = 2048;
const RC_CLASSES = 7;
const RC_RUN_CLASS = 16;
const RC_RUN_LISTS = 21; // up to 2^20 pages, and a size is below 2^31 plus its header

export interface RcBuild {
  check: boolean;
  account: boolean;
  cycles?: boolean; // the cycle collector (SPEC 3.5, D41). Absent or false is `rc` as it was, byte for byte.
  budget?: number; // test builds: another RC_BUDGET
  pace?: boolean; // test builds: false runs the collector at every allocation, whether or not the heap has grown
  ccFault?: CcFault; // test builds: a mistake put into the collector, to show the tests catch it
}

/** What the tests can break in the collector. None of these is in any other build. */
export type CcFault =
  | "no-touch" // a count operation on an object being scanned doesn't mark it
  | "no-count-check" // an object's count isn't compared with the edges found to it
  | "no-trace" // what a held object reaches isn't marked
  | "no-rescan" // a touch doesn't ask for another pass
  | "no-weak-gate" // deref doesn't ask whether its target has been decided on
  | "no-giveup-wait"; // R1e: a scan decides while an object it gave up still holds references it counted

// The cycle collector's bits in `meta`, whose class byte only needs 6 bits (SPEC 3.5, D41).
export const RC_CC_BUF = 0x40; // in the candidate table: its link holds the table index above its weak cell
export const RC_CC_INS = 0x80; // in the scan going on now: its link holds the scan's state
export const RC_CC_CYC = 1 << 28; // its type can be in a cycle. Part of the descriptor word a caller passes __rc_new
export const RC_CC_DESC_CYC = 1 << 20; // the same bit, in that word
const RC_CC_ROOT = 1 << 27; // in a scan: it was a candidate
const RC_CC_AGAIN = 1 << 26; // in a scan: a decrement left a count above zero on it, so it's a candidate again after
const RC_CC_DESC_MASK = 0x3ffff; // a descriptor's word index: 18 bits, checked where descriptors are made
const RC_CC_HASCELL = 1 << 29; // it has a weak cell
const RC_CC_BLACK = 1 << 30; // in a scan: held. On a dead object, freed in all but its block, waiting on its buffer entry
const RC_CC_SCANNED = -2147483648; // in a scan: held, and what it reaches has been marked
const RC_CC_NOT_SCAN = 0x33ffff7f; // meta without INS, ROOT, AGAIN, BLACK and SCANNED
const RC_CC_LOW44 = 17592186044415; // in a scan, a link is [edges found: 20 bits][next or weak cell, >> 4: 44 bits]
const RC_CC_ONE_EDGE = 17592186044416;
const RC_CC_EDGES_MAX = 1048575;
const RC_CC_FIRST_LIMIT = 64; // objects in a scan, at retry level 0
const RC_FREES_STEPS = 2; // with the collector linked, an allocation frees one object, unless its free list is empty (SPEC 4.5)
const RC_CC_TABLE = 4096; // candidates; with the table full, one is forgotten to make room (SPEC 3.5)
const RC_CC_MAX_LEVEL = 13;
const RC_CC_GAP_SHIFT = 4; // allocations to wait, per object in a whole scan that freed nothing, before starting another
const RC_CC_QUIET = 16; // fewer candidates than this waiting: the gap goes by faster, as they're not a flood
const RC_CC_GAP_SHIFT_CUT = 2; // the same, for a scan cut off by its limit, which may simply not have got there yet
export const RC_MAX_DESC_WORDS = 0x3ffff;

export const RC_STATS = [
  "incs",
  "decs",
  "allocs",
  "frees",
  "live_objects",
  "live_bytes",
  "max_steps",
  "full_drains",
  "steps",
] as const;

/** The collector's own counters, in a test build with it on. */
export const RC_CC_STATS = [
  "cc_scans", // scans: each takes the whole candidate table as its roots
  "cc_roots", // candidates a scan took
  "cc_steps", // steps the collector took, of `steps`
  "cc_freed", // objects freed as garbage in a cycle
  "cc_touches", // objects turned black by a count operation during a scan
  "cc_retries", // roots of scans cut off by their size limit, put back to go again with a larger one
  "cc_evicted", // candidates that didn't fit because the table was full
  "cc_walks", // passes over the whole heap for what was forgotten: only at exhaustion, or a caller's __rc_collect
  "cc_passes", // passes of the marking phase
  "cc_max_passes", // the most passes in one scan
  "cc_max_scan", // the most objects in one scan
  "cc_fruitless", // scans that freed nothing
] as const;

type StatFn = (name: string, by: string, sign?: "add" | "sub") => string;

/**
 * The cycle collector (SPEC 3.5, D41): trial deletion that never changes a count, in bounded steps, with the mutator running
 * between them. A scan keeps its state in the objects it has reached: a bit in `meta`, and in `link` how many edges it has
 * found to the object and the next object in the scan. So a scan allocates nothing, and nothing has to be restored but those. The candidates
 * are a fixed table: an object's link says where it is, so one whose count reaches zero leaves in constant time.
 * An object's real count stays true throughout, and any count operation on an object in the scan turns it black.
 *
 * Phase 0: start. 5: take the whole candidate table as roots. 1: find what they reach, counting edges. 2: mark, in passes over
 * the list, what's held: its count isn't the edges found, or it was touched, or something held reaches it. A pass with
 * nothing new is the decision. 3: what's not black is garbage: clear its weak cell and release what it holds. 4: give back
 * the blocks.
 */
function ccText(o: RcBuild, stat: StatFn): string {
  const low44 = `iconst.ix ${RC_CC_LOW44}`;
  const maxStat = (name: string, v: string): string =>
    o.account
      ? `  %mx_${name} = globaladdr @__rc_s_${name}
  %mv_${name} = load.i64.na %mx_${name}
  %mb_${name} = icmp.ugt.i64 ${v}, %mv_${name}
  %mn_${name} = select.i64 %mb_${name}, ${v}, %mv_${name}
  store.i64.na %mx_${name}, %mn_${name}
`
      : "";
  // Steps counted against one allocation's budget: `left` now, and `before` it if this isn't the first to take any.
  const asSteps = (budget: string, left: string, before?: string): string =>
    o.account
      ? `  %ud = sub.i32 ${before ?? budget}, ${left}
  %ux = zext.i64 %ud
${stat("steps", "%ux")}  %ua = sub.i32 ${budget}, ${left}
  %uy = zext.i64 %ua
${maxStat("max_steps", "%uy")}`
      : "";
  const ccSteps = (used: string): string =>
    o.account
      ? `  %cx = zext.i64 ${used}
${stat("cc_steps", "%cx")}`
      : "";
  return `func @__rc_cc_active() -> (i32) {
bb_e:
  %gp = globaladdr @__rc_cc_phase
  %p = load.i32.na %gp
  %gt = globaladdr @__rc_cc_top
  %t = load.i32.na %gt
  %a = or.i32 %p, %t
  ret %a
}
func @__rc_cc_recheck() -> () {
bb_e:
  %a = call @__rc_cc_active
  %gb = globaladdr @__rc_cc_busy
  store.i32.na %gb, %a
  ret
}
func @__rc_steps(%budget: i32) -> () {
bb_e:
${
  o.pace === false
    ? ""
    : `  %gg = globaladdr @__rc_cc_gap
  %g = load.i32.na %gg
  brif %g, bb_gap, bb_go
bb_gap:
  %gtop = globaladdr @__rc_cc_top
  %tp = load.i32.na %gtop
  %few = iconst.i32 ${RC_CC_QUIET}
  %quiet = icmp.ult.i32 %tp, %few
  %o = iconst.i32 1
  %o2 = iconst.i32 ${1 << RC_CC_GAP_SHIFT}
  %by = select.i32 %quiet, %o2, %o
  %over = icmp.ult.i32 %g, %by
  %g0 = sub.i32 %g, %by
  %zg = iconst.i32 0
  %g1 = select.i32 %over, %zg, %g0
  store.i32.na %gg, %g1
  br bb_go
bb_go:
`
}  %two = iconst.i32 2
  %q = lshr.i32 %budget, %two
  %one = iconst.i32 1
  %s = add.i32 %q, %one
  %used = call @__rc_cc_paced %s
  %b1 = sub.i32 %budget, %used
  %fw = iconst.i32 ${RC_FREES_STEPS}
  %more = icmp.ugt.i32 %b1, %fw
  %w = select.i32 %more, %fw, %b1
  %lw = call @__rc_work %w
  %donew = sub.i32 %w, %lw
  %left = sub.i32 %b1, %donew
  %gl = globaladdr @__rc_left
  store.i32.na %gl, %left
${asSteps("%budget", "%left")}  ret
}
func @__rc_dry() -> () {
bb_e:
  %gl = globaladdr @__rc_left
  %left = load.i32.na %gl
  brif %left, bb_look, bb_end
bb_end:
  ret
bb_look:
  %gq = globaladdr @__rc_q
  %gc = globaladdr @__rc_cur
  %q = load.ix.na %gq
  %c = load.ix.na %gc
  %any = or.ix %q, %c
  %z = iconst.ix 0
  %has = icmp.ne.ix %any, %z
  brif %has, bb_go, bb_end
bb_go:
  %l2 = call @__rc_work %left
  store.i32.na %gl, %l2
  %budget = iconst.i32 ${o.budget ?? RC_BUDGET}
${asSteps("%budget", "%l2", "%left")}  ret
}
func @__rc_rest(%left: i32) -> () {
bb_e:
  %gb = globaladdr @__rc_cc_busy
  %b = load.i32.na %gb
  %gl = globaladdr @__rc_left
  %z = iconst.i32 0
  store.i32.na %gl, %z
  brif %b, bb_go, bb_end
bb_end:
  ret
bb_go:
  %used = call @__rc_cc_paced %left
  %l2 = sub.i32 %left, %used
  %budget = iconst.i32 ${o.budget ?? RC_BUDGET}
${asSteps("%budget", "%l2", "%left")}  ret
}
func @__rc_cc_off(%p: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %mp = gep %p, %zx, 1, -4
  %lp = gep %p, %zx, 1, -16
  %l = load.ix.na %lp
  %s44 = iconst.ix 44
  %i = lshr.ix %l, %s44
  %tbl = globaladdr @__rc_cc_table
  %slot = gep %tbl, %i, 8, 0
  %gt = globaladdr @__rc_cc_top
  %t = load.i32.na %gt
  %one = iconst.i32 1
  %t1 = sub.i32 %t, %one
  store.i32.na %gt, %t1
  %t1x = zext.ix %t1
  %ls = gep %tbl, %t1x, 8, 0
  %other = load.ptr.na %ls
  store.ptr.na %slot, %other
  %oi = bitcast.ix %other
  %pi = bitcast.ix %p
  %same = icmp.eq.ix %oi, %pi
  brif %same, bb_plain, bb_move
bb_move:
  %olp = gep %other, %zx, 1, -16
  %ol = load.ix.na %olp
  %lo0 = ${low44}
  %ola = and.ix %ol, %lo0
  %ih = shl.ix %i, %s44
  %ol2 = or.ix %ih, %ola
  store.ix.na %olp, %ol2
  br bb_plain
bb_plain:
  %lo = ${low44}
  %a = and.ix %l, %lo
  %four = iconst.ix 4
  %b = shl.ix %a, %four
  store.ix.na %lp, %b
  %m = load.i32.na %mp
  %nb = iconst.i32 ${~RC_CC_BUF}
  %m1 = and.i32 %m, %nb
  store.i32.na %mp, %m1
  ret
}
func @__rc_cc_paced(%b: i32) -> (i32) {
bb_e:
  %left = call @__rc_cc_work %b
  %used = sub.i32 %b, %left
  call @__rc_cc_recheck
  ret %used
}
func @__rc_cc_work(%b: i32) -> (i32) {
bb_e:
  br bb_loop(%b)
bb_loop(%left: i32):
  %z = iconst.i32 0
  %out = icmp.eq.i32 %left, %z
  brif %out, bb_end(%left), bb_try
bb_try:
  %a = call @__rc_cc_active
${
  o.pace === false
    ? "  brif %a, bb_step, bb_end(%left)\n"
    : `  brif %a, bb_gapped, bb_end(%left)
bb_gapped:
  %gp = globaladdr @__rc_cc_phase
  %ph = load.i32.na %gp
  %gg = globaladdr @__rc_cc_gap
  %g = load.i32.na %gg
  %gx = globaladdr @__rc_cc_exh
  %ex = load.i32.na %gx
  %idle = icmp.eq.i32 %ph, %z
  %wait = icmp.ne.i32 %g, %z
  %notx = icmp.eq.i32 %ex, %z
  %w1 = and.i32 %idle, %wait
  %w2 = and.i32 %w1, %notx
  brif %w2, bb_end(%left), bb_step
`
}bb_step:
  call @__rc_cc_step
  %gwt = globaladdr @__rc_cc_wait
  %wt = load.i32.na %gwt
  brif %wt, bb_waited, bb_stepped
bb_waited:
  %zw = iconst.i32 0
  store.i32.na %gwt, %zw
  br bb_end(%left)
bb_stepped:
  %one = iconst.i32 1
  %l2 = sub.i32 %left, %one
  br bb_loop(%l2)
bb_end(%l: i32):
  %done = sub.i32 %b, %l
${ccSteps("%done")}  ret %l
}
func @__rc_cc_step() -> () {
bb_e:
  %gp = globaladdr @__rc_cc_phase
  %p = load.i32.na %gp
  %z = iconst.i32 0
  %is0 = icmp.eq.i32 %p, %z
  brif %is0, bb_0, bb_n1
bb_0:
  call @__rc_cc_p0
  ret
bb_n1:
  %one = iconst.i32 1
  %is1 = icmp.eq.i32 %p, %one
  brif %is1, bb_1, bb_n2
bb_1:
  call @__rc_cc_p1
  ret
bb_n2:
  %two = iconst.i32 2
  %is2 = icmp.eq.i32 %p, %two
  brif %is2, bb_2, bb_n3
bb_2:
  call @__rc_cc_p2
  ret
bb_n3:
  %three = iconst.i32 3
  %is3 = icmp.eq.i32 %p, %three
  brif %is3, bb_3, bb_n4
bb_3:
  call @__rc_cc_p3
  ret
bb_n4:
  %four = iconst.i32 4
  %is4 = icmp.eq.i32 %p, %four
  brif %is4, bb_4, bb_5
bb_4:
  call @__rc_cc_p4
  ret
bb_5:
  call @__rc_cc_p5
  ret
}
func @__rc_cc_cell(%x: ptr) -> (ptr) {
bb_e:
  %z = iconst.ix 0
  %lp = gep %x, %z, 1, -16
  %l = load.ix.na %lp
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %ins = iconst.i32 ${RC_CC_INS | RC_CC_BUF}
  %t = and.i32 %m, %ins
  brif %t, bb_scan, bb_plain
bb_plain:
  %p = bitcast.ptr %l
  ret %p
bb_scan:
  %lo = ${low44}
  %a = and.ix %l, %lo
  %four = iconst.ix 4
  %b = shl.ix %a, %four
  %q = bitcast.ptr %b
  ret %q
}
func @__rc_cc_next(%x: ptr) -> (ptr) {
bb_e:
  %z = iconst.ix 0
  %gmp = gep %x, %z, 1, -4
  %gm = load.i32.na %gmp
  %gmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %gb = and.i32 %gm, %gmask
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gone = icmp.eq.i32 %gb, %gsc
  brif %gone, bb_gone, bb_link
bb_gone:
  %gcp = gep %x, %z, 1, -8
  %gc = load.i32.na %gcp
  %gcx = zext.ix %gc
  %gfour = iconst.ix 4
  %gc4 = shl.ix %gcx, %gfour
  %gp = bitcast.ptr %gc4
  ret %gp
bb_link:
  %lp = gep %x, %z, 1, -16
  %l = load.ix.na %lp
  %lo = ${low44}
  %a = and.ix %l, %lo
  %four = iconst.ix 4
  %b = shl.ix %a, %four
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %t = and.i32 %m, %hc
  brif %t, bb_cell, bb_plain
bb_plain:
  %p = bitcast.ptr %b
  ret %p
bb_cell:
  %c = bitcast.ptr %b
  %eight = iconst.ix 8
  %np = gep %c, %eight, 1, 0
  %n = load.ptr.na %np
  ret %n
}
func @__rc_cc_set_next(%x: ptr, %n: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %gmp = gep %x, %z, 1, -4
  %gm = load.i32.na %gmp
  %gmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %gb = and.i32 %gm, %gmask
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gone = icmp.eq.i32 %gb, %gsc
  brif %gone, bb_gone, bb_link
bb_gone:
  %gni = bitcast.ix %n
  %gfour = iconst.ix 4
  %gn4 = lshr.ix %gni, %gfour
  %glim = iconst.ix 4294967295
  %gfits = icmp.ule.ix %gn4, %glim
  brif %gfits, bb_gstore, bb_gbad
bb_gbad:
  trap t900001
bb_gstore:
  %gn32 = trunc.i32 %gn4
  %gcp = gep %x, %z, 1, -8
  store.i32.na %gcp, %gn32
  ret
bb_link:
  %lp = gep %x, %z, 1, -16
  %l = load.ix.na %lp
  %lo = ${low44}
  %a = and.ix %l, %lo
  %four = iconst.ix 4
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %t = and.i32 %m, %hc
  brif %t, bb_cell, bb_plain
bb_plain:
  %hi = xor.ix %a, %l
  %ni = bitcast.ix %n
  %n4 = lshr.ix %ni, %four
  %l2 = or.ix %hi, %n4
  store.ix.na %lp, %l2
  ret
bb_cell:
  %b = shl.ix %a, %four
  %c = bitcast.ptr %b
  %eight = iconst.ix 8
  %np = gep %c, %eight, 1, 0
  store.ptr.na %np, %n
  ret
}
func @__rc_cc_edges(%x: ptr) -> (i32) {
bb_e:
  %z = iconst.ix 0
  %lp = gep %x, %z, 1, -16
  %l = load.ix.na %lp
  %s = iconst.ix 44
  %e = lshr.ix %l, %s
  %r = trunc.i32 %e
  ret %r
}
func @__rc_cc_join(%x: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %lp = gep %x, %z, 1, -16
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %keep = iconst.i32 ${RC_CC_NOT_SCAN}
  %m1 = and.i32 %m, %keep
  %ins = iconst.i32 ${RC_CC_INS}
  %m2 = or.i32 %m1, %ins
  store.i32.na %mp, %m2
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %t = and.i32 %m, %hc
  brif %t, bb_cell, bb_plain
bb_plain:
  store.ix.na %lp, %z
  br bb_add
bb_cell:
  %c = load.ptr.na %lp
  %ci = bitcast.ix %c
  %four = iconst.ix 4
  %c4 = lshr.ix %ci, %four
  store.ix.na %lp, %c4
  %eight = iconst.ix 8
  %np = gep %c, %eight, 1, 0
  store.ix.na %np, %z
  br bb_add
bb_add:
  %gt = globaladdr @__rc_cc_tail
  %t0 = load.ptr.na %gt
  %t0i = bitcast.ix %t0
  %none = icmp.eq.ix %t0i, %z
  brif %none, bb_first, bb_link
bb_first:
  %gh = globaladdr @__rc_cc_head
  store.ptr.na %gh, %x
  br bb_done
bb_link:
  call @__rc_cc_set_next %t0, %x
  br bb_done
bb_done:
  store.ptr.na %gt, %x
  %gs = globaladdr @__rc_cc_size
  %s0 = load.ix.na %gs
  %one = iconst.ix 1
  %s1 = add.ix %s0, %one
  store.ix.na %gs, %s1
  ret
}
func @__rc_cc_edge(%x: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %e = call @__rc_cc_edges %x
  %max = iconst.i32 ${RC_CC_EDGES_MAX}
  %full = icmp.uge.i32 %e, %max
  brif %full, bb_sat, bb_add
bb_sat:
  %bl = iconst.i32 ${RC_CC_BLACK}
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %m2 = or.i32 %m, %bl
  store.i32.na %mp, %m2
  ret
bb_add:
  %lp = gep %x, %z, 1, -16
  %l = load.ix.na %lp
  %one = iconst.ix ${RC_CC_ONE_EDGE}
  %l2 = add.ix %l, %one
  store.ix.na %lp, %l2
  ret
}
func @__rc_cc_slot(%x: ptr, %idx: ix) -> (ptr) {
bb_e:
  %z = iconst.ix 0
  %zero32 = iconst.i32 0
  %gk = globaladdr @__rc_cc_kind
  %mp = gep %x, %z, 1, -4
  %m = load.i32.na %mp
  %eight = iconst.i32 8
  %dw0 = lshr.i32 %m, %eight
  %dmask = iconst.i32 ${RC_CC_DESC_MASK}
  %dw = and.i32 %dw0, %dmask
  %dwx = zext.ix %dw
  %tbl = globaladdr @__rc_descs
  %d = gep %tbl, %dwx, 4, 0
  %w0 = load.i32.na %d
  %kmask = iconst.i32 255
  %kind = and.i32 %w0, %kmask
  %count = lshr.i32 %w0, %eight
  %two = iconst.i32 2
  %isvec = icmp.eq.i32 %kind, %two
  %mask = iconst.i32 ${1073741823}
  brif %isvec, bb_vec, bb_obj
bb_obj:
  %cx = zext.ix %count
  %more = icmp.ult.ix %idx, %cx
  brif %more, bb_objslot, bb_end
bb_objslot:
  %ep = gep %d, %idx, 4, 4
  %e = load.i32.na %ep
  %off = and.i32 %e, %mask
  %offx = zext.ix %off
  %slot = gep %x, %offx, 1, 0
  %ov = load.ptr.na %slot
  br bb_found(%ov, %e)
bb_vec:
  %w1p = gep %d, %z, 1, 4
  %w1 = load.i32.na %w1p
  %none = icmp.eq.i32 %w1, %zero32
  brif %none, bb_end, bb_vechas
bb_vechas:
  %lenp = gep %x, %z, 1, 8
  %len = load.ix.na %lenp
  %vm = icmp.ult.ix %idx, %len
  brif %vm, bb_vecslot, bb_end
bb_vecslot:
  %stride = and.i32 %w1, %mask
  %sx = zext.ix %stride
  %data = load.ptr.na %x
  %at = mul.ix %idx, %sx
  %vslot = gep %data, %at, 1, 0
  %vv = load.ptr.na %vslot
  br bb_found(%vv, %w1)
bb_found(%v: ptr, %w: i32):
  %s31 = iconst.i32 31
  %arr = lshr.i32 %w, %s31
  brif %arr, bb_arr(%v), bb_ref(%v, %w)
bb_arr(%va: ptr):
  %three = iconst.i32 3
  store.i32.na %gk, %three
  ret %va
bb_ref(%vr: ptr, %w2: i32):
  %s30 = iconst.i32 30
  %tr = lshr.i32 %w2, %s30
  %one = iconst.i32 1
  %k = sub.i32 %two, %tr
  store.i32.na %gk, %k
  ret %vr
bb_end:
  store.i32.na %gk, %zero32
  %nul = iconst.ptr 0
  ret %nul
}
func @__rc_cc_p0() -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
${stat("cc_scans", "1")}  %gp = globaladdr @__rc_cc_phase
  %five = iconst.i32 5
  store.i32.na %gp, %five
  %gt0 = globaladdr @__rc_cc_top
  %t0 = load.i32.na %gt0
  %gg = globaladdr @__rc_cc_gather
  store.i32.na %gg, %t0
  %gh = globaladdr @__rc_cc_head
  store.ix.na %gh, %zx
  %gt = globaladdr @__rc_cc_tail
  store.ix.na %gt, %zx
  %gs = globaladdr @__rc_cc_size
  store.ix.na %gs, %zx
  %gtr = globaladdr @__rc_cc_trunc
  store.i32.na %gtr, %z
  %gd = globaladdr @__rc_cc_dirty
  store.i32.na %gd, %z
  %gw = globaladdr @__rc_cc_wn
  store.ix.na %gw, %zx
  %gps = globaladdr @__rc_cc_npass
  store.i32.na %gps, %z
  ret
}
func @__rc_cc_p5() -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %one = iconst.i32 1
  %gg = globaladdr @__rc_cc_gather
  %g = load.i32.na %gg
  %none = icmp.eq.i32 %g, %z
  brif %none, bb_gathered, bb_take
bb_take:
  %g1 = sub.i32 %g, %one
  store.i32.na %gg, %g1
  %gt = globaladdr @__rc_cc_top
  %t = load.i32.na %gt
  %noneleft = icmp.eq.i32 %t, %z
  brif %noneleft, bb_left, bb_top
bb_left:
  ret
bb_top:
  %t1 = sub.i32 %t, %one
  %tx = zext.ix %t1
  %tbl = globaladdr @__rc_cc_table
  %slot = gep %tbl, %tx, 8, 0
  %p = load.ptr.na %slot
  call @__rc_cc_off %p
  call @__rc_cc_root %p
  ret
bb_gathered:
  %gh = globaladdr @__rc_cc_head
  %h = load.ptr.na %gh
  %hi = bitcast.ix %h
  %empty = icmp.eq.ix %hi, %zx
  brif %empty, bb_nothing, bb_trial
bb_nothing:
  %gp0 = globaladdr @__rc_cc_phase
  store.i32.na %gp0, %z
  call @__rc_cc_recheck
  ret
bb_trial:
  %gl2 = globaladdr @__rc_cc_level
  %lv2 = load.i32.na %gl2
  %first = iconst.ix ${RC_CC_FIRST_LIMIT}
  %two = iconst.i32 2
  %sh = mul.i32 %lv2, %two
  %shx = zext.ix %sh
  %lim0 = shl.ix %first, %shx
  %gs = globaladdr @__rc_cc_size
  %s = load.ix.na %gs
  %lim = add.ix %lim0, %s
  %glim = globaladdr @__rc_cc_limit
  store.ix.na %glim, %lim
  %gcur = globaladdr @__rc_cc_cur
  store.ptr.na %gcur, %h
  %gi = globaladdr @__rc_cc_idx
  store.ix.na %gi, %zx
  %gp1 = globaladdr @__rc_cc_phase
  store.i32.na %gp1, %one
  ret
}
func @__rc_cc_root(%p: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
${stat("cc_roots", "1")}  call @__rc_cc_join %p
  %mp = gep %p, %zx, 1, -4
  %rb = iconst.i32 ${RC_CC_ROOT}
  %m3 = load.i32.na %mp
  %m4 = or.i32 %m3, %rb
  store.i32.na %mp, %m4
  ret
}
func @__rc_cc_queue(%x: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %lp = gep %x, %zx, 1, -16
  %mp = gep %x, %zx, 1, -4
  %m = load.i32.na %mp
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %th = and.i32 %m, %hc
  brif %th, bb_cell, bb_link
bb_cell:
  %cell = load.ptr.na %lp
  %nhc = iconst.i32 ${~RC_CC_HASCELL}
  %m1 = and.i32 %m, %nhc
  store.i32.na %mp, %m1
  store.ix.na %lp, %zx
  call @__rc_dec %cell
  br bb_link
bb_link:
  %gq = globaladdr @__rc_q
  %head = load.ptr.na %gq
  store.ptr.na %lp, %head
  store.ptr.na %gq, %x
  ret
}
func @__rc_cc_p1() -> () {
bb_e:
  %zx = iconst.ix 0
  %gcur = globaladdr @__rc_cc_cur
  %gi = globaladdr @__rc_cc_idx
  %cur = load.ptr.na %gcur
  %idx = load.ix.na %gi
  %z = iconst.i32 0
  %one32 = iconst.i32 1
  %gmp = gep %cur, %zx, 1, -4
  %gm = load.i32.na %gmp
  %gmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %gb = and.i32 %gm, %gmask
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gone = icmp.eq.i32 %gb, %gsc
  brif %gone, bb_end, bb_look
bb_look:
  %v = call @__rc_cc_slot %cur, %idx
  %gk = globaladdr @__rc_cc_kind
  %k = load.i32.na %gk
  %end = icmp.eq.i32 %k, %z
  brif %end, bb_end, bb_slot
bb_slot:
  %isref = icmp.eq.i32 %k, %one32
  %vi = bitcast.ix %v
  %nn = icmp.ne.ix %vi, %zx
  %go = and.i32 %isref, %nn
  brif %go, bb_ref, bb_adv
bb_ref:
  %mp = gep %v, %zx, 1, -4
  %m = load.i32.na %mp
  %ins = iconst.i32 ${RC_CC_INS}
  %t = and.i32 %m, %ins
  brif %t, bb_edge, bb_new
bb_new:
  %gs = globaladdr @__rc_cc_size
  %s = load.ix.na %gs
  %glim = globaladdr @__rc_cc_limit
  %l = load.ix.na %glim
  %over = icmp.uge.ix %s, %l
  %gx = globaladdr @__rc_cc_exh
  %ex = load.i32.na %gx
  %notx = icmp.eq.i32 %ex, %z
  %stop = and.i32 %over, %notx
  brif %stop, bb_cut, bb_join
bb_cut:
  %gtr = globaladdr @__rc_cc_trunc
  store.i32.na %gtr, %one32
  br bb_adv
bb_join:
  %cand = iconst.i32 ${RC_CC_BUF}
  %tl = and.i32 %m, %cand
  brif %tl, bb_cand, bb_plainjoin
bb_cand:
  call @__rc_cc_off %v
  call @__rc_cc_root %v
  br bb_edge
bb_plainjoin:
  call @__rc_cc_join %v
  br bb_edge
bb_edge:
  call @__rc_cc_edge %v
  br bb_adv
bb_adv:
  %onex = iconst.ix 1
  %i2 = add.ix %idx, %onex
  store.ix.na %gi, %i2
  ret
bb_end:
  %nx = call @__rc_cc_next %cur
  store.ptr.na %gcur, %nx
  store.ix.na %gi, %zx
  %nxi = bitcast.ix %nx
  %last = icmp.eq.ix %nxi, %zx
  brif %last, bb_mark, bb_more
bb_more:
  ret
bb_mark:
${
  o.account
    ? `  %gs0 = globaladdr @__rc_cc_size
  %sz = load.i64.na %gs0
${maxStat("cc_max_scan", "%sz")}`
    : ""
}  %gp = globaladdr @__rc_cc_phase
  %two = iconst.i32 2
  store.i32.na %gp, %two
  %gprev = globaladdr @__rc_cc_prev
  store.ix.na %gprev, %zx
  %gh = globaladdr @__rc_cc_head
  %h = load.ptr.na %gh
  store.ptr.na %gcur, %h
  %gd = globaladdr @__rc_cc_dirty
  store.i32.na %gd, %z
  %gst = globaladdr @__rc_cc_start
  store.i32.na %gst, %one32
  ret
}
func @__rc_cc_p2() -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %one32 = iconst.i32 1
  %gcur = globaladdr @__rc_cc_cur
  %gi = globaladdr @__rc_cc_idx
  %gd = globaladdr @__rc_cc_dirty
  %gprev = globaladdr @__rc_cc_prev
  %gst = globaladdr @__rc_cc_start
  %bl = iconst.i32 ${RC_CC_BLACK}
  %st = load.i32.na %gst
  brif %st, bb_start, bb_go
bb_start:
  store.i32.na %gst, %z
${stat("cc_passes", "1")}  %gps = globaladdr @__rc_cc_npass
  %np0 = load.i32.na %gps
  %np1 = add.i32 %np0, %one32
  store.i32.na %gps, %np1
${
  o.account
    ? `  %npx = zext.i64 %np1
${maxStat("cc_max_passes", "%npx")}`
    : ""
}  br bb_go
bb_go:
  %x = load.ptr.na %gcur
  %xi = bitcast.ix %x
  %pend = icmp.eq.ix %xi, %zx
  brif %pend, bb_passend, bb_visit
bb_passend:
  %d0 = load.i32.na %gd
  %gpn = globaladdr @__rc_cc_pend
  %pn = load.ix.na %gpn
  %haspn = icmp.ne.ix %pn, %zx
  %nod = icmp.eq.i32 %d0, %z
  %wait = and.i32 %haspn, %nod
${o.ccFault === "no-giveup-wait" ? "  brif %z, bb_wait, bb_passgo\n" : "  brif %wait, bb_wait, bb_passgo\n"}
bb_wait:
  %gwt = globaladdr @__rc_cc_wait
  store.i32.na %gwt, %one32
  ret
bb_passgo:
  %pv = load.ptr.na %gprev
  %gh = globaladdr @__rc_cc_head
  store.ptr.na %gh, %pv
  store.ptr.na %gcur, %pv
  store.ix.na %gprev, %zx
  store.ix.na %gi, %zx
  %d = load.i32.na %gd
  brif %d, bb_again, bb_decide
bb_again:
  store.i32.na %gd, %z
  store.i32.na %gst, %one32
  ret
bb_decide:
  %gw = globaladdr @__rc_cc_wlist
  store.ix.na %gw, %zx
  %gph = globaladdr @__rc_cc_phase
  %three = iconst.i32 3
  store.i32.na %gph, %three
  ret
bb_visit:
  %mp = gep %x, %zx, 1, -4
  %m = load.i32.na %mp
  %gmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %gb = and.i32 %m, %gmask
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gone = icmp.eq.i32 %gb, %gsc
  brif %gone, bb_letgo, bb_visit2
bb_letgo:
  %lnx = call @__rc_cc_next %x
  call @__rc_cc_letgo %x
  store.ptr.na %gcur, %lnx
  store.ix.na %gi, %zx
  ret
bb_visit2:
  %idx = load.ix.na %gi
  %b0 = and.i32 %m, %bl
  %i0 = icmp.eq.ix %idx, %zx
  %nb = icmp.eq.i32 %b0, %z
  %first = and.i32 %i0, %nb
  brif %first, bb_compare, bb_check(%m)
bb_compare:
  %cp = gep %x, %zx, 1, -8
  %cnt = load.i32.na %cp
  %e = call @__rc_cc_edges %x
  %ne = icmp.ne.i32 %cnt, %e
${o.ccFault === "no-count-check" ? "  brif %z, bb_mismatch, bb_check(%m)\n" : "  brif %ne, bb_mismatch, bb_check(%m)\n"}bb_mismatch:
  %m1 = or.i32 %m, %bl
  store.i32.na %mp, %m1
  br bb_check(%m1)
bb_check(%mm: i32):
  %b1 = and.i32 %mm, %bl
  %scn = iconst.i32 ${RC_CC_SCANNED}
  %s1 = and.i32 %mm, %scn
  %ns = icmp.eq.i32 %s1, %z
  %blk = icmp.ne.i32 %b1, %z
  %both = and.i32 %blk, %ns
  brif %both, bb_trace(%mm), bb_adv
bb_trace(%mt: i32):
  %idx2 = load.ix.na %gi
  %v = call @__rc_cc_slot %x, %idx2
  %gk = globaladdr @__rc_cc_kind
  %k = load.i32.na %gk
  %fin = icmp.eq.i32 %k, %z
  brif %fin, bb_traced(%mt), bb_slot
bb_traced(%mf: i32):
  %m3 = load.i32.na %mp
  %m4 = or.i32 %m3, %scn
  store.i32.na %mp, %m4
  br bb_adv
bb_slot:
  %isref = icmp.eq.i32 %k, %one32
  %vi = bitcast.ix %v
  %nn = icmp.ne.ix %vi, %zx
  %go = and.i32 %isref, %nn
  brif %go, bb_child, bb_next
bb_child:
  %vmp = gep %v, %zx, 1, -4
  %vm = load.i32.na %vmp
  %ins = iconst.i32 ${RC_CC_INS}
  %vi1 = and.i32 %vm, %ins
  %vin = icmp.ne.i32 %vi1, %z
  %vb1 = and.i32 %vm, %bl
  %vnb = icmp.eq.i32 %vb1, %z
  %white = and.i32 %vin, %vnb
${o.ccFault === "no-trace" ? "  brif %z, bb_blacken, bb_next\n" : "  brif %white, bb_blacken, bb_next\n"}bb_blacken:
  %vm2 = or.i32 %vm, %bl
  store.i32.na %vmp, %vm2
  store.i32.na %gd, %one32
  br bb_next
bb_next:
  %onex = iconst.ix 1
  %i3 = add.ix %idx2, %onex
  store.ix.na %gi, %i3
  ret
bb_adv:
  %nx = call @__rc_cc_next %x
  %pv2 = load.ptr.na %gprev
  call @__rc_cc_set_next %x, %pv2
  store.ptr.na %gprev, %x
  store.ptr.na %gcur, %nx
  store.ix.na %gi, %zx
  ret
}
func @__rc_cc_clean(%x: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %mp = gep %x, %zx, 1, -4
  %lp = gep %x, %zx, 1, -16
  %m = load.i32.na %mp
  %keep = iconst.i32 ${RC_CC_NOT_SCAN}
  %m1 = and.i32 %m, %keep
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %th = and.i32 %m, %hc
  brif %th, bb_cell, bb_nocell
bb_cell:
  %cell = call @__rc_cc_cell %x
  br bb_plain(%cell)
bb_nocell:
  %np = iconst.ptr 0
  br bb_plain(%np)
bb_plain(%c: ptr):
  store.ptr.na %lp, %c
  store.i32.na %mp, %m1
  %cp = gep %x, %zx, 1, -8
  %cnt = load.i32.na %cp
  %live = icmp.ne.i32 %cnt, %z
  brif %live, bb_live, bb_dead
bb_dead:
  call @__rc_cc_queue %x
  ret
bb_live:
  %again = iconst.i32 ${RC_CC_AGAIN}
  %ta = and.i32 %m, %again
  brif %ta, bb_back, bb_root
bb_root:
  %gtr = globaladdr @__rc_cc_trunc
  %tr = load.i32.na %gtr
  %rb = iconst.i32 ${RC_CC_ROOT}
  %isr = and.i32 %m, %rb
  %isrn = icmp.ne.i32 %isr, %z
  %retry = and.i32 %isrn, %tr
  brif %retry, bb_retry, bb_done
bb_retry:
${stat("cc_retries", "1")}  br bb_back
bb_back:
  call @__rc_cc_push %x
  ret
bb_done:
  ret
}
func @__rc_cc_push(%x: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %mp = gep %x, %zx, 1, -4
  %lp = gep %x, %zx, 1, -16
  %tbl = globaladdr @__rc_cc_table
  %gt = globaladdr @__rc_cc_top
  %t = load.i32.na %gt
  %one = iconst.i32 1
  %cap = iconst.i32 ${RC_CC_TABLE}
  %full = icmp.uge.i32 %t, %cap
  brif %full, bb_evict, bb_room
bb_evict:
${stat("cc_evicted", "1")}  %gls = globaladdr @__rc_cc_lost
  store.i32.na %gls, %one
  %gv = globaladdr @__rc_cc_victim
  %v = load.i32.na %gv
  %v1 = add.i32 %v, %one
  %capm = iconst.i32 ${RC_CC_TABLE - 1}
  %v2 = and.i32 %v1, %capm
  store.i32.na %gv, %v2
  %vx = zext.ix %v
  %vs = gep %tbl, %vx, 8, 0
  %old = load.ptr.na %vs
  call @__rc_cc_off %old
  br bb_room
bb_room:
  %t0 = load.i32.na %gt
  %t1 = add.i32 %t0, %one
  store.i32.na %gt, %t1
  %m = load.i32.na %mp
  %bb = iconst.i32 ${RC_CC_BUF}
  %m1 = or.i32 %m, %bb
  store.i32.na %mp, %m1
  %ix = zext.ix %t0
  %slot = gep %tbl, %ix, 8, 0
  store.ptr.na %slot, %x
  %l = load.ix.na %lp
  %four = iconst.ix 4
  %l4 = lshr.ix %l, %four
  %s44 = iconst.ix 44
  %ih = shl.ix %ix, %s44
  %l5 = or.ix %ih, %l4
  store.ix.na %lp, %l5
  ret
}
func @__rc_cc_walk() -> () {
bb_e:
  %zx = iconst.ix 0
${stat("cc_walks", "1")}  %t0 = globaladdr @__rc_map
  br bb_l0(%zx)
bb_l0(%i0: ix):
  %n = iconst.ix 512
  %m0 = icmp.ult.ix %i0, %n
  brif %m0, bb_l0b, bb_end
bb_end:
  ret
bb_l0b:
  %a0 = gep %t0, %i0, 8, 0
  %t1 = load.ptr.na %a0
  %t1i = bitcast.ix %t1
  %e0 = icmp.eq.ix %t1i, %zx
  %one = iconst.ix 1
  %i0n = add.ix %i0, %one
  brif %e0, bb_l0(%i0n), bb_l1(%zx, %t1, %i0n)
bb_l1(%i1: ix, %t1b: ptr, %r0: ix):
  %m1 = icmp.ult.ix %i1, %n
  brif %m1, bb_l1b, bb_l0(%r0)
bb_l1b:
  %a1 = gep %t1b, %i1, 8, 0
  %t2 = load.ptr.na %a1
  %t2i = bitcast.ix %t2
  %e1 = icmp.eq.ix %t2i, %zx
  %i1n = add.ix %i1, %one
  brif %e1, bb_l1(%i1n, %t1b, %r0), bb_l2(%zx, %t2, %i1n, %t1b, %r0)
bb_l2(%i2: ix, %t2b: ptr, %r1: ix, %t1c: ptr, %r0b: ix):
  %m2 = icmp.ult.ix %i2, %n
  brif %m2, bb_l2b, bb_l1(%r1, %t1c, %r0b)
bb_l2b:
  %a2 = gep %t2b, %i2, 8, 0
  %t3 = load.ptr.na %a2
  %t3i = bitcast.ix %t3
  %e2 = icmp.eq.ix %t3i, %zx
  %i2n = add.ix %i2, %one
  brif %e2, bb_l2(%i2n, %t2b, %r1, %t1c, %r0b), bb_leaves
bb_leaves:
  call @__rc_cc_leaves %t3
  br bb_l2(%i2n, %t2b, %r1, %t1c, %r0b)
}
func @__rc_cc_leaves(%t3: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %n = iconst.ix 512
  %one = iconst.ix 1
  br bb_loop(%zx)
bb_loop(%i: ix):
  %m = icmp.ult.ix %i, %n
  brif %m, bb_look, bb_end
bb_end:
  ret
bb_look:
  %a = gep %t3, %i, 8, 0
  %leaf = load.ix.na %a
  %in = add.ix %i, %one
  %e = icmp.eq.ix %leaf, %zx
  brif %e, bb_loop(%in), bb_page
bb_page:
  call @__rc_cc_page %leaf
  br bb_loop(%in)
}
func @__rc_cc_page(%leaf: ix) -> () {
bb_e:
  %cm = iconst.ix 255
  %cl = and.ix %leaf, %cm
  %hm = iconst.ix -4096
  %pg = and.ix %leaf, %hm
  %runc = iconst.ix ${RC_RUN_CLASS}
  %isrun = icmp.uge.ix %cl, %runc
  brif %isrun, bb_run, bb_small
bb_run:
  %sixteen = iconst.ix 16
  %o = add.ix %pg, %sixteen
  %op = bitcast.ptr %o
  call @__rc_cc_maybe_root %op
  ret
bb_small:
  %base = iconst.ix 32
  %size = shl.ix %base, %cl
  %whole = iconst.ix 4096
  %end = add.ix %pg, %whole
  br bb_loop(%pg)
bb_loop(%b: ix):
  %next = add.ix %b, %size
  %fits = icmp.ule.ix %next, %end
  brif %fits, bb_block, bb_done
bb_done:
  ret
bb_block:
  %s16 = iconst.ix 16
  %o2 = add.ix %b, %s16
  %o2p = bitcast.ptr %o2
  call @__rc_cc_maybe_root %o2p
  br bb_loop(%next)
}
func @__rc_cc_maybe_root(%p: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %cp = gep %p, %zx, 1, -8
  %cnt = load.i32.na %cp
  %dead = icmp.eq.i32 %cnt, %z
  brif %dead, bb_no, bb_live
bb_no:
  ret
bb_live:
  %mp = gep %p, %zx, 1, -4
  %m = load.i32.na %mp
  %cyc = iconst.i32 ${RC_CC_CYC}
  %tc = and.i32 %m, %cyc
  %skip = iconst.i32 ${RC_CC_BUF | RC_CC_INS}
  %ts = and.i32 %m, %skip
  %clear = icmp.eq.i32 %ts, %z
  %go = and.i32 %tc, %clear
  brif %go, bb_root, bb_no
bb_root:
  call @__rc_cc_root %p
  ret
}
func @__rc_cc_p3() -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %one32 = iconst.i32 1
  %gcur = globaladdr @__rc_cc_cur
  %gi = globaladdr @__rc_cc_idx
  %x = load.ptr.na %gcur
  %xi = bitcast.ix %x
  %end = icmp.eq.ix %xi, %zx
  brif %end, bb_done, bb_visit
bb_done:
  %gw = globaladdr @__rc_cc_wn
  %wn = load.ix.na %gw
  %any = icmp.ne.ix %wn, %zx
  brif %any, bb_free, bb_none
bb_free:
  %gph = globaladdr @__rc_cc_phase
  %four = iconst.i32 4
  store.i32.na %gph, %four
  ret
bb_none:
${stat("cc_fruitless", "1")}  %gph2 = globaladdr @__rc_cc_phase
  store.i32.na %gph2, %z
  call @__rc_cc_nextlevel
  %gs0 = globaladdr @__rc_cc_size
  %s0 = load.ix.na %gs0
  %gtr0 = globaladdr @__rc_cc_trunc
  %tr0 = load.i32.na %gtr0
  %shw = iconst.ix ${RC_CC_GAP_SHIFT}
  %shc = iconst.ix ${RC_CC_GAP_SHIFT_CUT}
  %gapsh = select.ix %tr0, %shc, %shw
  %s1 = shl.ix %s0, %gapsh
  %s32 = trunc.i32 %s1
  %ggp = globaladdr @__rc_cc_gap
  store.i32.na %ggp, %s32
  call @__rc_cc_recheck
  ret
bb_visit:
  %mp = gep %x, %zx, 1, -4
  %m = load.i32.na %mp
  %gmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %gb = and.i32 %m, %gmask
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gone = icmp.eq.i32 %gb, %gsc
  brif %gone, bb_letgo, bb_visit2
bb_letgo:
  %lnx = call @__rc_cc_next %x
  call @__rc_cc_letgo %x
  store.ptr.na %gcur, %lnx
  store.ix.na %gi, %zx
  ret
bb_visit2:
  %bl = iconst.i32 ${RC_CC_BLACK}
  %held = and.i32 %m, %bl
  brif %held, bb_clean, bb_white
bb_clean:
  %nx = call @__rc_cc_next %x
  call @__rc_cc_clean %x
  store.ptr.na %gcur, %nx
  store.ix.na %gi, %zx
  ret
bb_white:
  %idx = load.ix.na %gi
  %i0 = icmp.eq.ix %idx, %zx
  brif %i0, bb_decided, bb_slots
bb_decided:
  %cp = gep %x, %zx, 1, -8
  store.i32.na %cp, %z
  %gwn = globaladdr @__rc_cc_wn
  %wn0 = load.ix.na %gwn
  %onex = iconst.ix 1
  %wn1 = add.ix %wn0, %onex
  store.ix.na %gwn, %wn1
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %th = and.i32 %m, %hc
  brif %th, bb_clearcell, bb_slots
bb_clearcell:
  %cell = call @__rc_cc_cell %x
  %np = iconst.ptr 0
  store.ptr.na %cell, %np
  br bb_slots
bb_slots:
  %idx2 = load.ix.na %gi
  %v = call @__rc_cc_slot %x, %idx2
  %gk = globaladdr @__rc_cc_kind
  %k = load.i32.na %gk
  %fin = icmp.eq.i32 %k, %z
  brif %fin, bb_listed, bb_slot
bb_listed:
  %nx2 = call @__rc_cc_next %x
  %gwl = globaladdr @__rc_cc_wlist
  %wl = load.ptr.na %gwl
  call @__rc_cc_set_next %x, %wl
  store.ptr.na %gwl, %x
  store.ptr.na %gcur, %nx2
  store.ix.na %gi, %zx
  ret
bb_slot:
  %vi = bitcast.ix %v
  %nn = icmp.ne.ix %vi, %zx
  brif %nn, bb_has, bb_next
bb_has:
  %three = iconst.i32 3
  %isarr = icmp.eq.i32 %k, %three
  brif %isarr, bb_arr, bb_ref
bb_arr:
  call @__rc_arr_dec %v
  br bb_next
bb_ref:
  %vmp = gep %v, %zx, 1, -4
  %vm = load.i32.na %vmp
  %ins = iconst.i32 ${RC_CC_INS}
  %vi1 = and.i32 %vm, %ins
  %vin = icmp.ne.i32 %vi1, %z
  %bl2 = iconst.i32 ${RC_CC_BLACK}
  %vb1 = and.i32 %vm, %bl2
  %vnb = icmp.eq.i32 %vb1, %z
  %inw = and.i32 %vin, %vnb
  brif %inw, bb_next, bb_dec
bb_dec:
  call @__rc_dec %v
  br bb_next
bb_next:
  %onex2 = iconst.ix 1
  %idx3 = load.ix.na %gi
  %i3 = add.ix %idx3, %onex2
  store.ix.na %gi, %i3
  ret
}
func @__rc_cc_letgo(%x: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %mp = gep %x, %zx, 1, -4
  %m = load.i32.na %mp
  %keep = iconst.i32 ${RC_CC_NOT_SCAN}
  %m1 = and.i32 %m, %keep
  %cp = gep %x, %zx, 1, -8
  store.i32.na %cp, %z
  %again = iconst.i32 ${RC_CC_AGAIN}
  %ta = and.i32 %m, %again
  brif %ta, bb_done, bb_out
bb_done:
  store.i32.na %mp, %m1
  call @__rc_block_free %x
  ret
bb_out:
  %sc = iconst.i32 ${RC_CC_SCANNED}
  %m2 = or.i32 %m1, %sc
  store.i32.na %mp, %m2
  ret
}
func @__rc_cc_nextlevel() -> () {
bb_e:
  %gtr = globaladdr @__rc_cc_trunc
  %tr = load.i32.na %gtr
  %gl = globaladdr @__rc_cc_level
  %l = load.i32.na %gl
  %one = iconst.i32 1
  %up = add.i32 %l, %one
  %top = iconst.i32 ${RC_CC_MAX_LEVEL}
  %over = icmp.ugt.i32 %up, %top
  %u2 = select.i32 %over, %top, %up
  %z = iconst.i32 0
  %v = select.i32 %tr, %u2, %z
  store.i32.na %gl, %v
  ret
}
func @__rc_cc_p4() -> () {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %gwl = globaladdr @__rc_cc_wlist
  %x = load.ptr.na %gwl
  %xi = bitcast.ix %x
  %end = icmp.eq.ix %xi, %zx
  brif %end, bb_done, bb_free
bb_done:
  %gph = globaladdr @__rc_cc_phase
  store.i32.na %gph, %z
  call @__rc_cc_nextlevel
  %gg = globaladdr @__rc_cc_gap
  store.i32.na %gg, %z
  call @__rc_cc_recheck
  ret
bb_free:
  %nx = call @__rc_cc_next %x
  store.ptr.na %gwl, %nx
  %mp = gep %x, %zx, 1, -4
  %lp = gep %x, %zx, 1, -16
  %m = load.i32.na %mp
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %th = and.i32 %m, %hc
  brif %th, bb_cell, bb_body
bb_cell:
  %cell = call @__rc_cc_cell %x
  call @__rc_dec %cell
  br bb_body
bb_body:
  %eight = iconst.i32 8
  %dw0 = lshr.i32 %m, %eight
  %dmask = iconst.i32 ${RC_CC_DESC_MASK}
  %dw = and.i32 %dw0, %dmask
  %dwx = zext.ix %dw
  %tbl = globaladdr @__rc_descs
  %d = gep %tbl, %dwx, 4, 0
  %w0 = load.i32.na %d
  %kmask = iconst.i32 255
  %kind = and.i32 %w0, %kmask
  %two = iconst.i32 2
  %isvec = icmp.eq.i32 %kind, %two
  brif %isvec, bb_vec, bb_hdr
bb_vec:
  %buf = load.ptr.na %x
  call @__rc_block_free %buf
  br bb_hdr
bb_hdr:
  store.ix.na %lp, %zx
${stat("cc_freed", "1")}  %keep = iconst.i32 ${RC_CC_NOT_SCAN}
  %m1 = and.i32 %m, %keep
  %nhc = iconst.i32 ${~RC_CC_HASCELL}
  %m2 = and.i32 %m1, %nhc
  store.i32.na %mp, %m2
  call @__rc_block_free %x
  ret
}
func @__rc_touch(%p: ptr) -> () {
bb_e:
${
  o.ccFault === "no-touch"
    ? "  ret\n}\n"
    : `  %zx = iconst.ix 0
  %z = iconst.i32 0
  %mp = gep %p, %zx, 1, -4
  %m = load.i32.na %mp
  %bl = iconst.i32 ${RC_CC_BLACK}
  %b = and.i32 %m, %bl
  brif %b, bb_done, bb_white
bb_done:
  ret
bb_white:
${
  o.check
    ? `  %dd = call @__rc_cc_decided %p
  brif %dd, bb_wrong, bb_right
bb_wrong:
  trap t900002
bb_right:
`
    : ""
}  %m2 = or.i32 %m, %bl
  store.i32.na %mp, %m2
${o.ccFault === "no-rescan" ? "" : "  %gd = globaladdr @__rc_cc_dirty\n  %one = iconst.i32 1\n  store.i32.na %gd, %one\n"}${stat("cc_touches", "1")}  ret
}
`
}func @__rc_cc_decided(%t: ptr) -> (i32) {
bb_e:
  %zx = iconst.ix 0
  %z = iconst.i32 0
  %ti = bitcast.ix %t
  %nul = icmp.eq.ix %ti, %zx
  brif %nul, bb_no, bb_look
bb_no:
  ret %z
bb_look:
  %mp = gep %t, %zx, 1, -4
  %m = load.i32.na %mp
  %ins = iconst.i32 ${RC_CC_INS}
  %t1 = and.i32 %m, %ins
  %bl = iconst.i32 ${RC_CC_BLACK}
  %t2 = and.i32 %m, %bl
  %inq = icmp.ne.i32 %t1, %z
  %white = icmp.eq.i32 %t2, %z
  %w = and.i32 %inq, %white
  %gp = globaladdr @__rc_cc_phase
  %ph = load.i32.na %gp
  %three = iconst.i32 3
  %four = iconst.i32 4
  %late = icmp.eq.i32 %ph, %three
  %later = icmp.eq.i32 %ph, %four
  %l = or.i32 %late, %later
  %r = and.i32 %w, %l
  ret %r
}
func @__rc_cand(%p: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %mp = gep %p, %zx, 1, -4
  %m = load.i32.na %mp
  %cyc = iconst.i32 ${RC_CC_CYC}
  %tc = and.i32 %m, %cyc
  brif %tc, bb_cyc, bb_ret
bb_ret:
  ret
bb_cyc:
  %ins = iconst.i32 ${RC_CC_INS}
  %ti = and.i32 %m, %ins
  brif %ti, bb_scan, bb_list
bb_scan:
  call @__rc_touch %p
  %m0 = load.i32.na %mp
  %ag = iconst.i32 ${RC_CC_AGAIN}
  %m1 = or.i32 %m0, %ag
  store.i32.na %mp, %m1
  ret
bb_list:
  %bufb = iconst.i32 ${RC_CC_BUF}
  %tb = and.i32 %m, %bufb
  brif %tb, bb_ret, bb_add
bb_add:
  call @__rc_cc_push %p
  %gb = globaladdr @__rc_cc_busy
  %b = load.i32.na %gb
  brif %b, bb_ret, bb_check
bb_check:
  call @__rc_cc_recheck
  ret
}
${
  o.check
    ? `func @__rc_ac(%p: ptr) -> () {
bb_e:
  %zx = iconst.ix 0
  %pi = bitcast.ix %p
  %nul = icmp.eq.ix %pi, %zx
  brif %nul, bb_ok, bb_look
bb_ok:
  ret
bb_look:
  %mp = gep %p, %zx, 1, -4
  %m = load.i32.na %mp
  %cyc = iconst.i32 ${RC_CC_CYC}
  %t = and.i32 %m, %cyc
  brif %t, bb_bad, bb_ok
bb_bad:
  trap t900002
}
`
    : ""
}`;
}

function rcText(o: RcBuild): string {
  let n = 0;
  const cc = o.cycles === true;
  const classMask = cc ? 63 : 255;
  const slotMask = cc ? 1073741823 : 2147483647;
  const stat = (name: string, by: string, sign: "add" | "sub" = "add"): string => {
    if (!o.account) return "";
    const i = n++;
    const byText = by.startsWith("%") ? by : `%sb${i}`;
    return `${by.startsWith("%") ? "" : `  %sb${i} = iconst.i64 ${by}\n`}  %sg${i} = globaladdr @__rc_s_${name}
  %sv${i} = load.i64.na %sg${i}
  %sn${i} = ${sign}.i64 %sv${i}, ${byText}
  store.i64.na %sg${i}, %sn${i}
`;
  };
  // A dead object's count is zero, so these two see it however it died.
  const trapZero = (c: string, lbl: string): string =>
    o.check
      ? `  %tz${lbl} = iconst.i32 0
  %tq${lbl} = icmp.eq.i32 ${c}, %tz${lbl}
  brif %tq${lbl}, bb_dead${lbl}, bb_live${lbl}
bb_dead${lbl}:
  trap t900002
bb_live${lbl}:
`
      : "";
  const poison = o.check
    ? `  %pz = iconst.i32 219
  intrinsic mem.fill %p, %pz, %psize
  %pc = gep %p, %zero, 1, -8
  %pzero = iconst.i32 0
  store.i32.na %pc, %pzero
`
    : "";
  const accountFree = o.account
    ? `${stat("frees", "1")}${stat("live_objects", "1", "sub")}  %fb = zext.i64 %whole
${stat("live_bytes", "%fb", "sub")}`
    : "";
  const accountNew = (bytes: string): string =>
    o.account
      ? `${stat("allocs", "1")}${stat("live_objects", "1")}  %nb = zext.i64 ${bytes}
${stat("live_bytes", "%nb")}`
      : "";
  return `
func @__rc_inc(%p: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %pi = bitcast.ix %p
  %nul = icmp.eq.ix %pi, %z
  brif %nul, bb_done, bb_go
bb_done:
  ret
bb_go:
  %a = gep %p, %z, 1, -8
  %c = load.i32.na %a
${trapZero("%c", "i")}  %one = iconst.i32 1
  %m = add.i32 %c, %one
  store.i32.na %a, %m
${stat("incs", "1")}${
    cc
      ? `  %mp = gep %p, %z, 1, -4
  %meta = load.i32.na %mp
  %ins = iconst.i32 ${RC_CC_INS}
  %t = and.i32 %meta, %ins
  brif %t, bb_touch, bb_done3
bb_touch:
  call @__rc_touch %p
  ret
bb_done3:
`
      : ""
  }  ret
}
func @__rc_dec(%p: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %pi = bitcast.ix %p
  %nul = icmp.eq.ix %pi, %z
  brif %nul, bb_done, bb_go
bb_done:
  ret
bb_go:
  %a = gep %p, %z, 1, -8
  %c = load.i32.na %a
${trapZero("%c", "d")}  %one = iconst.i32 1
  %m = sub.i32 %c, %one
  store.i32.na %a, %m
${stat("decs", "1")}  %zero32 = iconst.i32 0
  %last = icmp.eq.i32 %m, %zero32
  brif %last, bb_zero, bb_done2
bb_done2:
${cc ? "  call @__rc_cand %p\n" : ""}  ret
bb_zero:
  call @__rc_zero %p
  ret
}
func @__rc_zero(%p: ptr) -> () {
bb_e:
  %z = iconst.ix 0
  %lp = gep %p, %z, 1, -16
${
  cc
    ? `  %mp = gep %p, %z, 1, -4
  %m0 = load.i32.na %mp
  %ins = iconst.i32 ${RC_CC_INS}
  %t0 = and.i32 %m0, %ins
  brif %t0, bb_inscan, bb_notscan
bb_inscan:
  %gph = globaladdr @__rc_cc_phase
  %ph = load.i32.na %gph
  %three = iconst.i32 3
  %four = iconst.i32 4
  %ph3 = icmp.eq.i32 %ph, %three
  %ph4 = icmp.eq.i32 %ph, %four
  %decided = or.i32 %ph3, %ph4
  brif %decided, bb_held, bb_giveup
bb_giveup:
  %nx = call @__rc_cc_next %p
  %nxi = bitcast.ix %nx
  %four4 = iconst.ix 4
  %n4 = lshr.ix %nxi, %four4
  %lim = iconst.ix 4294967295
  %fits = icmp.ule.ix %n4, %lim
  brif %fits, bb_gu, bb_held
bb_gu:
  %ghc = iconst.i32 ${RC_CC_HASCELL}
  %gth = and.i32 %m0, %ghc
  brif %gth, bb_gucell, bb_guq
bb_gucell:
  %gcell = call @__rc_cc_cell %p
  %gnull = iconst.ptr 0
  store.ptr.na %gcell, %gnull
  store.ptr.na %lp, %gcell
  br bb_guq
bb_guq:
  %n32 = trunc.i32 %n4
  %gcp = gep %p, %z, 1, -8
  store.i32.na %gcp, %n32
  %gkeep = iconst.i32 ${~(RC_CC_BLACK | RC_CC_SCANNED | RC_CC_AGAIN)}
  %gm0 = and.i32 %m0, %gkeep
  %gsc = iconst.i32 ${RC_CC_SCANNED}
  %gm1 = or.i32 %gm0, %gsc
  store.i32.na %mp, %gm1
  %gpn = globaladdr @__rc_cc_pend
  %pn = load.ix.na %gpn
  %onex = iconst.ix 1
  %pn1 = add.ix %pn, %onex
  store.ix.na %gpn, %pn1
  call @__rc_cc_queue %p
  ret
bb_held:
  call @__rc_touch %p
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %t1 = and.i32 %m0, %hc
  brif %t1, bb_incell, bb_inret
bb_incell:
  %cp = call @__rc_cc_cell %p
  %np = iconst.ptr 0
  store.ptr.na %cp, %np
  ret
bb_inret:
  ret
bb_notscan:
  %bu = iconst.i32 ${RC_CC_BUF}
  %t2 = and.i32 %m0, %bu
  brif %t2, bb_leave, bb_plain
bb_leave:
  call @__rc_cc_off %p
  br bb_plain
bb_plain:
`
    : ""
}  %cell = load.ptr.na %lp
  %ci = bitcast.ix %cell
  %nocell = icmp.eq.ix %ci, %z
  brif %nocell, bb_queue, bb_weak
bb_weak:
  %nullp = iconst.ptr 0
  store.ptr.na %cell, %nullp
  call @__rc_dec %cell
  br bb_queue
bb_queue:
  %q = globaladdr @__rc_q
  %head = load.ptr.na %q
  store.ptr.na %lp, %head
  store.ptr.na %q, %p
  ret
}
func @__rc_block_size(%meta: i32) -> (i32) {
bb_e:
  %mask = iconst.i32 ${classMask}
  %c = and.i32 %meta, %mask
  %runc = iconst.i32 ${RC_RUN_CLASS}
  %isrun = icmp.uge.i32 %c, %runc
  brif %isrun, bb_run, bb_small
bb_small:
  %base = iconst.i32 32
  %s = shl.i32 %base, %c
  ret %s
bb_run:
  %k = sub.i32 %c, %runc
  %page = iconst.i32 4096
  %s2 = shl.i32 %page, %k
  ret %s2
}
func @__rc_block_free(%p: ptr) -> () {
bb_e:
  %zero = iconst.ix 0
  %mp = gep %p, %zero, 1, -4
  %meta = load.i32.na %mp
${
  o.check || o.account
    ? `  %whole = call @__rc_block_size %meta
  %wx = zext.ix %whole
  %sixteen = iconst.ix 16
  %psize = sub.ix %wx, %sixteen
`
    : ""
}${poison}${accountFree}  %block = gep %p, %zero, 1, -16
  %mask = iconst.i32 ${classMask}
  %c = and.i32 %meta, %mask
  %runc = iconst.i32 ${RC_RUN_CLASS}
  %isrun = icmp.uge.i32 %c, %runc
  brif %isrun, bb_run, bb_small
bb_small:
  %cx = zext.ix %c
  %lists = globaladdr @__rc_free
  %lp = gep %lists, %cx, 8, 0
  %head = load.ptr.na %lp
  store.ptr.na %block, %head
  store.ptr.na %lp, %block
  ret
bb_run:
  %k = sub.i32 %c, %runc
  %kx = zext.ix %k
  %rlists = globaladdr @__rc_runs
  %rp = gep %rlists, %kx, 8, 0
  %rhead = load.ptr.na %rp
  store.ptr.na %block, %rhead
  store.ptr.na %rp, %block
  ret
}
func @__rc_work(%budget: i32) -> (${cc ? "i32" : ""}) {
bb_e:
  %zero = iconst.ix 0
  %zero32 = iconst.i32 0
  %one32 = iconst.i32 1
  %gcur = globaladdr @__rc_cur
  %gidx = globaladdr @__rc_idx
  %gq = globaladdr @__rc_q
  br bb_loop(%budget)
bb_loop(%b: i32):
  %out = icmp.eq.i32 %b, %zero32
  brif %out, bb_end(%b), bb_more
bb_end(%left: i32):
${
  cc
    ? "  ret %left\n"
    : o.account
      ? `  %used32 = sub.i32 %budget, %left
  %used = zext.i64 %used32
${stat("steps", "%used")}  %mg = globaladdr @__rc_s_max_steps
  %mx = load.i64.na %mg
  %big = icmp.ugt.i64 %used, %mx
  %nm = select.i64 %big, %used, %mx
  store.i64.na %mg, %nm
`
      : ""
}${cc ? "" : "  ret\n"}bb_more:
  %cur0 = load.ptr.na %gcur
  %c0i = bitcast.ix %cur0
  %idle = icmp.eq.ix %c0i, %zero
  brif %idle, bb_take, bb_scan(%cur0)
bb_take:
  %q = load.ptr.na %gq
  %qi = bitcast.ix %q
  %empty = icmp.eq.ix %qi, %zero
  brif %empty, bb_end(%b), bb_pop
bb_pop:
  %lp = gep %q, %zero, 1, -16
  %nxt = load.ptr.na %lp
  store.ptr.na %gq, %nxt
  store.ptr.na %gcur, %q
  store.ix.na %gidx, %zero
  br bb_scan(%q)
bb_scan(%cur: ptr):
  %mp = gep %cur, %zero, 1, -4
  %meta = load.i32.na %mp
  %eight = iconst.i32 8
${
  cc
    ? `  %dw0 = lshr.i32 %meta, %eight
  %dmask = iconst.i32 ${RC_CC_DESC_MASK}
  %dw = and.i32 %dw0, %dmask
`
    : `  %dw = lshr.i32 %meta, %eight
`
}  %dwx = zext.ix %dw
  %tbl = globaladdr @__rc_descs
  %d = gep %tbl, %dwx, 4, 0
  %w0 = load.i32.na %d
  %kmask = iconst.i32 255
  %kind = and.i32 %w0, %kmask
  %count = lshr.i32 %w0, %eight
  %idx = load.ix.na %gidx
  %two32 = iconst.i32 2
  %isvec = icmp.eq.i32 %kind, %two32
  brif %isvec, bb_vec, bb_obj
bb_obj:
  %cx = zext.ix %count
  %more = icmp.ult.ix %idx, %cx
  brif %more, bb_objslot, bb_finish
bb_objslot:
  %ep = gep %d, %idx, 4, 4
  %e = load.i32.na %ep
  %high = iconst.i32 31
  %isarr = lshr.i32 %e, %high
  %lowmask = iconst.i32 ${slotMask}
  %off = and.i32 %e, %lowmask
  %offx = zext.ix %off
  %slot = gep %cur, %offx, 1, 0
  %ov = load.ptr.na %slot
  brif %isarr, bb_oarr, bb_oref
bb_oarr:
  call @__rc_arr_dec %ov
  br bb_step
bb_oref:
  call @__rc_dec %ov
  br bb_step
bb_vec:
  %w1p = gep %d, %zero, 1, 4
  %w1 = load.i32.na %w1p
  %noslots = icmp.eq.i32 %w1, %zero32
  brif %noslots, bb_vecdone, bb_vechas
bb_vechas:
  %lenp = gep %cur, %zero, 1, 8
  %len = load.ix.na %lenp
  %vmore = icmp.ult.ix %idx, %len
  brif %vmore, bb_vecslot, bb_vecdone
bb_vecslot:
  %vhigh = iconst.i32 31
  %varr = lshr.i32 %w1, %vhigh
  %vmask = iconst.i32 ${slotMask}
  %stride = and.i32 %w1, %vmask
  %sx = zext.ix %stride
  %data = load.ptr.na %cur
  %vat = mul.ix %idx, %sx
  %vslot = gep %data, %vat, 1, 0
  %vv = load.ptr.na %vslot
  brif %varr, bb_varr, bb_vref
bb_varr:
  call @__rc_arr_dec %vv
  br bb_step
bb_vref:
  call @__rc_dec %vv
  br bb_step
bb_step:
  %idx1 = load.ix.na %gidx
  %oneix = iconst.ix 1
  %idx2 = add.ix %idx1, %oneix
  store.ix.na %gidx, %idx2
  %b1 = sub.i32 %b, %one32
  br bb_loop(%b1)
bb_vecdone:
  %buf = load.ptr.na %cur
  call @__rc_block_free %buf
  br bb_finish
bb_finish:
${
  cc
    ? `  %fm = load.i32.na %mp
  %fmask = iconst.i32 ${RC_CC_SCANNED | RC_CC_BLACK}
  %fb = and.i32 %fm, %fmask
  %fsc = iconst.i32 ${RC_CC_SCANNED}
  %fgone = icmp.eq.i32 %fb, %fsc
  brif %fgone, bb_fgone, bb_ffree
bb_fgone:
  %fpn = globaladdr @__rc_cc_pend
  %fp = load.ix.na %fpn
  %fone = iconst.ix 1
  %fp1 = sub.ix %fp, %fone
  store.ix.na %fpn, %fp1
  %fins = iconst.i32 ${RC_CC_INS}
  %fti = and.i32 %fm, %fins
  brif %fti, bb_fdone, bb_fout
bb_fdone:
  %fag = iconst.i32 ${RC_CC_AGAIN}
  %fm2 = or.i32 %fm, %fag
  store.i32.na %mp, %fm2
  br bb_fafter
bb_fout:
  %fns = iconst.i32 ${~RC_CC_SCANNED}
  %fm3 = and.i32 %fm, %fns
  store.i32.na %mp, %fm3
  br bb_ffree
bb_ffree:
`
    : ""
}  call @__rc_block_free %cur
${cc ? "  br bb_fafter\nbb_fafter:\n" : ""}  %nullp = iconst.ptr 0
  store.ptr.na %gcur, %nullp
  %b2 = sub.i32 %b, %one32
  br bb_loop(%b2)
}
func @__rc_collect() -> () export {
bb_e:
  %zero = iconst.ix 0
  %gq = globaladdr @__rc_q
  %gcur = globaladdr @__rc_cur
${
  cc
    ? `  %gx = globaladdr @__rc_cc_exh
  %on = iconst.i32 1
  store.i32.na %gx, %on
  %lots = iconst.i32 1048576
  br bb_loop
bb_loop:
  %q = load.ix.na %gq
  %c = load.ix.na %gcur
  %both = or.ix %q, %c
  %idle = icmp.eq.ix %both, %zero
  brif %idle, bb_cc, bb_go
bb_go:
  %l0 = call @__rc_work %lots
${o.account ? `  %u0 = sub.i32 %lots, %l0\n  %u0x = zext.i64 %u0\n${stat("steps", "%u0x")}` : ""}  br bb_loop
bb_cc:
  %ph = call @__rc_cc_active
  brif %ph, bb_ccgo, bb_lost
bb_lost:
  %gls = globaladdr @__rc_cc_lost
  %ls = load.i32.na %gls
  brif %ls, bb_walk, bb_end
bb_walk:
  %nols = iconst.i32 0
  store.i32.na %gls, %nols
  call @__rc_cc_p0
  call @__rc_cc_walk
  br bb_loop
bb_ccgo:
  %l1 = call @__rc_cc_work %lots
${o.account ? `  %u1 = sub.i32 %lots, %l1\n  %u1x = zext.i64 %u1\n${stat("steps", "%u1x")}` : ""}  br bb_loop
bb_end:
  %off = iconst.i32 0
  store.i32.na %gx, %off
  call @__rc_cc_recheck
  ret
`
    : `  br bb_loop
bb_loop:
  %q = load.ix.na %gq
  %c = load.ix.na %gcur
  %both = or.ix %q, %c
  %done = icmp.eq.ix %both, %zero
  brif %done, bb_end, bb_go
bb_end:
  ret
bb_go:
  %lots = iconst.i32 1048576
  call @__rc_work %lots
  br bb_loop
`
}}
func @__rc_map_set(%base: ptr, %pages: ix, %val: i64) -> () {
bb_e:
  %on = globaladdr @__rc_map_on
  %flag = load.i32.na %on
  brif %flag, bb_go, bb_off
bb_off:
  ret
bb_go:
  %zero = iconst.ix 0
  %page = iconst.ix 4096
  br bb_loop(%zero)
bb_loop(%i: ix):
  %more = icmp.ult.ix %i, %pages
  brif %more, bb_put, bb_end
bb_end:
  ret
bb_put:
  %off = mul.ix %i, %page
  %at = gep %base, %off, 1, 0
  %leaf = call @__rc_map_leaf %at
  store.i64.na %leaf, %val
  %one = iconst.ix 1
  %i2 = add.ix %i, %one
  br bb_loop(%i2)
}
func @__rc_map_step(%tbl: ptr, %at: ix, %shift: ix) -> (ptr) {
bb_e:
  %s = lshr.ix %at, %shift
  %mask = iconst.ix 511
  %ix = and.ix %s, %mask
  %slot = gep %tbl, %ix, 8, 0
  %next = load.ptr.na %slot
  %z = iconst.ix 0
  %ni = bitcast.ix %next
  %none = icmp.eq.ix %ni, %z
  brif %none, bb_make, bb_have
bb_have:
  ret %next
bb_make:
  %t = call @__rc_page_any
  store.ptr.na %slot, %t
  ret %t
}
func @__rc_map_leaf(%p: ptr) -> (ptr) {
bb_e:
  %at = bitcast.ix %p
  %l0 = globaladdr @__rc_map
  %s39 = iconst.ix 39
  %l1 = call @__rc_map_step %l0, %at, %s39
  %s30 = iconst.ix 30
  %l2 = call @__rc_map_step %l1, %at, %s30
  %s21 = iconst.ix 21
  %l3 = call @__rc_map_step %l2, %at, %s21
  %s12 = iconst.ix 12
  %sh = lshr.ix %at, %s12
  %mask = iconst.ix 511
  %ix = and.ix %sh, %mask
  %slot = gep %l3, %ix, 8, 0
  ret %slot
}
func @__rc_find(%p: ptr) -> (ptr) {
bb_e:
  %at = bitcast.ix %p
  %z = iconst.ix 0
  %none = iconst.ptr 0
  %nul = icmp.eq.ix %at, %z
  brif %nul, bb_no, bb_l0
bb_no:
  ret %none
bb_l0:
  %tbl0 = globaladdr @__rc_map
  %s39 = iconst.ix 39
  %i0 = lshr.ix %at, %s39
  %mask = iconst.ix 511
  %x0 = and.ix %i0, %mask
  %a0 = gep %tbl0, %x0, 8, 0
  %t1 = load.ix.na %a0
  %m1 = icmp.eq.ix %t1, %z
  brif %m1, bb_no, bb_l1
bb_l1:
  %s30 = iconst.ix 30
  %i1 = lshr.ix %at, %s30
  %x1 = and.ix %i1, %mask
  %t1p = bitcast.ptr %t1
  %a1 = gep %t1p, %x1, 8, 0
  %t2 = load.ix.na %a1
  %m2 = icmp.eq.ix %t2, %z
  brif %m2, bb_no, bb_l2
bb_l2:
  %s21 = iconst.ix 21
  %i2 = lshr.ix %at, %s21
  %x2 = and.ix %i2, %mask
  %t2p = bitcast.ptr %t2
  %a2 = gep %t2p, %x2, 8, 0
  %t3 = load.ix.na %a2
  %m3 = icmp.eq.ix %t3, %z
  brif %m3, bb_no, bb_l3
bb_l3:
  %s12 = iconst.ix 12
  %i3 = lshr.ix %at, %s12
  %x3 = and.ix %i3, %mask
  %t3p = bitcast.ptr %t3
  %a3 = gep %t3p, %x3, 8, 0
  %leaf = load.i64.na %a3
  %z64 = iconst.i64 0
  %m4 = icmp.eq.i64 %leaf, %z64
  brif %m4, bb_no, bb_hit
bb_hit:
  %lm = iconst.i64 255
  %c64 = and.i64 %leaf, %lm
  %runc = iconst.i64 ${RC_RUN_CLASS}
  %isrun = icmp.uge.i64 %c64, %runc
  brif %isrun, bb_run, bb_small
bb_small:
  %base32 = iconst.ix 32
  %cx = bitcast.ix %c64
  %size = shl.ix %base32, %cx
  %m1s = iconst.ix 1
  %low = sub.ix %size, %m1s
  %all = iconst.ix -1
  %inv = xor.ix %low, %all
  %blk = and.ix %at, %inv
  %sixteen = iconst.ix 16
  %obj = add.ix %blk, %sixteen
  %objp = bitcast.ptr %obj
  ret %objp
bb_run:
  %hi = iconst.i64 -4096
  %base64 = and.i64 %leaf, %hi
  %bx = bitcast.ix %base64
  %sixteen2 = iconst.ix 16
  %obj2 = add.ix %bx, %sixteen2
  %obj2p = bitcast.ptr %obj2
  ret %obj2p
}
func @__rc_arr_inc(%p: ptr) -> () {
bb_e:
  %o = call @__rc_find %p
  call @__rc_inc %o
  ret
}
func @__rc_arr_dec(%p: ptr) -> () {
bb_e:
  %o = call @__rc_find %p
  call @__rc_dec %o
  ret
}
func @__rc_retain(%p: ptr) -> () export {
bb_e:
  call @__rc_inc %p
  ret
}
func @__rc_release(%p: ptr) -> () export {
bb_e:
  call @__rc_dec %p
  ret
}
func @__rc_retain_arr(%p: ptr) -> () export {
bb_e:
  call @__rc_arr_inc %p
  ret
}
func @__rc_release_arr(%p: ptr) -> () export {
bb_e:
  call @__rc_arr_dec %p
  ret
}
func @__rc_source(%n: ix) -> (ptr) {
bb_e:
  %g = globaladdr @__page_source
  %f = load.ptr.na %g
  %z = iconst.ix 0
  %fi = bitcast.ix %f
  %none = icmp.eq.ix %fi, %z
  brif %none, bb_no, bb_go
bb_no:
  %nul = iconst.ptr 0
  ret %nul
bb_go:
  %p = call.indirect sig0 %f, %n
  ret %p
}
func @__rc_split(%want: i32) -> (ptr) {
bb_e:
  %lists = globaladdr @__rc_runs
  %one = iconst.i32 1
  %z = iconst.ix 0
  %max = iconst.i32 ${RC_RUN_LISTS}
  br bb_scan(%want)
bb_scan(%k: i32):
  %out = icmp.uge.i32 %k, %max
  brif %out, bb_none, bb_try
bb_none:
  %nul = iconst.ptr 0
  ret %nul
bb_try:
  %kx = zext.ix %k
  %lp = gep %lists, %kx, 8, 0
  %head = load.ptr.na %lp
  %hi = bitcast.ix %head
  %empty = icmp.eq.ix %hi, %z
  brif %empty, bb_next, bb_found
bb_next:
  %k2 = add.i32 %k, %one
  br bb_scan(%k2)
bb_found:
  %link = load.ptr.na %head
  store.ptr.na %lp, %link
  br bb_cut(%k)
bb_cut(%at: i32):
  %done = icmp.eq.i32 %at, %want
  brif %done, bb_give, bb_halve
bb_give:
  ret %head
bb_halve:
  %low = sub.i32 %at, %one
  %lx = zext.ix %low
  %page = iconst.ix 4096
  %bytes = shl.ix %page, %lx
  %half = gep %head, %bytes, 1, 0
  %lq = gep %lists, %lx, 8, 0
  %lh = load.ptr.na %lq
  store.ptr.na %half, %lh
  store.ptr.na %lq, %half
  %pages = iconst.ix 1
  %pn = shl.ix %pages, %lx
  %runc = iconst.i32 ${RC_RUN_CLASS}
  %cls = add.i32 %low, %runc
  %v32 = zext.i64 %cls
  %hv = bitcast.i64 %half
  %val = or.i64 %hv, %v32
  call @__rc_map_set %half, %pn, %val
  br bb_cut(%low)
}
func @__rc_short(%k: i32) -> (ptr) {
bb_e:
${stat("full_drains", "1")}  call @__rc_collect
  %r = call @__rc_split %k
  ret %r
}
func @__rc_page_any() -> (ptr) {
bb_e:
  %one = iconst.ix 1
  %p = call @__rc_source %one
  %z = iconst.ix 0
  %pi = bitcast.ix %p
  %none = icmp.eq.ix %pi, %z
  brif %none, bb_short, bb_ok
bb_ok:
  ret %p
bb_short:
  %k0 = iconst.i32 0
  %r = call @__rc_short %k0
  %ri = bitcast.ix %r
  %none2 = icmp.eq.ix %ri, %z
  brif %none2, bb_oom, bb_fill
bb_oom:
  trap t900001
bb_fill:
  %zb = iconst.i32 0
  %page = iconst.ix 4096
  intrinsic mem.fill %r, %zb, %page
  ret %r
}
func @__rc_small(%c: i32) -> (ptr) {
bb_e:
${cc ? "  call @__rc_dry\n" : ""}  %cx = zext.ix %c
  %z = iconst.ix 0
  %lists = globaladdr @__rc_free
  %lp = gep %lists, %cx, 8, 0
  %thirtytwo = iconst.ix 32
  %size = shl.ix %thirtytwo, %cx
  %head = load.ptr.na %lp
  %hi = bitcast.ix %head
  %empty = icmp.eq.ix %hi, %z
  brif %empty, bb_bump, bb_reuse
bb_reuse:
  %link = load.ptr.na %head
  store.ptr.na %lp, %link
  %zero64 = iconst.i64 0
  br bb_wipe(%z)
bb_wipe(%at: ix):
  %wmore = icmp.ult.ix %at, %size
  brif %wmore, bb_wiping, bb_wiped
bb_wiped:
  ret %head
bb_wiping:
  %wp = gep %head, %at, 1, 0
  store.i64.na %wp, %zero64
  %eightw = iconst.ix 8
  %at2 = add.ix %at, %eightw
  br bb_wipe(%at2)
bb_bump:
  %curs = globaladdr @__rc_bump
  %ends = globaladdr @__rc_bump_end
  %cp = gep %curs, %cx, 8, 0
  %ep = gep %ends, %cx, 8, 0
  %cur = load.ix.na %cp
  %end = load.ix.na %ep
  %fits = icmp.ult.ix %cur, %end
  brif %fits, bb_take, bb_page
bb_take:
  %next = add.ix %cur, %size
  store.ix.na %cp, %next
  %out = bitcast.ptr %cur
  ret %out
bb_page:
  %one = iconst.ix 1
  %p = call @__rc_source %one
  %pi = bitcast.ix %p
  %none = icmp.eq.ix %pi, %z
  brif %none, bb_short, bb_fresh(%p)
bb_short:
${stat("full_drains", "1")}  call @__rc_collect
  %h2 = load.ptr.na %lp
  %h2i = bitcast.ix %h2
  %still = icmp.eq.ix %h2i, %z
  brif %still, bb_split, bb_reuse2
bb_reuse2:
  %link2 = load.ptr.na %h2
  store.ptr.na %lp, %link2
  %zb2 = iconst.i32 0
  intrinsic mem.fill %h2, %zb2, %size
  ret %h2
bb_split:
  %k0 = iconst.i32 0
  %r = call @__rc_split %k0
  %ri = bitcast.ix %r
  %nop = icmp.eq.ix %ri, %z
  brif %nop, bb_oom, bb_clean
bb_oom:
  trap t900001
bb_clean:
  %zb3 = iconst.i32 0
  %whole = iconst.ix 4096
  intrinsic mem.fill %r, %zb3, %whole
  br bb_fresh(%r)
bb_fresh(%pg: ptr):
  %v32 = zext.i64 %c
  %v0 = bitcast.i64 %pg
  %val = or.i64 %v0, %v32
  %pone = iconst.ix 1
  call @__rc_map_set %pg, %pone, %val
  %pgi = bitcast.ix %pg
  %after = add.ix %pgi, %size
  %whole2 = iconst.ix 4096
  %stop = add.ix %pgi, %whole2
  store.ix.na %cp, %after
  store.ix.na %ep, %stop
  ret %pg
}
func @__rc_run(%k: i32) -> (ptr) {
bb_e:
${cc ? "  call @__rc_dry\n" : ""}  %kx = zext.ix %k
  %z = iconst.ix 0
  %lists = globaladdr @__rc_runs
  %lp = gep %lists, %kx, 8, 0
  %page = iconst.ix 4096
  %bytes = shl.ix %page, %kx
  %one = iconst.ix 1
  %npages = shl.ix %one, %kx
  %head = load.ptr.na %lp
  %hi = bitcast.ix %head
  %empty = icmp.eq.ix %hi, %z
  brif %empty, bb_source, bb_reuse(%head)
bb_reuse(%h: ptr):
  %link = load.ptr.na %h
  store.ptr.na %lp, %link
  %zb = iconst.i32 0
  intrinsic mem.fill %h, %zb, %bytes
  ret %h
bb_source:
  %p = call @__rc_source %npages
  %pi = bitcast.ix %p
  %none = icmp.eq.ix %pi, %z
  brif %none, bb_short, bb_fresh(%p)
bb_short:
  %r = call @__rc_short %k
  %ri = bitcast.ix %r
  %nop = icmp.eq.ix %ri, %z
  brif %nop, bb_oom, bb_clean
bb_oom:
  trap t900001
bb_clean:
  %zb2 = iconst.i32 0
  intrinsic mem.fill %r, %zb2, %bytes
  br bb_mark(%r)
bb_fresh(%q: ptr):
  br bb_mark(%q)
bb_mark(%m: ptr):
  %runc = iconst.i64 ${RC_RUN_CLASS}
  %kk = bitcast.i64 %kx
  %cls = add.i64 %runc, %kk
  %mi = bitcast.i64 %m
  %val = or.i64 %mi, %cls
  call @__rc_map_set %m, %npages, %val
  ret %m
}
func @__rc_new(%size: ix, %desc: i32) -> (ptr) export {
bb_e:
  %z = iconst.ix 0
  %limit = iconst.ix 2147483647
  %huge = icmp.ugt.ix %size, %limit
  brif %huge, bb_oom, bb_fits
bb_oom:
  trap t900001
bb_fits:
  %gq = globaladdr @__rc_q
  %gc = globaladdr @__rc_cur
  %q = load.ix.na %gq
  %c = load.ix.na %gc
${
  cc
    ? `  %gb = globaladdr @__rc_cc_busy
  %cb = load.i32.na %gb
  %cbx = zext.ix %cb
  %any0 = or.ix %q, %c
  %any = or.ix %any0, %cbx
`
    : `  %any = or.ix %q, %c
`
}  %busy = icmp.ne.ix %any, %z
  brif %busy, bb_work, bb_take
bb_work:
  %budget = iconst.i32 ${o.budget ?? RC_BUDGET}
  call @${cc ? "__rc_steps" : "__rc_work"} %budget
  br bb_take
bb_take:
  %sixteen = iconst.ix 16
  %total0 = add.ix %size, %sixteen
  %minblock = iconst.ix 32
  %tiny = icmp.ult.ix %total0, %minblock
  %total = select.ix %tiny, %minblock, %total0
  %smax = iconst.ix ${RC_SMALL_MAX}
  %small = icmp.ule.ix %total, %smax
  brif %small, bb_small, bb_big
bb_small:
  %one = iconst.i32 1
  %t32 = trunc.i32 %total
  %t1 = sub.i32 %t32, %one
  %lz = intrinsic clz32 %t1
  %thirtytwo = iconst.i32 32
  %bits = sub.i32 %thirtytwo, %lz
  %five = iconst.i32 5
  %cl = sub.i32 %bits, %five
  %s32 = iconst.i32 32
  %whole = shl.i32 %s32, %cl
  %clx = zext.ix %cl
  %flists = globaladdr @__rc_free
  %flp = gep %flists, %clx, 8, 0
  %fhead = load.ptr.na %flp
  %fhi = bitcast.ix %fhead
  %fnone = icmp.eq.ix %fhi, %z
  brif %fnone, bb_slow, bb_fast
bb_slow:
  %b = call @__rc_small %cl
  br bb_head(%b, %cl, %whole)
bb_fast:
  %flink = load.ptr.na %fhead
  store.ptr.na %flp, %flink
  %wsize = zext.ix %whole
  %zero64 = iconst.i64 0
  br bb_wipe(%z)
bb_wipe(%at: ix):
  %wmore = icmp.ult.ix %at, %wsize
  brif %wmore, bb_wiping, bb_head(%fhead, %cl, %whole)
bb_wiping:
  %wp = gep %fhead, %at, 1, 0
  store.i64.na %wp, %zero64
  %eightw = iconst.ix 8
  %at2 = add.ix %at, %eightw
  br bb_wipe(%at2)
bb_big:
  %page = iconst.ix 4095
  %up = add.ix %total, %page
  %twelve = iconst.ix 12
  %n = lshr.ix %up, %twelve
  %one2 = iconst.ix 1
  %n1 = sub.ix %n, %one2
  %n32 = trunc.i32 %n1
  %lz2 = intrinsic clz32 %n32
  %thirtytwo2 = iconst.i32 32
  %k = sub.i32 %thirtytwo2, %lz2
  %r = call @__rc_run %k
  %runc = iconst.i32 ${RC_RUN_CLASS}
  %cr = add.i32 %k, %runc
  %pg32 = iconst.i32 4096
  %wr = shl.i32 %pg32, %k
  br bb_head(%r, %cr, %wr)
bb_head(%blk: ptr, %cls: i32, %bytes: i32):
${
  cc
    ? `  %gl2 = globaladdr @__rc_left
  %lf = load.i32.na %gl2
  brif %lf, bb_rest, bb_norest
bb_rest:
  call @__rc_rest %lf
  br bb_norest
bb_norest:
`
    : ""
}${accountNew("%bytes")}  %nullp = iconst.ptr 0
  store.ptr.na %blk, %nullp
  %cp = gep %blk, %z, 1, 8
  %one3 = iconst.i32 1
  store.i32.na %cp, %one3
  %mp = gep %blk, %z, 1, 12
  %eight = iconst.i32 8
  %dsh = shl.i32 %desc, %eight
  %meta = or.i32 %dsh, %cls
  store.i32.na %mp, %meta
  %obj = gep %blk, %z, 1, 16
  ret %obj
}
func @__vec_new_rc(%len: ix, %slot: ix, %desc: i32) -> (ptr) export {
bb_e:
  %hsize = iconst.ix 24
  %h = call @__rc_new %hsize, %desc
  %four = iconst.ix 4
  %small = icmp.ult.ix %len, %four
  %cap = select.ix %small, %four, %len
  %bytes = mul.chk.u.ix %cap, %slot, t900001
  %leaf = iconst.i32 ${RC_DESC_LEAF}
  %d = call @__rc_new %bytes, %leaf
  store.ptr.na %h, %d
  %zero = iconst.ix 0
  %lp = gep %h, %zero, 1, 8
  store.ix.na %lp, %len
  %cp = gep %h, %zero, 1, 16
  store.ix.na %cp, %cap
  ret %h
}
func @__vec_reserve_rc(%v: ptr, %need: ix, %slot: ix) -> () {
bb_e:
  %zero = iconst.ix 0
  %cp = gep %v, %zero, 1, 16
  %cap = load.ix.na %cp
  %enough = icmp.ule.ix %need, %cap
  brif %enough, bb_done, bb_grow
bb_done:
  ret
bb_grow:
  %two = iconst.ix 2
  %dbl = mul.chk.u.ix %cap, %two, t900001
  %small = icmp.ult.ix %dbl, %need
  %ncap = select.ix %small, %need, %dbl
  %bytes = mul.chk.u.ix %ncap, %slot, t900001
  %leaf = iconst.i32 ${RC_DESC_LEAF}
  %d = call @__rc_new %bytes, %leaf
  %lp = gep %v, %zero, 1, 8
  %len = load.ix.na %lp
  %old = load.ptr.na %v
  %used = mul.ix %len, %slot
  intrinsic mem.copy %d, %old, %used
  store.ptr.na %v, %d
  store.ix.na %cp, %ncap
  call @__rc_block_free %old
  ret
}
func @__rc_weak_new(%target: ptr) -> (ptr) {
bb_e:
  %z = iconst.ix 0
  %lp = gep %target, %z, 1, -16
${
  cc
    ? `  %mp = gep %target, %z, 1, -4
  %m0 = load.i32.na %mp
  %hc = iconst.i32 ${RC_CC_HASCELL}
  %t0 = and.i32 %m0, %hc
  brif %t0, bb_old, bb_make
bb_old:
  %c0 = call @__rc_cc_cell %target
  br bb_have(%c0)
bb_make:
  %sixteen = iconst.ix 16
  %leaf = iconst.i32 ${RC_DESC_LEAF}
  %made = call @__rc_new %sixteen, %leaf
  store.ptr.na %made, %target
  %m1 = load.i32.na %mp
  %m2 = or.i32 %m1, %hc
  store.i32.na %mp, %m2
  %ins = iconst.i32 ${RC_CC_INS | RC_CC_BUF}
  %t1 = and.i32 %m1, %ins
  brif %t1, bb_inscan, bb_plain
bb_plain:
  store.ptr.na %lp, %made
  br bb_have(%made)
bb_inscan:
  %l0 = load.ix.na %lp
  %lo = iconst.ix ${RC_CC_LOW44}
  %nx0 = and.ix %l0, %lo
  %four = iconst.ix 4
  %nx1 = shl.ix %nx0, %four
  %eight0 = iconst.ix 8
  %np = gep %made, %eight0, 1, 0
  store.ix.na %np, %nx1
  %hi = xor.ix %nx0, %l0
  %mi = bitcast.ix %made
  %mi4 = lshr.ix %mi, %four
  %l1 = or.ix %hi, %mi4
  store.ix.na %lp, %l1
  br bb_have(%made)
`
    : `  %cell0 = load.ptr.na %lp
  %ci = bitcast.ix %cell0
  %none = icmp.eq.ix %ci, %z
  brif %none, bb_make, bb_have(%cell0)
bb_make:
  %eight = iconst.ix 8
  %leaf = iconst.i32 ${RC_DESC_LEAF}
  %made = call @__rc_new %eight, %leaf
  store.ptr.na %made, %target
  store.ptr.na %lp, %made
  br bb_have(%made)
`
}bb_have(%cell: ptr):
  %eight2 = iconst.ix 8
  %wd = iconst.i32 ${RC_DESC_WEAK}
  %w = call @__rc_new %eight2, %wd
  store.ptr.na %w, %cell
  call @__rc_inc %cell
  ret %w
}
func @__rc_weak_deref(%w: ptr) -> (ptr) {
bb_e:
  %cell = load.ptr.na %w
  %t = load.ptr.na %cell
${
  cc && o.ccFault !== "no-weak-gate"
    ? `  %dead = call @__rc_cc_decided %t
  brif %dead, bb_gone, bb_ok
bb_gone:
  %nul = iconst.ptr 0
  ret %nul
bb_ok:
`
    : ""
}  call @__rc_inc %t
  ret %t
}
${cc ? ccText(o, stat) : ""}${
    o.check
      ? `func @__rc_chk(%p: ptr) -> (ptr) {
bb_e:
  %z = iconst.ix 0
  %pi = bitcast.ix %p
  %nul = icmp.eq.ix %pi, %z
  brif %nul, bb_ok, bb_look
bb_ok:
  ret %p
bb_look:
  %a = gep %p, %z, 1, -8
  %c = load.i32.na %a
  %zero = iconst.i32 0
  %dead = icmp.eq.i32 %c, %zero
  brif %dead, bb_bad, bb_ok
bb_bad:
  trap t900002
}
func @__rc_chk_arr(%p: ptr) -> (ptr) {
bb_e:
  %o = call @__rc_find %p
  %c = call @__rc_chk %o
  ret %p
}
`
      : ""
  }`;
}

/** The counted heap's runtime, in the shape the build asks for. */
export function rcRtFuncs(o: RcBuild): Func[] {
  return assemble(`sig sig0 (ix) -> (ptr)\n${rcText(o)}`).funcs;
}

export function rcRtGlobals(o: RcBuild, descs: number[], mapOn: boolean): Global[] {
  const bytes = new Uint8Array(new Uint32Array(descs).buffer);
  const out: Global[] = [
    { name: "__rc_q", size: 8, align: 8, section: "data" },
    { name: "__rc_cur", size: 8, align: 8, section: "data" },
    { name: "__rc_idx", size: 8, align: 8, section: "data" },
    { name: "__rc_free", size: 8 * RC_CLASSES, align: 8, section: "data" },
    { name: "__rc_bump", size: 8 * RC_CLASSES, align: 8, section: "data" },
    { name: "__rc_bump_end", size: 8 * RC_CLASSES, align: 8, section: "data" },
    { name: "__rc_runs", size: 8 * RC_RUN_LISTS, align: 8, section: "data" },
    { name: "__rc_map", size: 4096, align: 8, section: "data" },
    {
      name: "__rc_map_on",
      size: 4,
      align: 4,
      section: "data",
      bytes: new Uint8Array([mapOn ? 1 : 0, 0, 0, 0]),
    },
    { name: "__rc_descs", size: bytes.length, align: 4, section: "data", bytes },
  ];
  if (o.account) {
    for (const s of RC_STATS) out.push({ name: `__rc_s_${s}`, size: 8, align: 8, section: "data" });
  }
  if (o.cycles === true) {
    if (o.account) {
      for (const s of RC_CC_STATS)
        out.push({ name: `__rc_s_${s}`, size: 8, align: 8, section: "data" });
    }
    out.push({ name: "__rc_cc_table", size: 8 * RC_CC_TABLE, align: 8, section: "data" });
    out.push({ name: "__rc_left", size: 4, align: 4, section: "data" });
    for (const name of [
      "head",
      "tail",
      "cur",
      "prev",
      "idx",
      "size",
      "limit",
      "wlist",
      "wn",
      "pend",
    ])
      out.push({ name: `__rc_cc_${name}`, size: 8, align: 8, section: "data" });
    for (const name of [
      "phase",
      "gap",
      "busy",
      "exh",
      "top",
      "gather",
      "victim",
      "lost",
      "level",
      "trunc",
      "dirty",
      "kind",
      "start",
      "npass",
      "wait",
    ])
      out.push({ name: `__rc_cc_${name}`, size: 4, align: 4, section: "data" });
  }
  return out;
}

// --- what a native caller uses for a string (SPEC 4.5, D36): a flat one, placed by count, and its units in place afterwards.
export function strRtFuncs(mode: "leak" | "manual" | "rc"): Func[] {
  const call =
    mode === "rc"
      ? "%d0 = iconst.i32 0\n  %p = call @__rc_new %size, %d0"
      : `%p = call @${mode === "leak" ? "__leak_alloc" : "__heap_alloc"} %size`;
  const zero = mode === "manual" ? "%z = iconst.i32 0\n  intrinsic mem.fill %p, %z, %size" : "";
  const callee =
    mode === "rc"
      ? "extern @__rc_new(ix, i32) -> (ptr)"
      : `extern @${mode === "leak" ? "__leak_alloc" : "__heap_alloc"}(ix) -> (ptr)`;
  return assemble(`
${callee}
func @__str_place(%n: ix) -> (ptr) export {
bb_e:
  %two = iconst.ix 2
  %bytes = mul.chk.u.ix %n, %two, t900001
  %hdr = iconst.ix 16
  %size = add.ix %bytes, %hdr
  ${call}
  ${zero}
  %len = trunc.i32 %n
  %zero0 = iconst.ix 0
  store.i32.na %p, %len
  %op = gep %p, %zero0, 1, 8
  store.ix.na %op, %hdr
  ret %p
}
func @__str_units(%p: ptr) -> (ptr) export {
bb_e:
  %zero0 = iconst.ix 0
  %op = gep %p, %zero0, 1, 8
  %off = load.ix.na %op
  %u = gep %p, %off, 1, 0
  ret %u
}
func @__str_length(%p: ptr) -> (i32) export {
bb_e:
  %n = load.i32.na %p
  ret %n
}
`).funcs;
}

/** For a caller with entropy: hash flooding is only as hard as this key is to guess (SPEC 4.5, D42). */
export function hashRtFuncs(): Func[] {
  return assemble(`
func @__hash_key_use(%a: i32, %b: i32) -> () export {
bb_e:
  %g = globaladdr @__hash_key
  store.i32.na %g, %a
  %zero0 = iconst.ix 0
  %h = gep %g, %zero0, 1, 4
  store.i32.na %h, %b
  ret
}
`).funcs;
}

export const RC_TRAPS: TrapSite[] = [{ id: 900002, kind: "rc", code: 16, loc: "runtime" }];

// --- exceptions (SPEC 4.5, D36, D49): what a native caller has, in a module where something can throw.
// `__exc_catch_use(1)` asks an export to return zeros with its exception in flight, where it would otherwise take the trap
// path. `__exc_pending()` says whether one is, and `__exc_take()` gives the thrown value, an `unknown`, and clears it: in
// `rc` its count is the caller's, to give back with `__rc_release`.
const EXC = `
func @__exc_catch_use(%on: i32) -> () export {
bb_e:
  %g = globaladdr @__exc_mode
  store.i32.na %g, %on
  ret
}
func @__exc_stack_use(%limit: ptr) -> () export {
bb_e:
  %g = globaladdr @__exc_stack_limit
  store.ptr.na %g, %limit
  ret
}
func @__exc_pending() -> (i32) export {
bb_e:
  %g = globaladdr @__exc_on
  %v = load.i32.na %g
  ret %v
}
func @__exc_take() -> (ptr) export {
bb_e:
  %g = globaladdr @__exc_val
  %v = load.ptr.na %g
  %z = iconst.ptr 0
  store.ptr.na %g, %z
  %f = globaladdr @__exc_on
  %zi = iconst.i32 0
  store.i32.na %f, %zi
  ret %v
}
`;

export function excRtFuncs(): Func[] {
  return assemble(EXC).funcs;
}

export function excRtGlobals(): Global[] {
  return [
    { name: "__exc_on", size: 8, align: 8, section: "data" },
    { name: "__exc_val", size: 8, align: 8, section: "data" },
    { name: "__exc_mode", size: 8, align: 8, section: "data" },
    // Below this, a recursive function throws RangeError rather than run off the stack. 0, unless a caller sets it.
    { name: "__exc_stack_limit", size: 8, align: 8, section: "data" },
  ];
}
