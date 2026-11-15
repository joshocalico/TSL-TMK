// rc-stack: 65536
// Large maps and sets dropped while a move is on, so both tables, the old one's counted keys and values and the cursor
// generations go at once, and the program then allocates (SPEC 3.5, D39, D47): the freeing bound holds, with no full drain.
class Item {
  constructor(public v: number) {}
}

let kept: Map<number, Item> | null = null;
let keptSet: Set<string> | null = null;
let last: Item | null = null;

/** A map of n objects, one more to start a move, a cursor that sleeps through it, and the map held by a global. */
export function buildMoving(n: number): number {
  const m = new Map<number, Item>();
  for (let i = 0; i < n; i++) m.set(i, new Item(i));
  const it = m.keys();
  it.next();
  m.set(n, new Item(n));
  kept = m;
  return m.size;
}

export function buildMovingSet(n: number): number {
  const s = new Set<string>();
  for (let i = 0; i < n; i++) s.add(`w${i}`);
  s.add("one more");
  keptSet = s;
  return s.size;
}

/** Drop them both, then allocate: what was held is freed a bounded number of steps at a time. */
export function dropAndChurn(rounds: number): number {
  kept = null;
  keptSet = null;
  let sum = 0;
  for (let i = 0; i < rounds; i++) {
    const t = new Item(i);
    last = t; // on the heap, so each one is an allocation that frees its share
    sum = (sum + t.v) | 0;
  }
  return (sum + (last?.v ?? 0)) | 0;
}
