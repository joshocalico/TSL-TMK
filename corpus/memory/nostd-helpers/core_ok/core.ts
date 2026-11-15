// A package set up as kernel-core is: noStd and strict, over @tsl/alloc with a page source of its own (5.6, D38).
import { Heap, Vec } from "@tsl/alloc";
import { u32, type u64, type usize } from "@tsl/core";

function frames(_n: usize): u64 {
  return 0n;
}

const heap = new Heap(frames);

export function pushOne(): u32 {
  using v = new Vec(u32, heap);
  return v.push(1) ? 1 : 0;
}
