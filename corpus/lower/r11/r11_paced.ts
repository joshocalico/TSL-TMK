// memory-pages: 512
// R11: making a map's table takes the counted heap's freeing steps, as any allocation there does (D39). `build` keeps a
// list of 2,000 objects in module state; `grow` lets go of it and grows one set to 5,000 numbers, which makes one counted
// object and dozens of tables. tools/r11-tests.ts reads the freeing steps each case took, with nothing collected between
// cases: `grow` has to take steps for its tables, never more than the budget each.
class Item {
  next: Item | null;
  v: number;
  constructor(next: Item | null, v: number) {
    this.next = next;
    this.v = v;
  }
}

let kept: Item | null = null;

export function build(n: number): number {
  let h: Item | null = null;
  for (let i = 0; i < n; i++) h = new Item(h, i);
  kept = h;
  return n;
}

export function grow(n: number): number {
  kept = null;
  const s = new Set<number>();
  for (let j = 0; j < n; j++) s.add(j * 3);
  return s.size;
}

/** Takes an object from a native caller, so the build has a native caller's counters (4.5's ABI in `rc`, R8). */
export function peek(x: Item | null): number {
  if (x === null) return -1;
  return 1;
}
