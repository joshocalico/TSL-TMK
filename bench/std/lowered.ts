// What `tmk bench std` measures on the lowered `rc` runtime and on V8's own arrays (SPEC 8.4, D43). Map and Set are bench/strmap's.
export function vecPushRead(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i);
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + a[i]!) | 0;
  return (s + a.length) | 0;
}

function lcg(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}

export function sortWork(n: number): number {
  const a: number[] = [];
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    a.push(x);
  }
  a.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
  return a[n >> 1]!;
}

export function setDedupe(n: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add((i * 2) % 1000);
  return s.size;
}
