// R22: thrown objects in `rc`, freed with the collector linked two steps an allocation, the second taken in place: a thrown
// object has several reference slots (its message, its name, its cause, and the fields of the runtime's other error
// classes). Errors with and without causes, causes that are errors of a class of the program's own holding objects, caught
// one and many frames up, rethrown, kept past their catch and let go of, and thrown in loops long enough that each is freed
// while the next are made. A cause lost, a field read as another's, or an object freed while still held shows in the results.
class Leaf {
  constructor(public v: number) {}
}

class Holder {
  a: Leaf;
  b: Leaf;
  c: Leaf | null;
  constructor(v: number) {
    this.a = new Leaf(v);
    this.b = new Leaf(v * 2 + 1);
    this.c = v % 2 === 0 ? new Leaf(v * 3 + 2) : null;
  }
}

class AppError extends Error {
  constructor(
    message: string,
    public code: number,
    public held: Holder,
  ) {
    super(message);
  }
}

function fail(d: number, k: number): number {
  if (d === 0) {
    if (k % 3 === 0) throw new Error("plain " + "abcdefgh"[k % 8]!);
    if (k % 3 === 1) throw new AppError("app", k, new Holder(k));
    throw new Error("wrapped", { cause: new AppError("inner", k + 100, new Holder(k + 7)) });
  }
  return fail(d - 1, k) + 1;
}

function heldValue(h: Holder): number {
  return h.a.v * 3 + h.b.v * 5 + (h.c !== null ? h.c.v * 7 : 0);
}

/** What a caught error says: its message, its code and what it holds, or its cause's. */
function describe(e: unknown): number {
  if (e instanceof AppError) return e.code * 11 + heldValue(e.held) + e.message.length;
  if (e instanceof Error) {
    const c = e.cause;
    if (c instanceof AppError) return 1000 + c.code * 13 + heldValue(c.held) + e.message.length;
    if (c === undefined)
      return 2000 + e.message.length + e.message.charCodeAt(e.message.length - 1);
    return 3000;
  }
  return -1;
}

/** Throws caught `depth` frames up, `n` times, each described. */
export function caught(n: number, depth: number): number {
  let t = 0;
  for (let k = 0; k < n; k++) {
    try {
      t = (t + fail(depth, k)) | 0;
    } catch (e) {
      t = (t * 3 + describe(e)) | 0;
    }
  }
  return t;
}

/** Each caught error kept in an array, read back after many more are thrown, then let go of. */
export function keptPast(n: number): number {
  const kept: unknown[] = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    try {
      fail(k % 4, k);
    } catch (e) {
      if (k % 5 === 0) kept.push(e);
      t = (t + describe(e)) | 0;
    }
  }
  for (const e of kept) t = (t * 7 + describe(e)) | 0;
  kept.length = 0;
  for (let k = 0; k < n; k++) {
    try {
      fail(1, k + 1);
    } catch (e) {
      t = (t + describe(e)) | 0;
    }
  }
  return t;
}

/** Rethrown with a cause of its own, through a finally, and caught again further up. */
export function rethrown(n: number): number {
  let t = 0;
  let fin = 0;
  for (let k = 0; k < n; k++) {
    try {
      try {
        fail(2, k);
      } catch (e) {
        throw new Error("again", { cause: e });
      } finally {
        fin++;
      }
    } catch (e) {
      if (e instanceof Error) {
        const c = e.cause;
        t = (t * 5 + describe(c) + e.message.length) | 0;
      }
    }
  }
  return (t + fin) | 0;
}
