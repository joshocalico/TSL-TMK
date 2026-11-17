// memory-pages: 256
// @tsl/jsrt's JsString written by hand in a `leak` package (D67): D42's representation, which lowered programs' strings
// are printed as, a flat class and a view class behind a dispatch interface (D70, pipe-split). A substring shares its owner's units only when it's at least 32 units and a quarter of what it keeps
// alive, concatenation appends in place only at its buffer's tail, `for...of` steps over a surrogate pair as one, and a
// literal's UTF-8 is its UTF-16. The expected values are JS's, or D42's where JS says nothing (sharing).
import { lit, toI32, toUsize, type i32, type u32 } from "@tsl/core";
import { JsArray, JsFlat, jsEq, type JsString } from "@tsl/jsrt";
import { ref } from "@tsl/std";

function filled(n: u32): JsString {
  const s = JsFlat.zeroed(toI32(n));
  for (let i: u32 = 0; i < n; i++) s.put(toUsize(i), 97 + toI32(i % 26));
  return s;
}

/** 1 where `s.slice(1, 1 + n)` of a flat string of `len` shares its units, 0 where it copies. */
export function shares(len: u32, n: u32): i32 {
  return filled(len).sub(1, toI32(n)).isView() ? 1 : 0;
}

/** A substring of a substring: the bound is against the first one's owner, all of it, not the view. */
export function sharesInView(len: u32, n1: u32, n2: u32): i32 {
  const v = filled(len).sub(0, toI32(n1));
  const w = v.sub(2, toI32(n2));
  return (v.isView() ? 10 : 0) + (w.isView() ? 1 : 0);
}

/** A substring reads its owner's units at its own place, whichever way it's made. */
export function subUnits(len: u32, at: i32, n: i32): i32 {
  const s = filled(len);
  const v = s.sub(at, n);
  let bad: i32 = 0;
  for (let i: i32 = 0; i < n; i++) if (v.unit(toUsize(i)) !== s.unit(toUsize(at + i))) bad++;
  return bad * 1000 + v.len();
}

/**
 * A substring of a substring that shares (pipe-split): it reads the first owner's units from the first view's start plus
 * its own, which stay inside the owner. Gives how many units read wrong, then 100 if it's a view and 10 if the first is.
 */
export function viewOfView(len: u32, at1: i32, n1: i32, at2: i32, n2: i32): i32 {
  const s = filled(len);
  const v = s.sub(at1, n1);
  const w = v.sub(at2, n2);
  let bad: i32 = 0;
  for (let i: i32 = 0; i < n2; i++)
    if (w.unit(toUsize(i)) !== s.unit(toUsize(at1 + at2 + i))) bad++;
  return bad * 1000 + (w.isView() ? 100 : 0) + (v.isView() ? 10 : 0);
}

/** `x = base + "X"; y = base + "Y"`: the second can't append where the first did. Gives x's, y's and base's last units. */
export function branches(): i32 {
  let base: JsString = JsFlat.empty();
  const ab = JsFlat.of(lit("ab"));
  for (let i: i32 = 0; i < 50; i++) base = base.concat(ab);
  const x = base.concat(JsFlat.of(lit("X")));
  const y = base.concat(JsFlat.of(lit("Y")));
  const z = x.concat(JsFlat.of(lit("Z")));
  const last = (s: JsString): i32 => s.unit(toUsize(s.len() - 1));
  return (
    last(x) * 1000000 + last(y) * 1000 + last(z) + (base.len() === 100 && x.len() === 101 ? 0 : 1)
  );
}

/** How many steps `for...of` takes over these units, and the length of each step, as digits. */
export function steps(which: i32): i32 {
  let s = JsFlat.of(lit("a😀b"));
  if (which === 1) s = JsFlat.of(lit("😀😀é"));
  if (which === 2) {
    s = JsFlat.zeroed(5);
    s.put(0, 0xd83d);
    s.put(1, 0xd83d);
    s.put(2, 0xde00);
    s.put(3, 0xde00);
    s.put(4, 0x78);
  }
  let out: i32 = 0;
  let i: i32 = 0;
  while (i < s.len()) {
    const n = s.cpLen(i);
    out = out * 10 + n;
    i += n;
  }
  return out;
}

/** A literal's units, from its UTF-8: "é😀" is 0xe9, 0xd83d, 0xde00. */
export function literal(i: u32): i32 {
  const s = JsFlat.of(lit("é😀"));
  return i < 3 ? s.unit(toUsize(i)) : s.len();
}

/** Equality and order by code unit. */
export function order(): i32 {
  const a = JsFlat.of(lit("é"));
  const b = JsFlat.of(lit("😀"));
  const c = filled(40).sub(0, 40);
  const d = filled(40);
  return (jsEq(c, d) ? 100 : 0) + (a.compare(b) < 0 ? 10 : 0) + (jsEq(null, null) ? 1 : 0);
}

/**
 * k strings made and kept, of lengths from 1 to 200 units, each with units of its own: their units come from chunks that
 * start at a page and double (D67), so this crosses every size a chunk takes. Gives how many strings read wrong after.
 */
export function chunks(k: u32): i32 {
  const kept = new JsArray(ref<JsString | null>(), 0, false, true);
  for (let i: u32 = 0; i < k; i++) {
    const n = toI32((i * 37) % 200) + 1;
    const s = JsFlat.zeroed(n);
    for (let j: i32 = 0; j < n; j++) s.put(toUsize(j), (Math.imul(toI32(i), 7) + j) & 0x7fff);
    kept.push(s);
  }
  let bad: i32 = 0;
  for (let i: u32 = 0; i < k; i++) {
    const s = kept.get(toUsize(i))!;
    const n = toI32((i * 37) % 200) + 1;
    let ok = s.len() === n;
    for (let j: i32 = 0; ok && j < n; j++)
      ok = s.unit(toUsize(j)) === ((Math.imul(toI32(i), 7) + j) & 0x7fff);
    if (!ok) bad++;
  }
  return bad;
}
