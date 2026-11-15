// The word report, against @tsl/std. Beside corpus/std/ergo_alloc.ts, which does the same (SPEC 3.5, D43).
import { lit, toU32, u32, type bool, type u64 } from "@tsl/core";
import { ExactMap, ref, Str, StrBuilder, Vec } from "@tsl/std";

const TEXT = lit("the quick brown fox jumps over the lazy dog and the dog barks at the fox");

export function report(): u32 {
  const text = Str.of(TEXT);
  using parts = new Vec(ref<Str>());
  text.split(32, parts);
  using counts = new ExactMap(ref<Str>(), u32);
  parts.forEach((w) => {
    counts.set(w, counts.getOr(w, 0) + 1);
  });
  using list = new Vec(ref<Str>());
  counts.forEach((w) => {
    list.push(w);
  });
  list.sortInPlace((a, b) => {
    const na = counts.get(a);
    const nb = counts.get(b);
    if (na !== nb) return na > nb ? -1 : 1;
    return a.compare(b);
  });
  using out = new StrBuilder();
  list.forEach((w) => {
    out.append(w);
    out.appendByte(61);
    out.appendU32(counts.get(w));
    out.appendByte(32);
  });
  const done = out.finish();
  let h: u32 = 0x811c9dc5;
  done.withBytes((a) => {
    for (const x of a) h = Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
  });
  const n = toU32(list.length);
  parts.forEach((w) => {
    w.free();
  });
  text.free();
  done.free();
  return (h + n) >>> 0;
}

export function nothingToNameOrPass(n: u64): bool {
  return n === 0n;
}
