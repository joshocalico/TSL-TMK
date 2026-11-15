// Rule: known closure, single target or local const called directly: inlined, or lambda-lifted.
// expect-note: closure-inlined
// expect-tir: func @walk
function apply(f: (x: number) => number, v: number): number {
  return f(v) + 1;
}
export function local(a: number): number {
  const k = a | 0;
  const add = (x: number): number => x + k;
  return add(1) + add(2);
}
export function mutatedCapture(a: number): number {
  let total = a | 0;
  const bump = (x: number): void => {
    total += x;
  };
  bump(1);
  bump(2);
  return total;
}
export function callback(a: number): number {
  const k = a | 0;
  return apply((x) => x * k, 3);
}
export function earlyReturn(a: number): number {
  const f = (x: number): number => {
    if (x > 10) return 1;
    for (let i = 0; i < 3; i++) {
      if (i === x) return i + 100;
    }
    return 2;
  };
  return f(a | 0) + f(11);
}
export function recursive(n: number): number {
  const step = (n | 0) > 0 ? 2 : 3;
  function walk(k: number): number {
    return k <= 0 ? 0 : step + walk(k - 1);
  }
  return walk(n | 0);
}
export function namedFunction(a: number): number {
  function twice(x: number): number {
    return x * 2;
  }
  return twice(a | 0);
}
