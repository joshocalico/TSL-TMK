// A string builder, and everything a Str does (SPEC 3.5).
import { lit, toU32, u32, wrapU8, type i32, type bool, type usize } from "@tsl/core";
import { ref, Str, StrBuilder, Vec } from "@tsl/std";

function digest(s: Str): u32 {
  let h: u32 = 0x811c9dc5;
  s.withBytes((a) => {
    for (const x of a) h = Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
  });
  return (h + toU32(s.length)) >>> 0;
}

export function numbers(n: u32): u32 {
  using b = new StrBuilder();
  for (let i: u32 = 0; i < n; i++) {
    b.appendU32(i * 37);
    b.appendByte(44);
    b.appendI32(1000 - toI32Of(i) * 3);
    b.appendBytes(lit(";"));
  }
  const s = b.finish();
  const d = digest(s);
  s.free();
  return d;
}

function toI32Of(x: u32): i32 {
  return x | 0;
}

export function edgeNumbers(): u32 {
  using b = new StrBuilder();
  b.appendU32(0);
  b.appendByte(32);
  b.appendU32(4294967295);
  b.appendByte(32);
  b.appendI32(-2147483648);
  b.appendByte(32);
  b.appendI32(2147483647);
  const s = b.finish();
  const want = Str.of(lit("0 4294967295 -2147483648 2147483647"));
  const ok = s.equals(want);
  s.free();
  want.free();
  return ok ? 1 : 0;
}

export function builderGoesOn(): u32 {
  using b = new StrBuilder();
  b.appendBytes(lit("ab"));
  const one = b.finish();
  b.appendBytes(lit("cd"));
  const two = b.finish();
  const r = toU32(one.length) * 10 + toU32(two.length);
  one.free();
  two.free();
  return r;
}

export function emptyBuilder(): usize {
  using b = new StrBuilder();
  const s = b.finish();
  const n = s.length;
  s.free();
  return n;
}

export function methods(): u32 {
  const s = Str.of(lit("hello, world"));
  const w = Str.of(lit("world"));
  const e = Str.of(lit(""));
  const sub = s.slice(7, 12);
  const both = s.concat(w);
  let r: u32 = 0;
  if (sub.equals(w)) r += 1;
  if (s.indexOf(w, 0) === 7) r += 2;
  if (s.indexOf(w, 8) === -1) r += 4;
  if (s.indexOf(e, 5) === 5) r += 8;
  if (s.indexOf(e, 13) === -1) r += 16;
  if (both.length === 17) r += 32;
  if (both.at(16) === 100) r += 64;
  if (w.compare(s) > 0) r += 128;
  if (s.compare(w) < 0) r += 256;
  if (s.compare(s) === 0) r += 512;
  if (e.compare(w) < 0) r += 1024;
  if (s.hashKey() !== w.hashKey()) r += 2048;
  if (sub.hashKey() === w.hashKey()) r += 4096;
  s.free();
  w.free();
  e.free();
  sub.free();
  both.free();
  return r;
}

export function sliceTooFar(): u32 {
  const s = Str.of(lit("abc"));
  const t = s.slice(1, 4);
  return toU32(t.length);
}

export function sliceBackwards(): u32 {
  const s = Str.of(lit("abc"));
  const t = s.slice(2, 1);
  return toU32(t.length);
}

export function atTooFar(): u32 {
  return Str.of(lit("abc")).at(3);
}

export function splitEmptyRuns(): u32 {
  const s = Str.of(lit(",a,,b,"));
  using v = new Vec(ref<Str>());
  s.split(44, v);
  let lengths: u32 = 0;
  v.forEach((p) => {
    lengths = lengths * 10 + toU32(p.length);
  });
  return toU32(v.length) * 100000 + lengths;
}

export function bigBuilder(n: u32): u32 {
  using b = new StrBuilder();
  for (let i: u32 = 0; i < n; i++) b.appendByte(wrapU8(97 + (i % 26)));
  const s = b.finish();
  const d = digest(s);
  s.free();
  return d;
}

export function equalHashes(): bool {
  const a = Str.of(lit("the same text, past one word"));
  const b = Str.of(lit("the same text, ")).concat(Str.of(lit("past one word")));
  return a.equals(b) && a.hashKey() === b.hashKey();
}
