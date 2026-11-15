// The spec's @tsl/std blocks, run as written (SPEC 3.5, D43). The package is the same bytes: tools/spec-extract.ts checks.
import { lit, toU32, u32 } from "@tsl/core";
import { ExactMap, Map, Set } from "./ex-std-map.ts";
import { Slab } from "./ex-std-slab.ts";
import { Str, StrBuilder } from "./ex-std-str.ts";
import { Vec } from "./ex-std-vec.ts";

class Item {
  constructor(public id: u32) {}
}

const items = new Slab<Item>();

export function everything(): u32 {
  using v = new Vec(u32);
  v.push(1);
  using m = new ExactMap(u32, u32);
  m.set(1, 2);
  using j = new Map(u32, u32);
  j.set(5, 6);
  using s = new Set(u32);
  s.add(3);
  const it = items.add(new Item(4));
  using b = new StrBuilder();
  b.appendU32(567);
  const t = b.finish();
  const r =
    v.get(0) +
    m.get(1) +
    (j.get(5) ?? 0) +
    (j.get(7) ?? 1) +
    toU32(s.size) +
    it.id +
    toU32(t.length) +
    Str.of(lit("ab")).at(1);
  t.free();
  return r;
}
