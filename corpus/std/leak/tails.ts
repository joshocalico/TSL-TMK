// memory-pages: 1024
// Variable-length tails (D69) in a `leak` package: a plain class may end in `tail(T)` of any scalar, sized when the object
// is made by `withTail(n, new T(…))`, which is always on the heap at the object's real size. Each scalar type, a tail of
// none, a large one, two objects made back to back (a tail sized one element short writes over the next one), and a tail
// read through a method. The expected values are V8's.
import {
  idiv,
  f32,
  f64,
  i16,
  i32,
  i64,
  i8,
  tail,
  toF64,
  toI64,
  toU64,
  toU32,
  toU8,
  toI32,
  toUsize,
  u16,
  u32,
  u64,
  u8,
  withTail,
  wrapI16,
  wrapI8,
  wrapU16,
  wrapU8,
  type usize,
} from "@tsl/core";

class Bytes {
  tag: i32 = 7;
  constructor(public id: u32) {}
  data = tail(u8); // after the parameter property: a tail is the last field, and id is declared where it's written

  sum(): i32 {
    let t: i32 = 0;
    for (let i: usize = 0; i < this.data.length; i++) t += this.data[i]!;
    return t;
  }
}

class SBytes {
  data = tail(i8);
}
class Halves {
  first: u8 = 1;
  data = tail(u16);
}
class SHalves {
  data = tail(i16);
}
class Words {
  wide: u64 = 5n;
  data = tail(u32);
}
class SWords {
  data = tail(i32);
}
class Longs {
  small: u8 = 3;
  data = tail(u64);
}
class SLongs {
  data = tail(i64);
}
class Floats {
  data = tail(f32);
}
class Doubles {
  k: i32 = 2;
  data = tail(f64);
}

function bytes(n: u32): Bytes {
  const b = withTail(toUsize(n), new Bytes(n));
  for (let i: usize = 0; i < b.data.length; i++) b.data[i] = wrapU8(toI32(i) * 3 + 1);
  return b;
}

/** u8: the sum, the length, the fixed fields around it. */
export function u8Tail(n: u32): i32 {
  const b = bytes(n);
  return b.sum() * 10 + toI32(b.data.length) + b.tag * 1000000 + toI32(b.id);
}

/** i8: negative elements stay negative. */
export function i8Tail(n: u32): i32 {
  const s = withTail(toUsize(n), new SBytes());
  for (let i: usize = 0; i < s.data.length; i++) s.data[i] = wrapI8(toI32(i) * 37);
  let t: i32 = 0;
  for (let i: usize = 0; i < s.data.length; i++) t = t * 3 + s.data[i]!;
  return t;
}

export function u16Tail(n: u32): i32 {
  const h = withTail(toUsize(n), new Halves());
  for (let i: usize = 0; i < h.data.length; i++) h.data[i] = wrapU16(toI32(i) * 4099);
  let t: i32 = 0;
  for (let i: usize = 0; i < h.data.length; i++) t = (t ^ h.data[i]!) + 1;
  return t + toI32(h.first) * 100000;
}

export function i16Tail(n: u32): i32 {
  const h = withTail(toUsize(n), new SHalves());
  for (let i: usize = 0; i < h.data.length; i++) h.data[i] = wrapI16(toI32(i) * 4099);
  let t: i32 = 0;
  for (let i: usize = 0; i < h.data.length; i++) t += h.data[i]!;
  return t;
}

export function u32Tail(n: u32): f64 {
  const w = withTail(toUsize(n), new Words());
  for (let i: usize = 0; i < w.data.length; i++)
    w.data[i] = toU32(0xfffffff0) + toU32(toI32(i) & 15);
  let t: f64 = 0;
  for (let i: usize = 0; i < w.data.length; i++) t += toF64(w.data[i]!);
  return t + (w.wide === 5n ? 0.5 : 0);
}

export function i32Tail(n: u32): i32 {
  const w = withTail(toUsize(n), new SWords());
  for (let i: usize = 0; i < w.data.length; i++) w.data[i] = toI32(i) * -1000003;
  let t: i32 = 0;
  for (let i: usize = 0; i < w.data.length; i++) t = (t + w.data[i]!) | 0;
  return t;
}

export function u64Tail(n: u32): i32 {
  const l = withTail(toUsize(n), new Longs());
  for (let i: usize = 0; i < l.data.length; i++) l.data[i] = 0xffff_ffff_0000_0000n + toU64(i);
  let ok: i32 = 0;
  for (let i: usize = 0; i < l.data.length; i++) if (l.data[i]! >> 32n === 0xffff_ffffn) ok++;
  return ok * 10 + toI32(l.small);
}

export function i64Tail(n: u32): i32 {
  const l = withTail(toUsize(n), new SLongs());
  for (let i: usize = 0; i < l.data.length; i++) l.data[i] = -1n - toI64(i);
  let ok: i32 = 0;
  for (let i: usize = 0; i < l.data.length; i++) if (l.data[i]! < 0n) ok++;
  return ok;
}

export function f32Tail(n: u32): f64 {
  const f = withTail(toUsize(n), new Floats());
  for (let i: usize = 0; i < f.data.length; i++) f.data[i] = toF64(toI32(i)) / 3;
  let t: f64 = 0;
  for (let i: usize = 0; i < f.data.length; i++) t += f.data[i]!;
  return t;
}

export function f64Tail(n: u32): f64 {
  const d = withTail(toUsize(n), new Doubles());
  for (let i: usize = 0; i < d.data.length; i++) d.data[i] = toF64(toI32(i)) / 3;
  let t: f64 = 0;
  for (let i: usize = 0; i < d.data.length; i++) t += d.data[i]!;
  return t * toF64(d.k);
}

/** A tail of none: its length is 0 and the fixed fields are all there. */
export function zeroTail(): i32 {
  const b = withTail(0, new Bytes(9));
  const l = withTail(0, new Longs());
  return (
    toI32(b.data.length) + toI32(l.data.length) + b.tag * 10 + toI32(b.id) + toI32(l.small) * 1000
  );
}

/** A large tail: a million u16s, the last one written and read. */
export function largeTail(n: u32): i32 {
  const h = withTail(toUsize(n), new Halves());
  const last = h.data.length - 1;
  h.data[last] = 0xbeef;
  h.data[0] = 0x1234;
  return toI32(h.data.length) + h.data[last]! + h.data[0]! + h.data[idiv(last, 2)]!;
}

/**
 * Objects made back to back: every element of each written to all ones, then each one's fixed fields read. A tail one
 * element short of its length would overrun into the next object's fields.
 */
export function backToBack(n: u32, k: u32): i32 {
  let bad: i32 = 0;
  let prev: Bytes | null = null;
  for (let j: u32 = 0; j < k; j++) {
    const b: Bytes = withTail(toUsize(n), new Bytes(j));
    if (prev !== null) {
      for (let i: usize = 0; i < prev.data.length; i++) prev.data[i] = 0xff;
      if (prev.id !== j - 1) bad++;
    }
    for (let i: usize = 0; i < b.data.length; i++) b.data[i] = 0xff;
    if (b.tag !== 7 || b.id !== j) bad++;
    prev = b;
  }
  return bad;
}

/** Of u64 tails, whose words must stay 8-byte aligned, back to back: each starts zeroed, and the one before keeps its fields. */
export function wideBackToBack(n: u32, k: u32): i32 {
  let bad: i32 = 0;
  let prev: Longs | null = null;
  for (let j: u32 = 0; j < k; j++) {
    const l = withTail(toUsize(n), new Longs());
    l.small = toU8(toI32(j) & 127);
    for (let i: usize = 0; i < l.data.length; i++) if (l.data[i]! !== 0n) bad += 100; // made zeroed
    for (let i: usize = 0; i < l.data.length; i++) l.data[i] = 0xffff_ffff_ffff_ffffn;
    if (prev !== null && prev.small !== toU8((toI32(j) - 1) & 127)) bad++;
    prev = l;
  }
  return bad;
}
