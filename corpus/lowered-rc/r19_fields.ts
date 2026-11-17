// R19: tslc's rule that a field of a lowered `rc` package's counted class, stored by its constructor alone, is invariant
// (markInvariantFields, D73, 3.4), on a hand-written lowered package, as `tmk lower` never prints a class whose constructor
// stores a field something else stores too. `Pick` is an environment's shape (a kind and a capture, made by a constructor
// that takes them), but `retarget` stores its kind again, through a call nothing inlines: so its kind isn't invariant, and a
// load of it read once for a loop, or once for two reads around that call, is a wrong answer. `Fixed` is the same shape with
// nothing storing it after construction: its kind is invariant, the loop's compare chain taken out of the loop at -O2, and
// the answers the same at every level.
import { type f64, type i32 } from "@tsl/core";

class Pick {
  kind: i32;
  base: f64;

  constructor(kind: i32, base: f64) {
    this.kind = kind;
    this.base = base;
  }

  /** @tsl.inline */
  call(a: f64): f64 {
    if (this.kind === 1) return this.base + a;
    if (this.kind === 2) return this.base * a;
    return a - this.base;
  }

  /** @tsl.noinline */
  retarget(k: i32): void {
    this.kind = k;
  }
}

class Fixed {
  kind: i32;
  base: f64;

  constructor(kind: i32, base: f64) {
    this.kind = kind;
    this.base = base;
  }

  /** @tsl.inline */
  call(a: f64): f64 {
    if (this.kind === 1) return this.base + a;
    if (this.kind === 2) return this.base * a;
    return a - this.base;
  }
}

/** Kind 1 for the first four turns, then 2: a call in the loop stores the kind. */
export function switching(n: f64): f64 {
  const p = new Pick(1, 2);
  let t: f64 = 0;
  for (let i: f64 = 0; i < n; i = i + 1) {
    t = t + p.call(i);
    if (i === 3) p.retarget(2);
    t = t + p.call(i) * 0.5;
  }
  return t;
}

/** The kind changed between two reads with nothing but the call between them. */
export function around(k: i32): f64 {
  const p = new Pick(1, 10);
  const a = p.call(1);
  p.retarget(k);
  const b = p.call(1);
  return a * 100 + b;
}

/** Each kind of `Fixed`, in a loop. */
export function fixed(which: i32, n: f64): f64 {
  const p = new Fixed(which, 3);
  let t: f64 = 0;
  for (let i: f64 = 0; i < n; i = i + 1) t = t + p.call(i);
  return t;
}
