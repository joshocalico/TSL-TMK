// Closures returned from functions, with captured mutable state and per-iteration captures (SPEC 4.5).
function counter(start: number): () => number {
  let c = start;
  return () => {
    c++;
    return c;
  };
}

function adder(k: number) {
  return (x: number) => x + k;
}

function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x) => g(f(x));
}

function pair(n: number): { inc: () => void; get: () => number } {
  let v = n;
  return {
    inc: () => {
      v = v * 2;
    },
    get: () => v,
  };
}

export function twoCounters(n: number): number {
  const a = counter(n);
  const b = counter(100);
  a();
  a();
  b();
  return a() * 1000 + b();
}

export function curried(a: number, b: number): number {
  return adder(a)(b);
}

export function composed(x: number): number {
  const f = compose(
    adder(1),
    compose(adder(2), (y) => y * 3),
  );
  return f(x);
}

export function sharedState(n: number): number {
  const p = pair(n);
  p.inc();
  p.inc();
  return p.get();
}

export function perIteration(n: number): number {
  const fs: (() => number)[] = [];
  for (let i = 0; i < (n | 0); i++) {
    const j = i * i;
    fs.push(() => i + j);
  }
  let t = 0;
  for (const f of fs) t = t * 10 + f();
  return t;
}

export function loopVarMutatedInBody(): number {
  const fs: (() => number)[] = [];
  for (let i = 0; i < 6; i++) {
    fs.push(() => i);
    i++;
  }
  let t = 0;
  for (const f of fs) t = t * 10 + f();
  return t;
}

export function closureMutatesLoopVar(): number {
  const bump: (() => number)[] = [];
  for (let i = 0; i < 3; i++) {
    bump.push(() => ++i);
  }
  return bump[0]!() * 100 + bump[0]!() * 10 + bump[1]!();
}

export function kept(n: number): number {
  let f = (x: number): number => x;
  for (let i = 0; i < (n | 0); i++) {
    const k = i * 10;
    if (i === 1) f = (x) => x + k;
  }
  return f(1);
}

function each(n: number, f: (i: number) => void): void {
  if (n > 0) {
    f(n);
    each(n - 1, f);
  }
}

export function recursiveWithCallback(n: number): number {
  let t = 0;
  each(n | 0, (i) => {
    t += i;
  });
  return t;
}

function fact(k: number): () => number {
  const go = (n: number): number => (n <= 1 ? 1 : n * go(n - 1));
  return () => go(k);
}

export function recursiveReturned(k: number): number {
  return fact(k | 0)();
}

class Box {
  op: (x: number) => number;
  constructor(public k: number) {
    this.op = (x) => x * this.k;
  }
  apply(x: number, then: (y: number) => number): number {
    return then(this.op(x));
  }
}

export function viaClassField(k: number, x: number): number {
  const b = new Box(k);
  b.k = k + 1;
  return b.apply(x, (y) => y - 1);
}

function plain(x: number): number {
  return x + 7;
}

export function namedAsValue(x: number): number {
  const fs = [plain, (y: number): number => y * 2];
  return fs.map((f) => f(x)).reduce((a, b) => a + b, 0);
}

export function dynamicCallback(xs: number[], neg: boolean): number[] {
  const f = neg ? (x: number): number => -x : (x: number): number => x + 1;
  return xs.map(f);
}

export function returnsClosureToCaller(k: number): () => number {
  return () => k;
}

export function optionalCallback(f: boolean): number {
  let cb: ((x: number) => number) | null = null;
  if (f) cb = (x) => x + 1;
  return cb === null ? -1 : cb(1);
}

class Maybe {
  hook: ((x: number) => number) | null = null;
  next: Maybe | null = null;
  constructor(public v: number) {}
  get2(by: number): number {
    return this.v * by;
  }
  bump(): void {
    this.v++;
  }
}

function touched(log: number[], x: number): number {
  log.push(x);
  return x;
}

/** With nothing there, no call happens and the arguments aren't evaluated. */
export function optionalCalls(present: boolean): number[] {
  const log: number[] = [];
  const m = new Maybe(3);
  let cb: ((x: number) => number) | null = null;
  if (present) {
    m.next = new Maybe(4);
    m.hook = (x) => x + 100;
    cb = (x) => x + 200;
  }
  const a = m.next?.get2(touched(log, 1)) ?? -1;
  const b = m.hook?.(touched(log, 2)) ?? -2;
  const c = cb?.(touched(log, 3)) ?? -3;
  m.next?.bump();
  return [a, b, c, m.next?.v ?? -4, ...log];
}
