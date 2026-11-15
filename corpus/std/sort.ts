// In-place sort, of scalars and of references, and what a comparator can't do (SPEC 3.5).
import { i64, toU32, u32, type bool, type i32, type usize } from "@tsl/core";
import { ref, Slab, Vec } from "@tsl/std";

function fill(v: Vec<u32>, n: usize, seed: u32): void {
  let x: u32 = seed;
  for (let i: usize = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    v.push(x >>> 8);
  }
}

const up = (a: u32, b: u32): i32 => (a < b ? -1 : a > b ? 1 : 0);

export function ascending(n: usize, seed: u32): u32 {
  using v = new Vec(u32);
  fill(v, n, seed);
  v.sortInPlace(up);
  let digest: u32 = 0;
  let sorted: bool = true;
  for (let i: usize = 0; i < n; i++) {
    if (i > 0 && v.get(i - 1) > v.get(i)) sorted = false;
    digest = ((Math.imul(digest, 31) >>> 0) + v.get(i)) >>> 0;
  }
  return sorted ? digest : 0;
}

export function descendingWithACapture(n: usize): u32 {
  using v = new Vec(u32);
  fill(v, n, 7);
  let calls: u32 = 0;
  v.sortInPlace((a, b) => {
    calls++;
    return a > b ? -1 : a < b ? 1 : 0;
  });
  return v.get(0) >= v.get(n - 1) && calls > 0 ? 1 : 0;
}

export function alreadySorted(n: usize): u32 {
  using v = new Vec(u32);
  for (let i: usize = 0; i < n; i++) v.push(toU32(i));
  v.sortInPlace(up);
  for (let i: usize = 0; i < n; i++) if (v.get(i) !== toU32(i)) return 0;
  return 1;
}

export function allEqualAndEmpty(): u32 {
  using v = new Vec(u32);
  v.sortInPlace(up);
  for (let i: u32 = 0; i < 100; i++) v.push(5);
  v.sortInPlace(up);
  return v.get(50) + toU32(v.length);
}

export function signed(): i64 {
  using v = new Vec(i64);
  v.push(5n);
  v.push(-3n);
  v.push(9223372036854775807n);
  v.push(-9223372036854775808n);
  v.sortInPlace((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return v.get(1) * 1000n + v.get(2);
}

class Person {
  constructor(
    public age: u32,
    public id: u32,
  ) {}
}
const people = new Slab<Person>();

export function references(n: u32): u32 {
  using v = new Vec(ref<Person>());
  for (let i: u32 = 0; i < n; i++) v.push(people.add(new Person((i * 37) % 11, i)));
  v.sortInPlace((a, b) => (a.age < b.age ? -1 : a.age > b.age ? 1 : a.id < b.id ? -1 : 1));
  let digest: u32 = 0;
  v.forEach((p) => {
    digest = ((Math.imul(digest, 33) >>> 0) + p.id) >>> 0;
    people.remove(p);
  });
  return digest;
}

export function staleInASort(): u32 {
  const v = new Vec(ref<Person>());
  const a = people.add(new Person(1, 1));
  const b = people.add(new Person(2, 2));
  v.push(a);
  v.push(b);
  people.remove(b);
  v.sortInPlace(() => 0);
  return 0;
}

export function pushInAComparator(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.push(2);
  v.sortInPlace((a, b) => {
    v.push(3);
    return up(a, b);
  });
  return 0;
}

export function sortNoAllocation(n: usize): u32 {
  using v = new Vec(u32);
  fill(v, n, 3);
  v.sortInPlace(up);
  v.pop();
  return toU32(v.length);
}
