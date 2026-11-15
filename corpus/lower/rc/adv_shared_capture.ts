// A mutated capture shared by closures, one of which is dropped.
class P {
  constructor(public x: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
function pair(start: number): { inc: () => number; get: () => number } {
  let c = start;
  return {
    inc: (): number => {
      c = c + 1;
      return c;
    },
    get: (): number => c,
  };
}
export function scalarShared(n: number): number {
  const o = pair(n | 0);
  o.inc();
  const get = o.get;
  o.inc = (): number => 0;
  churn();
  return get();
}
function refPair(v: number): { set: (x: number) => void; get: () => number } {
  let cur = new P(v);
  return {
    set: (x: number): void => {
      cur = new P(x);
    },
    get: (): number => cur.x,
  };
}
export function refShared(n: number): number {
  const o = refPair(n | 0);
  o.set(7);
  const get = o.get;
  o.set = (_x: number): void => undefined;
  churn();
  return get();
}
export function dropOne(n: number): number {
  let cur: P = new P(n | 0);
  let a: (() => number) | null = (): number => cur.x;
  const b = (x: number): void => {
    cur = new P(x);
  };
  b(1);
  const first = a();
  a = null;
  churn();
  b(2);
  return first * 10 + cur.x;
}
export function dropSetter(n: number): number {
  let cur: P = new P(n | 0);
  let set: ((x: number) => void) | null = (x: number): void => {
    cur = new P(x);
  };
  const get = (): number => cur.x;
  const keep: (() => number)[] = [get];
  set(3);
  set = null;
  churn();
  return keep[0]!();
}
export function perIteration(n: number): number {
  const fs: (() => number)[] = [];
  for (let i = 0; i < (n | 0); i++) {
    const p = new P(i);
    fs.push((): number => p.x + i);
  }
  fs.pop();
  churn();
  let t = 0;
  for (const f of fs) t += f();
  return t;
}
export function perIterationMutated(n: number): number {
  const fs: (() => number)[] = [];
  for (let i = 0; i < (n | 0); i++) {
    fs.push((): number => {
      i = i + 100;
      return i;
    });
  }
  let t = 0;
  for (const f of fs) t += f();
  fs.length = 0;
  churn();
  return t;
}
