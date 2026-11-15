// The word report, against @tsl/alloc: a heap passed around, exhaustion handled at each step, a Vec<u8> for a string, and a table
// and a sort by hand. Beside corpus/std/ergo_std.ts, which does the same (SPEC 3.5, D43).
import { Heap, Slab, Vec, ref } from "@tsl/alloc";
import { idiv, lit, toU32, u32, u8, wrapU8, type bool, type u64, type usize } from "@tsl/core";
import { sourcePagesOf } from "./ergo_pages.ts";

const heap = new Heap(sourcePagesOf);

class Word {
  bytes: Vec<u8> = new Vec(u8, heap);
  count: u32 = 0;
}

const words = new Slab<Word>(heap, 32);
const TEXT = lit("the quick brown fox jumps over the lazy dog and the dog barks at the fox");

function sameWord(w: Word, text: Uint8Array, start: usize, end: usize): bool {
  if (w.bytes.length !== end - start) return false;
  for (let i = start; i < end; i++) {
    if (w.bytes.get(i - start) !== text[i]!) return false;
  }
  return true;
}

function before(a: Word, b: Word): bool {
  if (a.count !== b.count) return a.count > b.count;
  const n = a.bytes.length < b.bytes.length ? a.bytes.length : b.bytes.length;
  for (let i: usize = 0; i < n; i++) {
    if (a.bytes.get(i) !== b.bytes.get(i)) return a.bytes.get(i) < b.bytes.get(i);
  }
  return a.bytes.length < b.bytes.length;
}

export function report(): u32 {
  const list = new Vec(ref<Word>(), heap);
  let start: usize = 0;
  for (let i: usize = 0; i <= TEXT.length; i++) {
    if (i < TEXT.length && TEXT[i]! !== 32) continue;
    let found: Word | null = null;
    for (let j: usize = 0; j < list.length; j++) {
      if (sameWord(list.get(j), TEXT, start, i)) found = list.get(j);
    }
    if (found === null) {
      found = words.add(new Word());
      if (found === null || !list.push(found)) return 0;
      for (let at = start; at < i; at++) {
        if (!found.bytes.push(TEXT[at]!)) return 0;
      }
    }
    found.count++;
    start = i + 1;
  }
  // Insertion sort: a Vec has no sort.
  for (let i: usize = 1; i < list.length; i++) {
    const w = list.get(i);
    let j = i;
    while (j > 0 && before(w, list.get(j - 1))) {
      list.set(j, list.get(j - 1));
      j--;
    }
    list.set(j, w);
  }
  const out = new Vec(u8, heap);
  let h: u32 = 0x811c9dc5;
  for (let i: usize = 0; i < list.length; i++) {
    const w = list.get(i);
    for (let at: usize = 0; at < w.bytes.length; at++) {
      if (!out.push(w.bytes.get(at))) return 0;
    }
    if (!out.push(61)) return 0;
    if (!pushDecimal(out, w.count)) return 0;
    if (!out.push(32)) return 0;
  }
  for (let i: usize = 0; i < out.length; i++) {
    h = Math.imul((h ^ out.get(i)) >>> 0, 0x01000193) >>> 0;
  }
  const n = toU32(list.length);
  for (let i: usize = 0; i < list.length; i++) {
    const w = list.get(i);
    w.bytes.free();
    words.remove(w);
  }
  list.free();
  out.free();
  return (h + n) >>> 0;
}

// A number has no way into a Vec<u8> but by hand either.
function pushDecimal(out: Vec<u8>, x: u32): bool {
  if (x >= 10 && !pushDecimal(out, idiv(x, 10))) return false;
  return out.push(wrapU8(48 + (x % 10)));
}

export function fromHeap(n: u64): bool {
  return n === 0n && heap.allocBytes(16) !== 0n;
}
