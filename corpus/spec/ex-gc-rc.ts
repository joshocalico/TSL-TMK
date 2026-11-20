// file: ex-gc-rc.ts
import { idiv, tail, toU32, toU64, toUsize, Trap, trap, u32, u64, type bool, type usize } from "@tsl/core";
import { Heap } from "@tsl/alloc";
import {
  callRelease,
  copyBytes,
  countedExactly,
  cycleGroup,
  cycleGroupOf,
  cyclesLinked,
  elemSize,
  genOf,
  inlineOf,
  objectAt,
  placeObject,
  placeTail,
  ptrAt,
  releaseIndex,
  releaseIsEmpty,
  retireObject,
  slotOf,
  slotOfLive,
  sourcePages,
  tailAddr,
  tailBytes,
  type Elem,
  type Ptr,
} from "@tsl/unsafe";

/**
 * A counted reference: a reference to an object in a counted slot, carrying its generation like any `Slab` object's. The
 * tag makes it a handle: a `@tsl.moves` parameter of this type takes the caller's local over, and reading that local again
 * before assigning it is TSL3009 (3.5). A copy made some other way is still safe: once the count reaches zero and the
 * object goes, every reference to it is stale, and using one traps with code 5, wherever it's held (3.5).
 * @tsl.handle
 */
export type Counted<T extends object> = T;

/** Freeing steps an allocation does first, at most: one reference slot visited, or one block given back (D39). */
export const RC_BUDGET: usize = 32;

/**
 * What a release function is asked to do with the reference in a slot. `Drop` and `Collect` are freeing: the object is
 * going, so a vector may be emptied as it goes. `Scan` and `Trace` are the cycle collector looking (D41): the object may
 * well be alive, so a release function given either must change nothing, only visit the slot.
 */
export enum Visit {
  Drop = 0, //    give up the count the slot holds: the object holding it is being freed
  Collect = 1, // the same, for an object the cycle collector decided is garbage: what's garbage too is left alone
  Scan = 2, //    the collector counts an edge to what the slot refers to
  Trace = 3, //   the collector marks what the slot refers to as held
}

/**
 * A class's release function (3.5, D39, D74): `release(item, at, op)` does `op` to what's in `item`'s slot number `at`, and
 * gives how many slots `item` has. A slot is a reference, or past the references, something that isn't one, such as a
 * vector's buffer, which `Visit.Drop` gives back. Freeing calls it once for each slot, one step each, then gives the
 * object's own block back as one more, so an object holding a million references is a million and one steps. Given
 * `Visit.Scan` or `Visit.Trace`, it changes nothing: a slot past the last does nothing, and a vector's element is visited
 * where it is (D41).
 */
export type Release<T> = (item: T, at: usize, op: Visit) => usize;

/** Any counted object, as freeing sees it: its release function is called with it, as the class it really is. */
class Counted0 {}

// A slot is [count, or a waiting object's link: u64][generation: u32][store << 8 | size class: u32], then the object.
// The generation is odd while the object is live or waiting to be freed.
const SLOT_PREFIX: usize = 16;
const MAX_GEN: u32 = 0xfffe;
const WAITING: u64 = 0x8000_0000_0000_0000n; // a count word with this bit is a waiting object's queue link, not a count

// One counted heap for every class (D39's shared size classes): a slot is 2^k bytes, its prefix included, from 32. A
// freed slot goes on its size's list, whatever class it held, and the next object of any class that size takes it. Its
// generation stays in its prefix while it's free, and only ever goes up, so a reference to what it held before is stale
// whatever it holds now. Blocks are never given back to the heap below, so a slot is always a slot.
const FIRST_CLASS: usize = 5;
const CLASSES: usize = 48;

// Each store's entry in the table of stores, by its number (from 1): its release function's number in the program's closed
// set (callRelease, R1d), how many of its objects have been given back, with the collector its group in the type graph in
// that word's top 16 bits, and (R17) how many it has made, so that neither freeing nor making counts the objects of every
// store as well: rcLive adds the stores' up when it's asked. A fourth word, unused, makes an entry 32 bytes.
const ENTRY: usize = 32;
// R17: in the entry's first word, above the release function's number: its body is `return 0;` alone (releaseIsEmpty), so
// freeing one of the store's objects is giving its block back, one step, with no call.
const EMPTY: u64 = 0x1_0000_0000n;
const FREED: u64 = 0xffff_ffff_ffffn; // with the collector, the store's group is the freed count's top 16 bits
const MAX_STORES: u32 = 0xffff; // a store's number is 16 bits: the owner word's top byte is a scan's while it's on

// The cycle collector's state in a slot's prefix (3.5, D41, R1c). Nothing is added to a slot: a scan's state goes in the
// bits a live object's prefix doesn't use. In the count word, the count is the low 32 bits (as D39's count is 32 bits),
// and above it, for an object whose class can be in a cycle:
const COUNT: u64 = 0xffff_ffffn;
const ST_MASK: u64 = 0x7000_0000_0000_0000n; // its state, bits 60 to 62:
const ST_CAND: u64 = 0x1000_0000_0000_0000n; //   a candidate, in the table; bits 32 to 43 are where
const ST_WHITE: u64 = 0x2000_0000_0000_0000n; //  in the scan going on, not yet known to be held
const ST_HELD: u64 = 0x3000_0000_0000_0000n; //   in the scan, held: its count isn't the edges found, a count operation touched it, or
const ST_TRACED: u64 = 0x4000_0000_0000_0000n; // something held refers to it; and traced, what it refers to marked held too
// Given up (R1e): its count reached zero before the scan decided, so it's on the queue to be freed like any other, and the
// scan no longer looks at it. The scan takes it out of its list when it next passes it, and decides nothing while one it
// gave up still has references to drop (3.5's argument). While waiting, the next waiting object is the low 52 bits.
const ST_GONE: u64 = 0x5000_0000_0000_0000n; //  given up, still in the scan's list, waiting or being freed
const ST_OUT: u64 = 0x6000_0000_0000_0000n; //   given up and out of the list, still waiting or being freed
const ST_DONE: u64 = 0x7000_0000_0000_0000n; //  given up and freed but for its block, still in the list: the scan gives it back
const QLINK: u64 = 0x000f_ffff_ffff_ffffn;
const AGAIN: u64 = 0x0800_0000_0000_0000n; //  in the scan: a decrement left a count above zero, so it's a candidate again after
const ROOT: u64 = 0x0400_0000_0000_0000n; //   in the scan: it was a candidate, so it goes back in the table if the scan is cut off
const EDGE: u64 = 0x1_0000_0000n; //           edges found to it in the scan, bits 32 to 51
const EDGES: u64 = 0x000f_ffff_0000_0000n;
const EDGES_MAX: u64 = 0xf_ffffn; //            more than this from one scan, and it's held
const LINK_A: u64 = 0x03f0_0000_0000_0000n; // bits 52 to 57: the low 6 bits of the next object in the scan, as its address / 32
const CAND_SHIFT: u64 = 32n;
const NOT_LINK_A: u64 = 0xfc0fffffffffffffn;
const NOT_SCAN_BITS: u64 = 0x80000000ffffffffn;
const NOT_ST_MASK: u64 = 0x8fffffffffffffffn;
const NOT_EDGES: u64 = 0xfff00000ffffffffn;
const NOT_COUNT: u64 = 0xffffffff00000000n;
// The rest of the next object's address / 32 is in the generation word's top 16 bits (a generation is 16 bits, and
// gen.chk compares only those) and the owner word's top 8 (a store's number is 16 bits): 30 bits, so an object below 32
// GiB can be in a scan, and one above is never a candidate or reached, which is a leak and safe.
const SCANNABLE: u64 = 0x8_0000_0000n;
const FREES_STEPS: usize = 2; // with the collector linked, freeing's steps an allocation, unless its size's list is empty
const GROUP_UNKNOWN: u32 = 0xffff_ffff; // what cycleGroup<T>() is on the host, which can't see T: the store knows

// The candidate table and the scan's limits (D41).
const TABLE: u32 = 4096; //       candidates; with the table full, one is forgotten round-robin to make room
const FIRST_LIMIT: usize = 64; // objects in a scan, beyond its roots, at retry level 0; four times as many each level up
const MAX_LEVEL: u32 = 13;
const GAP_SHIFT: usize = 4; //    allocations to wait, per object in a scan that freed nothing, before another
const GAP_SHIFT_CUT: usize = 2; // the same for a scan cut off by its limit, which may simply not have got there yet
const CHUNK: usize = 4096; //     with the collector, fresh slots are cut from chunks of a size class, so the heap can be walked
const CHUNK_HEAD: usize = 32; //  [next chunk: u64][end of what's been cut: u64], then slots
const PAGE_CUT: usize = 2048; //  R19: without the collector, slots to this size are cut from a page of their size class

/** A slot's count word, or its link while it waits or is free. */
// SAFETY: every caller passes a counted slot, which is at least 32 bytes and never given back to the heap.
function countAt(slot: u64): Ptr<u64> {
  return ptrAt(u64, slot);
}

/** A slot's generation. */
// SAFETY: as countAt.
function genAt(slot: u64): Ptr<u32> {
  return ptrAt(u32, slot).add(2);
}

/** A slot's owner word: its store's number, times 256, plus its size class. */
// SAFETY: as countAt.
function ownerAt(slot: u64): Ptr<u32> {
  return ptrAt(u32, slot).add(3);
}

/**
 * The size class of a slot of `bytes`: 2^k bytes, from 32. R17: up to 2^31 bytes, the k with 2^(k-1) < bytes <= 2^k is
 * 32 less the leading zeros of bytes - 1, one instruction where it was a loop of one turn a doubling (a lowered array's
 * rooms are each a size of their own). R19: inlined, so a tail of a new length is made in line too (`tailFast`).
 */
/** @tsl.inline */
function sizeClass(bytes: usize): usize {
  if (bytes <= 32) return FIRST_CLASS;
  if (bytes <= 0x8000_0000) return toUsize(32 - Math.clz32(toU32(bytes - 1)));
  let k: usize = 32;
  while (toU64(1) << toU64(k) < toU64(bytes)) k++;
  return k;
}

/**
 * R22: the owner word of a store's object in size class k, from its owner word for one with no tail (`Rc.owner`, its number
 * times 256 plus that class, worked out checked when it registered): the same number, and k in the low byte. A size class is
 * below 256 (at most 64), so this is `id * 256 + k` with nothing to check, where that was a checked multiply and add each
 * time a tail's class changed.
 */
/** @tsl.inline */
function tailOwner(owner: u32, k: usize): u32 {
  return ((owner & 0xffff_ff00) | toU32(k)) >>> 0;
}

// SAFETY: the environment registered this source (setPageSource), and it's trusted to return what it promises (3.8).
function pages(n: usize): u64 {
  return sourcePages(n);
}

/** Where counted slots come from: one Heap over the registered page source, so a program needs nothing unsafe. */
const heap = new Heap(pages);

let heads: u64 = 0n; //      CLASSES heads of free slots, by size class
let cuts: u64 = 0n; //       R19, without the collector: CLASSES words, where each size class's page is cut to, then CLASSES
//                            more, where it ends
let table: u64 = 0n; //      the stores' entries
let tableCap: u32 = 0;
let stores: u32 = 0;
let waiting: u64 = 0n; //    objects whose count reached zero, linked through their count words, last first
let cur: u64 = 0n; //        the slot being freed, and how far through its reference slots: the cursor
let at: usize = 0;
let slots: usize = 0; //     how many the object at the cursor has, from its release function's first answer
let stepping: bool = false; // freeing or collecting is under way: a make inside a release function does no more
let budget: usize = RC_BUDGET;
let spare: u64 = 0n; //    while freeing visits a slot: steps the budget has left after it (R4), 0 everywhere else
let rest: usize = 0; //     with the collector linked: what this allocation's budget has left after freeing one object
// R17: a u64 added to in a wrap context, so not a checked add a step: a count of steps can't reach 2^64 (rcSteps converts it
// back, checked).
let stepsTaken: u64 = 0n;

// The cycle collector's globals: all cursors, so there's no stack (D41).
let ccTable: u64 = 0n; //   TABLE candidate slots
let ccTop: u32 = 0;
let ccVictim: u32 = 0; //   the next to forget when the table is full
let ccLost: bool = false; // a candidate was forgotten since the heap was last walked
let ccChunks: u64 = 0n; //  per size class: the newest chunk, where cutting is, and where it ends
let ccPhase: u32 = 0; //    0 idle, 5 taking roots, 1 finding edges, 2 marking, 3 deciding and releasing, 4 giving back
let ccGather: u32 = 0;
let ccHead: u64 = 0n; //    the scan's objects, linked through their prefixes
let ccTail: u64 = 0n;
let ccSize: usize = 0;
let ccLimit: usize = 0;
let ccLevel: u32 = 0;
let ccCut: bool = false; // something wasn't joined because of the limit: what it reaches is held, and roots go again
let ccDirty: bool = false; // something turned held since this marking pass began: another pass
let ccCur: u64 = 0n; //     where the phase is, and how far through that object's slots
let ccIdx: usize = 0;
let ccSlots: usize = 0; //  deciding: how many slots the garbage object at ccCur has
let ccPrev: u64 = 0n; //    marking: the list so far, reversed
let ccGarbage: u64 = 0n; // deciding: what's garbage, to give back
let ccFound: usize = 0;
let ccGroup: u32 = 0; //    the group of the object whose slots are being visited
let ccRel: u32 = 0; //      and its release function's number
let ccGap: usize = 0; //    allocations to wait before the next scan
let ccExh: bool = false; // running to completion: exhaustion, or rcCollect
let ccPending: usize = 0; // objects a scan gave up whose references aren't all dropped yet: no decision until it's 0
let ccWait: bool = false; // marking is waiting for those, so the step did nothing
let pacing: bool = true;
let walking: bool = true; // test builds can forbid exhaustion's heap walk (rcSetWalk), so needing it traps 14
let ccFreed: usize = 0;
let ccScans: usize = 0;
let ccTouched: usize = 0;
let ccWalks: usize = 0;
let ccSteps: usize = 0;
let ccGaveUp: usize = 0;

/** A store's entry. */
// SAFETY: id is a registered store's, below the table's capacity; this only forms the address.
function entryOf(id: u32): u64 {
  return ptrAt(u64, table).add(toUsize((id << 2) >>> 0)).addr; // a store's number is 16 bits: four words an entry
}

/** Objects made and not yet given back, in every store: what each store's entry counts, added up (R17). */
// SAFETY: every number from 1 to `stores` is a registered store's, below the table's capacity.
function liveCount(): u64 {
  let n: u64 = 0n;
  for (let id: u32 = 1; id <= stores; id++) {
    const e = ptrAt(u64, entryOf(id));
    n = BigInt.asUintN(64, n + e.add(2).read() - (e.add(1).read() & FREED));
  }
  return n;
}

// SAFETY: heads is a fresh block of CLASSES words, all set here; so are the collector's table and chunk records.
function setUp(): bool {
  const h = heap.allocBytes(CLASSES * 8);
  if (h === 0n) return false;
  for (let i: usize = 0; i < CLASSES; i++) ptrAt(u64, h).add(i).write(0n);
  if (cyclesLinked()) {
    const t = heap.allocBytes(toUsize(TABLE) * 8);
    const c = heap.allocBytes(CLASSES * 24);
    if (t === 0n || c === 0n) return false;
    for (let i: usize = 0; i < CLASSES * 3; i++) ptrAt(u64, c).add(i).write(0n);
    ccTable = t;
    ccChunks = c;
  } else {
    // R19: where each size class's page is cut to, then where it ends
    const c = heap.allocBytes(CLASSES * 16);
    if (c === 0n) return false;
    for (let i: usize = 0; i < CLASSES * 2; i++) ptrAt(u64, c).add(i).write(0n);
    cuts = c;
  }
  heads = h;
  return true;
}

/** With the collector, a fresh slot of size class k, cut from that class's newest chunk, or a new one; 0 if there's none. */
// SAFETY: a chunk is a fresh block of the heap's, CHUNK bytes or one slot's worth, recorded in its class's list before a
// slot is cut from it, and its end only ever moves forward over slots handed out.
function cutSlot(k: usize): u64 {
  const rec = ptrAt(u64, ccChunks).add(k * 3);
  const size = toU64(1) << toU64(k);
  let slot = rec.add(1).read();
  if (slot === 0n || slot + size > rec.add(2).read()) {
    const bytes: usize = toUsize(size) + CHUNK_HEAD <= CHUNK ? CHUNK : toUsize(size) + CHUNK_HEAD;
    const c = heap.allocBytes(bytes);
    if (c === 0n) return 0n;
    ptrAt(u64, c).write(rec.read());
    rec.write(c);
    slot = c + toU64(CHUNK_HEAD);
    rec.add(2).write(c + toU64(bytes));
  }
  rec.add(1).write(slot + size);
  ptrAt(u64, rec.read()).add(1).write(slot + size);
  return slot;
}

/**
 * R19: without the collector, a fresh slot of size class k: a small one (to PAGE_CUT bytes, as the direct route's small
 * blocks) cut from a page of its class's own, as the direct route cuts them, a larger one the heap's. Each small slot was
 * the heap's `allocBytes` (from `tmk profile`, a fresh object made was 241 instructions to the direct route's 116), and
 * the heap's one bump pointer, shared by every size and aligned to each, left the rest of a page behind whenever a size
 * didn't fit. 0 if there's none.
 */
/** @tsl.inline */
// SAFETY: a page is a fresh block of the heap's, PAGE_CUT * 2 bytes, recorded in its class's words of `cuts` before a slot
// is cut from it, and where cutting is only ever moves forward over slots handed out, each 2^k bytes, within the page: so
// an address plus a slot's size, at most the page's end, can't wrap.
function pageSlot(k: usize): u64 {
  // R26: k is a size class, below CLASSES (cuts' words at k are read below), so the shift loses nothing: a wrapping one,
  // where the checked shift's test that no bit was lost was ten instructions of every fresh slot.
  const size = BigInt.asUintN(64, toU64(1) << toU64(k));
  if (size > toU64(PAGE_CUT)) return heap.allocBytes(toUsize(size));
  const at = ptrAt(u64, cuts).add(k);
  const end = at.add(CLASSES);
  let slot = at.read();
  if (slot === 0n || BigInt.asUintN(64, slot + size) > end.read()) {
    const page = heap.allocBytes(PAGE_CUT * 2);
    if (page === 0n) return 0n;
    slot = page;
    end.write(BigInt.asUintN(64, page + toU64(PAGE_CUT * 2)));
  }
  at.write(BigInt.asUintN(64, slot + size));
  return slot;
}

/**
 * R28: pageSlot's common case alone, for `make`'s and `tailFast`'s fast paths in line: a slot of size class k cut from the
 * page its class is being cut from, where it's a small class and that page has room; 0 otherwise, and nothing changed, so
 * the caller goes on to `slotAfter` or `tailSlotAfter` (R30; `tryMakeAfter` and `tailMakeAfter` before), whose pageSlot
 * finds the same and takes a fresh page. A fresh object was a call out of line (`tryMakeAfter`, 59 instructions to the direct
 * route's `__rc_small` 34 at -O2, R26).
 */
/** @tsl.inline */
// SAFETY: as pageSlot's: where cutting is only ever moves forward over slots handed out, within the page.
function pageCut(k: usize): u64 {
  const size = BigInt.asUintN(64, toU64(1) << toU64(k));
  if (size > toU64(PAGE_CUT)) return 0n;
  const at = ptrAt(u64, cuts).add(k);
  const slot = at.read();
  if (slot === 0n || BigInt.asUintN(64, slot + size) > at.add(CLASSES).read()) return 0n;
  at.write(BigInt.asUintN(64, slot + size));
  return slot;
}

/**
 * R30: with the collector, cutSlot's common case alone, for `make`'s and `tailFast`'s fast paths in line, as pageCut is
 * without it: a slot of size class k cut from its class's newest chunk where that has room; 0 otherwise, and nothing
 * changed, so the caller goes on to `slotAfter` or `tailSlotAfter`, whose cutSlot finds the same and takes a fresh chunk.
 * Only where slotFor's dryStep would do nothing (nothing left of the budget, or nothing to free): the same slot, the same
 * steps. A fresh slot was a call out of line (tailMakeAfter, 58 instructions to the direct route's `__rc_small` 30).
 */
/** @tsl.inline */
// SAFETY: as cutSlot's: a chunk's end only ever moves forward over slots handed out, within the chunk, so an address plus a
// slot's size, at most the chunk's end, can't wrap.
function chunkCut(k: usize): u64 {
  const rec = ptrAt(u64, ccChunks).add(k * 3);
  const size = BigInt.asUintN(64, toU64(1) << toU64(k)); // k is a size class: below CLASSES, so nothing is lost
  const slot = rec.add(1).read();
  if (slot === 0n || BigInt.asUintN(64, slot + size) > rec.add(2).read()) return 0n;
  const end = BigInt.asUintN(64, slot + size);
  rec.add(1).write(end);
  ptrAt(u64, rec.read()).add(1).write(end);
  return slot;
}

/**
 * R19: slotFor where the caller has just found size class k's list empty after its freeing steps, with nothing run since
 * (`make`'s and `tailFast`'s fast paths, before `slotAfter` and `tailSlotAfter`): without the collector that's what
 * takeSlot would find too, so a fresh slot from its page straight away; and with no memory, slotDrained, as slotFor.
 */
/** @tsl.inline */
// SAFETY: as takeSlot's: a fresh block is 2^k bytes, and its generation is written here.
function freshSlot(k: usize): u64 {
  if (cyclesLinked()) return slotFor(k);
  const fresh = pageSlot(k);
  if (fresh === 0n) return slotDrained(k);
  genAt(fresh).write(0);
  return fresh;
}

/** A free slot of size class k: off its list, or fresh from the heap with its generation zero; 0 if neither has one. */
/** @tsl.inline */
// SAFETY: a slot on a list is free and 2^k bytes; a fresh block is 2^k bytes, and its generation is written here.
function takeSlot(k: usize): u64 {
  if (heads === 0n && !setUp()) return 0n;
  const head = ptrAt(u64, heads).add(k);
  const slot = head.read();
  if (slot !== 0n) {
    head.write(ptrAt(u64, slot).read());
    return slot;
  }
  const fresh = cyclesLinked() ? cutSlot(k) : pageSlot(k);
  if (fresh === 0n) return 0n;
  genAt(fresh).write(0);
  return fresh;
}

/**
 * A slot of size class k, everything waiting freed first if there's none otherwise; 0 if there's still none. R19: inlined
 * into the four out-of-line makes that call it, takeSlot with it, and what's done when there's none, `slotDrained`, kept out
 * of line: a fresh slot was three calls deep.
 */
/** @tsl.inline */
function slotFor(k: usize): u64 {
  if (cyclesLinked() && rest !== 0) dryStep(k);
  const slot = takeSlot(k);
  if (slot !== 0n) return slot;
  return slotDrained(k);
}

/** slotFor with no slot to be had: out of memory, everything waiting goes first, and garbage cycles, then it's asked again. */
/** @tsl.noinline */
function slotDrained(k: usize): u64 {
  if (cyclesLinked()) collectAll();
  else drainAll();
  return takeSlot(k);
}

/** Gives a freed object's slot back: its generation even, so every reference to it is stale, then on its size's list. */
/** @tsl.inline */
// SAFETY: slot is a counted slot whose object has been released, and it's on no list; entry is its store's.
function giveBack(slot: u64, owner: u32, entry: u64): void {
  retireObject(objectAt<Counted0>(slot));
  const g = genAt(slot);
  // R17: unchecked, as a live object's generation is odd and below MAX_GEN (a slot that reaches it is never claimed again)
  const gen = (g.read() + 1) >>> 0;
  g.write(gen); // even: every reference to it is stale from now on
  const freed = ptrAt(u64, entry).add(1);
  freed.write(BigInt.asUintN(64, freed.read() + 1n));
  if (gen >= MAX_GEN - 1) return; // out of generations: the slot is never reused
  const head = ptrAt(u64, heads).add(toUsize(owner % 0x100)); // its size class, as a u32: no sign to check
  countAt(slot).write(head.read());
  head.write(slot);
}

/**
 * Up to `n` steps of freeing (D39): each step visits one reference slot of the object at the cursor, through its store's
 * release function, or gives one block back. When the object at the cursor is done, the next is the one that waited last.
 * The cursor is held in locals while it runs and put back after, so a release function can't move it: a `make` one calls
 * frees nothing. An object's slots are visited in a loop of their own (R4), its store's release function found once.
 * While a slot is visited, `spare` is what the budget has left after that step: a release function dropping the last
 * count of an object with no slots of its own may give its block back at once, as one of those steps (`Rc.visitLeaf`).
 * Gives the steps it took.
 *
 * R17: the same steps in the same order, at the direct route's cost. Slot 0's visit, which says how many slots there are,
 * is taken first, outside the loop over the rest, so an object with none (the common case: a leaf) is one visit and its
 * block given back, with no test of the loop's; the budget is a u64 counted down unchecked, as it's tested above zero first;
 * and the cursor's position is read and put back only where an object is part freed.
 */
// SAFETY: a waiting slot holds its object still, linked only on the queue, and the cursor's slot was taken off it, so
// nothing else reaches it; its store's entry has the release function of the class it holds.
function freeSteps(n: usize): u64 {
  if (stepping) return 0n;
  stepping = true;
  let c = cur;
  let a: usize = 0;
  let s: usize = 0;
  if (c !== 0n) {
    a = at;
    s = slots;
  }
  const all = toU64(n);
  let left = all; // steps the budget has left
  while (left !== 0n) {
    if (c === 0n) {
      const slot = waiting;
      if (slot === 0n) break;
      const w = countAt(slot).read() ^ WAITING;
      waiting = cyclesLinked() && w >= ST_CAND ? w & QLINK : w; // one a scan gave up keeps its state above the link
      c = slot;
      a = 0;
    }
    const owner = ownerAt(c).read();
    // one a scan gave up may still be in its list, whose link is in the owner word's top byte
    const entry = entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8);
    const rel = ptrAt(u32, entry).read();
    const item = objectAt<Counted0>(c);
    if (a === 0) {
      // slot 0's visit, a step, which also says how many there are: with none, that step gives the block back
      spare = BigInt.asUintN(64, left - 1n);
      s = callRelease(rel, item, 0, Visit.Drop);
      left = spare;
      spare = 0n;
      a = 1;
    }
    if (s !== 0) {
      // the rest of its slots, one a step
      while (a < s && left !== 0n) {
        spare = BigInt.asUintN(64, left - 1n);
        callRelease(rel, item, a, Visit.Drop);
        left = spare;
        spare = 0n;
        a++;
      }
      // every slot visited, and the budget has room for giving the block back, a step of its own
      if (a < s || left === 0n) break;
      left = BigInt.asUintN(64, left - 1n);
    }
    if (cyclesLinked() && (countAt(c).read() ^ WAITING) >= ST_GONE && !releasedGivenUp(c)) {
      c = 0n; // a scan gave it up and it's still in the scan's list: the scan gives its block back
      continue;
    }
    giveBack(c, owner, entry);
    c = 0n;
  }
  cur = c;
  if (c !== 0n) {
    at = a;
    slots = s;
  }
  const took = BigInt.asUintN(64, all - left);
  stepsTaken = BigInt.asUintN(64, stepsTaken + took);
  stepping = false;
  return took;
}

/**
 * Up to `n` steps of freeing (D39), as freeSteps takes them, gives how many it took. R17: while the object waiting next is
 * one whose store's release function does nothing (EMPTY), and the cursor is idle, each step is giving its block back, as
 * freeSteps would after calling that function on slot 0 and being told there are none: the same step, the same effects, a
 * call less. That calls nothing, so nothing can come back in here, and `stepping` isn't needed for it. Anything else, from
 * where that stopped, is freeSteps', with what the budget has left: R19, by way of freeFlat for an object whose release
 * function isn't empty, which visits its slot 0 as freeSteps would.
 */
// SAFETY: as freeSteps: the queue's head is a waiting slot holding its object, and its store's entry is its class's.
function runSteps(n: usize): u64 {
  if (stepping) return 0n;
  if (cur !== 0n) return freeSteps(n);
  const all = toU64(n);
  let left = all;
  while (left !== 0n) {
    const slot = waiting;
    if (slot === 0n) break;
    const owner = ownerAt(slot).read();
    const entry = entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8);
    const w = countAt(slot).read() ^ WAITING;
    if (cyclesLinked() && w >= ST_CAND) {
      // one a scan gave up: freeSteps takes it from here, with what the budget has left
      const took = BigInt.asUintN(64, all - left);
      stepsTaken = BigInt.asUintN(64, stepsTaken + took);
      return BigInt.asUintN(64, took + freeSteps(toUsize(left)));
    }
    if ((ptrAt(u64, entry).read() & EMPTY) === 0n) {
      // R19: one whose release function isn't empty: freeFlat visits its slot 0, and freeSteps takes it on from slot 1 if
      // it has more. R21: the first waiting, with no step taken here, is freeFlat's whole, with nothing to add up
      if (left === all) return freeFlat(n);
      const took = BigInt.asUintN(64, all - left);
      stepsTaken = BigInt.asUintN(64, stepsTaken + took);
      return BigInt.asUintN(64, took + freeFlat(toUsize(left)));
    }
    waiting = w;
    giveBack(slot, owner, entry);
    left = BigInt.asUintN(64, left - 1n);
  }
  const took = BigInt.asUintN(64, all - left);
  stepsTaken = BigInt.asUintN(64, stepsTaken + took);
  return took;
}

/**
 * R19: runSteps' rest, from a waiting object whose store's release function isn't empty, with the cursor idle: up to `n`
 * steps, as freeSteps takes them. Each object's slots are visited in order, a step each, as freeSteps visits them, `spare`
 * what the budget has left after each; then giving its block back is a step of its own, but for an object with no slots,
 * whose slot 0's visit is that step; and the next waiting object is taken here too, an empty store's given back as runSteps
 * gives it. Where the budget runs out part way through an object, the cursor is left where freeSteps would have it, and the
 * next freeing takes it on there (freeSteps, as the cursor is set); at an object a scan gave up, freeSteps takes it whole.
 * So the same steps in the same order with the same effects, without freeSteps' frame and its cursor read and put back for
 * each call: from `tmk profile`, a lowered array of numbers' holder freed was 163 instructions against the direct route's
 * 77. Gives the steps it took.
 */
/** @tsl.noinline */
// SAFETY: as freeSteps: the queue's head is a waiting slot holding its object, taken off before its release function runs
// (which may queue more), and its store's entry is its class's; the cursor is idle, so nothing else is being freed.
function freeFlat(n: usize): u64 {
  if (stepping) return 0n;
  const all = toU64(n);
  let left = all;
  while (left !== 0n) {
    const head = waiting;
    if (head === 0n) break;
    const w = countAt(head).read() ^ WAITING;
    if (cyclesLinked() && w >= ST_CAND) break; // one a scan gave up: freeSteps' to take
    const owner = ownerAt(head).read();
    const entry = entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8);
    waiting = w;
    const rel = ptrAt(u32, entry).read();
    const item = objectAt<Counted0>(head);
    let s: usize = 0;
    let a: usize = 1;
    stepping = true;
    if ((ptrAt(u64, entry).read() & EMPTY) === 0n) {
      // slot 0's visit, a step, which also says how many there are
      spare = BigInt.asUintN(64, left - 1n);
      s = callRelease(rel, item, 0, Visit.Drop);
      left = spare;
      spare = 0n;
    } else left = BigInt.asUintN(64, left - 1n);
    if (s > 1) {
      // the rest of its slots, one a step, as freeSteps visits them (R21: an object of one slot has no rest, and isn't
      // dispatched on its release function a second time to find that out)
      while (a < s && left !== 0n) {
        spare = BigInt.asUintN(64, left - 1n);
        callRelease(rel, item, a, Visit.Drop);
        left = spare;
        spare = 0n;
        a++;
      }
    }
    stepping = false;
    if (s !== 0) {
      // every slot visited, and the budget has room for giving the block back, a step of its own; or the cursor left where
      // freeSteps would have it, for the next freeing to take on
      if (a < s || left === 0n) {
        cur = head;
        at = a;
        slots = s;
        break;
      }
      left = BigInt.asUintN(64, left - 1n);
    }
    if (cyclesLinked() && (countAt(head).read() ^ WAITING) >= ST_GONE && !releasedGivenUp(head)) continue;
    giveBack(head, owner, entry);
  }
  const took = BigInt.asUintN(64, all - left);
  stepsTaken = BigInt.asUintN(64, stepsTaken + took);
  if (left === 0n || (waiting === 0n && cur === 0n)) return took;
  return BigInt.asUintN(64, took + freeSteps(toUsize(left)));
}

/**
 * R24: an allocation's freeing without the collector linked (what `make` called runSteps for): up to `n` steps, as runSteps
 * takes them, gives how many it took. While the cursor is idle, at least two steps are left and the next waiting object has
 * at most one slot, it's freed here, as freeFlat frees it: slot 0's visit a step (`spare` what the budget has left after
 * it), then, for an object with one slot, giving its block back a step of its own, or, for one with none, that visit the
 * step that gives it back; and an empty store's object is given back as runSteps gives it. Where it has more slots, the
 * cursor is left at slot 1, where freeFlat's loop over its rest starts, and freeSteps takes it on from there with what the
 * budget has left, as it takes any object part freed. Anything else (the cursor set, a scan's object, one step left) is
 * runSteps', with what's left. So the same steps in the same order with the same effects, in one call: the strings'
 * one-slot objects went through runSteps' 33-instruction hand-over and freeFlat's frame, 187 instructions a freeing call
 * against the direct route's 108.
 *
 * R25: with one step left, too, as freeFlat takes it (slot 0's visit, then the cursor left at slot 1, or for an object with
 * no slots that visit the step that gives it back); and where the cursor is set with every slot of its object visited, its
 * block's step first, as freeSteps takes it, then the rest here. A one-slot object is two steps, so once a budget ran out
 * between them every later allocation found the cursor set that way and went through freeSteps' general loop, about 120
 * instructions an object where this takes 80 (split and join's strings, let go of by their array).
 */
/** @tsl.noinline */
// SAFETY: as freeFlat: the queue's head is a waiting slot holding its object, taken off before its release function runs
// (which may queue more), and its store's entry is its class's; the cursor is idle when the loop starts (a cursor whose
// object has every slot visited is that object's block given back first, as freeSteps gives it back), so nothing else is
// being freed.
function freeAlloc(n: usize): u64 {
  if (stepping) return runSteps(n);
  const all = toU64(n);
  let left = all;
  if (cur !== 0n) {
    // R25: the cursor's object with every slot visited, so only its block's step is left (a one-slot object's two steps
    // split by the budget leave it so, and from then on every allocation's would): that step taken here, as freeSteps
    // takes it first, then the rest as below; with slots of its own still to visit, freeSteps takes it on (runSteps')
    if (cyclesLinked() || at < slots || left === 0n) return runSteps(n);
    const c = cur;
    const owner = ownerAt(c).read();
    cur = 0n;
    left = BigInt.asUintN(64, left - 1n); // giving its block back, a step of its own
    giveBack(c, owner, entryOf(owner >>> 8));
  }
  // R25: down to the last step (R24 stopped at two): with one left, a waiting object's slot 0 visit is that step, and an
  // object with slots is left at the cursor's slot 1, as freeFlat leaves it, or its block given back where it has none
  while (left !== 0n) {
    const head = waiting;
    if (head === 0n) {
      // nothing more waiting, and the cursor idle: what runSteps' test after the loop would say
      const done = BigInt.asUintN(64, all - left);
      stepsTaken = BigInt.asUintN(64, stepsTaken + done);
      return done;
    }
    const w = countAt(head).read() ^ WAITING;
    if (cyclesLinked() && w >= ST_CAND) break; // one a scan gave up: freeSteps', by way of runSteps
    const owner = ownerAt(head).read();
    const entry = entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8);
    waiting = w;
    let s: usize = 0;
    if ((ptrAt(u64, entry).read() & EMPTY) === 0n) {
      // slot 0's visit, a step, which also says how many there are
      stepping = true;
      spare = BigInt.asUintN(64, left - 1n);
      const rel = ptrAt(u32, entry).read();
      // R28: the object made in the call, so each release function's arm makes its own class's (an address, for a lowered
      // package's class, with no generation read or put on, or masked off again)
      s = callRelease(rel, objectAt<Counted0>(head), 0, Visit.Drop);
      left = spare;
      spare = 0n;
      stepping = false;
      if (s !== 0) {
        if (s > 1 && left !== 0n) {
          // the rest of its slots (freeRest), out of line, so the common one-slot object keeps a small frame
          left = freeRest(head, entry, s, left);
          if (cur !== 0n) break;
        } else if (s > 1 || left === 0n) {
          // the cursor left where freeFlat leaves it, at slot 1, for the next freeing to take on
          cur = head;
          at = 1;
          slots = s;
          break;
        }
        left = BigInt.asUintN(64, left - 1n); // every slot visited: giving its block back, a step of its own
      }
    } else left = BigInt.asUintN(64, left - 1n);
    if (cyclesLinked() && (countAt(head).read() ^ WAITING) >= ST_GONE && !releasedGivenUp(head)) continue;
    giveBack(head, owner, entry);
  }
  const took = BigInt.asUintN(64, all - left);
  stepsTaken = BigInt.asUintN(64, stepsTaken + took);
  if (left === 0n || (waiting === 0n && cur === 0n)) return took;
  return BigInt.asUintN(64, took + runSteps(toUsize(left)));
}

/**
 * R24: freeAlloc's object of more than one slot, its slot 0 visited, `n` steps left (at least one): its slots from 1 visited
 * in order, one a step, as freeFlat visits them, `spare` what the budget has left after each. Gives what's left; where the
 * budget runs out before its block's step, the cursor is left where freeFlat leaves it, for the next freeing to take on.
 */
/** @tsl.noinline */
// SAFETY: as freeFlat: head is off the queue, its object still in its slot, and its store's entry, `entry`, is its class's.
function freeRest(head: u64, entry: u64, s: usize, n: u64): u64 {
  const rel = ptrAt(u32, entry).read();
  const item = objectAt<Counted0>(head);
  let left = n;
  let a: usize = 1;
  stepping = true;
  while (a < s && left !== 0n) {
    spare = BigInt.asUintN(64, left - 1n);
    callRelease(rel, item, a, Visit.Drop);
    left = spare;
    spare = 0n;
    a++;
  }
  stepping = false;
  if (a < s || left === 0n) {
    cur = head;
    at = a;
    slots = s;
  }
  return left;
}

/**
 * R24: `visitLeaf`'s last count, given back at once as a step the budget had to spare. Its store's entry is found from its
 * owner word, as freeing finds it, so the store's object isn't made at hand on the way that keeps a count.
 */
/** @tsl.inline */
// SAFETY: as visitLeaf's: slot is a live counted slot of a store whose objects have no slots, its one count the one being
// dropped, so what freeing would do with it is give its block back; its owner word names its store, whose entry is this.
function leafBack(slot: u64): void {
  spare = BigInt.asUintN(64, spare - 1n); // runSteps counts it: its steps are what the budget had, less what's left
  const owner = ownerAt(slot).read();
  giveBack(slot, owner, entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8));
}

/**
 * Freeing has dropped every reference in x, which a scan gave up (R1e): the scan may decide once none is left like it.
 * Whether its block can be given back now: not while it's still in the scan's list, as its link there is in its prefix.
 */
// SAFETY: x is a counted slot a scan gave up, all of whose slots freeing has visited.
function releasedGivenUp(x: u64): bool {
  ccPending--;
  const ca = countAt(x);
  const w = ca.read() ^ WAITING;
  if ((w & ST_MASK) === ST_OUT) return true;
  ca.write((w & LINK_A) | ST_DONE);
  return false;
}

/**
 * One allocation's work with the collector linked (D39, D41): the collector gets a quarter of the budget and one more,
 * freeing what's left, and the collector anything freeing didn't need. With no scan on and no candidate, it's freeing's
 * whole budget, exactly as with no collector. Steps of both count against the one budget.
 */
function stepAll(b: usize): void {
  rest = 0;
  if (stepping) return;
  if (pacing && ccGap > 0) ccGap--;
  let left = b;
  if (ccPhase !== 0 || ccTop !== 0) left -= ccWork(idiv(b, 4) + 1);
  rest = left;
  if (left > 0 && (waiting !== 0n || cur !== 0n)) freeOne(left);
}

/** An allocation while the collector has nothing to do, or waits out its gap: the gap goes by, freeing gets the budget. */
/** @tsl.inline */
function idleStep(): void {
  rest = 0;
  if (ccGap > 0 && pacing) ccGap--;
  if (waiting !== 0n || cur !== 0n) freeOne(budget);
}

/**
 * With the collector linked, an allocation frees one object (FREES_STEPS), and what its budget has left goes to more
 * freeing if its size's list is empty, then to the collector (`rest`), as the direct route does (D41, M5's Phase E: it
 * keeps a list's order, which freeing many objects for each one made, off a last-in, first-out list, loses).
 */
function freeOne(b: usize): void {
  rest = b;
  if (stepping) return;
  const slot = waiting;
  let took: u64 = cur === 0n && slot !== 0n && b >= FREES_STEPS ? quickFree(slot) : 0n;
  if (took === 0n) took = runSteps(b < FREES_STEPS ? b : FREES_STEPS);
  rest = b - toUsize(took);
}

/**
 * freeOne's common case (R1f, from `tmk profile`): the cursor idle, and the next waiting object not one a scan gave up. Its
 * first step is taken here rather than in runSteps' loop, and if the object has one reference slot, its second, giving its
 * block back: the same two steps runSteps takes, in the same order, with the same effects. Otherwise the cursor is left
 * where runSteps would have it after that first step, and runSteps takes the second. Gives true; false, having done
 * nothing, if the object was given up. Inlined into freeOne, its one caller (R4): a call and a frame less an allocation.
 * R17: gives the steps it took, 0 for none; and runSteps takes the second step only where there's one to take (the
 * cursor set, or another object waiting), as it would have taken none.
 */
/** @tsl.inline */
// SAFETY: slot is the queue's head, so a waiting slot that holds its object still, linked only on the queue; it's taken
// off before its release function runs, which may queue more. Its store's entry has the class's release function.
function quickFree(slot: u64): u64 {
  const w = countAt(slot).read() ^ WAITING;
  if (cyclesLinked() && w >= ST_CAND) return 0n; // given up by a scan: runSteps knows what to do
  waiting = w;
  const owner = ownerAt(slot).read();
  const entry = entryOf(cyclesLinked() ? (owner % 0x100_0000) >>> 8 : owner >>> 8);
  // R17: a store whose release function does nothing gives 0 for it without the call (EMPTY), as runSteps takes it
  let s: usize = 0;
  if ((ptrAt(u64, entry).read() & EMPTY) === 0n) {
    stepping = true;
    s = callRelease(ptrAt(u32, entry).read(), objectAt<Counted0>(slot), 0, Visit.Drop);
    stepping = false;
  }
  if (s === 1) {
    // its one slot visited: the second step gives its block back, as runSteps' would
    stepsTaken = BigInt.asUintN(64, stepsTaken + 2n);
    if (cyclesLinked() && (countAt(slot).read() ^ WAITING) >= ST_GONE && !releasedGivenUp(slot)) return 2n;
    giveBack(slot, owner, entry);
    return 2n;
  }
  // the first of runSteps' steps, taken: with no slots it gave the block back, with more the cursor is at slot 1
  stepsTaken = BigInt.asUintN(64, stepsTaken + 1n);
  if (s === 0) {
    if (!cyclesLinked() || (countAt(slot).read() ^ WAITING) < ST_GONE || releasedGivenUp(slot))
      giveBack(slot, owner, entry);
  } else {
    cur = slot;
    at = 1;
    slots = s;
    // R22: the second step, the visit of the slot at the cursor (slot 1), taken here as runSteps(1) took it (freeSteps with
    // a budget of one: `spare` 0 while the slot is visited, then the cursor one on), without the two calls and freeSteps'
    // frame; a thrown object (five slots) took both for every allocation that freed it
    stepping = true;
    callRelease(ptrAt(u32, entry).read(), objectAt<Counted0>(slot), at, Visit.Drop);
    stepping = false;
    at++;
    stepsTaken = BigInt.asUintN(64, stepsTaken + 1n);
    return 2n;
  }
  if (cur === 0n && waiting === 0n) return 1n;
  return 1n + runSteps(1);
}

/** Size class k's list is empty: freeing gets what the allocation's budget has left, before the heap is asked. */
// SAFETY: heads, once set, is a block of CLASSES words, and k is a size class.
function dryStep(k: usize): void {
  if (heads === 0n || ptrAt(u64, heads).add(k).read() !== 0n) return;
  if (waiting === 0n && cur === 0n) return;
  rest -= toUsize(runSteps(rest));
}

/** After the allocation: what its budget has left goes to the collector, as the direct route's `__rc_rest`. */
function restStep(): void {
  let left = rest;
  rest = 0;
  if (stepping) return;
  // only if the collector has work: idle, or waiting out its gap, it would take no step (R1f: the call cost churn a
  // tenth of an allocation's instructions)
  if (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))) left -= ccWork(left);
  // a scan waiting for what it gave up to be freed: freeing gets what the collector couldn't use (R1e)
  if (ccPending !== 0 && left > 0 && (waiting !== 0n || cur !== 0n)) runSteps(left);
}

/**
 * After an allocation, restStep only if it has something to do, tested here where the allocation is (R1f): with no scan
 * on, the collector's gap not over and no scan waiting on freeing, all it would do is clear `rest`.
 */
/** @tsl.inline */
function restIfWork(): void {
  if (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing)) || ccPending !== 0) restStep();
  else rest = 0;
}

/** Everything waiting, and what that releases. */
function drainAll(): void {
  if (stepping) return; // inside a release function: the freeing under way goes on after it
  while (waiting !== 0n || cur !== 0n) runSteps(0x10_0000);
}

/**
 * Exhaustion's pause, and `rcCollect` (D41): everything waiting freed, then the collector run to completion with no
 * limits, over the scan under way and then everything in the table, then, if a candidate was forgotten since the last
 * time, over every live object whose class can be in a cycle, found by walking the counted heap's chunks; then what that
 * released freed too. The one unbounded thing there is, and only here.
 */
function collectAll(): void {
  drainAll();
  if (stepping) return;
  ccRun(); // the scan under way, then what it let go
  // the table, until a round frees nothing: what one round frees can make candidates of what it held
  let live = BigInt.asUintN(64, liveCount() + 1n);
  while (ccTop !== 0 && liveCount() !== live) {
    live = liveCount();
    ccStart();
    ccRun();
  }
  if (ccLost && walking) {
    ccLost = false;
    ccWalk();
    ccRun();
  }
}

/** Runs the scan under way to completion with no limits, then frees what that let go. */
function ccRun(): void {
  stepping = true;
  ccExh = true;
  ccFinish();
  ccExh = false;
  stepping = false;
  drainAll();
}

/** Frees everything waiting now, and garbage cycles: the one unbounded call, and only when it's asked for (or at trap 14). */
export function rcCollect(): void {
  if (cyclesLinked()) collectAll();
  else drainAll();
}

/** Counted objects made and not yet given back, in every store: waiting ones count. For tests and assertions. */
export function rcLive(): usize {
  return toUsize(liveCount());
}

/**
 * R11: the freeing steps one allocation of the counted heap takes, with nothing allocated: for memory a counted object holds
 * that comes from elsewhere, as @tsl/jsrt's JsMap's tables in a lowered `rc` package come from @tsl/std (`tablesIn`), so
 * making it frees what's waiting at the pace the counted heap's own allocations do (D39), never more than the budget. It
 * takes what `make` takes before it looks for a slot, then, as for a size whose list is empty (an allocation from elsewhere
 * finds no free slot here), what the budget has left goes to freeing, and the collector gets what's left after that.
 */
export function rcAllocSteps(): void {
  if (cyclesLinked()) {
    if (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))) stepAll(budget);
    else idleStep();
    if (rest !== 0 && !stepping && (waiting !== 0n || cur !== 0n)) rest -= toUsize(runSteps(rest));
    if (rest !== 0) restIfWork();
  } else if (waiting !== 0n || cur !== 0n) freeAlloc(budget);
}

/** Freeing and collecting steps taken since the program started: a deterministic count, for tests (D39, D41). */
export function rcSteps(): usize {
  return toUsize(stepsTaken);
}

/** Freeing steps each allocation does first: RC_BUDGET unless a test says otherwise (at least 1). */
export function rcSetBudget(n: usize): void {
  budget = n < 1 ? 1 : n;
}

/** Test builds' switch for the cycle collector's pacing (D41): off, it works at every allocation, never waiting. */
export function rcSetPacing(on: bool): void {
  pacing = on;
}

/**
 * Test builds' switch for exhaustion's heap walk (D41): off, a forgotten candidate is never looked for, so a program whose
 * garbage cycles the paced collector didn't reach in time runs out of memory, trap 14, rather than pausing to walk the
 * heap. The churn tests turn it off, so pacing that falls behind shows (R1d).
 */
export function rcSetWalk(on: bool): void {
  walking = on;
}

/** Objects the cycle collector has freed as garbage in a cycle: for tests. */
export function rcCcFreed(): usize {
  return ccFreed;
}

/** Scans the cycle collector has started: for tests. */
export function rcCcScans(): usize {
  return ccScans;
}

/** Objects a count operation marked held during a scan: for tests. */
export function rcCcTouched(): usize {
  return ccTouched;
}

/** Walks of the whole counted heap, at exhaustion or in rcCollect: for tests. */
export function rcCcWalks(): usize {
  return ccWalks;
}

/** Steps the cycle collector took, of rcSteps: for tests. */
export function rcCcSteps(): usize {
  return ccSteps;
}

/** Objects a scan gave up because their count reached zero before it decided (R1e): for tests. */
export function rcCcGaveUp(): usize {
  return ccGaveUp;
}

/** Whether a scan is on: the `rc` expansion touches a vector's elements before moving them only then (D41's barrier). */
export function rcScanning(): bool {
  return ccPhase !== 0;
}

// ---- the cycle collector (3.5, D41, R1c): trial deletion that never changes a count, in bounded steps

/** The next object in the scan after x, from the three places its address is kept. Inlined at -O1 too (R1f). */
/** @tsl.inline */
// SAFETY: x is a counted slot in the scan.
function nextOf(x: u64): u64 {
  const a = (countAt(x).read() & LINK_A) >> 52n;
  const b = toU64(genAt(x).read() >>> 16);
  const c = toU64(ownerAt(x).read() >>> 24);
  return (a | (b << 6n) | (c << 22n)) << 5n;
}

/** Inlined (R1f): a call each time was a tenth of the cycles benchmark's collector instructions. */
/** @tsl.inline */
// SAFETY: x is a counted slot in the scan; n is one too, or 0, below SCANNABLE and 32-byte aligned as every slot is.
function setNext(x: u64, n: u64): void {
  const v = n >> 5n;
  const ca = countAt(x);
  ca.write((ca.read() & NOT_LINK_A) | ((v & 0x3fn) << 52n));
  const g = genAt(x);
  g.write((g.read() % 0x1_0000) + toU32((v >> 6n) & 0xffffn) * 0x1_0000);
  const o = ownerAt(x);
  o.write((o.read() % 0x100_0000) + toU32((v >> 22n) & 0xffn) * 0x100_0000);
}

/** Out of the scan: its prefix as it was before it joined, count kept. */
// SAFETY: x is a counted slot in the scan or the table.
function clearScan(x: u64): void {
  const ca = countAt(x);
  ca.write(ca.read() & NOT_SCAN_BITS);
  const g = genAt(x);
  g.write(g.read() % 0x1_0000);
  const o = ownerAt(x);
  o.write(o.read() % 0x100_0000);
}

/** The group of the class in slot x: its store's, from the table of stores. */
// SAFETY: x is a live counted slot; its store is registered.
function groupOf(x: u64): u32 {
  return toU32(ptrAt(u64, entryOf((ownerAt(x).read() % 0x100_0000) >>> 8)).add(1).read() >> 48n);
}

/**
 * Calls x's release function on slot `at` with `op`: gives how many slots x has. Every phase visits an object's slots
 * from 0 up, one a step, so its store's release function and group are found at slot 0 and kept for the rest (R1e).
 */
/** @tsl.inline */
// SAFETY: x is a live counted slot; its store's entry has the number of the release function of the class it holds.
function releaseCall(x: u64, at: usize, op: Visit): usize {
  if (at === 0) {
    const entry = entryOf((ownerAt(x).read() % 0x100_0000) >>> 8);
    ccGroup = toU32(ptrAt(u64, entry).add(1).read() >> 48n);
    ccRel = ptrAt(u32, entry).read();
  }
  return callRelease(ccRel, objectAt<Counted0>(x), at, op);
}

/** The barrier (D41): a count operation or count-preserving move on an object in the scan marks it held. */
// SAFETY: x is a live counted slot.
function touch(x: u64): void {
  const ca = countAt(x);
  const n = ca.read();
  if ((n & ST_MASK) !== ST_WHITE) return;
  ca.write((n & NOT_ST_MASK) | ST_HELD);
  ccDirty = true;
  ccTouched++;
}

/** A candidate leaves the table in constant time: the last one takes its place. */
/** @tsl.inline */
// SAFETY: x is a counted slot in the table, its index in its count word.
function tableOff(x: u64): void {
  const ca = countAt(x);
  const n = ca.read();
  const i = toUsize((n >> CAND_SHIFT) & 0xfffn);
  ccTop--;
  const last = ptrAt(u64, ccTable).add(toUsize(ccTop)).read();
  ptrAt(u64, ccTable).add(i).write(last);
  if (last !== x) {
    const la = countAt(last);
    la.write((la.read() & NOT_EDGES) | (toU64(i) << CAND_SHIFT));
  }
  ca.write(n & NOT_SCAN_BITS);
}

/** A decrement left a count above zero (D41): a candidate, if it isn't one, forgetting another if the table is full. */
/** @tsl.inline */
// SAFETY: x is a live counted slot whose class can be in a cycle, in no scan.
function tablePush(x: u64): void {
  if (ccTable === 0n || x >= SCANNABLE) {
    ccLost = true;
    return;
  }
  if (ccTop >= TABLE) {
    const v = ptrAt(u64, ccTable).add(toUsize(ccVictim)).read();
    ccVictim = ccVictim + 1 >= TABLE ? 0 : ccVictim + 1;
    tableOff(v);
    ccLost = true;
  }
  ptrAt(u64, ccTable).add(toUsize(ccTop)).write(x);
  const ca = countAt(x);
  ca.write((ca.read() & NOT_SCAN_BITS) | ST_CAND | (toU64(ccTop) << CAND_SHIFT));
  ccTop++;
}

/** A decrement on an object whose class can be in a cycle: D39's, with the barrier and candidates (D41). */
// SAFETY: x is a live counted slot whose class can be in a cycle, and n its count word as read.
function ccDrop(x: u64, n: u64): void {
  const ca = countAt(x);
  if ((n & COUNT) > 1n) {
    ca.write(n - 1n);
    if (n >= ST_WHITE) {
      touch(x);
      ca.write(ca.read() | AGAIN);
    } else if ((n & ST_MASK) === 0n) tablePush(x);
    return;
  }
  if (n >= ST_WHITE) {
    if (ccPhase !== 3 && ccPhase !== 4 && waiting <= QLINK) {
      // in a scan that hasn't decided: given up, and on the queue like any other (R1e, 3.5)
      ca.write(WAITING | ST_GONE | (n & LINK_A) | waiting);
      waiting = x;
      ccPending++;
      ccGaveUp++;
      return;
    }
    // in a scan that has decided: it stays there, held, and goes on the queue when the scan lets it go
    ca.write(n - 1n);
    touch(x);
    return;
  }
  if ((n & ST_MASK) === ST_CAND) tableOff(x);
  ca.write(waiting | WAITING);
  waiting = x;
}

/** x joins the scan, white, with no edges found yet, at the end of its list. */
// SAFETY: x is a live counted slot below SCANNABLE, in no scan and not in the table.
function join(x: u64): void {
  const ca = countAt(x);
  ca.write((ca.read() & COUNT) | ST_WHITE);
  setNext(x, 0n);
  if (ccTail === 0n) ccHead = x;
  else setNext(ccTail, x);
  ccTail = x;
  ccSize++;
}

// SAFETY: x is a counted slot that was in the table, now off it.
function joinRoot(x: u64): void {
  join(x);
  const ca = countAt(x);
  ca.write(ca.read() | ROOT);
}

/** Visit.Scan reached y: an edge found, and y joins the scan if it isn't in it. */
// SAFETY: y is a live counted slot whose class is in the group being scanned.
function ccEdge(y: u64): void {
  const ca = countAt(y);
  let n = ca.read();
  if (n < ST_WHITE || n >= WAITING) {
    if (y >= SCANNABLE) return;
    if (ccSize >= ccLimit && !ccExh) {
      ccCut = true;
      return;
    }
    if ((n & ST_MASK) === ST_CAND) {
      tableOff(y);
      joinRoot(y);
    } else join(y);
    n = ca.read();
  }
  if ((n & EDGES) >> 32n >= EDGES_MAX) {
    if ((n & ST_MASK) === ST_WHITE) ca.write((n & NOT_ST_MASK) | ST_HELD);
    return;
  }
  ca.write(n + EDGE);
}

/** Visit.Trace reached y: if it's in the scan and white, it's held, and marking needs another pass. */
// SAFETY: y is a live counted slot whose class is in the group being scanned.
function ccTrace(y: u64): void {
  const ca = countAt(y);
  const n = ca.read();
  if ((n & ST_MASK) !== ST_WHITE) return;
  ca.write((n & NOT_ST_MASK) | ST_HELD);
  ccDirty = true;
}

/** Whether y is in the scan and white: garbage, once the scan has decided. */
// SAFETY: y is a live counted slot.
function ccWhite(y: u64): bool {
  return (countAt(y).read() & ST_MASK) === ST_WHITE;
}

/**
 * One the scan gave up, out of its list (R1e): its block given back if freeing is done with it, or left to freeing to give
 * back, with nothing of the scan's left in its prefix.
 */
// SAFETY: x was in the scan's list, given up, and the caller has read its next; n is its count word as read.
function ccLetGo(x: u64, n: u64): void {
  if ((n & ST_MASK) === ST_DONE) {
    clearScan(x);
    const owner = ownerAt(x).read();
    giveBack(x, owner, entryOf(owner >>> 8));
    return;
  }
  const g = genAt(x);
  g.write(g.read() % 0x1_0000);
  const o = ownerAt(x);
  o.write(o.read() % 0x100_0000);
  countAt(x).write((n & (WAITING | QLINK)) | ST_OUT);
}

/** Collector steps, at most b, unless it's waiting out its gap: gives how many it took. */
function ccWork(b: usize): usize {
  stepping = true;
  let used: usize = 0;
  while (used < b) {
    if (ccPhase === 0 && (ccTop === 0 || (pacing && ccGap > 0 && !ccExh))) break;
    ccStep();
    if (ccWait) {
      ccWait = false; // marking waits for freeing, which gets the rest of the budget
      break;
    }
    used++;
  }
  stepsTaken = BigInt.asUintN(64, stepsTaken + toU64(used));
  ccSteps += used;
  stepping = false;
  return used;
}

/** Steps until the scan under way is done: exhaustion's and rcCollect's, with no limit. */
function ccFinish(): void {
  let used: usize = 0;
  while (ccPhase !== 0) {
    ccStep();
    if (ccWait) {
      ccWait = false;
      stepping = false;
      runSteps(RC_BUDGET);
      stepping = true;
      continue;
    }
    used++;
  }
  stepsTaken = BigInt.asUintN(64, stepsTaken + toU64(used));
  ccSteps += used;
}

/**
 * One step: one root taken, one slot visited, one object passed in marking, or one block given back. The phases are tested
 * most frequent first, marking's, then finding's, deciding's and giving back's, as `tmk profile` counted them, and the
 * dispatch is inlined into its two callers (R1f).
 */
/** @tsl.inline */
function ccStep(): void {
  if (ccPhase === 2) ccMark();
  else if (ccPhase === 1) ccFind();
  else if (ccPhase === 3) ccDecide();
  else if (ccPhase === 4) ccGiveBack();
  else if (ccPhase === 5) ccRoots();
  else ccStart();
}

function ccStart(): void {
  ccScans++;
  ccPhase = 5;
  ccGather = ccTop;
  ccHead = 0n;
  ccTail = 0n;
  ccSize = 0;
  ccCut = false;
  ccDirty = false;
  ccFound = 0;
}

/** Phase 5: the table's candidates become the scan's roots, one a step, last first. */
// SAFETY: every slot in the table is live, with a count above zero, and its index right.
function ccRoots(): void {
  if (ccGather > 0 && ccTop > 0) {
    ccGather--;
    const x = ptrAt(u64, ccTable).add(toUsize(ccTop) - 1).read();
    tableOff(x);
    joinRoot(x);
    return;
  }
  if (ccHead === 0n) {
    ccPhase = 0;
    return;
  }
  ccLimit = toUsize(toU64(FIRST_LIMIT) << toU64(ccLevel * 2)) + ccSize;
  ccCur = ccHead;
  ccIdx = 0;
  ccPhase = 1;
}

/** Phase 1: what the roots reach, each slot one step, counting an edge for each reference found. */
// SAFETY: ccCur is in the scan, so live.
function ccFind(): void {
  // one given up is passed over: freeing drops what it holds (R1e)
  if ((countAt(ccCur).read() & ST_MASK) < ST_GONE) {
    const k = releaseCall(ccCur, ccIdx, Visit.Scan);
    if (ccIdx < k) {
      ccIdx++;
      return;
    }
  }
  ccCur = nextOf(ccCur);
  ccIdx = 0;
  if (ccCur !== 0n) return;
  ccPhase = 2;
  ccPrev = 0n;
  ccCur = ccHead;
  ccDirty = false;
}

/**
 * Phase 2: marking, in passes over the scan's list, reversing it each time. An object is held if its count isn't the
 * edges found, or a count operation touched it, or something held refers to it. A pass in which nothing new is held is
 * the decision: from that instant, what's white is garbage.
 */
// SAFETY: ccCur is in the scan, so live.
function ccMark(): void {
  const x = ccCur;
  if (x === 0n) {
    if (!ccDirty && ccPending !== 0) {
      // nothing new held, but something given up still holds references the scan counted: no decision until freeing
      // has dropped them, each a count operation on what it held (R1e, 3.5)
      ccWait = true;
      return;
    }
    ccHead = ccPrev;
    ccCur = ccPrev;
    ccPrev = 0n;
    ccIdx = 0;
    if (ccDirty) {
      ccDirty = false;
      return;
    }
    ccGarbage = 0n;
    ccPhase = 3;
    return;
  }
  const ca = countAt(x);
  let n = ca.read();
  if ((n & ST_MASK) >= ST_GONE) {
    ccCur = nextOf(x);
    ccIdx = 0;
    ccLetGo(x, n);
    return;
  }
  if (ccIdx === 0 && (n & ST_MASK) === ST_WHITE && (n & COUNT) !== (n & EDGES) >> 32n) {
    n = (n & NOT_ST_MASK) | ST_HELD;
    ca.write(n);
  }
  if ((n & ST_MASK) === ST_HELD) {
    const k = releaseCall(x, ccIdx, Visit.Trace);
    if (ccIdx < k) {
      ccIdx++;
      return;
    }
    ca.write((ca.read() & NOT_ST_MASK) | ST_TRACED);
  }
  const nx = nextOf(x);
  setNext(x, ccPrev);
  ccPrev = x;
  ccCur = nx;
  ccIdx = 0;
}

/**
 * Phase 3: what's held goes back as it was, a step each (a candidate again if a decrement left it a count, back in the
 * table if it was a root of a scan that was cut off, on the queue if its count reached zero meanwhile). What's white is
 * garbage: its count is set to zero, and its slots released a step each, dropping what isn't garbage too.
 */
// SAFETY: ccCur is in the scan; a white object's slots are visited through its own release function.
function ccDecide(): void {
  const x = ccCur;
  if (x === 0n) {
    if (ccFound > 0) {
      ccCur = ccGarbage;
      ccPhase = 4;
      return;
    }
    ccPhase = 0;
    ccNextLevel();
    ccGap = toUsize(toU64(ccSize) << toU64(ccCut ? GAP_SHIFT_CUT : GAP_SHIFT));
    return;
  }
  const ca = countAt(x);
  const n = ca.read();
  if ((n & ST_MASK) >= ST_GONE) {
    ccCur = nextOf(x);
    ccIdx = 0;
    ccLetGo(x, n);
    return;
  }
  if ((n & ST_MASK) !== ST_WHITE) {
    const nx = nextOf(x);
    clearScan(x);
    if ((n & COUNT) === 0n) {
      ca.write(waiting | WAITING);
      waiting = x;
    } else if ((n & AGAIN) !== 0n || ((n & ROOT) !== 0n && ccCut)) tablePush(x);
    ccCur = nx;
    ccIdx = 0;
    return;
  }
  // releasing empties a vector as it goes, so how many slots there are is its first answer, as freeing's is
  const k0 = releaseCall(x, ccIdx, Visit.Collect);
  if (ccIdx === 0) {
    ca.write(ca.read() & NOT_COUNT);
    ccFound++;
    ccSlots = k0;
  }
  if (ccIdx < ccSlots) {
    ccIdx++;
    return;
  }
  const nx = nextOf(x);
  setNext(x, ccGarbage);
  ccGarbage = x;
  ccCur = nx;
  ccIdx = 0;
}

/** Phase 4: each garbage object's block given back, a step each. */
// SAFETY: ccCur is garbage, released in phase 3, linked only on this list; nothing holds a count on it.
function ccGiveBack(): void {
  const x = ccCur;
  if (x === 0n) {
    ccPhase = 0;
    ccNextLevel();
    ccGap = 0;
    return;
  }
  ccCur = nextOf(x);
  clearScan(x);
  const owner = ownerAt(x).read();
  giveBack(x, owner, entryOf(owner >>> 8));
  ccFreed++;
}

function ccNextLevel(): void {
  ccLevel = ccCut ? (ccLevel + 1 > MAX_LEVEL ? MAX_LEVEL : ccLevel + 1) : 0;
}

/**
 * Exhaustion's walk (D41): a scan whose roots are every live object whose class can be in a cycle, found by walking each
 * size class's chunks: the one pass over the whole counted heap there is, and only at exhaustion or in rcCollect.
 */
// SAFETY: every chunk was recorded when it was made, and every slot below its end was handed out, so each is a counted
// slot, live (an odd generation and no queue link) or not.
function ccWalk(): void {
  ccWalks++;
  ccStart();
  ccGather = 0;
  for (let k: usize = FIRST_CLASS; k < CLASSES; k++) {
    const size = toU64(1) << toU64(k);
    let c = ptrAt(u64, ccChunks).add(k * 3).read();
    while (c !== 0n) {
      const end = ptrAt(u64, c).add(1).read();
      for (let x = c + toU64(CHUNK_HEAD); x + size <= end; x += size) {
        if (genAt(x).read() % 2 === 0) continue;
        const n = countAt(x).read();
        if (n >= ST_WHITE || (n & COUNT) === 0n) continue;
        if (groupOf(x) === 0 || x >= SCANNABLE) continue;
        if ((n & ST_MASK) === ST_CAND) tableOff(x);
        joinRoot(x);
      }
      c = ptrAt(u64, c).read();
    }
  }
}

/**
 * The counted objects of one class (3.5, D39, D63): what freeing one takes, its release function, and how many there are.
 * Its objects are in the one counted heap every store shares. `make` places an object with a count of one, `share` adds
 * one, `drop` takes one away, and at zero the object waits to be freed, so a drop never frees anything itself. Every
 * `make` first does up to `RC_BUDGET` steps of freeing, of whatever is waiting, one reference slot or one block a step,
 * with a cursor through the object being freed. When the heap has nothing more, everything waiting is freed before `make`
 * gives up. If T can be in a cycle (`cycleGroup<T>()`, from the type graph), the cycle collector's barrier is in its count
 * operations and garbage cycles are collected (D41); if it can't, none of that is in them.
 *
 * Where tslc's `rc` expansion places every count of T (`countedExactly`, D74), a counted reference can't be stale (3.5), so
 * a count operation checks nothing; anywhere else it checks that the slot is this store's and the reference's generation.
 * @tsl.sharedSlots
 */
export class Rc<T extends object> {
  private id: u32 = 0; //   this store's number, in its slots' prefixes and the table of stores; 0 until its first make
  private k: usize = 0; //  the size class of one of its objects with no tail; 0 until its first make
  private owner: u32 = 0; // what that object's owner word is
  private elem: Elem<T> = inlineOf<T>();
  private tn: usize = 0; // R3: the tail length of its last object made with one, and that object's size class
  private tk: usize = 0;
  private tw: u32 = 0; // R21: and that object's owner word, worked out (checked) when tk is

  /** `release` is a top-level function, given each object as it's freed, one slot at a time (`Release`). */
  constructor(private release: Release<T>) {}

  /** T's group in the type graph: a constant natively, 0 if T can't be in a cycle. */
  /** @tsl.inline */
  // SAFETY: on the host the group is in this store's entry, registered at its first make.
  private grp(): u32 {
    const g = cycleGroup<T>();
    if (g === GROUP_UNKNOWN) return this.id === 0 ? 0 : toU32(ptrAt(u64, entryOf(this.id)).add(1).read() >> 48n);
    return g;
  }

  /** Objects made and not yet given back: waiting ones count, as they still hold what they hold. */
  // SAFETY: the entry is this store's, in the table.
  get size(): usize {
    if (this.id === 0) return 0;
    const e = ptrAt(u64, entryOf(this.id));
    if (cyclesLinked()) return toUsize(e.add(2).read() - (e.add(1).read() & FREED));
    return toUsize(e.add(2).read() - e.add(1).read());
  }

  /** The store's number and its entry, at its first make: its release function, typed for any class, and no objects. */
  // SAFETY: the table is grown to hold the entry before it's written; the old one is copied whole and then given back.
  private register(): bool {
    if (this.id !== 0) return true;
    if (heads === 0n && !setUp()) return false; // a registered store's make reads its size's list straight away
    if (stores + 1 >= tableCap) {
      if (cyclesLinked() && stores + 1 >= MAX_STORES) return false;
      const cap: u32 = tableCap === 0 ? 16 : tableCap * 2;
      const t = heap.allocBytes(toUsize(cap) * ENTRY);
      if (t === 0n) return false;
      if (table !== 0n) {
        copyBytes(t, table, toUsize(tableCap) * ENTRY);
        heap.freeBytes(table, toUsize(tableCap) * ENTRY);
      }
      table = t;
      tableCap = cap;
    }
    // its release function's number: freeing and the collector call it by a comparison and a direct call (D70, R1d)
    const r = releaseIndex(this.release);
    if (r === 0) trap(Trap.Dispatch);
    stores++;
    this.id = stores;
    ptrAt(u64, entryOf(this.id)).write(releaseIsEmpty(this.release) ? toU64(r) | EMPTY : toU64(r));
    ptrAt(u64, entryOf(this.id)).add(1).write(0n);
    ptrAt(u64, entryOf(this.id)).add(2).write(0n);
    if (cyclesLinked()) ptrAt(u64, entryOf(this.id)).add(1).write(toU64(this.grp()) << 48n);
    this.k = sizeClass(SLOT_PREFIX + elemSize(this.elem));
    this.owner = this.id * 256 + toU32(this.k);
    return true;
  }

  /** On the host, which can't see T: its group, from its first object, into the store and its entry. */
  // SAFETY: the entry is this store's, registered before its first object was placed.
  private learn(made: T): void {
    if (cycleGroup<T>() !== GROUP_UNKNOWN || ptrAt(u64, entryOf(this.id)).add(2).read() !== 1n) return;
    ptrAt(u64, entryOf(this.id)).add(1).write(toU64(cycleGroupOf<T>(made)) << 48n);
  }

  /** A fresh object's prefix: a count of one, the next generation, and its owner word. */
  /** @tsl.inline */
  // SAFETY: slot is a free counted slot of the size class in owner.
  private claim(slot: u64, owner: u32): u32 {
    countAt(slot).write(1n);
    const g = genAt(slot);
    // R17: unchecked, as a free slot's generation is even and below MAX_GEN - 1 (giveBack keeps one that reaches it off
    // every list), and so is a fresh one's, 0
    const gen = (g.read() + 1) >>> 0;
    g.write(gen);
    ownerAt(slot).write(owner);
    const made = ptrAt(u64, entryOf(this.id)).add(2);
    made.write(BigInt.asUintN(64, made.read() + 1n));
    return gen;
  }

  /** @tsl.inline */
  // SAFETY: only an odd generation that matches, in a slot of this store's, is one of ours and not yet given back. A scan's
  // bits are in the top of the owner and generation words of an object whose class can be in a cycle, so those are masked.
  private slotIn(item: T): u64 {
    // tslc placed every count: it can't be stale, so nothing is checked, its generation bits included (3.5, D74, R1f)
    if (countedExactly<T>()) return slotOfLive(item);
    const slot = slotOf(item);
    if (cycleGroup<T>() !== 0) {
      if ((ownerAt(slot).read() % 0x100_0000) >>> 8 !== this.id) trap(Trap.Stale);
      if ((genAt(slot).read() % 0x1_0000) !== genOf(item)) trap(Trap.Stale);
      return slot;
    }
    if (ownerAt(slot).read() >>> 8 !== this.id) trap(Trap.Stale);
    if (genAt(slot).read() !== genOf(item)) trap(Trap.Stale);
    return slot;
  }

  /** Whether a count word says nothing holds a count: zero, or waiting to be freed. */
  /** @tsl.inline */
  private gone(n: u64): bool {
    if (cycleGroup<T>() !== 0) return (n & COUNT) === 0n || n >= WAITING;
    return n === 0n || n >= WAITING;
  }

  /**
   * `make` for a class with a tail of n elements (D69): the moved object's fields go in a slot of its real size, from the
   * same size classes as every other counted object, and its tail is zeroed.
   */
  /** @tsl.moves item */
  /** @tsl.tailed item */
  /** @tsl.inline */
  tryMakeTail(n: usize, item: T): Counted<T> | null {
    return this.tailMake(n, 0, item);
  }

  /**
   * tryMakeTail, with the tail's first `keep` elements left unzeroed (R4): the caller writes them before anything reads
   * them, as a room a lowered array grows into is written with the elements it had.
   */
  /** @tsl.moves item */
  /** @tsl.tailed item */
  private tailMake(n: usize, keep: usize, item: T): Counted<T> | null {
    const slot = this.tailSlot(n);
    if (slot === 0n) return null;
    return this.tailPlace(slot, n, keep, item);
  }

  /**
   * R30: tailMake's steps and its slot, without the object: freeing's steps, the store registered, the size class for a tail
   * of n (kept as the last, with its owner word), and a free slot of it, off its list or slotFor's; 0 if there's none, or the
   * store can't be registered. Out of line, and given no object, so a caller's new object is never in memory of its own: it's
   * placed where it's made (tailPlace, inlined), its fields written straight into the slot.
   */
  /** @tsl.noinline */
  // SAFETY: a slot on a list is free and 2^k bytes; slotFor's is too.
  private tailSlot(n: usize): u64 {
    if (cyclesLinked()) {
      if (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))) stepAll(budget);
      else idleStep();
    } else if (waiting !== 0n || cur !== 0n) freeAlloc(budget);
    if (!this.register()) return 0n;
    // the size class as for the last object made, if its tail was as long: a lowered array's holders mostly are (R3)
    let k = this.tk;
    if (n !== this.tn || k === 0) {
      k = sizeClass(SLOT_PREFIX + tailBytes(this.elem, n));
      this.tn = n;
      if (k !== this.tk) {
        this.tk = k;
        this.tw = tailOwner(this.owner, k);
      }
    }
    // a free slot of its size on its list first, as `tryMake` takes one (R3: a lowered `rc` array is made so)
    const head = ptrAt(u64, heads).add(k);
    const slot = head.read();
    if (slot !== 0n) {
      head.write(countAt(slot).read());
      return slot;
    }
    return slotFor(k);
  }

  /**
   * R30: a slot of size class tk, free, for an object with a tail of n elements (tn is n): claimed, the object placed in it
   * with its tail zeroed but for what's kept, as every make of a tailed object ends. Inlined, so the moved object is placed
   * where it's made.
   */
  /** @tsl.moves item */
  /** @tsl.tailed item */
  /** @tsl.inline */
  // SAFETY: the slot is a free one of size class tk, which holds the prefix and tailBytes(n) as tn is n, claimed before it's
  // placed in; keep is the caller's promise, and more than n traps.
  private tailPlace(slot: u64, n: usize, keep: usize, item: T): Counted<T> {
    const gen = this.claim(slot, this.tw);
    // a whole tail zeroed is one fill: only a room growth writes into (keep) takes the two around what it keeps
    const made = keep === 0 ? placeTail(slot, gen, n, item) : placeTail(slot, gen, n, item, keep);
    // learn has nothing to do but on the host, for a store's first object
    if (cycleGroup<T>() === GROUP_UNKNOWN) this.learn(made);
    if (cyclesLinked() && rest !== 0) restIfWork();
    return made;
  }

  /** @tsl.moves item */
  /** @tsl.tailed item */
  /** @tsl.inline */
  makeTail(n: usize, item: T): Counted<T> {
    return this.tailFast(n, 0, item);
  }

  /** makeTail with the tail's first `keep` elements left for the caller to write before anything reads them (R4). */
  /** @tsl.moves item */
  /** @tsl.tailed item */
  /** @tsl.inline */
  makeTailKeep(n: usize, keep: usize, item: T): Counted<T> {
    return this.tailFast(n, keep, item);
  }

  /**
   * R17: `makeTail` and `makeTailKeep`, inlined where the inliner inlines, as `make` is: for a tail as long as the last one
   * made (its size class known, R3), freeing's steps as `tailSlot` takes them, then a free slot of that size off its list.
   * Anything else is `tailSlot`'s, or with the steps taken, `tailSlotAfter`'s, out of line: the same steps and the same
   * slot. R19: a tail of another length than the last is made in line too, its size class worked out here (sizeClass,
   * inlined) and kept as the last, as `tailSlot` keeps it: a lowered array's rooms are each a length of their own, and its
   * holders' lengths alternate where two arrays of a class are made in turn. R30: whichever way the slot comes, the object
   * is placed here (tailPlace): only the slot is found out of line, so the moved object is never given to a call, and the
   * optimiser writes its fields straight into the slot, where it was built in a frame slot and copied.
   */
  /** @tsl.moves item */
  /** @tsl.tailed item */
  /** @tsl.inline */
  // SAFETY: the slot is a free one of size class tk, as tailPlace needs.
  private tailFast(n: usize, keep: usize, item: T): Counted<T> {
    let slot: u64 = 0n;
    if (
      this.id !== 0 &&
      !(cyclesLinked() && (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))))
    ) {
      if (cyclesLinked()) idleStep();
      else if (waiting !== 0n || cur !== 0n) freeAlloc(budget);
      if (n !== this.tn || this.tk === 0) {
        // R22: a new length's size class, and its owner word only where the class is new too (short strings' lengths
        // change from one make to the next, and most share a class)
        const nk = sizeClass(SLOT_PREFIX + tailBytes(this.elem, n));
        this.tn = n;
        if (nk !== this.tk) {
          this.tk = nk;
          this.tw = tailOwner(this.owner, nk);
        }
      }
      const k = this.tk;
      const head = ptrAt(u64, heads).add(k);
      slot = head.read();
      if (slot !== 0n) head.write(countAt(slot).read());
      else {
        // R28: without the collector, a fresh slot cut in line where its page has room, as tailSlotAfter cuts it
        if (!cyclesLinked()) {
          slot = pageCut(k);
          if (slot !== 0n) genAt(slot).write(0);
        } else if (rest === 0 || (waiting === 0n && cur === 0n)) {
          // R30: with the collector, from its chunk in line, where slotFor's dryStep would do nothing
          slot = chunkCut(k);
          if (slot !== 0n) genAt(slot).write(0);
        }
        if (slot === 0n) slot = this.tailSlotAfter();
      }
    } else slot = this.tailSlot(n);
    if (slot === 0n) trap(Trap.OutOfMemory);
    return this.tailPlace(slot, n, keep, item);
  }

  /**
   * `tailFast`'s rest, its steps taken, its size class tk's list empty: slotFor's slot, as `tailSlot` takes it (R19: by way
   * of freshSlot, as the list was just found empty). R30: the slot alone; tailFast places the object.
   */
  /** @tsl.noinline */
  private tailSlotAfter(): u64 {
    return freshSlot(this.tk);
  }

  /** @tsl.moves item */
  tryMake(item: T): Counted<T> | null {
    const slot = this.slotSlow();
    if (slot === 0n) return null;
    return this.place(slot, item);
  }

  /**
   * R30: tryMake's steps and its slot, without the object: freeing's steps, then, for a store that has made something before,
   * a free slot of its size off its list, or else the store registered at its first make, and slotFor's; 0 if there's none.
   * Out of line and given no object, as tailSlot is, so `make` places its object where it's made.
   */
  /** @tsl.noinline */
  // SAFETY: a slot on a list is free and of the class's size class; slotFor's is too.
  private slotSlow(): u64 {
    if (cyclesLinked()) {
      if (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))) stepAll(budget);
      else idleStep();
    } else if (waiting !== 0n || cur !== 0n) freeAlloc(budget);
    // the common case first: a store that has made something before, and a free slot of its size on its list
    if (this.id !== 0) {
      const head = ptrAt(u64, heads).add(this.k);
      const slot = head.read();
      if (slot !== 0n) {
        head.write(countAt(slot).read());
        return slot;
      }
    } else if (!this.register()) return 0n;
    return slotFor(this.k);
  }

  /**
   * R30: a free slot of the class's size class: claimed, and the object placed in it, as every make ends. Inlined, so the
   * moved object is placed where it's made.
   */
  /** @tsl.moves item */
  /** @tsl.inline */
  // SAFETY: the slot is a free one of the class's size class, claimed before the object is placed in it.
  private place(slot: u64, item: T): Counted<T> {
    const made = placeObject(slot, this.claim(slot, this.owner), item);
    // learn has nothing to do but on the host, for a store's first object
    if (cycleGroup<T>() === GROUP_UNKNOWN) this.learn(made);
    if (cyclesLinked() && rest !== 0) restIfWork();
    return made;
  }

  /**
   * R17: inlined where the inliner inlines, as the direct route's `__rc_new` is at -O2: freeing's steps first, as `tryMake`
   * takes them (a call, only with something waiting; with the collector, only while it's idle or waits out its gap), then
   * a free slot of its size off its list. Anything else is `slotSlow`'s, or with the steps taken, `slotAfter`'s, out of
   * line: the same steps and the same slot as `tryMake` takes. R30: whichever way the slot comes, the object is placed here
   * (`place`), so the moved object is never given to a call, and its fields are written straight into the slot.
   */
  /** @tsl.moves item */
  /** @tsl.inline */
  // SAFETY: the slot is a free one of the class's size class, as `place` needs.
  make(item: T): Counted<T> {
    let slot: u64 = 0n;
    if (this.id !== 0 && !(cyclesLinked() && (ccPhase !== 0 || (ccTop !== 0 && (ccGap === 0 || !pacing))))) {
      if (cyclesLinked()) idleStep();
      else if (waiting !== 0n || cur !== 0n) freeAlloc(budget);
      const head = ptrAt(u64, heads).add(this.k);
      slot = head.read();
      if (slot !== 0n) head.write(countAt(slot).read());
      else {
        // R28: without the collector, a fresh slot cut in line where its page has room: slotAfter's slot and steps
        if (!cyclesLinked()) {
          slot = pageCut(this.k);
          if (slot !== 0n) genAt(slot).write(0);
        } else if (rest === 0 || (waiting === 0n && cur === 0n)) {
          // R30: with the collector, from its chunk in line, where slotFor's dryStep would do nothing
          slot = chunkCut(this.k);
          if (slot !== 0n) genAt(slot).write(0);
        }
        if (slot === 0n) slot = this.slotAfter();
      }
    } else slot = this.slotSlow();
    if (slot === 0n) trap(Trap.OutOfMemory);
    return this.place(slot, item);
  }

  /**
   * `make`'s rest, for a registered store whose steps are taken and whose size's list is empty: slotFor's slot (R19: by way
   * of freshSlot, as the list was just found empty). R30: the slot alone; `make` places the object.
   */
  /** @tsl.noinline */
  private slotAfter(): u64 {
    return freshSlot(this.k);
  }

  /** One more count: the result is a second handle to the same object. */
  /** @tsl.inline */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T.
  share(h: Counted<T>): Counted<T> {
    const slot = this.slotIn(h);
    const c = countAt(slot);
    const n = c.read();
    // waiting to be freed: nothing holds a count to share
    if (!countedExactly<T>() && this.gone(n)) trap(Trap.Stale);
    c.write(n + 1n);
    if (cycleGroup<T>() !== 0 && n >= ST_WHITE) touch(slot); // the barrier (D41): a load and a branch
    return h;
  }

  /** The handle moved out, its count unchanged: for putting a local's count into a field. */
  /** @tsl.moves h */
  /** @tsl.inline */
  take(h: Counted<T>): Counted<T> {
    return h;
  }

  /** One count less. At zero it waits to be freed by later allocations, or `collect`. */
  /** @tsl.moves h */
  /** @tsl.inline */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T; a waiting object is never dropped, so the
  // queue's link can't overwrite a count.
  drop(h: Counted<T>): void {
    const slot = this.slotIn(h);
    const c = countAt(slot);
    const n = c.read();
    if (!countedExactly<T>() && this.gone(n)) trap(Trap.Stale);
    if (cycleGroup<T>() !== 0 && this.grp() !== 0) {
      // the barrier, and a candidate if a count is left (D41): the common case, a count left on an object in no scan that's
      // already a candidate, is a store and two tests
      if ((n & COUNT) > 1n && (n & ST_MASK) === ST_CAND) {
        c.write(n - 1n);
        return;
      }
      ccDrop(slot, n);
      return;
    }
    if (n > 1n) {
      c.write(n - 1n);
      return;
    }
    c.write(waiting | WAITING);
    waiting = slot;
  }

  /** A count-preserving move of `h` out of a slot, such as a vector's element moved: the barrier only (D41). */
  /** @tsl.inline */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T.
  touch(h: Counted<T>): void {
    if (cycleGroup<T>() === 0) return;
    const slot = this.slotIn(h);
    if (countAt(slot).read() >= ST_WHITE) touch(slot);
  }

  /**
   * What a release function does with the reference in a slot: `op` on `h` (3.5). Freeing drops it; the cycle collector,
   * for a class in the group it's scanning, counts an edge to it, marks it held, or, for an object decided to be garbage,
   * drops it unless it's garbage too (D41).
   */
  /** @tsl.moves h */
  /** @tsl.inline */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T.
  visit(h: Counted<T>, op: Visit): void {
    if (op === Visit.Drop) this.drop(h);
    else if (cyclesLinked()) this.visitCc(h, op);
  }

  /**
   * `visit`, for a class whose objects have no slots of their own, so freeing one is only giving its block back (R4).
   * Freeing with steps to spare (`spare`, set while a slot is visited) drops the last count of one by giving its block back
   * at once, as one of those steps, where `drop` would queue it to take that step later: the same steps, the bound the
   * same (D39), and no trip through the queue and its release function. Anything else is `visit`.
   */
  /** @tsl.moves h */
  /** @tsl.inline */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T. T's objects have no slots (the caller's
  // promise: tslc's expansion calls this only for such a class), so a count of one, the one this drops, is the last, and
  // what freeing would do with the object is give its block back, which this does.
  visitLeaf(h: Counted<T>, op: Visit): void {
    if (op === Visit.Drop && spare !== 0n) {
      const slot = this.slotIn(h);
      const c = countAt(slot);
      const n = c.read();
      if (n === 1n) {
        leafBack(slot);
        return;
      }
      // R24: a count left, which `drop` would take one off, as here, with the count read once: the same test of it (a
      // count tslc placed is never stale or waiting, and one below WAITING isn't), and no barrier, as T is in no cycle;
      // above 1, so less one can't wrap
      if (cycleGroup<T>() === 0 && n > 1n && (countedExactly<T>() || n < WAITING)) {
        c.write(BigInt.asUintN(64, n - 1n));
        return;
      }
    }
    this.visit(h, op);
  }


  /** visit's collector part: Collect, Scan and Trace. */
  /** @tsl.moves h */
  // SAFETY: slotIn checked it's ours and live, or tslc placed every count of T.
  private visitCc(h: Counted<T>, op: Visit): void {
    const g = this.grp();
    if (op === Visit.Collect) {
      if (g === 0 || !ccWhite(this.slotIn(h))) this.drop(h);
      return;
    }
    if (g === 0 || g !== ccGroup) return;
    if (op === Visit.Scan) ccEdge(this.slotIn(h));
    else ccTrace(this.slotIn(h));
  }

  /** Drops the old value and gives back the new one, for `o.f = rc.replace(o.f, h)`. Null is dropped as nothing. */
  /** @tsl.moves h */
  /** @tsl.inline */
  replace(old: Counted<T> | null, h: Counted<T>): Counted<T> {
    if (old !== null) this.drop(old);
    return h;
  }

  /** The count, for tests and assertions: always checked. */
  // SAFETY: checked here that it's ours and live.
  count(h: Counted<T>): u32 {
    // a reference tslc's expansion counts is a plain address, with no generation to check (R8)
    if (countedExactly<T>()) return toU32(countAt(slotOfLive(h)).read() & COUNT);
    const slot = slotOf(h);
    if (cycleGroup<T>() !== 0) {
      if ((ownerAt(slot).read() % 0x100_0000) >>> 8 !== this.id) trap(Trap.Stale);
      if (genAt(slot).read() % 0x1_0000 !== genOf(h)) trap(Trap.Stale);
      return toU32(countAt(slot).read() & COUNT);
    }
    if (ownerAt(slot).read() >>> 8 !== this.id) trap(Trap.Stale);
    if (genAt(slot).read() !== genOf(h)) trap(Trap.Stale);
    return toU32(countAt(slot).read());
  }

  /** Frees everything waiting now, and garbage cycles: the one unbounded call, only when asked. */
  collect(): void {
    if (cyclesLinked()) collectAll();
    else drainAll();
  }

  /** Where a weak reference finds `h`: its slot. */
  // SAFETY: slotIn checked it's ours and live.
  weakSlot(h: Counted<T>): u64 {
    return this.slotIn(h);
  }

  /** And the generation it has to still have there. */
  // SAFETY: slotIn checked it's ours and live, so its generation is the one in the slot's prefix. A reference tslc's
  // expansion counts is a plain address, carrying no generation (R8), so that's read from the prefix, a scan's bits off.
  weakGen(h: Counted<T>): u32 {
    const slot = this.slotIn(h);
    if (countedExactly<T>()) return genAt(slot).read() % 0x1_0000;
    return genOf(h);
  }

  /**
   * A weak reference's target, with a count of its own, if it's still alive: the slot is this store's, still has the
   * generation, and its count is above zero, and the cycle collector hasn't decided it's garbage (D41). From the moment the
   * count reaches zero, or the decision, this gives `undefined`, while the object waits, after it's freed, and after the
   * slot holds another object of any class, so nothing is ever brought back (D39). These checks stay wherever T is
   * counted: a weak reference holds no count, so it's the one that can go stale. The count it adds is a count operation, so
   * an object in a scan is held by it.
   */
  // SAFETY: a counted slot is never given back to the heap, so reading its prefix is reading our own memory.
  upgrade(slot: u64, gen: u32): Counted<T> | undefined {
    if (cycleGroup<T>() !== 0) {
      if ((ownerAt(slot).read() % 0x100_0000) >>> 8 !== this.id) return undefined;
      if (genAt(slot).read() % 0x1_0000 !== gen) return undefined;
      const m = countAt(slot).read();
      if ((m & COUNT) === 0n || m >= WAITING) return undefined;
      if ((ccPhase === 3 || ccPhase === 4) && (m & ST_MASK) === ST_WHITE) return undefined; // decided: garbage (D41)
      countAt(slot).write(m + 1n);
      if (m >= ST_WHITE) touch(slot);
      return objectAt<T>(slot);
    }
    if (ownerAt(slot).read() >>> 8 !== this.id) return undefined;
    if (genAt(slot).read() !== gen) return undefined;
    const n = countAt(slot).read();
    if (n === 0n || n >= WAITING) return undefined;
    countAt(slot).write(n + 1n);
    return objectAt<T>(slot);
  }
}

/**
 * A weak reference to a counted object (3.5, D39, D74): `new WeakRef(x)` in an `rc` package. It holds the object's slot
 * and generation and no count, so it never keeps the object alive; `deref` gives the object with a count of its own while
 * the object's count is above zero, and `undefined` from the moment it reaches zero or the cycle collector decides it's
 * garbage.
 */
export class Weak<T extends object> {
  private slot: u64 = 0n;
  private gen: u32 = 0;

  constructor(
    private store: Rc<T>,
    target: Counted<T>,
  ) {
    this.slot = store.weakSlot(target);
    this.gen = store.weakGen(target);
  }

  deref(): Counted<T> | undefined {
    return this.store.upgrade(this.slot, this.gen);
  }
}

/**
 * A room of the counted heap (R3): raw words for what a library keeps in the counted heap, such as a lowered `rc` array's
 * elements once they outgrow its holder's tail. It's a counted object with no reference slot, so freeing it is one step,
 * and the collector's walk sees an object like any other.
 */
export class Room {
  words = tail(u64);
}

function roomRelease(_o: Room, _at: usize, _op: Visit): usize {
  return 0;
}

const rooms = new Rc<Room>(roomRelease);

/**
 * A room of n words: an allocation of the counted heap, which takes its freeing steps as any `make` does. Its first `keep`
 * words aren't zeroed (R4): the caller writes them before anything reads them, as growth copies the elements it had; the
 * rest are zero. R19: inlined, as `make` is, into a lowered array's growth.
 */
/** @tsl.inline */
export function roomMake(n: usize, keep: usize): Counted<Room> {
  return rooms.makeTailKeep(n, keep, new Room());
}

/** Where a room's first word is. R19: inlined, a field's address. */
/** @tsl.inline */
// SAFETY: a room's words are its tail, there while the room is, which its holder's count keeps.
export function roomAddr(r: Counted<Room>): u64 {
  return tailAddr(r);
}

/**
 * A room let go of: its count dropped, so it's freed, in one step, by a later allocation (D39); or, by freeing with a step
 * to spare, given back at once as that step (R4, `visitLeaf`: a room has no slots).
 */
/** @tsl.moves r */
export function roomDrop(r: Counted<Room>): void {
  rooms.visitLeaf(r, Visit.Drop);
}
