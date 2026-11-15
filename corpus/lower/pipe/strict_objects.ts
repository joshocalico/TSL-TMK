// R12: objects printed as TSL classes in `strict` (pile item 7). What escapes its function (a helper's result, an object
// kept in another) goes in the call arena the direct route uses, which tslc places it in and the caller resets (D36), and
// what doesn't stays on the stack. A frame reused by a later call (scramble) shows an object left on a stack it outlived,
// and a case run after another, over the arena that one left, shows a field read before anything wrote it.
class Vec2 {
  x = 0;
  y = 0;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  add(o: Vec2): Vec2 {
    return new Vec2(this.x + o.x, this.y + o.y);
  }
  dot(o: Vec2): number {
    return this.x * o.x + this.y * o.y;
  }
}

class Acc {
  count = 0;
  sum = 0;
  last: Vec2 | null = null;
  push(v: Vec2): void {
    this.count++;
    this.sum += v.dot(v);
    this.last = v;
  }
}

function make(i: number): Vec2 {
  return new Vec2(i, i * 2);
}

function scramble(n: number): number {
  let t = 7;
  for (let i = 0; i < n; i++) t = (t * 31 + i) | 0;
  return t;
}

export function walk(n: number): number {
  const acc = new Acc();
  let p = make(1);
  for (let i = 0; i < (n | 0); i++) {
    const q = make(i);
    scramble(8);
    p = p.add(q);
    acc.push(p);
  }
  const l = acc.last;
  return acc.sum + acc.count + (l !== null ? l.x + l.y : -1);
}

export function counters(n: number): number {
  let total = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = new Acc();
    a.push(make(i));
    total += a.count + a.sum + (a.last !== null ? 1 : 0);
  }
  return total;
}

export function local(a: number, b: number): number {
  // nothing here escapes its function: on the stack
  const u = new Vec2(a, b);
  const v = new Vec2(b, a);
  return u.dot(v) + u.add(v).x;
}
