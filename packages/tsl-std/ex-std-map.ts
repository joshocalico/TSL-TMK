// file: ex-std-map.ts
import { Vec } from "@tsl/alloc";
import { toU32, Trap, trap, u32, u8, type bool, type usize } from "@tsl/core";
import { checkLive, heap, keyHash, keySame, mix, type ElemOf } from "./ex-std-global.ts";

const TOMB: u32 = 0xfffffffe;
const NONE: u32 = 0xffffffff;
const MIN_BUCKETS: usize = 4;

/**
 * A map where a missing key is a bug (D47): `get` traps 2 for one, as an index past the end does, and inserting, deleting or
 * clearing during `forEach` traps 13. A hash table in insertion order, arranged as compiler/rt/map.ts's tables are (D42):
 * keys and values in parallel vectors, and `heads` and `chain` a chained table of positions, with TOMB for what's deleted.
 * A key is an integer, a reference by identity, or a class with `hashKey` and `sameKey`, which `Str` has.
 */
export class ExactMap<K, V> {
  private keys: Vec<K>;
  private vals: Vec<V>;
  private chain: Vec<u32>;
  private heads: Vec<u32>;
  private count: usize = 0;
  private loans: usize = 0;
  private freed: bool = false;

  constructor(k: ElemOf<K>, v: ElemOf<V>) {
    this.keys = new Vec(k, heap);
    this.vals = new Vec(v, heap);
    this.chain = new Vec(u32, heap);
    this.heads = new Vec(u32, heap);
  }

  get size(): usize {
    return this.count;
  }

  // SAFETY: the hash can depend on an address. It only chooses a chain, and iteration is by position, so no result can.
  private hash(k: K): u32 {
    return mix(keyHash(k));
  }

  private find(k: K, h: u32): u32 {
    const b = this.heads.length;
    if (b === 0) return NONE;
    let i: u32 = this.heads.get((h & toU32(b - 1)) >>> 0);
    while (i !== NONE) {
      // SAFETY: comparing keys is a question about values: identity, or sameKey, which is the key's own method.
      if (keySame(this.keys.get(i), k)) return i;
      i = this.chain.get(i);
    }
    return NONE;
  }

  has(k: K): bool {
    return this.find(k, this.hash(k)) !== NONE;
  }

  /** Traps 2 if the key isn't there, as an index past the end does. */
  get(k: K): V {
    const i = this.find(k, this.hash(k));
    if (i === NONE) trap(Trap.Bounds);
    return this.vals.get(i);
  }

  getOr(k: K, otherwise: V): V {
    const i = this.find(k, this.hash(k));
    return i === NONE ? otherwise : this.vals.get(i);
  }

  set(k: K, v: V): void {
    if (!this.trySet(k, v)) trap(Trap.OutOfMemory);
  }

  /** False when out of memory, and the Map has the same entries. */
  trySet(k: K, v: V): bool {
    const h = this.hash(k);
    const i = this.find(k, h);
    if (i !== NONE) {
      this.vals.set(i, v);
      return true;
    }
    if (this.loans > 0) trap(Trap.Loan);
    if (this.keys.length >= this.heads.length && !this.grow()) return false;
    if (!this.keys.push(k)) return false;
    if (!this.vals.push(v)) {
      this.keys.pop();
      return false;
    }
    const b = (h & toU32(this.heads.length - 1)) >>> 0;
    if (!this.chain.push(this.heads.get(b))) {
      this.keys.pop();
      this.vals.pop();
      return false;
    }
    this.heads.set(b, toU32(this.keys.length - 1));
    this.count++;
    return true;
  }

  /** Full: drops what's deleted, and doubles if that doesn't free half. One operation, linear in the table, as D42's is. */
  private grow(): bool {
    const used = this.keys.length;
    const old = this.heads.length;
    let want = old;
    if (want === 0) want = MIN_BUCKETS;
    else if (this.count * 2 > used) want = want * 2;
    for (let i = old; i < want; i++) {
      if (!this.heads.push(NONE)) {
        for (let n = i; n > old; n--) this.heads.pop();
        return false;
      }
    }
    if (this.count < used) this.compact(used);
    for (let i: usize = 0; i < old; i++) this.heads.set(i, NONE);
    const mask = toU32(want - 1);
    const n = this.keys.length;
    for (let i: usize = 0; i < n; i++) {
      const b = (this.hash(this.keys.get(i)) & mask) >>> 0;
      this.chain.set(i, this.heads.get(b));
      this.heads.set(b, toU32(i));
    }
    return true;
  }

  private compact(used: usize): void {
    let to: usize = 0;
    for (let i: usize = 0; i < used; i++) {
      if (this.chain.get(i) === TOMB) continue;
      if (to !== i) {
        this.keys.set(to, this.keys.get(i));
        this.vals.set(to, this.vals.get(i));
      }
      to++;
    }
    for (let n = used; n > to; n--) {
      this.keys.pop();
      this.vals.pop();
      this.chain.pop();
    }
  }

  delete(k: K): bool {
    if (this.loans > 0) trap(Trap.Loan);
    const b = this.heads.length;
    if (b === 0) return false;
    const at = (this.hash(k) & toU32(b - 1)) >>> 0;
    let i: u32 = this.heads.get(at);
    let prev = NONE;
    while (i !== NONE) {
      const next = this.chain.get(i);
      // SAFETY: as in find.
      if (keySame(this.keys.get(i), k)) {
        if (prev === NONE) this.heads.set(at, next);
        else this.chain.set(prev, next);
        this.chain.set(i, TOMB);
        this.count--;
        return true;
      }
      prev = i;
      i = next;
    }
    return false;
  }

  /** In insertion order. Setting a key that's there is allowed: nothing moves. */
  forEach(f: (k: K, v: V) => void): void {
    this.loans++;
    const n = this.keys.length;
    for (let i: usize = 0; i < n; i++) {
      if (this.chain.get(i) === TOMB) continue;
      const k = this.keys.get(i);
      const v = this.vals.get(i);
      checkLive(k);
      checkLive(v);
      f(k, v);
    }
    this.loans--;
  }

  clear(): void {
    if (this.loans > 0) trap(Trap.Loan);
    for (let n = this.keys.length; n > 0; n--) {
      this.keys.pop();
      this.vals.pop();
      this.chain.pop();
    }
    for (let n = this.heads.length; n > 0; n--) this.heads.pop();
    this.count = 0;
  }

  free(): void {
    if (this.loans > 0) trap(Trap.Loan);
    this.freed = true;
    this.keys.free();
    this.vals.free();
    this.chain.free();
    this.heads.free();
  }

  dispose(): void {
    if (!this.freed) this.free();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * JS's `Map` (D47): `get` of a missing key gives `undefined`, and changing the map during `forEach` does what JS does. An
 * entry added is visited, one deleted before it's reached isn't, a value set before it's reached is the one seen, and after
 * `clear` what's added is visited. That needs a position to stay good while a `forEach` runs, so then nothing moves: a
 * growth doesn't compact, and `clear` leaves tombstones. The same table as ExactMap's otherwise.
 */
export class Map<K, V> {
  private keys: Vec<K>;
  private vals: Vec<V>;
  private chain: Vec<u32>;
  private heads: Vec<u32>;
  private count: usize = 0;
  private loans: usize = 0;
  private freed: bool = false;

  constructor(k: ElemOf<K>, v: ElemOf<V>) {
    this.keys = new Vec(k, heap);
    this.vals = new Vec(v, heap);
    this.chain = new Vec(u32, heap);
    this.heads = new Vec(u32, heap);
  }

  get size(): usize {
    return this.count;
  }

  // SAFETY: the hash can depend on an address. It only chooses a chain, and iteration is by position, so no result can.
  private hash(k: K): u32 {
    return mix(keyHash(k));
  }

  private find(k: K, h: u32): u32 {
    const b = this.heads.length;
    if (b === 0) return NONE;
    let i: u32 = this.heads.get((h & toU32(b - 1)) >>> 0);
    while (i !== NONE) {
      // SAFETY: comparing keys is a question about values: identity, or sameKey, which is the key's own method.
      if (keySame(this.keys.get(i), k)) return i;
      i = this.chain.get(i);
    }
    return NONE;
  }

  has(k: K): bool {
    return this.find(k, this.hash(k)) !== NONE;
  }

  /** `undefined` if the key isn't there. A scalar's is a flag and a value in registers, never in memory (3.3, rule 12). */
  get(k: K): V | undefined {
    const i = this.find(k, this.hash(k));
    if (i === NONE) return undefined;
    return this.vals.get(i);
  }

  getOr(k: K, otherwise: V): V {
    const i = this.find(k, this.hash(k));
    return i === NONE ? otherwise : this.vals.get(i);
  }

  set(k: K, v: V): void {
    if (!this.trySet(k, v)) trap(Trap.OutOfMemory);
  }

  /** False when out of memory, and the Map has the same entries. */
  trySet(k: K, v: V): bool {
    const h = this.hash(k);
    const i = this.find(k, h);
    if (i !== NONE) {
      this.vals.set(i, v);
      return true;
    }
    if (this.keys.length >= this.heads.length && !this.grow()) return false;
    if (!this.keys.push(k)) return false;
    if (!this.vals.push(v)) {
      this.keys.pop();
      return false;
    }
    const b = (h & toU32(this.heads.length - 1)) >>> 0;
    if (!this.chain.push(this.heads.get(b))) {
      this.keys.pop();
      this.vals.pop();
      return false;
    }
    this.heads.set(b, toU32(this.keys.length - 1));
    this.count++;
    return true;
  }

  /** Full: drops what's deleted, unless a forEach is running, and doubles if that doesn't free half. */
  private grow(): bool {
    const used = this.keys.length;
    const old = this.heads.length;
    const settled = this.loans === 0;
    let want = old;
    if (want === 0) want = MIN_BUCKETS;
    else if (this.count * 2 > used || !settled) want = want * 2;
    for (let i = old; i < want; i++) {
      if (!this.heads.push(NONE)) {
        for (let n = i; n > old; n--) this.heads.pop();
        return false;
      }
    }
    // Compacting leaves no tombstones, and `chain` stale: every link is made again. Without it, a tombstone stays one.
    const compacted = settled && this.count < used;
    if (compacted) this.compact(used);
    for (let i: usize = 0; i < old; i++) this.heads.set(i, NONE);
    const mask = toU32(want - 1);
    const n = this.keys.length;
    for (let i: usize = 0; i < n; i++) {
      if (!compacted && this.chain.get(i) === TOMB) continue;
      const b = (this.hash(this.keys.get(i)) & mask) >>> 0;
      this.chain.set(i, this.heads.get(b));
      this.heads.set(b, toU32(i));
    }
    return true;
  }

  private compact(used: usize): void {
    let to: usize = 0;
    for (let i: usize = 0; i < used; i++) {
      if (this.chain.get(i) === TOMB) continue;
      if (to !== i) {
        this.keys.set(to, this.keys.get(i));
        this.vals.set(to, this.vals.get(i));
      }
      to++;
    }
    for (let n = used; n > to; n--) {
      this.keys.pop();
      this.vals.pop();
      this.chain.pop();
    }
  }

  delete(k: K): bool {
    const b = this.heads.length;
    if (b === 0) return false;
    const at = (this.hash(k) & toU32(b - 1)) >>> 0;
    let i: u32 = this.heads.get(at);
    let prev = NONE;
    while (i !== NONE) {
      const next = this.chain.get(i);
      // SAFETY: as in find.
      if (keySame(this.keys.get(i), k)) {
        if (prev === NONE) this.heads.set(at, next);
        else this.chain.set(prev, next);
        this.chain.set(i, TOMB);
        this.count--;
        return true;
      }
      prev = i;
      i = next;
    }
    return false;
  }

  /** In insertion order, value first as JS has it, with what the callback adds, and without what it deletes first. */
  forEach(f: (v: V, k: K) => void): void {
    this.loans++;
    for (let i: usize = 0; i < this.keys.length; i++) {
      if (this.chain.get(i) === TOMB) continue;
      const k = this.keys.get(i);
      const v = this.vals.get(i);
      checkLive(k);
      checkLive(v);
      f(v, k);
    }
    this.loans--;
  }

  /** During a forEach, every entry becomes a tombstone, so its position still counts and what's added after is visited. */
  clear(): void {
    if (this.loans > 0) {
      for (let i: usize = 0; i < this.keys.length; i++) this.chain.set(i, TOMB);
      for (let i: usize = 0; i < this.heads.length; i++) this.heads.set(i, NONE);
      this.count = 0;
      return;
    }
    for (let n = this.keys.length; n > 0; n--) {
      this.keys.pop();
      this.vals.pop();
      this.chain.pop();
    }
    for (let n = this.heads.length; n > 0; n--) this.heads.pop();
    this.count = 0;
  }

  /** Not JS's: what a forEach is reading can't be freed under it, so that's trap 13. */
  free(): void {
    if (this.loans > 0) trap(Trap.Loan);
    this.freed = true;
    this.keys.free();
    this.vals.free();
    this.chain.free();
    this.heads.free();
  }

  dispose(): void {
    if (!this.freed) this.free();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * JS's `Set` (D47): a Map with a byte for a value, so changing it during `forEach` does what JS does. There's no trapping set:
 * with no `get` to miss, it would differ only there. `compiler/rt/map.ts` has no value slots for a Set, and that's not worth
 * a second table here.
 */
export class Set<K> {
  private m: Map<K, u8>;

  constructor(k: ElemOf<K>) {
    this.m = new Map(k, u8);
  }

  get size(): usize {
    return this.m.size;
  }

  has(k: K): bool {
    return this.m.has(k);
  }

  add(k: K): void {
    this.m.set(k, 1);
  }

  tryAdd(k: K): bool {
    return this.m.trySet(k, 1);
  }

  delete(k: K): bool {
    return this.m.delete(k);
  }

  forEach(f: (k: K) => void): void {
    this.m.forEach((_v, k) => {
      f(k);
    });
  }

  clear(): void {
    this.m.clear();
  }

  free(): void {
    this.m.free();
  }

  [Symbol.dispose](): void {
    this.m.dispose();
  }
}
