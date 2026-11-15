/* oxlint-disable unicorn/no-useless-spread -- the copy is the point: this deletes from what it would otherwise be going over */
// Lookups, updates and deletes while a move is on (SPEC 3.5, D47): a table built to a size where the next insert starts a
// move, and then every operation on keys the move has reached and keys it hasn't, with number, string and object keys, and
// counted values. Each returns a digest of every answer, so a key looked up in only one table shows.
function mix(h: number, x: number): number {
  return Math.imul((h ^ x) >>> 0, 16777619) >>> 0;
}

class Item {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

/** Number keys: n in, one more to start a move, then `ops` rounds of everything, probing all the keys each time. */
export function numbers(n: number, ops: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i * 7, i);
  let h = 0x811c9dc5;
  for (let r = 0; r < ops; r++) {
    m.set(100000 + r, r); // carries the move on
    const k = ((r * 37) % n) * 7;
    if (r % 4 === 0) h = mix(h, m.delete(k) ? 1 : 0);
    else if (r % 4 === 1) m.set(k, -r);
    else if (r % 4 === 2) h = mix(h, m.get(k) ?? 12345);
    else {
      m.delete(k);
      m.set(k, r);
    }
    for (let i = 0; i < n; i += 5) h = mix(h, m.has(i * 7) ? (m.get(i * 7) ?? 1) + 7 : 3);
    h = mix(h, m.size);
  }
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return h;
}

/** String keys, through two moves. */
export function strings(n: number, ops: number): number {
  const m = new Map<string, number>();
  for (let i = 0; i < n; i++) m.set(`k${i}`, i);
  let h = 0x811c9dc5;
  for (let r = 0; r < ops; r++) {
    m.set(`new${r}`, r);
    const k = `k${(r * 13) % n}`;
    if (r % 3 === 0) h = mix(h, m.delete(k) ? 1 : 0);
    else if (r % 3 === 1) h = mix(h, m.get(k) ?? -1);
    else m.set(k, r * 2);
    h = mix(h, m.size);
  }
  for (let i = 0; i < n; i++) h = mix(h, m.get(`k${i}`) ?? -2);
  for (const [k, v] of m) h = mix(mix(h, k.length), v);
  return h;
}

/** Objects as keys and as values: counted, through moves, deleted from either table, and still all there once. */
export function objects(n: number, ops: number): number {
  const keys: Item[] = [];
  const m = new Map<Item, Item>();
  for (let i = 0; i < n; i++) {
    const k = new Item(i);
    keys.push(k);
    m.set(k, new Item(1000 + i));
  }
  let h = 0x811c9dc5;
  for (let r = 0; r < ops; r++) {
    const fresh = new Item(5000 + r);
    keys.push(fresh);
    m.set(fresh, new Item(r));
    const k = keys[(r * 11) % keys.length]!;
    if (r % 3 === 0) m.delete(k);
    else if (r % 3 === 1) m.set(k, new Item(-r));
    else h = mix(h, m.get(k)?.id ?? -9);
  }
  for (const k of keys) h = mix(h, m.get(k)?.id ?? -3);
  for (const [k, v] of m) h = mix(mix(h, k.id), v.id);
  return mix(h, m.size);
}

/** A Set of strings through a move, with what's added and deleted on both sides of it. */
export function setStrings(n: number, ops: number): number {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) s.add(`s${i}`);
  let h = 0x811c9dc5;
  for (let r = 0; r < ops; r++) {
    s.add(`t${r}`);
    if (r % 2 === 0) h = mix(h, s.delete(`s${(r * 7) % n}`) ? 1 : 0);
    else h = mix(h, s.has(`s${(r * 3) % n}`) ? 1 : 0);
  }
  for (const k of s) h = mix(h, k.length);
  return mix(h, s.size);
}

/** Grow, empty, grow again: moves over tables that are mostly tombstones, so the new one is smaller. */
export function shrinkGrow(n: number, rounds: number): number {
  const m = new Map<number, number>();
  let h = 0x811c9dc5;
  let next = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) m.set(next++, r);
    let left = 0;
    for (const k of [...m.keys()]) {
      if (left++ % 8 !== 0) m.delete(k);
    }
    h = mix(h, m.size);
    for (let i = 0; i < next; i += 3) h = mix(h, m.get(i) ?? 77);
  }
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return h;
}

class Hub {
  id: number;
  peers = new Map<number, Hub>();
  constructor(id: number) {
    this.id = id;
  }
}

/**
 * Cycles through maps that move: each hub's map holds other hubs, which hold it back, grown through moves while iterated, then
 * all dropped. With the collector on they're freed as cycles, and the poisoning build traps on anything freed too soon.
 */
export function cyclic(n: number, rounds: number): number {
  let h = 0x811c9dc5;
  for (let r = 0; r < rounds; r++) {
    const hubs: Hub[] = [];
    for (let i = 0; i < n; i++) hubs.push(new Hub(i));
    for (const a of hubs) {
      for (let j = 0; j < 9; j++) {
        const b = hubs[(a.id * 7 + j) % n]!;
        a.peers.set(b.id, b);
      }
    }
    for (const a of hubs) {
      for (const [k, b] of a.peers) {
        h = mix(h, k + b.peers.size);
        if (k % 3 === 0 && k < 1000) a.peers.set(1000 + k, b);
      }
    }
    h = mix(h, hubs.length);
  }
  return h;
}

/** A table left mid-move and returned: what crosses must read as JS's Map (SPEC 4.5, D47). */
export function leftMoving(n: number, extra: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 2);
  for (let i = 0; i < extra; i++) m.set(n + i, i);
  m.delete(1);
  m.delete(n);
  return m;
}

export function leftMovingSet(n: number, extra: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < n + extra; i++) s.add(`e${i}`);
  s.delete("e0");
  return s;
}

/** A map passed in, changed, and its size: placed by the exports a native caller has for that (SPEC 4.5, D36). */
export function grows(m: Map<number, number>, by: number): number {
  const n = m.size;
  for (let i = 0; i < by; i++) m.set(1000 + i, i);
  m.delete(0);
  return n * 1000 + m.size;
}
