// memory-pages: 64
// R19: what `rc` class printing's remaining costs were (M5's R19 record), each where a wrong answer shows, for the dual route
// with class printing forced in `rc`. Arrays grow by rooms, numbers and objects, to lengths that alternate between arrays of
// one class (so a holder or a room is made at a tail length other than the last one made), and every element is read back
// weighted by its index, so an element lost or moved in a growth changes the sum. Array literals of two objects, and arrays
// of numbers grown into one room, are made and dropped far past the 64 pages there are: an element a holder's freeing
// doesn't drop, or a room it doesn't give back, runs out (trap 14). Objects of several sizes are kept alive at once in module
// state, every one fresh from the counted heap, and read back, so two that share memory show. Closures of three kinds are
// chosen at run time and called in a loop, each kind's arithmetic its own, so a call that reaches the wrong kind shows; and
// a map grows past several tables and is read back whole.
class P {
  constructor(public v: number) {}
}

class Wide {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  constructor(public v: number) {}
}

class Big {
  f0 = 0;
  f1 = 0;
  f2 = 0;
  f3 = 0;
  f4 = 0;
  f5 = 0;
  f6 = 0;
  f7 = 0;
  f8 = 0;
  f9 = 0;
  f10 = 0;
  f11 = 0;
  f12 = 0;
  constructor(public v: number) {}
}

/** Numbers pushed to length n, read back weighted: every growth's copy shows. */
function numbers(n: number, seed: number): number {
  const xs: number[] = [];
  for (let i = 0; i < (n | 0); i++) xs.push(i * 3 + seed);
  let t = 0;
  for (let i = 0; i < xs.length; i++) t = (t + xs[i]! * (i + 1)) | 0;
  return t;
}

/** Objects pushed to length n, read back weighted. */
function objects(n: number, seed: number): number {
  const ps: P[] = [];
  for (let i = 0; i < (n | 0); i++) ps.push(new P(i * 5 + seed));
  let t = 0;
  for (let i = 0; i < ps.length; i++) t = (t + ps[i]!.v * (i + 1)) | 0;
  return t;
}

/** Arrays of alternating lengths, two at a time of one class, so each tail length differs from the last one made. */
export function alternating(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const short = (r % 5) + 1;
    const long = (r % 37) + 9;
    t =
      (t + numbers(short, r) + numbers(long, r) * 3 + objects(long, r) + objects(short, r) * 7) | 0;
  }
  return t;
}

/** One array grown to n, through rooms of 8, 16, 32 and more, its elements written as it grows and read after. */
export function grown(n: number): number {
  return (numbers(n, 1) + objects(n, 2) * 3) | 0;
}

/** Literals of two objects, made and dropped again and again: each freed holder's elements have to go. */
export function pairs(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a = [new P(r), new P(r + 1)];
    t = (t + a[1]!.v - a[0]!.v + (a.length === 2 ? 1 : 0)) | 0;
  }
  return t;
}

/** Literals of one object, made and dropped: a holder whose freeing visits one slot. */
export function singles(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a = [new P(r)];
    t = (t + a[0]!.v) | 0;
  }
  return t;
}

/** Arrays of numbers grown into a room of their own, made and dropped: each freed holder gives its room back. */
export function roomed(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) xs.push(r + i);
    t = (t + xs[5]! - xs[0]!) | 0;
  }
  return t;
}

const keptP: P[] = [];
const keptW: Wide[] = [];
const keptB: Big[] = [];

/** Objects of three sizes kept alive together, each fresh from the counted heap, then all read back. */
export function keepMany(n: number): number {
  for (let i = 0; i < (n | 0); i++) {
    keptP.push(new P(i));
    const w = new Wide(i * 2);
    w.e = i;
    keptW.push(w);
    const b = new Big(i * 3);
    b.f12 = i + 1;
    keptB.push(b);
  }
  let t = 0;
  for (let i = 0; i < keptP.length; i++)
    t = (t + keptP[i]!.v + keptW[i]!.v + keptW[i]!.e * 5 + keptB[i]!.v + keptB[i]!.f12 * 7) | 0;
  return t;
}

/** Three kinds of closure over one counter, chosen by `which`, called n times in a loop. */
export function chosen(which: number, n: number): number {
  let acc = 1;
  const add = (a: number): void => {
    acc = acc + a;
  };
  const mul = (a: number): void => {
    acc = (acc * ((a & 3) + 1)) % 1000003;
  };
  const sub = (a: number): void => {
    acc = acc - a * 2;
  };
  const f = which === 0 ? add : which === 1 ? mul : sub;
  for (let i = 1; i <= (n | 0); i++) f(i);
  return acc;
}

/** A closure chosen afresh on every turn: the kind isn't the same from one call to the next. */
export function rotating(n: number): number {
  let acc = 0;
  const add = (a: number): void => {
    acc = acc + a;
  };
  const twice = (a: number): void => {
    acc = acc + a * 2;
  };
  const neg = (a: number): void => {
    acc = acc - a;
  };
  for (let i = 0; i < (n | 0); i++) {
    const f = i % 3 === 0 ? add : i % 3 === 1 ? twice : neg;
    f(i + 1);
  }
  return acc;
}

/** A map grown past several tables, then every key read back and some deleted. */
export function mapGrown(n: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < (n | 0); i++) m.set(i * 7, i + 1);
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + (m.get(i * 7) ?? -1000)) | 0;
  for (let i = 0; i < (n | 0); i += 3) m.delete(i * 7);
  return (t * 2 + m.size) | 0;
}
