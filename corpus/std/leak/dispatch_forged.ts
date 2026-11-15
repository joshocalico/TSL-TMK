// memory-pages: 64
// A dispatch interface's object whose class id isn't one of its classes' traps 18 natively (3.4, D70): only memory
// reused or written unsafely can give one, as here, a reference forged to zeroed memory. On the host there's no class
// id to read, and the forged reference is the host's own business (a divergence pinned, 3.10).
import { u64, type i32 } from "@tsl/core";
import { ptrAt, ref, sourcePages } from "@tsl/unsafe";

interface Coin {
  value(): i32;
}

class Penny {
  value(): i32 {
    return 1;
  }
}

class Dime {
  value(): i32 {
    return 10;
  }
}

function worth(c: Coin): i32 {
  return c.value();
}

export function honest(): i32 {
  return worth(new Penny()) + worth(new Dime());
}

// SAFETY: not safe, on purpose: the page is zeroed and no object was ever made there, so the reference read from its
// first word points at a zeroed object, whose class id is 0, which no class has.
export function forged(): i32 {
  const page: u64 = sourcePages(1);
  if (page === 0n) return -1;
  ptrAt(u64, page).write(page + 64n);
  const c = ptrAt(ref<Coin | null>(), page).read();
  if (c === null) return -2;
  return worth(c) + honest();
}
