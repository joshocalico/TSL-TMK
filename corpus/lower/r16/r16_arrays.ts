// R16: arrays as class printing makes them (@tsl/jsrt's JsArray in `leak` and `manual`, JsArenaArray in `strict`), at the
// edges R16's construction and `push` have: literals of every length from 0 to 9 made at their final size and read back
// whole, `push` up to and past each capacity a literal or `[]` starts with (4, the length, then each doubling) with another
// array made right after it, whose elements a write past the first's room would land on, growth keeping every element it
// had, pop then push at the edge, and arrays of objects. Nothing outlives a call, so `strict` prints it too.
class Cell {
  constructor(public v: number) {}
}

function lit(k: number): number[] {
  switch (k) {
    case 0:
      return [];
    case 1:
      return [11];
    case 2:
      return [11, 12];
    case 3:
      return [11, 12, 13];
    case 4:
      return [11, 12, 13, 14];
    case 5:
      return [11, 12, 13, 14, 15];
    case 6:
      return [11, 12, 13, 14, 15, 16];
    case 7:
      return [11, 12, 13, 14, 15, 16, 17];
    case 8:
      return [11, 12, 13, 14, 15, 16, 17, 18];
    default:
      return [11, 12, 13, 14, 15, 16, 17, 18, 19];
  }
}

/** Every element of a list, weighted by its place, with its length: a lost, moved or extra element changes it. */
function digest(a: number[]): number {
  let s = a.length * 1000003;
  for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]! * (i + 1)) | 0;
  return s;
}

/** A literal of length k read back whole, and its last element. */
export function literal(k: number): number {
  const a = lit(k | 0);
  return digest(a) + (a.length > 0 ? a[a.length - 1]! : -1);
}

/** A literal of length k, then n pushes, with a second array made right after it read back after each push. */
export function literalPush(k: number, n: number): number {
  const a = lit(k | 0);
  const b = [101, 102, 103, 104];
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const len = a.push(i * 7 + 1);
    t = (t * 17 + len + digest(b)) | 0;
  }
  return (t + digest(a) + digest(b)) | 0;
}

/** `[]` then n pushes of doubles (8 bytes each), with an array of the same made just after it, read back each time. */
export function emptyPush(n: number): number {
  const a: number[] = [];
  const b: number[] = [0.5, 1.5, 2.5];
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    a.push(i + 0.25);
    t = (t + a.length * 3 + (b[0]! + b[1]! + b[2]!) * 2) | 0;
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * (i + 1);
  return t + s + a.length;
}

/** Arrays of objects pushed past each capacity, every element's field read back, and a hole read past the end. */
export function objects(n: number): number {
  const a: Cell[] = [new Cell(1), new Cell(2)];
  const b: Cell[] = [];
  for (let i = 0; i < (n | 0); i++) {
    a.push(new Cell(i * 3));
    b.push(new Cell(i));
  }
  let t = 0;
  for (let i = 0; i < a.length; i++) t = (t * 7 + a[i]!.v) | 0;
  for (let i = 0; i < b.length; i++) t = (t * 5 + b[i]!.v) | 0;
  return t + a.length * 1000 + b.length + (a[a.length + 1] === undefined ? 1 : 0);
}

/** Pop to below a capacity and push back past it, n times over, the elements checked as it goes. */
export function popPush(n: number): number {
  const a = lit(4);
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    a.push(i);
    a.push(i + 1);
    t = (t + (a.pop() ?? -1) * 3 + a.length) | 0;
    if (i % 3 === 2) t = (t + (a.pop() ?? -1)) | 0;
  }
  return (t + digest(a)) | 0;
}

/** Many short arrays, one a turn, each made at a length and grown by a few pushes: what a callback's result is. */
export function turns(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = lit(i % 10);
    for (let j = 0; j < i % 6; j++) a.push(j + i);
    t = (t + digest(a)) | 0;
  }
  return t;
}
