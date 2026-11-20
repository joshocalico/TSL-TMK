// memory-pages: 512
// R31 (SPEC 3.5): with the cycle collector, @tsl/gc cuts slots from chunks, each its size class's run of whole pages, now
// taken from the page source straight (chunkPages) rather than through the heap. Here objects in cycles holding arrays
// large enough that their rooms are slots of several pages, made side by side with small objects and other large ones,
// each array's every element written and read back (a digest), so a chunk given fewer pages than it spans overlaps the
// next one and an answer differs from V8's. Rings of them are dropped and made again, so the collector frees and reuses
// their slots.
class Big {
  other: Big | null = null;
  data: number[] = [];
  constructor(public seed: number) {}
}

class Small {
  next: Small | null = null;
  constructor(public v: number) {}
}

function fill(b: Big, len: number): void {
  for (let i = 0; i < len; i++) b.data.push(Math.imul(i + 1, 2654435761 | 0) ^ b.seed);
}

function digest(b: Big): number {
  let h = b.data.length;
  for (let i = 0; i < b.data.length; i++) h = (Math.imul(h, 31) + b.data[i]!) | 0;
  return h;
}

/** Pairs of large objects in a cycle, with small ones made between, each read back after all are made. */
export function pairs(n: number, len: number): number {
  const keep: Big[] = [];
  let s: Small | null = null;
  for (let r = 0; r < n; r++) {
    const a = new Big(r * 7 + 1);
    const b = new Big(r * 11 + 2);
    fill(a, len);
    s = new Small(r);
    s.next = new Small(r + 1);
    fill(b, len + (r % 3));
    a.other = b;
    b.other = a;
    keep.push(a);
  }
  let h = s === null ? 0 : s.v;
  for (const a of keep) h = (Math.imul(h, 17) + digest(a) + digest(a.other!)) | 0;
  return h;
}

/** Rings of large objects dropped and made again: what the collector frees is made anew in the same chunks. */
export function churn(rounds: number, len: number): number {
  let h = 0;
  for (let r = 0; r < rounds; r++) {
    const first = new Big(r);
    let last = first;
    for (let i = 1; i < 4; i++) {
      const x = new Big(r + i * 100);
      fill(x, len + i);
      last.other = x;
      last = x;
    }
    last.other = first;
    fill(first, len);
    let p: Big | null = first;
    for (let i = 0; i < 4 && p !== null; i++) {
      h = (Math.imul(h, 13) + digest(p)) | 0;
      p = p.other;
    }
  }
  return h;
}
