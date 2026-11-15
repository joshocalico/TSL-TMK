import { type u32, type usize } from "@tsl/core";

function apply(f: (x: u32) => u32, x: u32): u32 {
  return f(x);
}
function twice(x: u32): u32 {
  return x * 2;
}

export function topLevelAsValue(x: u32): u32 {
  return apply(twice, x);
}

export function capturesConst(x: u32, k: u32): u32 {
  return apply((y) => y + k, x);
}

export function mutatesCaptured(n: usize): usize {
  let total = 0;
  let calls: u32 = 0;
  const add = (i: usize): void => {
    total += i;
    calls++;
  };
  for (let i = 0; i < n; i++) add(i);
  return total + calls;
}

function each(n: usize, f: (i: usize) => void): void {
  for (let i = 0; i < n; i++) f(i);
}

export function nested(n: usize): usize {
  let total = 0;
  each(n, (i) => {
    each(i, (j) => {
      total += j + 1;
    });
  });
  return total;
}

class Counter {
  count: usize = 0;
  bump(by: usize): void {
    each(3, () => {
      this.count += by;
    });
  }
}

export function capturesThis(by: usize): usize {
  const c = new Counter();
  c.bump(by);
  return c.count;
}

/** @tsl.noalloc */
export function inNoAlloc(n: usize): usize {
  let total = 0;
  each(n, (i) => {
    total += i;
  });
  return total;
}
