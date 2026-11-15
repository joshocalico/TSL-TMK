// `Map` and `Set` (SPEC 3.5, 4.5, D42, D47), in ordinary TS, lowered by down.ts for each key and value type a module uses. A
// `Set<K>` is a TmkMap<K, undefined>, with no value slots. It's a class of vectors, so what it holds is counted, described and
// collected as any class's fields are, and a borrow across `get` or `delete` is decided as it is for any method.
//
// Entries are in insertion order, in parallel vectors. `heads` and `chain` hold a hash table of positions: a link to
// position i is i + 2, 1 ends a chain, and a head of 0 or 1 is empty. `chain[i]` is 0 (TOMB) for a deleted entry, whose
// slots have been released. Along a chain positions only go down.
//
// A full table doesn't grow in one operation (D47). A new table is made at its final size, with room at its front for what's
// live, and the old one is emptied into it in order, STEP positions in each insert and delete after, while lookups look in
// both. Every vector is sized when it's made, so nothing grows by copying. When a move starts, or a table clears, the
// generation is replaced: a cursor holding an older one (TmkGen) finds its place from where the move put each old position,
// which the move writes into the old chain as -(new position) - 1. Nothing registers a cursor, so one that's dropped costs
// nothing.
import {
  __fault,
  __f64_hi,
  __f64_lo,
  __has_vals,
  __hash_k,
  __hole,
  __k_hash,
  __k_norm,
  __k_same,
  __v_at,
  __v_clear,
  __v_put,
  __v_size,
} from "./intrinsics.ts";

const TOMB = 0;
const END = 1;
const MIN_BUCKETS = 4;
/** Old positions moved in each insert or delete while a move is on: the new table has room for the move to finish first. */
const STEP = 4;

/**
 * One move or clear. `next` is always newer, so this never forms a cycle, whatever the type graph says. A generation made by a
 * move has `ranks`, the old table's chain, where the move writes each old position's new one, `end`, how many positions the
 * old table had, and `base`, where what's inserted after the move starts goes.
 */
export class TmkGen {
  cleared = false;
  next: TmkGen | null = null;
  ranks: number[] | null = null;
  end = 0;
  base = 0;
}

export class TmkCursor {
  pos = 0; // the next position to look at
  cur = 0; // what the last advance found
  gen: TmkGen;
  done = false;
  inOld = false; // pos is in the table `gen`'s move is emptying
  curOld = false; // and so is cur
  constructor(gen: TmkGen) {
    this.gen = gen;
  }
}

/** The table a move is emptying. */
export class TmkOld<K, V> {
  keys: K[];
  vals: V[];
  chain: number[];
  heads: number[];
  constructor(keys: K[], vals: V[], chain: number[], heads: number[]) {
    this.keys = keys;
    this.vals = vals;
    this.chain = chain;
    this.heads = heads;
  }
}

/** Where k is in a table, at or above `low`, or -1. Positions fall along a chain, so the first below `low` ends it. */
function seek<K>(
  heads: number[],
  chain: number[],
  keys: K[],
  k: K,
  h: number,
  low: number,
): number {
  const b = heads.length;
  if (b === 0) return -1;
  let s = __v_at(heads, h & ((b - 1) | 0));
  while (s > END) {
    const i = (s - 2) | 0;
    if (i < low) return -1;
    if (__k_same(__v_at(keys, i), k)) return i;
    s = __v_at(chain, i);
  }
  return -1;
}

/** As seek, and takes it out of its chain. */
function unlink<K>(
  heads: number[],
  chain: number[],
  keys: K[],
  k: K,
  h: number,
  low: number,
): number {
  const b = heads.length;
  if (b === 0) return -1;
  const at = h & ((b - 1) | 0);
  let s = __v_at(heads, at);
  let prev = -1;
  while (s > END) {
    const i = (s - 2) | 0;
    if (i < low) return -1;
    const next = __v_at(chain, i);
    if (__k_same(__v_at(keys, i), k)) {
      if (prev < 0) __v_put(heads, at, next);
      else __v_put(chain, prev, next);
      __v_put(chain, i, TOMB);
      return i;
    }
    prev = i;
    s = next;
  }
  return -1;
}

export class TmkMap<K, V> {
  keys: K[] = [];
  vals: V[] = [];
  chain: number[] = [];
  heads: number[] = [];
  size = 0;
  gen: TmkGen | null = null;
  old: TmkOld<K, V> | null = null;
  mv = 0; // the next old position to move
  end = 0; // how many positions the old table has
  to = 0; // where the next entry moved goes
  base = 0; // where what's inserted during the move starts

  find(k: K, h: number): number {
    return seek(this.heads, this.chain, this.keys, k, h, 0);
  }

  /** Where k is in the old table, if a move is on and hasn't got to it. */
  findOld(k: K, h: number): number {
    const o = this.old;
    if (o === null || __fault("old-unchecked")) return -1;
    return seek(o.heads, o.chain, o.keys, k, h, this.mv);
  }

  get(k: K): V | undefined {
    const h = __k_hash(k);
    const i = this.find(k, h);
    if (i >= 0) return __v_at(this.vals, i);
    const o = this.old;
    if (o === null) return undefined;
    const j = this.findOld(k, h);
    if (j < 0) return undefined;
    return __v_at(o.vals, j);
  }

  has(k: K): boolean {
    const h = __k_hash(k);
    return this.find(k, h) >= 0 || this.findOld(k, h) >= 0;
  }

  set(k0: K, v: V): void {
    const k = __fault("no-norm") ? k0 : __k_norm(k0);
    const h = __k_hash(k);
    const i = this.find(k, h);
    if (i >= 0) {
      __v_put(this.vals, i, v);
      return;
    }
    const o = this.old;
    if (o !== null) {
      const j = this.findOld(k, h);
      if (j >= 0) {
        __v_put(o.vals, j, v);
        return;
      }
    }
    this.insert(k, v, h);
  }

  add(k0: K): void {
    const k = __fault("no-norm") ? k0 : __k_norm(k0);
    const h = __k_hash(k);
    if (this.find(k, h) < 0 && this.findOld(k, h) < 0) this.insert(k, __hole<V>(), h);
  }

  insert(k: K, v: V, h: number): void {
    if (this.old !== null) this.steps(STEP);
    if (this.keys.length >= this.heads.length) this.grow();
    const at = this.keys.length;
    const heads = this.heads;
    const b = h & ((heads.length - 1) | 0);
    this.keys.push(k);
    if (__has_vals<V>()) this.vals.push(v);
    const s = __v_at(heads, b);
    this.chain.push(s > END ? s : END);
    __v_put(heads, b, (at + 2) | 0);
    this.size = (this.size + 1) | 0;
  }

  /**
   * Full: a new table, with room for twice what's live and for the move to finish before inserts fill it, at STEP old
   * positions each. Its vectors are sized now, and zero, which is TOMB in a chain and empty in a head (SPEC 4.5, D47).
   */
  grow(): void {
    // Can't happen: the new table has room for the move to finish. If it did, finishing here is correct, if slow.
    if (this.old !== null) this.steps(this.end);
    const used = this.keys.length;
    const live = this.size;
    let need = (live * 2) | 0;
    const forMove = (live + ((used + STEP - 1) >> 2) + 1) | 0; // STEP is 4
    if (forMove > need) need = forMove;
    let want = MIN_BUCKETS;
    while (want < need) want = (want * 2) | 0;
    const keys: K[] = [];
    __v_size(keys, want, live);
    const vals: V[] = [];
    if (__has_vals<V>()) __v_size(vals, want, live);
    const chain: number[] = [];
    __v_size(chain, want, live);
    const heads: number[] = [];
    __v_size(heads, want, want);
    if (used > 0) {
      const o = new TmkOld<K, V>(this.keys, this.vals, this.chain, this.heads);
      const g = this.gen;
      if (g !== null) {
        const fresh = new TmkGen();
        fresh.ranks = o.chain;
        fresh.end = used;
        fresh.base = live;
        g.next = fresh;
        this.gen = fresh;
      }
      this.old = o;
      this.mv = 0;
      this.end = used;
      this.to = 0;
      this.base = live;
    }
    this.keys = keys;
    if (__has_vals<V>()) this.vals = vals;
    this.chain = chain;
    this.heads = heads;
  }

  /** Moves up to n old positions, in order: a live entry to the next place at the front, and either way, where it went. */
  steps(n: number): void {
    const o = this.old;
    if (o === null) return;
    let mv = this.mv;
    const end = this.end;
    let left = n;
    while (left > 0 && mv < end) {
      const r = this.to;
      if (__v_at(o.chain, mv) !== TOMB && !(__fault("move-skips") && mv === 1)) {
        const k = __v_at(o.keys, mv);
        __v_put(this.keys, r, k);
        __v_clear(o.keys, mv);
        if (__has_vals<V>()) {
          __v_put(this.vals, r, __v_at(o.vals, mv));
          __v_clear(o.vals, mv);
        }
        this.link(r, __k_hash(k));
        this.to = (r + 1) | 0;
      }
      __v_put(o.chain, mv, (-r - 1) | 0);
      mv = (mv + 1) | 0;
      left = (left - 1) | 0;
    }
    this.mv = mv;
    if (mv >= end) this.old = null;
  }

  /** A moved entry into its chain, below what's been inserted since the move started, so positions still fall. */
  link(r: number, h: number): void {
    const heads = this.heads;
    const chain = this.chain;
    const b = h & ((heads.length - 1) | 0);
    const s = __v_at(heads, b);
    if (s <= END || ((s - 2) | 0) < r) {
      __v_put(chain, r, s > END ? s : END);
      __v_put(heads, b, (r + 2) | 0);
      return;
    }
    let p = (s - 2) | 0;
    for (;;) {
      const n = __v_at(chain, p);
      if (n <= END || ((n - 2) | 0) < r) {
        __v_put(chain, r, n > END ? n : END);
        __v_put(chain, p, (r + 2) | 0);
        return;
      }
      p = (n - 2) | 0;
    }
  }

  delete(k: K): boolean {
    if (this.old !== null) this.steps(STEP);
    const h = __k_hash(k);
    const i = unlink(this.heads, this.chain, this.keys, k, h, 0);
    if (i >= 0) {
      this.size = (this.size - 1) | 0;
      if (__has_vals<V>()) __v_clear(this.vals, i);
      __v_clear(this.keys, i);
      return true;
    }
    const o = this.old;
    if (o === null || __fault("old-unchecked")) return false;
    const j = unlink(o.heads, o.chain, o.keys, k, h, this.mv);
    if (j < 0) return false;
    this.size = (this.size - 1) | 0;
    if (__has_vals<V>()) __v_clear(o.vals, j);
    __v_clear(o.keys, j);
    return true;
  }

  /** New vectors, so what the old ones held is freed by later allocations, within the bound. */
  clear(): void {
    const g = this.gen;
    if (g !== null) {
      g.cleared = true;
      const fresh = new TmkGen();
      g.next = fresh;
      this.gen = fresh;
    }
    this.keys = [];
    if (__has_vals<V>()) this.vals = [];
    this.chain = [];
    this.heads = [];
    this.size = 0;
    this.old = null;
    this.mv = 0;
    this.end = 0;
    this.to = 0;
    this.base = 0;
  }

  genNow(): TmkGen {
    const g = this.gen;
    if (g !== null) return g;
    const fresh = new TmkGen();
    const o = this.old;
    if (o !== null) {
      fresh.ranks = o.chain;
      fresh.end = this.end;
      fresh.base = this.base;
    }
    this.gen = fresh;
    return fresh;
  }
}

export function mapCursor<K, V>(m: TmkMap<K, V>): TmkCursor {
  return new TmkCursor(m.genNow());
}

/** Where old position q went, once the move has passed it. */
function rankOf(g: TmkGen, q: number): number {
  if (q >= g.end) return g.base;
  const r = g.ranks;
  if (r === null) return 0;
  return (-__v_at(r, q) - 1) | 0;
}

/**
 * The next live entry, by JS's rules: what's added is seen, what's deleted isn't, and once finished it stays finished. During
 * a move, the entries not yet moved are in the old table, between what's been moved and what's been inserted since.
 */
export function mapAdvance<K, V>(m: TmkMap<K, V>, c: TmkCursor): boolean {
  if (c.done && !__fault("finished-wakes")) return false;
  let pos = c.pos;
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
    if (inOld && !__fault("cursor-stale")) {
      if (n !== null || m.old === null) {
        pos = rankOf(g, pos);
        inOld = false;
      } else if (pos < m.mv) {
        pos = rankOf(g, pos);
        inOld = false;
      }
    }
    if (n === null) break;
    inOld = true;
    g = n;
  }
  if (__fault("cursor-stale")) inOld = false;
  c.gen = g;
  for (;;) {
    const o = m.old;
    if (inOld && o !== null) {
      const end = m.end;
      while (pos < end) {
        if (__v_at(o.chain, pos) > TOMB) {
          c.cur = pos;
          c.curOld = true;
          c.pos = (pos + 1) | 0;
          c.inOld = true;
          return true;
        }
        pos = (pos + 1) | 0;
      }
      pos = m.base;
    }
    inOld = false;
    const used = m.keys.length;
    while (pos < used) {
      if (o !== null && pos === m.to && pos < m.base) {
        // What hasn't moved yet comes next: it's in the old table, from the move's place on.
        pos = m.mv;
        inOld = true;
        break;
      }
      if (__v_at(m.chain, pos) !== TOMB || __fault("sees-deleted")) {
        c.cur = pos;
        c.curOld = false;
        c.pos = (pos + 1) | 0;
        c.inOld = false;
        return true;
      }
      pos = (pos + 1) | 0;
    }
    if (!inOld) break;
  }
  c.pos = pos;
  c.inOld = false;
  c.done = true;
  return false;
}

export function curKey<K, V>(m: TmkMap<K, V>, c: TmkCursor): K {
  const o = m.old;
  if (c.curOld && o !== null) return __v_at(o.keys, c.cur);
  return __v_at(m.keys, c.cur);
}

export function curVal<K, V>(m: TmkMap<K, V>, c: TmkCursor): V {
  const o = m.old;
  if (c.curOld && o !== null) return __v_at(o.vals, c.cur);
  return __v_at(m.vals, c.cur);
}

export function mkPair<K, V>(k: K, v: V): [K, V] {
  return [k, v];
}

// --- an iterator as a value: `m.keys()` is a MapIterator<K>, whatever V is, so what it does has to hide K and V

export class TmkResult<T> {
  done: boolean;
  value: T | undefined;
  constructor(done: boolean, value: T | undefined) {
    this.done = done;
    this.value = value;
  }
}

export class TmkIter<T> {
  step: () => boolean;
  read: () => T;
  constructor(step: () => boolean, read: () => T) {
    this.step = step;
    this.read = read;
  }
  next(): TmkResult<T> {
    const s = this.step;
    if (!s()) return new TmkResult<T>(true, undefined);
    const r = this.read;
    return new TmkResult<T>(false, r());
  }
}

export function keysIter<K, V>(m: TmkMap<K, V>): TmkIter<K> {
  const c = mapCursor(m);
  return new TmkIter<K>(
    () => mapAdvance(m, c),
    () => curKey(m, c),
  );
}

export function valsIter<K, V>(m: TmkMap<K, V>): TmkIter<V> {
  const c = mapCursor(m);
  return new TmkIter<V>(
    () => mapAdvance(m, c),
    () => curVal(m, c),
  );
}

export function entriesIter<K, V>(m: TmkMap<K, V>): TmkIter<[K, V]> {
  const c = mapCursor(m);
  return new TmkIter<[K, V]>(
    () => mapAdvance(m, c),
    () => mkPair<K, V>(curKey(m, c), curVal(m, c)),
  );
}

export function setEntriesIter<K, V>(m: TmkMap<K, V>): TmkIter<[K, K]> {
  const c = mapCursor(m);
  return new TmkIter<[K, K]>(
    () => mapAdvance(m, c),
    () => mkPair<K, K>(curKey(m, c), curKey(m, c)),
  );
}

export function mapForEach<K, V>(m: TmkMap<K, V>, f: (v: V, k: K, m: TmkMap<K, V>) => void): void {
  const c = mapCursor(m);
  while (mapAdvance(m, c)) f(curVal(m, c), curKey(m, c), m);
}

export function setForEach<K, V>(m: TmkMap<K, V>, f: (v: K, k: K, m: TmkMap<K, V>) => void): void {
  const c = mapCursor(m);
  while (mapAdvance(m, c)) f(curKey(m, c), curKey(m, c), m);
}

export function iterNext<T>(it: TmkIter<T>): TmkResult<T> {
  return it.next();
}

export function iterStep<T>(it: TmkIter<T>): boolean {
  const s = it.step;
  return s();
}

export function iterRead<T>(it: TmkIter<T>): T {
  const r = it.read;
  return r();
}

// --- keys. Numbers and addresses are mixed with a keyed finaliser (MurmurHash3's), strings with HalfSipHash in str.ts.

export function hashI32(x: number): number {
  let h = x ^ __hash_k(0);
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h = h ^ __hash_k(1) ^ (h >>> 13);
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** The same hash as hashI32 for anything an integer location could hold: a map's `set` and `get` may disagree on rep. */
export function hashF64(x: number): number {
  if (x !== x) return 0x7ff80000;
  const i = x | 0;
  if (i === x) return hashI32(i);
  return hashI32(__f64_hi(x) ^ Math.imul(__f64_lo(x), 0x9e3779b1));
}

export function sameF64(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

// --- what a native caller uses (SPEC 4.5, D36, D47): to place one, and to read one, as the layout is the runtime's own

export function mapNew<K, V>(): TmkMap<K, V> {
  return new TmkMap<K, V>();
}

export function mapPut<K, V>(m: TmkMap<K, V>, k: K, v: V): void {
  m.set(k, v);
}

export function setPut<K, V>(m: TmkMap<K, V>, k: K): void {
  m.add(k);
}

export function mapLen<K, V>(m: TmkMap<K, V>): number {
  return m.size;
}

export function mapHas<K, V>(m: TmkMap<K, V>, k: K): boolean {
  return m.has(k);
}

/** A cursor, which `mapStep` moves on, and `mapKey` and `mapVal` read where it stopped, with JS's rules under change. */
export function mapIter<K, V>(m: TmkMap<K, V>): TmkCursor {
  return mapCursor(m);
}

export function mapStep<K, V>(m: TmkMap<K, V>, c: TmkCursor): boolean {
  return mapAdvance(m, c);
}

export function mapKey<K, V>(m: TmkMap<K, V>, c: TmkCursor): K {
  return curKey(m, c);
}

export function mapVal<K, V>(m: TmkMap<K, V>, c: TmkCursor): V {
  return curVal(m, c);
}
