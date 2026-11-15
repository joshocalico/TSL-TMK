import { type bool, type u32, type u64, type usize } from "@tsl/core";

/** @tsl.size 16 */
class Timer {
  count: u32 = 7;
  ready: bool = false;
  constructor(public deadline: u64) {}
  expired(now: u64): bool {
    return now >= this.deadline;
  }
  get twice(): u32 {
    return this.count * 2;
  }
  set twice(v: u32) {
    this.count = v - 1;
  }
  static readonly LIMIT: u32 = 40;
}

export function basics(n: u32): u32 {
  const t = new Timer(10n);
  t.count += n;
  t.count++;
  t.twice = t.twice + Timer.LIMIT;
  return t.expired(10n) && !t.ready ? t.count : 0;
}

class Totals {
  sum: usize = 0;
  add(x: usize): void {
    this.sum += x;
  }
}

export function loopNew(n: usize): usize {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = new Totals();
    t.add(i);
    total += t.sum;
  }
  return total;
}

const S = new Totals();
export function staticNew(x: usize): usize {
  S.add(x);
  return S.sum;
}

class Derived {
  doubled: u32;
  constructor(public base: u32) {
    this.doubled = base * 2;
    this.base = base + 1;
  }
}

export function parameterPropertyInConstructor(x: u32): u32 {
  const d = new Derived(x);
  return d.base * 1000 + d.doubled;
}

class Derived2 {
  twin: u32;
  constructor(public a: u32) {
    this.twin = a;
  }
}
const fixed = new Derived2(5);

export function staticConstructorAssigns(): u32 {
  return fixed.a * 10 + fixed.twin;
}
