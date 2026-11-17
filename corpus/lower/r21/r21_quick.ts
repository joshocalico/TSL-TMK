// R21: a function whose entry tests and returns at once, or goes on to work that needs a frame, as a call that can throw
// is, runs its quick way out before its prologue at -O1 and -O2 (the backend's shrink-wrapping). Each function here has
// both ways, called in loops whose own values are held across the calls (so a register the caller needs kept, written on
// the quick way, shows as a wrong answer), with integers, numbers and objects, through throws caught a frame and two frames
// up, recursion whose base case is the quick way, and a quick way that reads and writes memory.
class Fail extends Error {
  constructor(public code: number) {
    super("fail");
  }
}

class Cell {
  constructor(
    public v: number,
    public next: Cell | null,
  ) {}
}

let calls = 0;

/** Can throw: below zero it makes an object and throws it, otherwise the quick way. */
function risky(x: number): number {
  if (x < 0) throw new Fail(-x);
  return (x * 7 + 3) & 1023;
}

/** The argument is used on the slow way after a call, so it's held in a register the caller needs kept there. */
function keepsArg(x: number, y: number): number {
  if (x < 100) return (x + y) | 0;
  const c = new Cell(x, null);
  calls++;
  return (c.v + y + risky(x & 255)) | 0;
}

/** A number argument and result on the quick way. */
function half(d: number, k: number): number {
  if (d < 1000) return d * 0.5 + k;
  const c = new Cell(d, new Cell(k, null));
  return c.v * 0.25 + (c.next !== null ? c.next.v : 0);
}

/** The quick way reads and writes an object's field. */
function bump(c: Cell, by: number): number {
  if (by < 5) {
    c.v = c.v + by;
    return c.v;
  }
  const d = new Cell(by, c);
  c.next = d;
  return d.v + c.v;
}

/** Recursion: the base case is the quick way. */
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

/** Many arguments, all on the quick way. */
function many(a: number, b: number, c: number, d: number, e: number, f: number): number {
  if (a >= 0) return (a + b * 2 + c * 3 + d * 4 + e * 5 + f * 6) | 0;
  const x = new Cell(a, null);
  return (x.v + b + c + d + e + f + risky(-1)) | 0;
}

/** Each of the above in a loop whose own values cross the calls. */
export function loops(n: number): number {
  let s = 0;
  let t = 1;
  let u = 2.5;
  const cell = new Cell(0, null);
  for (let i = 0; i < n; i++) {
    s = (s + risky(i ^ (s & 511))) | 0;
    t = (t * 3 + keepsArg(i & 127, s & 63)) | 0;
    u = u + half(i * 3, t & 7);
    s = (s + bump(cell, i & 7)) | 0;
    t = (t + many(i, s & 15, t & 15, i & 3, 7, 9)) | 0;
  }
  return (s ^ t ^ Math.floor(u) ^ calls) | 0;
}

/** Throws caught a frame and two frames up, among quick calls. */
export function throwsAmong(n: number): number {
  let s = 0;
  let caught = 0;
  for (let i = 0; i < n; i++) {
    try {
      s = (s + risky(i % 7 === 3 ? -i : i)) | 0;
      s = (s + many(i % 11 === 5 ? -1 : i, 1, 2, 3, 4, 5)) | 0;
    } catch (e) {
      if (e instanceof Fail) caught = (caught + e.code) | 0;
      else caught = (caught + 1000) | 0;
    }
  }
  return (s * 31 + caught) | 0;
}

/** Recursion, whose every leaf is the quick way. */
export function fibs(n: number): number {
  let s = 0;
  for (let i = 0; i <= n; i++) s = (s * 3 + fib(i)) | 0;
  return s;
}
