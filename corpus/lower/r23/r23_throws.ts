// R23: thrown objects in `rc` built out of line, one builder function for each shape of throw (the class, its class id, and
// each argument a variable, a literal or a string literal's address), shared by throws of the same shape: classes of the
// program's own and Error's, literals that differ between throw sites of one class, variables of each kind, a constructor
// that throws itself, throws a frame and a hundred frames up, caught, kept, rethrown and read through `instanceof`. A class id
// lost, a literal taken from another site's throw or an argument in the wrong place shows in the results.
class Code {
  constructor(
    public code: number,
    public weight: number,
  ) {}
}

class Other {
  constructor(public tag: string) {}
}

class Fail extends Error {
  constructor(
    message: string,
    public depth: number,
  ) {
    super(message);
  }
}

class Strict {
  v: number;
  constructor(v: number) {
    if (v < 0) throw new RangeError("negative " + "xyz"[-v % 3]!);
    this.v = v * 2;
  }
}

function site(k: number, w: number): number {
  if (k % 7 === 0) throw new Code(1, w);
  if (k % 7 === 1) throw new Code(2, w);
  if (k % 7 === 2) throw new Code(w, 3);
  if (k % 7 === 3) throw new Other("t" + "abc"[k % 3]!);
  if (k % 7 === 4) throw new Fail("lit", k);
  if (k % 7 === 5) throw new Strict(k % 2 === 0 ? k : -k);
  return k;
}

function down(d: number, k: number, w: number): number {
  if (d === 0) return site(k, w);
  return down(d - 1, k, w) + 1;
}

function said(e: unknown): number {
  if (e instanceof Code) return e.code * 100 + e.weight;
  if (e instanceof Other) return 5000 + e.tag.charCodeAt(1);
  if (e instanceof Fail) return 7000 + e.depth * 3 + e.message.length;
  if (e instanceof Strict) return 8000 + e.v;
  if (e instanceof RangeError)
    return 9000 + e.message.length + e.message.charCodeAt(e.message.length - 1);
  if (e instanceof Error) return 9500;
  return -1;
}

/** Throws of every shape, caught `depth` frames up, `n` times. */
export function shapes(n: number, depth: number): number {
  let t = 0;
  for (let k = 0; k < n; k++) {
    try {
      t = (t + down(depth, k, k % 11)) | 0;
    } catch (e) {
      t = (t * 3 + said(e)) | 0;
    }
  }
  return t;
}

/** A message from a variable, and one kept past many more thrown, read after. */
export function messages(n: number): number {
  const kept: unknown[] = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const msg = k % 2 === 0 ? "even" : "odd" + "!".repeat(k % 4);
    try {
      if (k % 3 === 0) throw new Fail(msg, k);
      throw new Error(msg);
    } catch (e) {
      if (k % 9 === 0) kept.push(e);
      t = (t + said(e) + (e instanceof Error ? e.message.length : 0)) | 0;
    }
  }
  for (const e of kept) t = (t * 7 + said(e)) | 0;
  return t;
}

/** Rethrown as a cause through a finally, then caught further up. */
export function rethrown(n: number): number {
  let t = 0;
  let fin = 0;
  for (let k = 0; k < n; k++) {
    try {
      try {
        down(3, k, 2);
      } catch (e) {
        throw new Error("again", { cause: e });
      } finally {
        fin++;
      }
    } catch (e) {
      if (e instanceof Error) t = (t * 5 + said(e.cause)) | 0;
    }
  }
  return (t + fin) | 0;
}
