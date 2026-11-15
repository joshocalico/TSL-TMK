// Arrays of objects, and closures, stored in globals across calls (SPEC 4.5).
type Item = { id: number; weight: number; tags: number[] };
const items: Item[] = [];
let handlers: ((x: number) => number)[] = [];
let tick = makeTick();
const scratch = new Float64Array(4);
let grown = new Uint8Array(2);

function makeTick(): () => number {
  let n = 0;
  return () => ++n;
}

export function add(id: number, w: number): number {
  items.push({ id, weight: w, tags: [] });
  return items.length;
}

export function tag(i: number, t: number): number {
  const it = items[i | 0]!;
  it.tags.push(t);
  return it.tags.length;
}

export function totalWeight(): number {
  let t = 0;
  for (const it of items) t += it.weight;
  return t;
}

export function allTags(): number[] {
  const out: number[] = [];
  for (const it of items) for (const t of it.tags) out.push(t);
  return out;
}

export function heaviest(): Item | null {
  let best: Item | null = null;
  for (const it of items) if (best === null || it.weight > best.weight) best = it;
  return best;
}

export function drop(): number {
  const it = items.pop();
  return it === undefined ? -1 : it.id;
}

export function setSlot(i: number, id: number): number {
  items[i | 0] = { id, weight: 0, tags: [1] };
  return items.length;
}

export function addHandler(k: number): number {
  handlers.push((x) => x + k);
  return handlers.length;
}

export function runHandlers(x: number): number {
  let t = x;
  for (const h of handlers) t = h(t);
  return t;
}

export function resetHandlers(): void {
  handlers = [];
}

export function ticks(): number {
  tick();
  return tick();
}

export function restartTick(): void {
  tick = makeTick();
}

export function storeScratch(v: number): number {
  scratch[1] = v;
  return scratch[1]! + scratch[0]!;
}

export function growBytes(n: number): number {
  const next = new Uint8Array(n | 0);
  next.set(grown);
  next[(n | 0) - 1] = 200;
  grown = next;
  return grown.length;
}

export function lastByte(): number {
  return grown[grown.length - 1]!;
}

export function bytes(): Uint8Array {
  return grown;
}
