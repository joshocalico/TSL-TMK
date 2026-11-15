// memory-pages: 512
// R11: exceptions in `rc` through the TSL route, counted by tslc's expansion. Each case throws counted objects, holds them
// in locals and fields on the way out, catches, rethrows, runs `finally` blocks and lets exceptions reach the native caller,
// which takes them (4.5) and gives each back with the module's `__exc_release`. tools/r11-tests.ts reads what's live
// after each case, everything pending collected, in two rounds: only what module state keeps may be, so a thrown object
// not released after its catch shows as one more, and a `finally` or a rethrow releasing one twice shows as one fewer
// (or a stale count, trap 5).
class Res {
  id: number;
  next: Res | null;
  constructor(id: number, next: Res | null) {
    this.id = id;
    this.next = next;
  }
}

class Failure extends Error {
  res: Res;
  constructor(msg: string, res: Res) {
    super(msg);
    this.res = res;
  }
}

let kept: Res | null = null;
let rethrown = 0;

function chain(n: number): Res {
  let h: Res = new Res(0, null);
  for (let i = 1; i < n; i++) h = new Res(i, h);
  return h;
}

function boom(n: number): number {
  const local = chain(n);
  if (n > 2) throw new Failure("boom", local);
  return local.id;
}

/** A thrown object holding a chain, caught: the chain and the error go when the catch is done with them. */
export function catchOne(n: number): number {
  try {
    return boom(n);
  } catch (e) {
    if (e instanceof Failure) return e.res.id + 100;
    return -1;
  }
}

/** Caught, then thrown again from the catch, and caught a frame up. */
function rethrows(n: number): number {
  try {
    return boom(n);
  } catch (e) {
    rethrown = rethrown + 1;
    throw e;
  }
}

export function rethrowOne(n: number): number {
  try {
    return rethrows(n);
  } catch (e) {
    if (e instanceof Failure) return e.res.id + 200;
    return -2;
  }
}

/** A finally that holds an object of its own while the exception passes through it. */
function viaFinally(n: number): number {
  const mine = chain(3);
  try {
    return boom(n);
  } finally {
    kept = mine;
    kept = null;
  }
}

export function finallyOne(n: number): number {
  try {
    return viaFinally(n);
  } catch (e) {
    if (e instanceof Failure) return e.res.id + 300;
    return -3;
  }
}

/** A finally that throws its own exception over the one in flight: the first is released. */
function replaced(n: number): number {
  try {
    return boom(n);
  } finally {
    // oxlint-disable-next-line no-unsafe-finally -- the point: a finally's own throw replaces the one in flight
    if (n > 3) throw new Failure("over", chain(2));
  }
}

export function replaceOne(n: number): number {
  try {
    return replaced(n);
  } catch (e) {
    if (e instanceof Failure) return e.res.id + 400;
    return -4;
  }
}

/** A return out of a finally, which drops the exception in flight. */
function swallowed(n: number): number {
  try {
    return boom(n);
  } finally {
    // oxlint-disable-next-line no-unsafe-finally -- the point: a return out of a finally drops the exception in flight
    return 7;
  }
}

export function swallowOne(n: number): number {
  return swallowed(n) + n;
}

/** An exception that reaches the native caller, which takes it and gives it back. */
export function escapes(n: number): number {
  return boom(n);
}

/** A caught value kept in module state, then let go of by the next case. */
export function keepCaught(n: number): number {
  try {
    boom(n);
  } catch (e) {
    if (e instanceof Failure) kept = e.res;
  }
  return kept === null ? 0 : kept.id;
}

export function dropKept(n: number): number {
  kept = null;
  return n;
}

/** A loop that throws and catches on some passes, breaking out of a try with a finally. */
export function loopy(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    try {
      if (i % 3 === 0) t += boom(4);
      if (i === 7) break;
      t += i;
    } catch (e) {
      t += 1000;
    } finally {
      t += 1;
    }
  }
  return t;
}

/** Takes an object from a native caller, so the build has a native caller's counters (4.5's ABI in `rc`, R8). */
export function peek(x: Res | null): number {
  if (x === null) return -1;
  return x.id;
}
