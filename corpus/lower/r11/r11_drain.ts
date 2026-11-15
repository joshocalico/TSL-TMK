// memory-pages: 196
// R11: a map's tables are @tsl/std's, outside the counted heap, so when @tsl/std has nothing left the counted heap has to
// free what it has waiting before giving up, or a program runs out with garbage still holding tables. `fill` keeps three
// big sets at the far end of a chain of 5,000 objects; `refill` lets go of it all and builds one more big set. Freeing the
// chain takes about 10,000 steps, and the new set's tables take only some of them, so the three old sets are still waiting
// when @tsl/std runs out: the TSL route in `rc` must free what's waiting then, and fits in its 196 pages (it runs out at
// 176, and without the drain it runs out refilling below 216). For the TSL route alone, natively against V8's results
// (tools/r11-tests.ts): the direct route's vectors take more room than these tables, so the two needn't fit alike.
class Big {
  a: Set<number>;
  b: Set<number>;
  c: Set<number>;
  constructor(a: Set<number>, b: Set<number>, c: Set<number>) {
    this.a = a;
    this.b = b;
    this.c = c;
  }
}

class Node {
  next: Node | null;
  big: Big | null;
  constructor(next: Node | null, big: Big | null) {
    this.next = next;
    this.big = big;
  }
}

let keep: Node | null = null;

function filled(seed: number, n: number): Set<number> {
  const s = new Set<number>();
  for (let j = 0; j < n; j++) s.add(seed * 100000 + j);
  return s;
}

export function fill(n: number): number {
  const big = new Big(filled(1, n), filled(2, n), filled(3, n));
  let h: Node = new Node(null, big);
  for (let i = 0; i < 5000; i++) h = new Node(h, null);
  keep = h;
  return big.a.size + big.b.size + big.c.size;
}

export function refill(n: number): number {
  keep = null;
  const s = filled(4, n);
  return s.size;
}
