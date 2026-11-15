// file: ex-jsrt-map.ts
import {
  f64,
  Trap,
  toUsize,
  trap,
  u16,
  u32,
  u64,
  u8,
  wrapU32,
  type bool,
  type i32,
  type usize,
} from "@tsl/core";
import { keyHash, keySame, ptrAt, type ElemOf } from "@tsl/unsafe";
import { heap } from "@tsl/std";
import { JsArray } from "./ex-jsrt-array.ts";

// JS's `Map` and `Set` (D42, D47, D72), compiler/rt/map.ts written in TSL. Entries are in insertion order, in parallel
// arrays. `heads` and `chain` hold a hash table of positions: a link to position i is i + 2, END ends a chain, and a head
// of TOMB or END is empty. `chain[i]` is TOMB for a deleted entry. Along a chain positions only go down.
//
// A full table doesn't grow in one operation (D47). A new table is made at its final size, with room at its front for
// what's live, and the old one is emptied into it in order, STEP positions in each insert and delete after, while lookups
// look in both. Every array is sized when it's made, so nothing grows by copying. When a move starts, or a table clears,
// the generation is replaced: a cursor holding an older one finds its place from where the move put each old position,
// which the move writes into the old chain as MOVED | its new position. Nothing registers a cursor, so one that's dropped
// costs nothing, but where a map `freesTables` (a lowered `rc` package's), whose cursors tslc's expansion closes, so its
// generations and cursors are reused once none is open (R3).
const TOMB: u32 = 0;
const END: u32 = 1;
const MOVED: u32 = 0x80000000;
const MIN_BUCKETS: u32 = 4;
/** Old positions moved in each insert or delete while a move is on: the new table has room for the move to finish first. */
const STEP: u32 = 4;
/** Every NaN's key: JS's maps hold one NaN, whatever its bits. */
const NAN_KEY: u64 = 0x7ff8000000000000n;

let key0: u32 = 0x243f6a88;
let key1: u32 = 0x85a308d3;
let scratch: u64 = 0n; // 8 bytes where a number's bits are read, made the first time

/** The hash key (D42): two words, which a caller with entropy sets before it makes a map. */
export function jsMapKey(a: i32, b: i32): void {
  key0 = wrapU32(a);
  key1 = wrapU32(b);
}

/**
 * D42's string hash: HalfSipHash-1-3 of n UTF-16 units at p, two to a word, under the hash key, in 30 bits, as
 * compiler/rt's strHash gives it. A `JsString` key's `hashKey` is this, kept in its hash word.
 */
// SAFETY: the n units at p are a live string's, read below n only.
export function jsUnitsHash(p: u64, n: i32): u32 {
  const at = ptrAt(u16, p);
  const len: u32 = wrapU32(n);
  let v0: u32 = key0;
  let v1: u32 = key1;
  let v2: u32 = (0x6c796765 ^ key0) >>> 0;
  let v3: u32 = (0x74656462 ^ key1) >>> 0;
  let i: u32 = 0;
  while (i + 2 <= len) {
    const m: u32 = (at.add(toUsize(i)).read() | (at.add(toUsize(i + 1)).read() << 16)) >>> 0;
    v3 = (v3 ^ m) >>> 0;
    v0 = (v0 + v1) >>> 0;
    v1 = ((v1 << 5) | (v1 >>> 27)) >>> 0;
    v1 = (v1 ^ v0) >>> 0;
    v0 = ((v0 << 16) | (v0 >>> 16)) >>> 0;
    v2 = (v2 + v3) >>> 0;
    v3 = ((v3 << 8) | (v3 >>> 24)) >>> 0;
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = ((v3 << 7) | (v3 >>> 25)) >>> 0;
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = ((v1 << 13) | (v1 >>> 19)) >>> 0;
    v1 = (v1 ^ v2) >>> 0;
    v2 = ((v2 << 16) | (v2 >>> 16)) >>> 0;
    v0 = (v0 ^ m) >>> 0;
    i += 2;
  }
  const last: u32 = ((len << 25) | (i < len ? at.add(toUsize(i)).read() : 0)) >>> 0;
  v3 = (v3 ^ last) >>> 0;
  for (let r: u32 = 0; r < 4; r++) {
    v0 = (v0 + v1) >>> 0;
    v1 = ((v1 << 5) | (v1 >>> 27)) >>> 0;
    v1 = (v1 ^ v0) >>> 0;
    v0 = ((v0 << 16) | (v0 >>> 16)) >>> 0;
    v2 = (v2 + v3) >>> 0;
    v3 = ((v3 << 8) | (v3 >>> 24)) >>> 0;
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = ((v3 << 7) | (v3 >>> 25)) >>> 0;
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = ((v1 << 13) | (v1 >>> 19)) >>> 0;
    v1 = (v1 ^ v2) >>> 0;
    v2 = ((v2 << 16) | (v2 >>> 16)) >>> 0;
    if (r === 0) {
      v0 = (v0 ^ last) >>> 0;
      v2 = (v2 ^ 0xff) >>> 0;
    }
  }
  return (v1 ^ v3) & 0x3fffffff;
}

/** A keyed MurmurHash3 finaliser over the key's own hash: an integer's value, a reference's identity, or its hashKey. */
/** @tsl.inline */
// SAFETY: the hash can depend on an address. It only chooses a chain, and iteration is by position, so no result can.
function hashOf<K>(k: K): u32 {
  let h: i32 = keyHash(k) ^ key0;
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h = h ^ key1 ^ (h >>> 13);
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A number as a key: its bits, with -0 as +0 and every NaN one NaN, so that comparing keys as integers is JS's
 * SameValueZero. `jsKeyNum` gives the number back. Inlined (R4): a lookup's every key goes through it, and at -O1 it
 * was a call each.
 */
/** @tsl.inline */
// SAFETY: scratch is 8 bytes of the global allocator's, this module's alone and never given back, read as the u64 a
// double was just written as.
export function jsNumKey(x: f64): u64 {
  if (x !== x) return NAN_KEY;
  const s = scratchWord();
  ptrAt(f64, s).write(x + 0);
  return ptrAt(u64, s).read();
}

/** The number a key from `jsNumKey` is. */
// SAFETY: as jsNumKey.
export function jsKeyNum(k: u64): f64 {
  const s = scratchWord();
  ptrAt(u64, s).write(k);
  return ptrAt(f64, s).read();
}

/**
 * The scratch word, made the first time; out of memory traps 14 (R6). With a map's own objects and arrays in the per-call
 * region, the word can be the first thing of a map's the global allocator is asked for, and a null one was written at 0.
 * Inlined, as jsNumKey is.
 */
/** @tsl.inline */
function scratchWord(): u64 {
  if (scratch === 0n) {
    const s = heap.allocBytes(8);
    if (s === 0n) trap(Trap.OutOfMemory);
    scratch = s;
  }
  return scratch;
}

/**
 * One move or clear. `next` is always newer. A generation made by a move has `end`, how many positions the old table had,
 * `base`, where what's inserted after the move starts goes, and where the move put each old position: in the old table's
 * chain while that table is the map's (`live`), and in `ranks`, the chain's buffer taken over, once it isn't (R3).
 */
export class JsMapGen {
  cleared: bool = false;
  next: JsMapGen | null = null;
  ranks: JsArray<u32> | null = null;
  end: u32 = 0;
  base: u32 = 0;
  live: bool = false; // the ranks are the map's old chain, the move still on (R3)
  keep: JsArray<u32> | null = null; // a reused generation's array for ranks, empty while it's unused (R3)
}

/** Where an iteration is: `for...of`, `forEach`, spread and the iterators each hold one. */
export class JsMapCursor {
  pos: u32 = 0; // the next position to look at
  cur: u32 = 0; // what the last advance found
  done: bool = false;
  inOld: bool = false; // pos is in the table `gen`'s move is emptying
  curOld: bool = false; // and so is cur
  link: JsMapCursor | null = null; // a closed cursor's next, in the cursors to reuse (R3)
  constructor(public gen: JsMapGen) {}
}

// What maps that `freesTables` reuse (R3): generations once no cursor can read them, and cursors once closed. @tsl/jsrt's
// own objects are never freed (a `leak` package), so such a map makes them only when none is free to reuse, and what it
// has in use at once is what it needs, not what it ever made.
let freeGens: JsMapGen | null = null;
let freeCursors: JsMapCursor | null = null;

/**
 * R11: what a map whose tables a counted object holds (`tablesIn`) calls as it makes a table: `steps`, the freeing steps
 * an allocation of the counted heap takes, before each, and `drain`, which frees everything the counted heap has waiting,
 * when @tsl/std has nothing left, before asking once more. A lowered `rc` package's maps name @tsl/gc's `rcAllocSteps` and
 * `rcCollect`. A program has one counted heap, so this is module state, not a map's, held in an object as a function value
 * in memory is (TSL1010).
 */
export type TableSteps = () => void;

function noSteps(): void {}

class Tables {
  constructor(
    public steps: TableSteps,
    public drain: TableSteps,
  ) {}
}

const tables = new Tables(noSteps, noSteps);

/** Where k is in a table, at or above `low`, or -1 as a u32. Positions fall along a chain, so the first below `low` ends it. */
function seek<K>(
  heads: JsArray<u32>,
  chain: JsArray<u32>,
  keys: JsArray<K>,
  k: K,
  h: u32,
  low: u32,
): u32 {
  const b = heads.length;
  if (b === 0) return NONE;
  let s: u32 = heads.get((h & wrapU32(b - 1)) >>> 0);
  while (s > END) {
    const i: u32 = (s - 2) >>> 0;
    if (i < low) return NONE;
    // SAFETY: comparing keys is a question about values: an integer's, identity, or the key's own sameKey.
    if (keySame(keys.get(i), k)) return i;
    s = chain.get(i);
  }
  return NONE;
}

const NONE: u32 = 0xffffffff;

/** As seek, and takes it out of its chain. */
function unlink<K>(
  heads: JsArray<u32>,
  chain: JsArray<u32>,
  keys: JsArray<K>,
  k: K,
  h: u32,
  low: u32,
): u32 {
  const b = heads.length;
  if (b === 0) return NONE;
  const at: u32 = (h & wrapU32(b - 1)) >>> 0;
  let s: u32 = heads.get(at);
  let prev: u32 = NONE;
  while (s > END) {
    const i: u32 = (s - 2) >>> 0;
    if (i < low) return NONE;
    const next: u32 = chain.get(i);
    // SAFETY: as in seek.
    if (keySame(keys.get(i), k)) {
      if (prev === NONE) heads.set(at, next);
      else chain.set(prev, next);
      chain.set(i, TOMB);
      return i;
    }
    prev = i;
    s = next;
  }
  return NONE;
}

/**
 * JS's `Map` (D47): `get` of a missing key gives `undefined`, entries are in insertion order, keys are the same by
 * SameValueZero (a number by `jsNumKey`, an object by identity), and changing it during an iteration does what JS does.
 * A key is what @tsl/unsafe's `keyHash` takes: an integer, a reference, or a class or dispatch interface (D70) with
 * `hashKey` and `sameKey`, as `JsString` is. No operation does work proportional to the table: growth moves STEP entries
 * an insert or delete. Lowered programs print their maps as this class (`tmk lower --emit tsl`), and a person can write
 * it too.
 *
 * Both tables' arrays are held in place (R3): the map's own, and the old table's, which a move empties. Starting a move
 * gives the table's buffers to the old table's arrays (`adopt`) and makes the table's again; ending it gives the old
 * buffers back, where the map `freesTables`, and otherwise keeps them, as before R3, in arrays nothing else reads.
 */
export class JsMap<K, V> {
  private keys: JsArray<K>;
  private vals: JsArray<V>;
  private chain: JsArray<u32>;
  private heads: JsArray<u32>;
  private okeys: JsArray<K>; // the old table's, while a move is on; empty otherwise (R3)
  private ovals: JsArray<V>;
  private ochain: JsArray<u32>;
  private oheads: JsArray<u32>;
  private count: u32 = 0;
  private gen: JsMapGen | null = null;
  private first: JsMapGen | null = null; // the oldest generation, which a cursor may still read (R3)
  private readers: u32 = 0; // cursors open and not yet closed, where the map `freesTables` (R3)
  private moving: bool = false; // a move is on: the old table's arrays hold what it hasn't moved
  private mv: u32 = 0; // the next old position to move
  private end: u32 = 0; // how many positions the old table has
  private to: u32 = 0; // where the next entry moved goes
  private base: u32 = 0; // where what's inserted during the move starts
  private outK!: K; // what `put`, `cut` and `entryAt` handed back (R2)
  private outV!: V;
  private tables: bool = false; // `freesTables`: what it stops holding, and its tables, go back (R2)
  private counted: bool = false; // `tablesIn`: a counted object holds it, so making a table takes freeing steps (R11)

  /**
   * `withVals` false is a Set's table, which keeps no values. `giveBack` false keeps each array it outgrows, as a `leak`
   * package's lowered maps always have (JsArray's).
   */
  constructor(
    private kd: ElemOf<K>,
    private vd: ElemOf<V>,
    private withVals: bool,
    private giveBack: bool,
  ) {
    this.keys = new JsArray(kd, 0, giveBack);
    this.vals = new JsArray(vd, 0, giveBack);
    this.chain = new JsArray(u32, 0, giveBack);
    this.heads = new JsArray(u32, 0, giveBack);
    this.okeys = new JsArray(kd, 0, giveBack);
    this.ovals = new JsArray(vd, 0, giveBack);
    this.ochain = new JsArray(u32, 0, giveBack);
    this.oheads = new JsArray(u32, 0, giveBack);
  }

  get size(): u32 {
    return this.count;
  }

  private find(k: K, h: u32): u32 {
    return seek(this.heads, this.chain, this.keys, k, h, 0);
  }

  /** Where k is in the old table, if a move is on and hasn't got to it. */
  private findOld(k: K, h: u32): u32 {
    if (!this.moving) return NONE;
    return seek(this.oheads, this.ochain, this.okeys, k, h, this.mv);
  }

  /** `undefined` if the key isn't there. A scalar's is a flag and a value in registers (3.3, rule 12). */
  get(k: K): V | undefined {
    const h = hashOf(k);
    const i = this.find(k, h);
    if (i !== NONE) return this.vals.get(i);
    if (!this.moving) return undefined;
    const j = this.findOld(k, h);
    if (j === NONE) return undefined;
    return this.ovals.get(j);
  }

  /** `otherwise` if the key isn't there: a reference's `get`, with `null` for `undefined`. */
  getOr(k: K, otherwise: V): V {
    const h = hashOf(k);
    const i = this.find(k, h);
    if (i !== NONE) return this.vals.get(i);
    if (!this.moving) return otherwise;
    const j = this.findOld(k, h);
    if (j === NONE) return otherwise;
    return this.ovals.get(j);
  }

  has(k: K): bool {
    const h = hashOf(k);
    return this.find(k, h) !== NONE || this.findOld(k, h) !== NONE;
  }

  set(k: K, v: V): void {
    const h = hashOf(k);
    const i = this.find(k, h);
    if (i !== NONE) {
      this.vals.set(i, v);
      return;
    }
    if (this.moving) {
      const j = this.findOld(k, h);
      if (j !== NONE) {
        this.ovals.set(j, v);
        return;
      }
    }
    this.insert(k, v, h);
  }

  /** A Set's `add`: the key, with no value. */
  add(k: K, none: V): void {
    const h = hashOf(k);
    if (this.find(k, h) === NONE && this.findOld(k, h) === NONE) this.insert(k, none, h);
  }

  private insert(k: K, v: V, h: u32): void {
    if (this.moving) this.steps(STEP);
    if (this.keys.length >= this.heads.length) this.grow();
    const at: u32 = wrapU32(this.keys.length);
    const heads = this.heads;
    const b: u32 = (h & wrapU32(heads.length - 1)) >>> 0;
    this.keys.push(k);
    if (this.withVals) this.vals.push(v);
    const s: u32 = heads.get(b);
    this.chain.push(s > END ? s : END);
    heads.set(b, (at + 2) >>> 0);
    this.count = (this.count + 1) >>> 0;
  }

  /**
   * An array emptied by `adopt` or `trim` made `want` slots again, `live` of them in use, zero (R2). Where a counted object
   * holds the map (R11), making it takes the counted heap's freeing steps first, and if @tsl/std has nothing left,
   * everything the counted heap has waiting is freed, its maps' tables with it, before it's asked once more.
   */
  private resize<T>(a: JsArray<T>, want: u32, live: u32): void {
    if (this.counted && a.capacity < toUsize(want)) {
      const steps = tables.steps;
      steps();
      if (!a.tryReserve(want)) {
        const drain = tables.drain;
        drain();
        a.reserve(want);
      }
    } else a.reserve(want);
    a.setLength(live);
  }

  /**
   * An array's buffer let go of without giving it back: what a map that doesn't `freesTables` does with a table it
   * outgrows or clears, which stays allocated, as the direct route's runtime map's does (R3: before, the map made new
   * arrays and kept the old ones; now its arrays are held in place, so the buffer goes to an array nothing else reads,
   * which keeps what it's made with too, as each new array before R3 was kept).
   */
  private forget<T>(d: ElemOf<T>, a: JsArray<T>): void {
    const kept = new JsArray(d, 0, false);
    kept.adopt(a);
  }

  /**
   * From now on, what the map stops holding is zeroed where it was, its tables go back as it outgrows or clears them,
   * and its cursors are closed (`close`), so what its iterations, moves and clears make is reused: a lowered `rc`
   * package's map, whose holder counts what it holds and frees it (R2, R3). Otherwise each outgrown or cleared table is
   * kept, as a `leak` or `manual` program's runtime map's is.
   */
  freesTables(): void {
    this.tables = true;
  }

  /**
   * `freesTables`, for a map a counted object holds (R11): each table it makes from here on first takes the freeing steps
   * an allocation of the counted heap takes (`steps`), and where @tsl/std has nothing left, the counted heap frees all it
   * has waiting (`drain`), which gives back the tables of the maps waiting with it, before @tsl/std is asked again. So
   * churning maps frees as the counted heap's own allocations do, and running out of memory means what's live doesn't fit,
   * as the direct route's map's vectors, which are the counted heap's, have it (D39).
   */
  tablesIn(steps: TableSteps, drain: TableSteps): void {
    tables.steps = steps;
    tables.drain = drain;
    this.tables = true;
    this.counted = true;
  }

  /**
   * Full: a new table, with room for twice what's live and for the move to finish before inserts fill it, at STEP old
   * positions each. The new table's buffers are made first, in the old table's arrays, empty since the last move ended,
   * and only then do the two tables swap (R4), so running out of memory while they're made leaves the map as it was; the
   * old table's arrays then hold what's to be moved, and with nothing to move, the old buffers go back (or are kept, as
   * above).
   */
  private grow(): void {
    // Can't happen: the new table has room for the move to finish. If it did, finishing here is correct, if slow.
    if (this.moving) this.steps(this.end);
    const used: u32 = wrapU32(this.keys.length);
    const live: u32 = this.count;
    let need: u32 = (live << 1) >>> 0;
    const forMove: u32 = (live + ((used + STEP - 1) >>> 2) + 1) >>> 0; // STEP is 4
    if (forMove > need) need = forMove;
    let want: u32 = MIN_BUCKETS;
    while (want < need) want = (want << 1) >>> 0;
    this.resize(this.okeys, want, live);
    this.resize(this.ovals, this.withVals ? want : 0, this.withVals ? live : 0);
    this.resize(this.ochain, want, live);
    this.resize(this.oheads, want, want);
    // everything allocated: from here nothing can fail
    this.keys.swap(this.okeys);
    this.vals.swap(this.ovals);
    this.chain.swap(this.ochain);
    this.heads.swap(this.oheads);
    if (used > 0) this.startMove(used, live);
    else this.oldGone();
  }

  /** A generation: one reused where the map `freesTables` and one is free (R3), a new one otherwise. */
  private newGen(): JsMapGen {
    if (!this.tables) return new JsMapGen();
    const g = freeGens;
    if (g === null) return new JsMapGen();
    freeGens = g.next;
    g.next = null;
    return g;
  }

  /** A move starts, of `used` old positions with `live` entries, the old table's arrays holding them. */
  private startMove(used: u32, live: u32): void {
    const g = this.gen;
    if (g !== null) {
      const fresh = this.newGen();
      fresh.live = true;
      fresh.end = used;
      fresh.base = live;
      g.next = fresh;
      this.gen = fresh;
    }
    this.moving = true;
    this.mv = 0;
    this.end = used;
    this.to = 0;
    this.base = live;
  }

  /**
   * The old table is going: where its move put each position, in its chain, is taken over by the generation that reads
   * it, if one does (R3). Only the newest generation can: one is made at a move's start, or during it by `genNow`, and
   * nothing makes another until the move ends or the map clears.
   */
  private keepRanks(g: JsMapGen | null): void {
    if (g === null || !g.live) return;
    let r = g.keep;
    if (r === null) {
      r = new JsArray(u32, 0, this.giveBack);
      if (this.tables) g.keep = r;
    }
    r.adopt(this.ochain);
    g.ranks = r;
    g.live = false;
  }

  /** The old table's buffers, given back where the map `freesTables` and kept otherwise: its move has ended (R3). */
  private oldGone(): void {
    if (this.tables) {
      this.okeys.trim();
      this.ovals.trim();
      this.ochain.trim();
      this.oheads.trim();
    } else {
      this.forget(this.kd, this.okeys);
      this.forget(this.vd, this.ovals);
      this.forget(u32, this.ochain);
      this.forget(u32, this.oheads);
    }
    this.moving = false;
  }

  /** Moves up to n old positions, in order: a live entry to the next place at the front, and either way, where it went. */
  private steps(n: u32): void {
    if (!this.moving) return;
    const okeys = this.okeys;
    const ochain = this.ochain;
    let mv: u32 = this.mv;
    const end: u32 = this.end;
    let left: u32 = n;
    while (left > 0 && mv < end) {
      const r: u32 = this.to;
      if (ochain.get(mv) !== TOMB) {
        const k = okeys.get(mv);
        this.keys.set(r, k);
        if (this.withVals) this.vals.set(r, this.ovals.get(mv));
        // freesTables (R2): the old table no longer holds what the new one does, as the direct route's clears it
        if (this.tables) {
          okeys.zero(mv);
          if (this.withVals) this.ovals.zero(mv);
        }
        this.link(r, hashOf(k));
        this.to = (r + 1) >>> 0;
      }
      ochain.set(mv, (MOVED | r) >>> 0);
      mv = (mv + 1) >>> 0;
      left = (left - 1) >>> 0;
    }
    this.mv = mv;
    if (mv >= end) {
      // a generation that reads where the move put each position keeps that, and the old table goes (R3)
      this.keepRanks(this.gen);
      this.oldGone();
    }
  }

  /** A moved entry into its chain, below what's been inserted since the move started, so positions still fall. */
  private link(r: u32, h: u32): void {
    const heads = this.heads;
    const chain = this.chain;
    const b: u32 = (h & wrapU32(heads.length - 1)) >>> 0;
    const s: u32 = heads.get(b);
    if (s <= END || (s - 2) >>> 0 < r) {
      chain.set(r, s > END ? s : END);
      heads.set(b, (r + 2) >>> 0);
      return;
    }
    let p: u32 = (s - 2) >>> 0;
    for (;;) {
      const n: u32 = chain.get(p);
      if (n <= END || (n - 2) >>> 0 < r) {
        chain.set(r, n > END ? n : END);
        chain.set(p, (r + 2) >>> 0);
        return;
      }
      p = (n - 2) >>> 0;
    }
  }

  delete(k: K): bool {
    if (this.moving) this.steps(STEP);
    const h = hashOf(k);
    const i = unlink(this.heads, this.chain, this.keys, k, h, 0);
    if (i !== NONE) {
      this.count = (this.count - 1) >>> 0;
      if (this.tables) this.vacate(this.keys, this.vals, i);
      return true;
    }
    if (!this.moving) return false;
    const j = unlink(this.oheads, this.ochain, this.okeys, k, h, this.mv);
    if (j === NONE) return false;
    this.count = (this.count - 1) >>> 0;
    if (this.tables) this.vacate(this.okeys, this.ovals, j);
    return true;
  }

  /**
   * A position's key and value handed back (`outKey`, `outVal`) and its slots made zero, as the direct route's map clears
   * a slot it stops holding (`__v_clear`), so no table holds what the map no longer does (R2).
   */
  private vacate(keys: JsArray<K>, vals: JsArray<V>, i: usize): void {
    this.outK = keys.get(i);
    keys.zero(i);
    if (this.withVals) {
      this.outV = vals.get(i);
      vals.zero(i);
    }
  }

  /**
   * `set` for a map of counted keys or values (R2): true if it inserted, and then the map holds the key it was given;
   * false if the key was there already, and then the value it replaced is `outVal()`'s.
   */
  put(k: K, v: V): bool {
    const h = hashOf(k);
    const i = this.find(k, h);
    if (i !== NONE) {
      if (this.withVals) {
        this.outV = this.vals.get(i);
        this.vals.set(i, v);
      }
      return false;
    }
    if (this.moving) {
      const j = this.findOld(k, h);
      if (j !== NONE) {
        if (this.withVals) {
          this.outV = this.ovals.get(j);
          this.ovals.set(j, v);
        }
        return false;
      }
    }
    this.insert(k, v, h);
    return true;
  }

  /**
   * `delete`, with the entry handed back: true if it was there, and then its key and value are `outKey()`'s and
   * `outVal()`'s. Only for a map that `freesTables`.
   */
  cut(k: K): bool {
    return this.delete(k);
  }

  /** The key `cut` or `entryAt` last handed back. */
  outKey(): K {
    return this.outK;
  }

  /** The value `put`, `cut` or `entryAt` last handed back. */
  outVal(): V {
    return this.outV;
  }

  /**
   * How many positions the map has, live or not, in its table and, during a move, the old one's not yet moved: freeing a
   * lowered `rc` package's map takes one a step (R2, D39), as the direct route's frees a vector's slot a step.
   */
  positions(): usize {
    const n = this.keys.length;
    return this.moving ? n + toUsize(this.end - this.mv) : n;
  }

  /**
   * Whether position p holds an entry; if it does, its key and value are `outKey()`'s and `outVal()`'s, and with `take`
   * the entry is out of the map, its slots zero. Taking leaves its chain as it was, so a map is only ever taken from as
   * it's freed, and `trim` follows.
   */
  entryAt(p: usize, take: bool): bool {
    const n = this.keys.length;
    if (p < n) {
      if (this.chain.get(p) === TOMB) return false;
      if (!take) return this.peek(this.keys, this.vals, p);
      this.chain.set(p, TOMB);
      this.vacate(this.keys, this.vals, p);
      this.count = (this.count - 1) >>> 0;
      return true;
    }
    if (!this.moving) return false;
    const q: u32 = (this.mv + wrapU32(p - n)) >>> 0;
    if (q >= this.end) return false;
    const s: u32 = this.ochain.get(q);
    if (s === TOMB || s >= MOVED) return false;
    if (!take) return this.peek(this.okeys, this.ovals, q);
    this.ochain.set(q, TOMB);
    this.vacate(this.okeys, this.ovals, q);
    this.count = (this.count - 1) >>> 0;
    return true;
  }

  private peek(keys: JsArray<K>, vals: JsArray<V>, i: usize): bool {
    this.outK = keys.get(i);
    if (this.withVals) this.outV = vals.get(i);
    return true;
  }

  /**
   * Every array's buffer given back, the map left with none: the last step of freeing a lowered `rc` package's map (R2).
   * Both tables' arrays are the map's own (R3), so nothing of it is left behind in @tsl/jsrt but the generations and
   * cursors its iterations closed, which other maps reuse.
   */
  trim(): bool {
    // each array's own call, its result noted: a chain of eight `||`s here once inlined left -O2's cfg pass with
    // unreachable blocks (TIR verifier), R3
    let any = false;
    if (this.okeys.trim()) any = true;
    if (this.ovals.trim()) any = true;
    if (this.ochain.trim()) any = true;
    if (this.oheads.trim()) any = true;
    this.moving = false;
    if (this.keys.trim()) any = true;
    if (this.vals.trim()) any = true;
    if (this.chain.trim()) any = true;
    if (this.heads.trim()) any = true;
    this.count = 0;
    return any;
  }

  /** Emptied: what the tables held isn't reachable from here any more. */
  clear(): void {
    const g = this.gen;
    if (g !== null) {
      g.cleared = true;
      const fresh = this.newGen();
      g.next = fresh;
      this.gen = fresh;
    }
    if (this.moving) {
      // a move on: a generation that read the old chain keeps where the move put each position (R3)
      this.keepRanks(g);
      this.oldGone();
    }
    if (this.tables) {
      // freesTables (R2): emptied in place, its buffers back
      this.keys.trim();
      this.vals.trim();
      this.chain.trim();
      this.heads.trim();
    } else {
      // kept, as before R3, and the arrays made again as new ones are, with room for 4
      this.forget(this.kd, this.keys);
      this.forget(this.vd, this.vals);
      this.forget(u32, this.chain);
      this.forget(u32, this.heads);
      this.keys.reserve(4);
      this.vals.reserve(4);
      this.chain.reserve(4);
      this.heads.reserve(4);
    }
    this.count = 0;
    this.mv = 0;
    this.end = 0;
    this.to = 0;
    this.base = 0;
  }

  private genNow(): JsMapGen {
    const g = this.gen;
    if (g !== null) return g;
    const fresh = this.newGen();
    if (this.moving) {
      fresh.live = true;
      fresh.end = this.end;
      fresh.base = this.base;
    }
    this.gen = fresh;
    this.first = fresh;
    return fresh;
  }

  /**
   * A cursor before the first entry: `advance` moves it on, and `keyAt` and `valAt` read where it stopped. Where the map
   * `freesTables`, it's open until `close` (R3), and one closed before is reused.
   */
  cursor(): JsMapCursor {
    if (!this.tables) return new JsMapCursor(this.genNow());
    const g = this.genNow();
    this.readers = (this.readers + 1) >>> 0;
    const c = freeCursors;
    if (c === null) return new JsMapCursor(g);
    freeCursors = c.link;
    c.link = null;
    c.gen = g;
    c.pos = 0;
    c.cur = 0;
    c.done = false;
    c.inOld = false;
    c.curOld = false;
    return c;
  }

  /**
   * An iteration over, where the map `freesTables` (R3): tslc's expansion closes each cursor of a lowered `rc` package's
   * map where its variable's scope ends, by every way out, so `c` isn't used again. With none left open no cursor can
   * read a generation, so they're reused, and an old chain one kept goes back. Otherwise nothing: a cursor that's
   * dropped costs nothing more, as before.
   */
  close(c: JsMapCursor): void {
    if (!this.tables || this.readers === 0) return;
    c.link = freeCursors;
    freeCursors = c;
    this.readers = (this.readers - 1) >>> 0;
    if (this.readers === 0) this.retire();
  }

  /** Every generation free to reuse, its ranks given back: no cursor of this map is open (R3). */
  private retire(): void {
    let g = this.first;
    while (g !== null) {
      const n = g.next;
      const k = g.keep;
      if (k !== null) k.trim();
      g.ranks = null;
      g.live = false;
      g.cleared = false;
      g.end = 0;
      g.base = 0;
      g.next = freeGens;
      freeGens = g;
      g = n;
    }
    this.first = null;
    this.gen = null;
  }

  /** Where old position q went, once the move has passed it: in the old chain while it's the map's, else in `ranks`. */
  private rankOf(g: JsMapGen, q: u32): u32 {
    if (q >= g.end) return g.base;
    if (g.live) return (this.ochain.get(q) & ~MOVED) >>> 0;
    const r = g.ranks;
    if (r === null) return 0;
    return (r.get(q) & ~MOVED) >>> 0;
  }

  /**
   * The next live entry, by JS's rules: what's added is seen, what's deleted isn't, and once finished it stays finished.
   * During a move, the entries not yet moved are in the old table, between what's been moved and what's been inserted
   * since.
   */
  advance(c: JsMapCursor): bool {
    if (c.done) return false;
    let pos: u32 = c.pos;
    let g = c.gen;
    let inOld = c.inOld;
    // To the newest generation. A move made each one after the first, unless the one before it was cleared.
    for (;;) {
      const n = g.next;
      if (n !== null && g.cleared) {
        pos = 0;
        inOld = false;
        g = n;
        continue;
      }
      if (inOld) {
        if (n !== null || !this.moving) {
          pos = this.rankOf(g, pos);
          inOld = false;
        } else if (pos < this.mv) {
          pos = this.rankOf(g, pos);
          inOld = false;
        }
      }
      if (n === null) break;
      inOld = true;
      g = n;
    }
    c.gen = g;
    for (;;) {
      const moving = this.moving;
      if (inOld && moving) {
        const end: u32 = this.end;
        while (pos < end) {
          const s: u32 = this.ochain.get(pos);
          if (s !== TOMB && s < MOVED) {
            c.cur = pos;
            c.curOld = true;
            c.pos = (pos + 1) >>> 0;
            c.inOld = true;
            return true;
          }
          pos = (pos + 1) >>> 0;
        }
        pos = this.base;
      }
      inOld = false;
      const used: u32 = wrapU32(this.keys.length);
      while (pos < used) {
        if (moving && pos === this.to && pos < this.base) {
          // What hasn't moved yet comes next: it's in the old table, from the move's place on.
          pos = this.mv;
          inOld = true;
          break;
        }
        if (this.chain.get(pos) !== TOMB) {
          c.cur = pos;
          c.curOld = false;
          c.pos = (pos + 1) >>> 0;
          c.inOld = false;
          return true;
        }
        pos = (pos + 1) >>> 0;
      }
      if (!inOld) break;
    }
    c.pos = pos;
    c.inOld = false;
    c.done = true;
    return false;
  }

  /** The key where `advance` last stopped. */
  keyAt(c: JsMapCursor): K {
    if (c.curOld && this.moving) return this.okeys.get(c.cur);
    return this.keys.get(c.cur);
  }

  /** The value where `advance` last stopped. */
  valAt(c: JsMapCursor): V {
    if (c.curOld && this.moving) return this.ovals.get(c.cur);
    return this.vals.get(c.cur);
  }

  /** `forEach`, value first as JS has it, with JS's rules for what the callback adds and deletes. */
  forEach(f: (v: V, k: K) => void): void {
    const c = this.cursor();
    while (this.advance(c)) f(this.valAt(c), this.keyAt(c));
    this.close(c);
  }
}

/**
 * JS's `Set` (D47): a JsMap's table with no values, so changing it during an iteration does what JS does, and growth is
 * as incremental.
 */
export class JsSet<K> {
  private m: JsMap<K, u8>;

  constructor(kd: ElemOf<K>, giveBack: bool) {
    this.m = new JsMap(kd, u8, false, giveBack);
  }

  get size(): u32 {
    return this.m.size;
  }

  has(k: K): bool {
    return this.m.has(k);
  }

  add(k: K): void {
    this.m.add(k, 0);
  }

  delete(k: K): bool {
    return this.m.delete(k);
  }

  clear(): void {
    this.m.clear();
  }

  /** As JsMap's (R2). */
  freesTables(): void {
    this.m.freesTables();
  }

  /** As JsMap's (R11). */
  tablesIn(steps: TableSteps, drain: TableSteps): void {
    this.m.tablesIn(steps, drain);
  }

  /** `add` for a set of counted keys (R2): true if it inserted, and then the set holds the key it was given. */
  put(k: K): bool {
    return this.m.put(k, 0);
  }

  /** `delete`, with the key handed back as `outKey()`'s. */
  cut(k: K): bool {
    return this.m.cut(k);
  }

  outKey(): K {
    return this.m.outKey();
  }

  positions(): usize {
    return this.m.positions();
  }

  entryAt(p: usize, take: bool): bool {
    return this.m.entryAt(p, take);
  }

  trim(): bool {
    return this.m.trim();
  }

  cursor(): JsMapCursor {
    return this.m.cursor();
  }

  /** As JsMap's (R3). */
  close(c: JsMapCursor): void {
    this.m.close(c);
  }

  advance(c: JsMapCursor): bool {
    return this.m.advance(c);
  }

  keyAt(c: JsMapCursor): K {
    return this.m.keyAt(c);
  }

  forEach(f: (k: K) => void): void {
    const c = this.m.cursor();
    while (this.m.advance(c)) f(this.m.keyAt(c));
    this.m.close(c);
  }
}
