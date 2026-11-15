// memory-pages: 32
// Running out of memory while making an Error, or while throwing one, is trap 14, never an exception: throwing doesn't
// allocate without bound, and nothing is caught that V8 would have thrown (SPEC 3.10, divergence 4, D49).
class Held extends Error {
  constructor(
    public n: number,
    public prev: Held | null,
  ) {
    super(`held ${n}`);
  }
}

let kept: Held | null = null;

/** Each error is kept, so memory runs out while one is being made: in its allocation or its message's. */
export function keepThrowing(n: number): number {
  let caught = 0;
  for (let i = 0; i < (n | 0); i++) {
    try {
      throw new Held(i, kept);
    } catch (e) {
      if (e instanceof Held) {
        kept = e;
        caught++;
      }
    }
  }
  return caught;
}

/** Throwing and dropping as many: nothing builds up, and it finishes. */
export function throwAndDrop(n: number): number {
  let caught = 0;
  for (let i = 0; i < (n | 0); i++) {
    try {
      throw new Held(i, null);
    } catch {
      caught++;
    }
  }
  return caught;
}

export function stillWorks(): number {
  return kept === null ? -1 : kept.n;
}

export function release(): number {
  kept = null;
  return 0;
}
