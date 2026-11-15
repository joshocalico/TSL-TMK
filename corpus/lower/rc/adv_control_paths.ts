// Short-circuit, conditional and early-return paths, and loops with break and continue, that hold a reference.
class P {
  next: P | null = null;
  constructor(public x: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
function make(v: number): P {
  return new P(v);
}
function maybe(v: number): P | null {
  return v > 0 ? new P(v) : null;
}
export function andChain(n: number): number {
  const a = maybe(n | 0);
  const r = a && make(a.x + 1);
  churn();
  return r ? r.x : -1;
}
export function orChain(n: number): number {
  const r = maybe(n | 0) || make(99);
  churn();
  return r.x;
}
export function nullishChain(n: number): number {
  const r = maybe(n | 0) ?? make(77);
  churn();
  return r.x;
}
export function optionalChain(n: number): number {
  const a = maybe(n | 0);
  const r = a?.x;
  churn();
  return (r === undefined ? -2 : r) + (maybe(n | 0)?.x ?? 100);
}
export function conditional(n: number): number {
  const r = (n | 0) > 3 ? make(1) : make(2);
  const s = (n | 0) > 3 ? r : make(3);
  churn();
  return r.x * 10 + s.x;
}
export function earlyReturn(n: number): number {
  const a = make(n | 0);
  if (a.x > 10) return a.x;
  const b = make(a.x + 1);
  if (b.x > 5) {
    const c = make(b.x + 1);
    return c.x + churn() - churn();
  }
  return b.x;
}
function earlyObject(n: number): P | null {
  const a = make(n);
  const b = make(n + 1);
  if (n > 2) return a;
  if (n > 1) return b;
  a.next = b;
  return a.next;
}
export function earlyReturnsReference(n: number): number {
  const r = earlyObject(n | 0);
  churn();
  return r === null ? -1 : r.x;
}
export function breakAndContinue(n: number): number {
  let t = 0;
  let keep: P | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const a = make(i);
    if (i % 2 === 0) continue;
    const b = make(i * 10);
    if (i > 5) {
      keep = b;
      break;
    }
    t += a.x + b.x;
  }
  churn();
  return t + (keep !== null ? keep.x : 0);
}
export function labelled(n: number): number {
  let t = 0;
  outer: for (let i = 0; i < (n | 0); i++) {
    const a = make(i);
    for (let j = 0; j < 4; j++) {
      const b = make(j);
      if (j === 2) continue outer;
      if (i === 3) break outer;
      t += a.x + b.x;
    }
  }
  return t + churn() - churn();
}
export function whileHolding(n: number): number {
  let cur: P | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = make(i);
    c.next = cur;
    cur = c;
  }
  let t = 0;
  while (cur !== null) {
    const nx: P | null = cur.next;
    if (cur.x === 1) {
      cur = null;
      churn();
      t += 1000;
      continue;
    }
    t += cur.x;
    cur = nx;
  }
  return t;
}
export function doWhile(n: number): number {
  let a: P = make(n | 0);
  let i = 0;
  do {
    a = make(a.x + 1);
    i++;
  } while (i < 5 && make(i).x < 3);
  return a.x;
}
export function switchPaths(n: number): number {
  const a = make(n | 0);
  let r = 0;
  switch (a.x) {
    case 1: {
      const b = make(10);
      r = b.x;
      break;
    }
    case 2: {
      const b = make(20);
      r = b.x;
    }
    // falls through
    case 3:
      r += make(30).x;
      break;
    default:
      return make(40).x;
  }
  return r + churn() - churn();
}
export function parameterAssigned(n: number): number {
  return assignParam(make(n | 0));
}
function assignParam(p: P): number {
  const first = p.x;
  p = make(p.x + 1);
  churn();
  p = make(p.x + 1);
  return first * 100 + p.x;
}
export function defaultParameter(n: number): number {
  return withDefault() + withDefault(make(n | 0));
}
function withDefault(p: P = make(5)): number {
  churn();
  return p.x;
}
