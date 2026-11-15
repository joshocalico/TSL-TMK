// The worst single operation on a growing `Map` and `Set` (SPEC 3.5, D47): the bench calls one of these per operation and
// times each call by the counter, so what one `set` costs is seen alone, not as an average.
let m = new Map<number, number>();
let ms = new Map<string, number>();
let s = new Set<number>();
let words: string[] = [];

export function resetNum(): number {
  m = new Map<number, number>();
  return 0;
}

export function putNum(i: number): number {
  m.set(i, i);
  return m.size;
}

/** Deletes every other key as it goes, so tables compact as well as grow. */
export function churnNum(i: number): number {
  m.set(i, i);
  if ((i & 1) === 1) m.delete(i - 1);
  return m.size;
}

export function resetStr(n: number): number {
  ms = new Map<string, number>();
  words = [];
  for (let i = 0; i < n; i++) words.push(`k${i}`);
  return words.length;
}

export function putStr(i: number): number {
  ms.set(words[i]!, i);
  return ms.size;
}

export function resetSet(): number {
  s = new Set<number>();
  return 0;
}

export function addSet(i: number): number {
  s.add(i);
  return s.size;
}

/** Throughput: a whole build to n entries in one call, then a read of each. */
export function buildAndRead(n: number): number {
  const t = new Map<number, number>();
  for (let i = 0; i < n; i++) t.set(i * 7, i);
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum + (t.get(i * 7) ?? 0)) | 0;
  return sum;
}

/** Throughput: a mix of sets, gets and deletes over a window of keys. */
export function mixWork(n: number): number {
  const t = new Map<number, number>();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    t.set(i, i);
    if (i >= 64) t.delete(i - 64);
    sum = (sum + (t.get(i >> 1) ?? 1)) | 0;
  }
  return (sum + t.size) | 0;
}
