// memory-pages: 40
// A growing array's old buffers: leak keeps them, and manual gives them back, since nothing else can hold them
// (SPEC 4.5). 100 rounds of 200 pushes take about 50 pages in leak, and about 27 in manual. The elements are `| 0`, so
// they're i32s: `i + r` alone isn't proved to fit one, as `r` is bounded only by `n | 0`, and as f64s the two modes come
// to the same 101 pages, which isn't what this tests (M5, Maps phase).
let kept: number[] = [];
export function rounds(n: number): number {
  let t = 0;
  for (let r = 0; r < (n | 0); r++) {
    const a: number[] = [];
    for (let i = 0; i < 200; i++) a.push((i + r) | 0);
    kept = a;
    t += kept.length;
  }
  return t;
}
export function small(): number {
  return kept.length;
}
