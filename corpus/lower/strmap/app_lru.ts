// An LRU on a Map, with delete-and-reinsert, generic in its key and value, as people write it.
class LRU<K, V> {
  private map = new Map<K, V>();
  hits = 0;
  misses = 0;
  constructor(private cap: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  put(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  order(): K[] {
    return [...this.map.keys()];
  }
}

class Item {
  constructor(public name: string) {}
}

export function numbers(cap: number, n: number): number[] {
  const c = new LRU<number, number>(cap);
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const k = x % (cap * 2);
    if (c.get(k) === undefined) c.put(k, i);
  }
  return [c.hits, c.misses, ...c.order().slice(0, 5)];
}

export function strings(cap: number, n: number): string[] {
  const c = new LRU<string, Item>(cap);
  let x = 7;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const k = `key${x % (cap * 2)}`;
    const it = c.get(k);
    if (it === undefined) c.put(k, new Item(k.toString()));
    else if (it.name === k) hits++;
  }
  return [String(hits), ...c.order().slice(0, 4)];
}
