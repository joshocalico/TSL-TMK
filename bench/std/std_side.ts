// `tmk bench std`: @tsl/std, natively and on V8, against what's in alloc_side.ts, lowered.ts and bench/strmap (SPEC 8.4, D43).
import { toU32, u32, type usize } from "@tsl/core";
import { ExactMap, ref, Set, Str, StrBuilder, Vec } from "@tsl/std";

export function vecPushRead(n: u32): u32 {
  using v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  let s: u32 = 0;
  for (let i: u32 = 0; i < n; i++) s = (s + v.get(i)) >>> 0;
  return (s + toU32(v.length)) >>> 0;
}

function lcg(x: u32): u32 {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}

export function mapMix(n: u32): u32 {
  using m = new ExactMap(u32, u32);
  const range: u32 = (n >>> 1) + 1;
  let x: u32 = 1;
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    x = lcg(x);
    const k: u32 = x % range;
    const op: u32 = (x >>> 27) & 3;
    if (op <= 1) m.set(k, i);
    else if (op === 2) h = (h + m.getOr(k, 0)) >>> 0;
    else m.delete(k);
  }
  return (h + toU32(m.size)) >>> 0;
}

export function setDedupe(n: u32): u32 {
  using s = new Set(u32);
  for (let i: u32 = 0; i < n; i++) s.add((i * 2) % 1000);
  return toU32(s.size);
}

export function wordCount(n: u32): u32 {
  using vocab = new Vec(ref<Str>());
  for (let i: u32 = 0; i < 500; i++) {
    using w = new StrBuilder();
    w.appendByte(119);
    w.appendU32(i * 7);
    w.appendByte(120);
    vocab.push(w.finish());
  }
  using text = new StrBuilder();
  let x: u32 = 1;
  for (let i: u32 = 0; i < n; i++) {
    x = lcg(x);
    text.append(vocab.get(x % 500));
    text.appendByte(32);
  }
  const whole = text.finish();
  using m = new ExactMap(ref<Str>(), u32);
  const len: usize = whole.length;
  let start: usize = 0;
  whole.withBytes((a) => {
    for (let i: usize = 0; i < len; i++) {
      if (a[i]! === 32) {
        const w = whole.slice(start, i);
        if (m.has(w)) {
          m.set(w, m.get(w) + 1);
          w.free();
        } else m.set(w, 1);
        start = i + 1;
      }
    }
  });
  let t: u32 = 0;
  m.forEach((k, c) => {
    t = (t + (Math.imul(c, c) >>> 0)) >>> 0;
    k.free();
  });
  vocab.forEach((w) => {
    w.free();
  });
  whole.free();
  return t;
}

export function sortWork(n: u32): u32 {
  using v = new Vec(u32);
  let x: u32 = 1;
  for (let i: u32 = 0; i < n; i++) {
    x = lcg(x);
    v.push(x);
  }
  v.sortInPlace((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return v.get(n >>> 1);
}
