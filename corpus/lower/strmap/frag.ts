// memory-pages: 512
// A churn of strings of varied lengths in a small window, with far more going through than the limit. Blocks don't coalesce,
// so this is where trap 14 would come with free memory of the wrong shape.
function len(x: number, phase: number): number {
  const small = x % 97;
  if (phase === 0) return 1 + small;
  if (phase === 1) return 1 + (x % 3000);
  if (phase === 2) return (x & 1) === 0 ? 1 + small : 2000 + (x % 8000);
  return 1 + ((x >> 3) % 40000);
}
export function churn(iterations: number, phase: number, window: number): number {
  const keep: string[] = [];
  for (let i = 0; i < window; i++) keep.push("");
  let x = 12345;
  let t = 0;
  for (let i = 0; i < iterations; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const s = "ab".repeat(len(x, phase) >> 1) + "z";
    keep[x % window] = s;
    t = (t + s.length) | 0;
  }
  return t;
}
export function shifting(iterations: number): number {
  // Lengths that rise through every size, then fall: each class's free list fills up and is left behind.
  const keep: string[] = [];
  for (let i = 0; i < 16; i++) keep.push("");
  let t = 0;
  for (let i = 0; i < iterations; i++) {
    const size = i % 2000 < 1000 ? 1 + (i % 1000) : 1000 - (i % 1000);
    const s = "x".repeat(size * 4);
    keep[i % 16] = s;
    t = (t + s.length) | 0;
  }
  return t;
}
export function concatWindow(iterations: number): number {
  const keep = new Map<number, string>();
  let t = 0;
  let cur = "";
  for (let i = 0; i < iterations; i++) {
    cur += "abcdefgh";
    if (cur.length > 5000) cur = "";
    keep.set(i % 32, cur.slice(0, (i * 7) % 300));
    t = (t + keep.size) | 0;
  }
  return t;
}
