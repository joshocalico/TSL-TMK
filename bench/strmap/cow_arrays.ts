// Whether copy-on-write pays for arrays (SPEC 4.5, D42). What it would cost: a test on every write. What it would save: the
// copy in `.slice()` and spread, when nothing writes to the copy afterwards.
function lcg(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}
export function writesFill(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(0);
  for (let r = 0; r < 20; r++) for (let i = 0; i < n; i++) a[i] = (i + r) | 0;
  return a[n >> 1]!;
}
export function writesSort(n: number): number {
  const a: number[] = [];
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    a.push(x);
  }
  for (let i = 1; i < n; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) {
      a[j + 1] = a[j]!;
      j--;
    }
    a[j + 1] = v;
  }
  return a[0]!;
}
class P {
  constructor(public v: number) {}
}
export function writesRefs(n: number): number {
  const a: P[] = [];
  for (let i = 0; i < n; i++) a.push(new P(i));
  for (let r = 0; r < 20; r++) {
    for (let i = 1; i < n; i++) {
      const t = a[i]!;
      a[i] = a[i - 1]!;
      a[i - 1] = t;
    }
  }
  return a[0]!.v;
}
export function pushes(n: number): number {
  let t = 0;
  for (let r = 0; r < 20; r++) {
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(i);
    t = (t + a.length) | 0;
  }
  return t;
}
/** The copy a shared buffer would avoid: slices that are only ever read, by size. */
function sliceRead(a: number[], reads: number): number {
  let t = 0;
  for (let r = 0; r < reads; r++) {
    const c = a.slice();
    t = (t + c[r % c.length]!) | 0;
  }
  return t;
}
export function slice16(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < 16; i++) a.push(i);
  return sliceRead(a, n);
}
export function slice256(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < 256; i++) a.push(i);
  return sliceRead(a, n);
}
export function slice4096(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < 4096; i++) a.push(i);
  return sliceRead(a, n);
}
export function spreadRefs(n: number): number {
  const a: P[] = [];
  for (let i = 0; i < 256; i++) a.push(new P(i));
  let t = 0;
  for (let r = 0; r < n; r++) {
    const c = [...a];
    t = (t + c[r % 256]!.v) | 0;
  }
  return t;
}
export function headerOnly(n: number): number {
  // What a shared slice would still do: allocate a header and take a count.
  let t = 0;
  for (let r = 0; r < n; r++) {
    const c: number[] = [];
    t = (t + c.length + 1) | 0;
  }
  return t;
}
