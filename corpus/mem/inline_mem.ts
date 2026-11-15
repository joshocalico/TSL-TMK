// What the inliner meets in TSL with objects (SPEC D46): a known closure, a function passed as a value, an accessor on
// a class, a stack object whose methods are inlined until it's only values, and a stale reference that must still trap.
import { type i32, idiv } from "@tsl/core";

function apply(f: (x: i32) => i32, x: i32): i32 {
  return f(x);
}

function triple(y: i32): i32 {
  return y * 3;
}

class Acc {
  total: i32 = 0;
  count: i32 = 0;
  add(x: i32): void {
    this.total += x;
    this.count++;
  }
  mean(): i32 {
    return this.count === 0 ? 0 : idiv(this.total, this.count);
  }
}

export function viaClosure(x: i32, k: i32): i32 {
  const scale = (y: i32): i32 => y * k;
  return scale(x) + scale(1);
}

export function viaValue(x: i32): i32 {
  return apply(triple, x) + apply(triple, 2);
}

export function stackObject(n: i32): i32 {
  const a = new Acc();
  for (let i: i32 = 0; i < n; i++) a.add((i * 7) % 11);
  return a.total * 1000 + a.mean();
}
