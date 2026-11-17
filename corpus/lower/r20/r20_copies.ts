// R20: the runtime's copy and fill (`__rt_memmove`, `__rt_memset`) of every short size, where a wrong answer shows. Their
// last bytes, under 32 for a copy and under 16 for a fill, are now steps by the bits of the count (16, 8, 4, 2 and 1 bytes)
// where they were a byte at a time. Strings of every length up to 70 units are joined (a flat copy up to 64 units), cut
// (a copy of 2 to 31 units) and read back unit by unit, weighted by position, so a unit lost, doubled or moved shows. Arrays
// of booleans, one byte an element, are shifted and spliced at every length to 40, items put in at the front by a splice
// too, which moves their bytes over themselves both ways (a copy down, then a copy up), and read back weighted by index; and
// arrays of numbers likewise, 8 bytes an element.
function digest(s: string): number {
  let t = s.length;
  for (let i = 0; i < s.length; i++) t = (t * 31 + s.charCodeAt(i) * (i + 1)) | 0;
  return t;
}

/** Every pair of lengths a + b up to `max`, joined, each part made of units that differ by position. */
export function joins(max: number): number {
  let t = 0;
  const base = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_.:éü";
  for (let a = 0; a <= max; a++) {
    const x = base.slice(0, a);
    for (let b = 0; a + b <= max; b += 3) {
      const y = base.slice(base.length - b);
      t = (t * 7 + digest(x + y)) | 0;
    }
  }
  return t;
}

/** Every cut of 2 to 31 units, at every start, of a string longer than 64 units (a view's buffer, then a flat copy). */
export function cuts(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "the quick brown fox jumps over the lazy dog "[i % 44]!;
  let t = 0;
  for (let len = 2; len < 32; len++)
    for (let at = 0; at + len <= s.length; at += 5)
      t = (t * 3 + digest(s.substring(at, at + len))) | 0;
  return t;
}

function boolsDigest(xs: boolean[]): number {
  let t = xs.length;
  for (let i = 0; i < xs.length; i++) if (xs[i]) t = (t * 5 + i + 1) | 0;
  return t;
}

/** Arrays of booleans of every length to `max`: a byte an element, moved over themselves both ways. */
export function boolMoves(max: number): number {
  let t = 0;
  for (let n = 1; n <= max; n++) {
    const xs: boolean[] = [];
    for (let i = 0; i < n; i++) xs.push((i * 7) % 3 === 0 || i % 5 === 1);
    xs.shift();
    t = (t * 3 + boolsDigest(xs)) | 0;
    xs.splice(0, 0, true, false, true);
    t = (t * 3 + boolsDigest(xs)) | 0;
    const mid = n >> 1;
    xs.splice(mid, 2);
    t = (t * 3 + boolsDigest(xs)) | 0;
    xs.splice(mid >> 1, 0, false, true, true, false, true);
    t = (t * 3 + boolsDigest(xs)) | 0;
  }
  return t;
}

function numsDigest(xs: number[]): number {
  let t = xs.length;
  for (let i = 0; i < xs.length; i++) t = (t * 5 + xs[i]! * (i + 1)) | 0;
  return t;
}

/** Arrays of numbers of every length to `max`, 8 bytes an element, moved over themselves both ways. */
export function numMoves(max: number): number {
  let t = 0;
  for (let n = 1; n <= max; n++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(i * 3 + 1);
    xs.shift();
    t = (t * 3 + numsDigest(xs)) | 0;
    xs.splice(0, 0, -1, -2);
    t = (t * 3 + numsDigest(xs)) | 0;
    xs.splice(n >> 1, 3);
    t = (t * 3 + numsDigest(xs)) | 0;
    xs.splice(n >> 2, 0, 7, 8, 9);
    t = (t * 3 + numsDigest(xs)) | 0;
  }
  return t;
}

// R20's partial inlining with a frame slot in the callee's entry (inline.ts): a module count moved first, then a return on
// the common path, and on the rare one an object made (built in a frame slot of the entry's, then placed) and kept. The
// entry isn't free of effects, so no copy of it may be taken into the loop with the rare path calling the whole function,
// which would move the count twice.
let made = 0;
let last: Cell | null = null;

class Cell {
  constructor(public v: number) {}
}

function rare(c: Cell): number {
  return c.v * 3 + made;
}

function sometimes(x: number): number {
  made++;
  if (x % 97 !== 5) return x * 2;
  const c = new Cell(x);
  last = c;
  return rare(c) + rare(c);
}

/** n calls, the rare path about one in 97: the sum and the count, so a path taken twice shows. */
export function slowPaths(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = (t + sometimes(i)) | 0;
  return (t + made * 7 + (last !== null ? last.v : -1)) | 0;
}
