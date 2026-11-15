// The Vec row of `tmk bench std`, against @tsl/alloc: the one container it has that @tsl/std's is written over (SPEC 8.4).
import { Heap, Vec } from "@tsl/alloc";
import { toU32, u32, type u64, type usize } from "@tsl/core";
import { sourcePages } from "@tsl/unsafe";

function pages(n: usize): u64 {
  // SAFETY: the source the test image registers, as @tsl/std's default asks.
  return sourcePages(n);
}

const heap = new Heap(pages);

export function vecPushRead(n: u32): u32 {
  const v = new Vec(u32, heap);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  let s: u32 = 0;
  for (let i: u32 = 0; i < n; i++) s = (s + v.get(i)) >>> 0;
  const r = (s + toU32(v.length)) >>> 0;
  v.free();
  return r;
}
