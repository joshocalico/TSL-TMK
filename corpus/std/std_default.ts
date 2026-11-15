// memory-pages: 64
// No allocator named: @tsl/std's heap is over the registered page source, which a test image sets to a range of its RAM, here
// 64 pages (SPEC 3.5, D43).
import { toU32, u32 } from "@tsl/core";
import { Vec } from "@tsl/std";

export function fits(n: u32): u32 {
  using v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  return v.get(n - 1) + toU32(v.length);
}

export function pastTheTestImagesLimit(n: u32): u32 {
  using v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  return toU32(v.length);
}

export function pastItWithTry(n: u32): u32 {
  using v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) if (!v.tryPush(i)) return 1;
  return 2;
}
