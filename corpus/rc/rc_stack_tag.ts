// R18: `@tsl.stack` means something only in a package `tmk lower` printed in `rc` (a lowered package's tsl.json), where the
// printing tags a class the lowering keeps on the stack. In a hand-written `rc` package the tag means nothing: the class is
// counted as every class is, so its objects can outlive their frames, be kept in module state and be held by another.
import { type u32 } from "@tsl/core";

/** @tsl.stack */
class P {
  constructor(public v: u32) {}
}

class Holder {
  p: P | null = null;
}

let kept: P | null = null;

function make(v: u32): P {
  return new P(v);
}

/** Objects of the tagged class returned, kept in module state and held by another, read after the calls that made them. */
export function outlive(v: u32): u32 {
  const h = new Holder();
  h.p = make(v);
  kept = make(v + 1);
  const r = h.p.v * 10 + kept.v;
  kept = null;
  h.p = null;
  return r;
}
