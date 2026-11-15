// memory-pages: none
// A native program with nothing registered: the default allocator has no pages, so it's trap 14, or false from a try form. The
// host's default has no such state (SPEC 3.5, D43), and that's divergence 4. This image registers nothing, which no environment
// in 3.5's table does: it's here to show what happens if one forgets.
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";

export function viaTry(): u32 {
  using v = new Vec(u32);
  return v.tryPush(1) ? 1 : 0;
}

export function viaTrap(): u32 {
  const v = new Vec(u32);
  v.push(1);
  return 1;
}
