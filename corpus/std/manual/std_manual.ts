// memory-pages: 256
// @tsl/std in a `manual` package (SPEC 3.5, D43): collections of scalars, in objects the package frees itself, and of Slab
// references, which stay checked. A raw reference can't go in one (TSL3008, corpus/neg/std/manual).
import { lit, toU32, u32 } from "@tsl/core";
import { ExactMap, ref, Slab, Str, Vec } from "@tsl/std";
import { unsafeFree } from "@tsl/unsafe";

class Box {
  xs = new Vec(u32);
  next: Box | null = null;
  constructor(public id: u32) {}
}

function make(id: u32): Box {
  const b = new Box(id);
  b.xs.push(id * 2);
  return b;
}

export function aBoxWithAVec(id: u32): u32 {
  const b = make(id);
  const r = b.xs.get(0);
  b.xs.free();
  // SAFETY: b came from make, nothing else holds it, and it isn't used again.
  unsafeFree(b);
  return r;
}

export function churn(n: u32): u32 {
  let total: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const b = make(i % 100);
    for (let j: u32 = 0; j < 50; j++) b.xs.push(j);
    total = (total + b.xs.get(50)) >>> 0;
    b.xs.free();
    // SAFETY: as above.
    unsafeFree(b);
  }
  return total;
}

class Thing {
  constructor(public v: u32) {}
}
const things = new Slab<Thing>();

export function slabReferencesStayChecked(): u32 {
  using v = new Vec(ref<Thing>());
  const t = things.add(new Thing(1));
  v.push(t);
  things.remove(t);
  return v.get(0).v;
}

export function scalarsInAMap(): u32 {
  using m = new ExactMap(u32, u32);
  for (let i: u32 = 0; i < 1000; i++) m.set(i, i * 3);
  return m.get(999) + toU32(m.size);
}

export function loansStillTrap(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.withSlice(() => {
    v.free();
  });
  return 0;
}

export function strsToo(): u32 {
  const a = Str.of(lit("abc"));
  const b = a.concat(a);
  const r = toU32(b.length);
  a.free();
  b.free();
  return r;
}
