// Evaluation order where a reference variable is assigned inside the expression that uses it (R2): the `rc` printing reads
// a variable in place of a temporary only where nothing assigns it in between, and these are where something does.
class P {
  v: number;
  next: P | null = null;
  constructor(v: number) {
    this.v = v;
  }
}

/** The receiver is read before the right side assigns it: `p.v += (p = q).v` changes the first p. */
export function compoundReceiver(a: number, b: number): number {
  let p = new P(a);
  const first = p;
  const q = new P(b);
  p.v += (p = q).v;
  return first.v * 1000 + p.v;
}

/** An argument read before a later one assigns its variable. */
function pair(x: P, y: P): number {
  return x.v * 100 + y.v;
}

export function argumentOrder(a: number, b: number): number {
  let p = new P(a);
  const q = new P(b);
  return pair(p, ((p = q), new P(a * 2)));
}

/** In a loop: the node assigned while its successor is being made. */
export function chainSwap(n: number): number {
  let cur = new P(0);
  const head = cur;
  for (let i = 1; i < (n | 0); i++) {
    cur.next = ((cur = new P(i * 10)), new P(i));
  }
  let t = 0;
  for (let c: P | null = head; c !== null; c = c.next) t = (t * 3 + c.v) | 0;
  return t;
}

/**
 * The target's object is read before the right side assigns its variable (R3): `p.next = ((p = q), new P(…))` stores into
 * the first p, as JS evaluates an assignment's target before its value.
 */
export function storeTarget(a: number, b: number): number {
  let p = new P(a);
  const first = p;
  const q = new P(b);
  p.next = ((p = q), new P(a + b));
  const f = first.next;
  const n = p.next;
  return (f === null ? 0 : f.v) * 100 + (n === null ? 0 : n.v) + p.v * 10000;
}

/** The same for a scalar field, a compound assignment, and an increment. */
export function storeTargetScalar(a: number, b: number): number {
  let p = new P(a);
  const first = p;
  const q = new P(b);
  p.v = ((p = q), a * 3);
  const r1 = first.v * 100 + p.v;
  p = first;
  p.v -= ((p = q), 1);
  const r2 = first.v * 100 + p.v;
  return r1 * 100000 + r2;
}

/** An element's array and index are read before the right side assigns them. */
export function storeElement(n: number): number {
  let xs: P[] = [new P(1), new P(2)];
  const first = xs;
  let i = 0;
  xs[i] = ((xs = [new P(5), new P(6)]), (i = 1), new P(n));
  return first[0]!.v * 1000 + first[1]!.v * 100 + xs[0]!.v * 10 + xs[1]!.v;
}

/** The place read directly: q's next isn't known set, as the first p's was (native gave 7008, V8 7007). */
export function storeTargetRead(a: number, b: number): number {
  let p = new P(a);
  const q = new P(b);
  p.next = ((p = q), new P(a + b));
  return p.next === null ? 7007 : 7008;
}
