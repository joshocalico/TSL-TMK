// memory-pages: 64
// Class ids don't change (3.4, D73): a dispatch interface's class id, and a field stored only as the next step after its
// `new`, are loaded once where nothing can change them, across calls that write and stores elsewhere, and out of a loop
// that allocates every turn. A field stored after construction too, by a call the optimiser can't see into, is read again
// after the call: tslc's rule must see that store (opt-a box 12's `clsid-ignore-store`). Natively against V8.
import { type i32 } from "@tsl/core";

interface Pet {
  legs(): i32;
  feed(n: i32): void;
  eaten(): i32;
}

class Cat {
  food: i32 = 0;
  legs(): i32 {
    return 4;
  }
  feed(n: i32): void {
    this.food += n;
  }
  eaten(): i32 {
    return this.food;
  }
}

class Bird {
  food: i32 = 0;
  legs(): i32 {
    return 2;
  }
  feed(n: i32): void {
    this.food += n * 2;
  }
  eaten(): i32 {
    return this.food;
  }
}

/** `kind` is stored once, right after its `new`; `n` is stored again later. */
class Tag {
  kind: i32 = 0;
  n: i32 = 0;
}

/** `level` is stored right after its `new`, and again by `raise`. */
class Gauge {
  level: i32 = 0;
}

/** @tsl.noinline */
function raise(g: Gauge, by: i32): void {
  g.level = g.level + by;
}

function tagOf(k: i32): Tag {
  const t = new Tag();
  t.kind = k;
  return t;
}

function petOf(k: i32): Pet {
  if (k === 0) return new Cat();
  return new Bird();
}

/** A loop that makes an object every turn and dispatches on the same pet every turn. */
export function feedAll(count: i32, which: i32): i32 {
  const p = petOf(which);
  let legs: i32 = 0;
  for (let i: i32 = 0; i < count; i++) {
    const t = tagOf(i & 3);
    t.n = i;
    legs += p.legs() + t.kind;
    p.feed(t.n);
    t.n += 1;
    legs += t.n;
  }
  return legs * 1000 + p.eaten();
}

/** A field stored after construction, by a call: read before it and after it, the two differ. */
export function gauge(steps: i32): i32 {
  const g = new Gauge();
  g.level = 1;
  let sum: i32 = 0;
  for (let i: i32 = 0; i < steps; i++) {
    const before = g.level;
    raise(g, 3);
    if (g.level !== before + 3) return -1;
    sum += g.level - before;
  }
  return sum * 100 + g.level;
}

/** Two pets, each told apart by its class id, with stores to the other between the calls. */
export function pair(rounds: i32): i32 {
  const a = petOf(0);
  const b = petOf(1);
  let s: i32 = 0;
  for (let i: i32 = 0; i < rounds; i++) {
    a.feed(1);
    s += a.legs();
    b.feed(i);
    s += b.legs() + a.legs();
  }
  return s * 1000 + a.eaten() + b.eaten();
}
