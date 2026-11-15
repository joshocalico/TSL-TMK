// memory-pages: 12
// @tsl/jsrt's JsString in a small heap (D67, pipe-h): its units come from chunks that start at a page and double, so a
// program with 12 pages and a few strings has room for them and for its objects. A first chunk of 16 pages wouldn't fit.
import { lit, toUsize, type i32 } from "@tsl/core";
import { JsFlat, type JsString } from "@tsl/jsrt";

/** n strings of a few units each, joined: the total length and the last unit. */
export function fewStrings(n: i32): i32 {
  let s: JsString = JsFlat.empty();
  const part = JsFlat.of(lit("abc"));
  for (let i: i32 = 0; i < n; i++) s = s.concat(part.sub(0, 1 + (i % 3)));
  return s.len() * 1000 + (s.len() > 0 ? s.unit(toUsize(s.len() - 1)) : 0);
}
