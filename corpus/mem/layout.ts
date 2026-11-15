import {
  alignOf,
  array,
  arrayOf,
  assertSize,
  be16,
  be32,
  be64,
  bits,
  enumOf,
  enumValue,
  f32,
  f64,
  i16,
  i32,
  i64,
  i8,
  make,
  nested,
  offsetOf,
  over,
  pad,
  set,
  sizeOf,
  toF64,
  toU32,
  u16,
  u32,
  u64,
  u8,
  type bool,
  type f64 as f64v,
  type usize,
} from "@tsl/core";

export enum Kind {
  A = 1,
  B = 2,
}

export class Desc {
  addr = u64();
  len = u32();
  flags = bits(u16, { next: 1, write: 1, level: 3 });
  next = u16();
  isLast(): bool {
    return !this.flags.next;
  }
}
assertSize(Desc, 16);

export class Mixed {
  a = u8();
  reserved = pad(3);
  b = i8();
  kind = enumOf(u16, Kind);
  c = u32();
  inner = nested(Desc);
  ring = array(u16, 4);
  many = arrayOf(Desc, 3);
  wire16 = be16();
  wire32 = be32();
  wire64 = be64();
}

export function sizes(): usize {
  return sizeOf(Mixed) * 1000000 + alignOf(Mixed) * 1000 + offsetOf(Mixed, "inner");
}

export function offsets(): usize {
  return (
    offsetOf(Mixed, "ring") * 1000000 + offsetOf(Mixed, "many") * 1000 + offsetOf(Mixed, "wire16")
  );
}

export function descBytes(buf: Uint8Array): u32 {
  const d = over(Desc, buf, 0);
  set(d, { addr: 0x1000n, len: 512, next: 7 });
  d.flags.next = true;
  d.flags.write = true;
  d.flags.level = 5;
  return d.flags.level + (d.isLast() ? 100 : 0) + d.next;
}

export function bitsMask(buf: Uint8Array): u32 {
  const d = over(Desc, buf, 0);
  d.flags.level = 13; // masked to 3 bits
  return d.flags.level;
}

export function makeLocal(): u32 {
  const d = make(Desc, { len: 5 });
  d.flags.write = true;
  return d.len + (d.flags.write ? 10 : 0) + (d.flags.next ? 100 : 0);
}

export function nestedWrites(buf: Uint8Array): usize {
  const m = over(Mixed, buf, 0);
  m.inner.len = 9;
  m.ring[2] = 77;
  m.many.at(1).len = 300;
  return m.inner.len + m.ring[2]! + m.many.at(1).len + m.many.length;
}

export function arrayOfBound(buf: Uint8Array, i: usize): u32 {
  return over(Mixed, buf, 0).many.at(i).len;
}

export function bigEndian(buf: Uint8Array): u16 {
  const m = over(Mixed, buf, 0);
  m.wire16 = 0x1234;
  m.wire32 = 0x89abcdef;
  m.wire64 = 0x0102030405060708n;
  return m.wire16;
}

export function bigEndianRead(buf: Uint8Array): u32 {
  return over(Mixed, buf, 0).wire32;
}

export function enumRead(buf: Uint8Array): u32 {
  const m = over(Mixed, buf, 0);
  return toU32(m.kind);
}

export function enumWrite(buf: Uint8Array): u32 {
  const m = over(Mixed, buf, 0);
  m.kind = Kind.B;
  m.b = -3;
  return toU32(m.kind) + buf[4]!;
}

export function enumOk(x: u32): u32 {
  const e = enumValue(Kind, x);
  if (e === null) return 99;
  return e === Kind.A ? 1 : 2;
}

export function misaligned(buf: Uint8Array): u32 {
  return over(Desc, buf, 4).len;
}

export function pastEnd(buf: Uint8Array): u32 {
  return over(Desc, buf, 8).len;
}

export function typedArrayMethods(buf: Uint8Array): u32 {
  const s = buf.subarray(2, 6);
  s.fill(7);
  s.subarray(1).fill(8, 1, 2);
  buf.set(s, 8);
  return s[0]! + s[2]! * 10 + toU32(s.length) * 100 + toU32(buf[10]!) * 1000;
}

export class Floats {
  a = f32();
  b = f64();
  c = i32();
  d = i64();
  e = i16();
  f = array(f64, 2);
  g = array(u32, 2);
}

export function floatFields(buf: Uint8Array): f64v {
  const v = over(Floats, buf, 0);
  v.a = 1.5;
  v.b = 2.25;
  v.c = -7;
  v.d = -9n;
  v.e = -3;
  v.f[1] = 0.5;
  return v.a + v.b + toF64(v.c) + toF64(v.e) + v.f[1]! + (v.d === -9n ? 100 : 0);
}
