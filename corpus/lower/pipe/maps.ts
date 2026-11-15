// Maps and Sets with number and object keys, printed as @tsl/jsrt's JsMap and JsSet (D72): SameValueZero keys, objects by
// identity, an LRU cache that deletes and sets again, growth that moves entries a few at a time, and every change while a
// `for...of` is going over the map, each made before, during and after a move. Each returns a digest of every answer.
function mix(h: number, x: number): number {
  return Math.imul((h ^ x) >>> 0, 16777619) >>> 0;
}

class Node {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

/** -0 is +0 and NaN is NaN, and a key that's a fraction is itself. */
export function sameValueZero(x: number): number {
  const m = new Map<number, number>();
  m.set(-0, 1);
  m.set(0, 2);
  m.set(NaN, 3);
  m.set(0 / 0, 4);
  m.set(x / 4, 5);
  let h = mix(0, m.size);
  h = mix(h, m.has(-0) ? 1 : 0);
  h = mix(h, m.get(NaN) ?? 99);
  h = mix(h, m.get(x / 4) ?? 98);
  for (const [k, v] of m)
    h = mix(mix(h, k !== k ? 7777 : 1 / k === -Infinity ? 8888 : Math.floor(k * 4)), v);
  return h;
}

/** An LRU cache: a hit is deleted and set again, so it's last; past `cap`, the first goes. */
export function lru(n: number, cap: number): number {
  const m = new Map<number, number>();
  let h = 0;
  for (let i = 0; i < n; i++) {
    const k = ((i * 7) % 13) + ((i * 3) % 29);
    const v = m.get(k);
    if (v !== undefined) {
      m.delete(k);
      m.set(k, v + 1);
      h = mix(h, v);
    } else {
      m.set(k, i);
      if (m.size > cap) {
        for (const first of m.keys()) {
          m.delete(first);
          break;
        }
      }
    }
    h = mix(h, m.size);
  }
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return h;
}

/**
 * One change while a `for...of` goes over a map of n entries, made when it reaches `at`: 0 deletes the current entry, 1
 * the next, 2 the one before, 3 the last; 4 adds a key; 5 deletes and sets the current one again; 6 clears; 7 clears and
 * adds; 8 sets the next one's value; 9 deletes everything after; 10 adds n keys, so the table grows under the loop; 11
 * deletes every other entry; 12 deletes and sets again everything before.
 */
export function mutate(n: number, change: number, at: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 10);
  let h = 0x811c9dc5;
  let seen = 0;
  for (const [k, v] of m) {
    h = mix(mix(h, k), v);
    if (seen === at) {
      if (change === 0) m.delete(k);
      else if (change === 1) m.delete(k + 1);
      else if (change === 2) m.delete(k - 1);
      else if (change === 3) m.delete(n - 1);
      else if (change === 4) m.set(n + 100, 7);
      else if (change === 5) {
        m.delete(k);
        m.set(k, 5);
      } else if (change === 6) m.clear();
      else if (change === 7) {
        m.clear();
        m.set(500, 1);
        m.set(501, 2);
      } else if (change === 8) m.set(k + 1, 999);
      else if (change === 9) {
        for (let j = k + 1; j < n; j++) m.delete(j);
      } else if (change === 10) {
        for (let j = 0; j < n; j++) m.set(1000 + j, j);
      } else if (change === 11) {
        for (let j = 0; j < n; j += 2) m.delete(j);
      } else if (change === 12) {
        for (let j = 0; j < k; j++) m.delete(j);
        for (let j = 0; j < k; j++) m.set(j, j + 1);
      }
    }
    seen++;
    if (seen > 10000) break;
  }
  return mix(mix(h, seen), m.size);
}

/** Objects as keys, by identity, and as values; two nodes with one id are two keys. */
export function objects(n: number): number {
  const nodes: Node[] = [];
  const m = new Map<Node, Node>();
  for (let i = 0; i < n; i++) {
    const a = new Node(i % 7);
    nodes.push(a);
    m.set(a, new Node(i));
  }
  let h = mix(0, m.size);
  for (let i = 0; i < n; i += 3) {
    const a = nodes[i]!;
    h = mix(h, m.delete(a) ? 1 : 0);
    h = mix(h, m.has(a) ? 1 : 0);
    m.set(a, new Node(i + 1000));
  }
  h = mix(h, m.has(new Node(1)) ? 1 : 0);
  const got = m.get(nodes[1]!);
  h = mix(h, got === undefined ? 5 : got.id);
  for (const [k, v] of m) h = mix(mix(h, k.id), v.id);
  return h;
}

/** A Set of numbers: add, has, delete, clear, and a `for...of` that adds and deletes. */
export function sets(n: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add((i * 5) % (n + 3));
  let h = mix(0, s.size);
  for (let i = 0; i < n; i += 4) h = mix(h, s.delete(i) ? 1 : 0);
  h = mix(h, s.has(5) ? 1 : 0);
  for (const k of s) {
    h = mix(h, k);
    if (k === 10) s.add(n + 50);
    if (k === 15) s.delete(20);
  }
  s.clear();
  s.add(3);
  return mix(h, s.size);
}

/** Growth through many moves, with deletes ahead of the move and behind it. */
export function growth(n: number): number {
  const m = new Map<number, number>();
  let h = 0;
  for (let i = 0; i < n; i++) {
    m.set(i * 3, i);
    if (i % 3 === 0) m.delete(i * 3 - 9);
    if (i % 5 === 0) h = mix(h, m.get(i * 3 - 6) ?? 1);
  }
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return mix(h, m.size);
}

/** A get of an object value whose key isn't there: JS's undefined, which the printing has as null (strkeys). */
export function objectMisses(n: number): number {
  const nodes: Node[] = [];
  const m = new Map<Node, Node>();
  for (let i = 0; i < n; i++) nodes.push(new Node(i));
  for (let i = 0; i < n; i += 2) m.set(nodes[i]!, nodes[(i + 1) % n]!);
  let h = mix(0, m.size);
  for (let i = 0; i < n; i++) {
    const v = m.get(nodes[i]!);
    h = mix(h, v === undefined ? 4321 : v.id);
    if (i % 3 === 0) m.delete(nodes[i]!);
  }
  return mix(h, m.size);
}
