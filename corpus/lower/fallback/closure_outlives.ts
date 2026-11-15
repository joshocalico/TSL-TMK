// A closure kept past the iteration whose binding it captures: inlining would read the wrong one.
// expect-fallback: keptFromLoop closure-escape
// expect-lowered: sameScope
export function keptFromLoop(n: number): number {
  let f = (x: number): number => x;
  for (let i = 0; i < (n | 0); i++) {
    const k = i * 10;
    if (i === 1) f = (x) => x + k;
  }
  return f(1);
}
export function sameScope(flag: boolean): number {
  let total = 1;
  const a = (x: number): number => x + total;
  let f = (x: number): number => x;
  if (flag) f = a;
  total = 5;
  return f(1);
}
