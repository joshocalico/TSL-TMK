// A word count, with Str keys by content, and results sorted by count and then by word (SPEC 3.5).
import { lit, toU32, u32, type bool, type usize } from "@tsl/core";
import { ExactMap, ref, Str, StrBuilder, Vec } from "@tsl/std";

const TEXT = lit(
  "the quick brown fox jumps over the lazy dog and the dog barks at the fox while the quick fox runs",
);
const ACCENTED = lit("naïve café naïve 日本語 café 日本語 日本語");

class Count {
  constructor(
    public word: Str,
    public n: u32,
  ) {}
}

function report(text: Uint8Array): Str {
  const whole = Str.of(text);
  using parts = new Vec(ref<Str>());
  whole.split(32, parts);
  using counts = new ExactMap(ref<Str>(), u32);
  parts.forEach((w) => {
    counts.set(w, counts.getOr(w, 0) + 1);
  });
  using order = new Vec(ref<Str>());
  counts.forEach((w) => {
    order.push(w);
  });
  order.sortInPlace((a, b) => {
    const na = counts.get(a);
    const nb = counts.get(b);
    if (na !== nb) return na > nb ? -1 : 1;
    return a.compare(b);
  });
  using out = new StrBuilder();
  order.forEach((w) => {
    out.append(w);
    out.appendByte(61);
    out.appendU32(counts.get(w));
    out.appendByte(32);
  });
  const text2 = out.finish();
  parts.forEach((w) => {
    w.free();
  });
  whole.free();
  return text2;
}

function digest(s: Str): u32 {
  let h: u32 = 0x811c9dc5;
  s.withBytes((a) => {
    for (const x of a) h = Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
  });
  return h;
}

export function plain(): u32 {
  const r = report(TEXT);
  const d = digest(r);
  r.free();
  return d;
}

export function bytesOfPlain(): usize {
  const r = report(TEXT);
  const n = r.length;
  r.free();
  return n;
}

export function firstWordIsThe(): bool {
  const r = report(TEXT);
  const the = Str.of(lit("the=5 "));
  const at = r.indexOf(the, 0);
  r.free();
  the.free();
  return at === 0;
}

export function accented(): u32 {
  const r = report(ACCENTED);
  const d = digest(r);
  r.free();
  return d;
}

export function distinctWords(): u32 {
  const whole = Str.of(TEXT);
  using parts = new Vec(ref<Str>());
  whole.split(32, parts);
  using counts = new ExactMap(ref<Str>(), u32);
  for (let i: usize = 0; i < parts.length; i++) counts.set(parts.get(i), 1);
  const n = toU32(counts.size);
  parts.forEach((w) => {
    w.free();
  });
  whole.free();
  return n;
}

// Freed and made again a thousand times: this goes on running in a test image's memory, because everything comes back.
export function noLeak(rounds: u32): u32 {
  let last: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const r = report(TEXT);
    last = digest(r);
    r.free();
  }
  return last;
}

export function countClassIsUsed(): u32 {
  const w = Str.of(lit("x"));
  const c = new Count(w, 2);
  const n = c.n + toU32(c.word.length);
  w.free();
  return n;
}
