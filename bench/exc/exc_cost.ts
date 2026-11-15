// What exceptions cost (SPEC 8.4, D49): a call that can throw against one that can't, a `try` when nothing throws, and a
// throw caught 1, 10 and 100 frames up. Each export does `n` of its operation and returns a checksum, the same on V8.
class Fail extends Error {
  constructor(public depth: number) {
    super("fail");
  }
}

// Can't throw: nothing in it, or anything it calls, throws.
function plain(x: number): number {
  return (x * 7 + 3) & 1023;
}

// Can throw, and doesn't here: callers test after each call.
function risky(x: number): number {
  if (x < 0) throw new Fail(0);
  return (x * 7 + 3) & 1023;
}

export function callsPlain(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + plain(i ^ s)) | 0;
  return s;
}

export function callsRisky(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + risky(i ^ s)) | 0;
  return s;
}

export function tryNoThrow(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try {
      s = (s + risky(i ^ s)) | 0;
    } catch {
      s = -1;
    }
  }
  return s;
}

export function tryFinallyNoThrow(n: number): number {
  let s = 0;
  let f = 0;
  for (let i = 0; i < n; i++) {
    try {
      s = (s + risky(i ^ s)) | 0;
    } finally {
      f++;
    }
  }
  return (s + f) | 0;
}

function down(d: number): number {
  if (d === 0) throw new Fail(d);
  return down(d - 1) + 1;
}

function catchAt(d: number): number {
  try {
    return down(d - 1);
  } catch (e) {
    return e instanceof Fail ? e.depth + d : -1;
  }
}

export function throw1(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + catchAt(1)) | 0;
  return s;
}

export function throw10(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + catchAt(10)) | 0;
  return s;
}

export function throw100(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + catchAt(100)) | 0;
  return s;
}
