// memory-pages: 64
// What's in a garbage cycle isn't lost to exhaustion: trap 14 comes only after the queue is drained and the collector has run
// to completion, which is the one pause there is. Live data past the limit still traps (SPEC 3.5, D41).
class C {
  next: C | null = null;
  constructor(public v: number) {}
}
let keep: C | null = null;
function ring(len: number, seed: number): C {
  const first = new C(seed);
  let last = first;
  for (let i = 1; i < len; i++) {
    const r = new C(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}
/** One ring as large as fits, made and dropped again and again. */
export function largeRings(n: number, len: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + ring(len | 0, i).next!.v) | 0;
  return t;
}
/**
 * Rings dropped amid more candidates than the table holds, so some are forgotten: they aren't lost. When the memory runs out,
 * the collector walks the heap for what it forgot, rather than trap 14 with garbage around.
 */
export function forgotten(rounds: number): number {
  let t = 0;
  for (let i = 0; i < (rounds | 0); i++) {
    t = (t + ring(800, i).v) | 0;
    let h: C | null = null;
    for (let j = 0; j < 4400; j++) {
      const c = new C(j);
      c.next = h;
      h = c;
    }
    keep = h;
    t = (t + keep!.v) | 0;
    keep = null;
  }
  return t;
}
export function tooMuchLive(n: number): number {
  let h: C | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = new C(i);
    c.next = h;
    h = c;
  }
  keep = h;
  return keep === null ? 0 : keep.v;
}
