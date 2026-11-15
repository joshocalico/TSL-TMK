// Function values in raw memory (R1b): a top-level function written through `ptrAt(ref<F>())` and read back is the
// same function, natively a code pointer (`store.ptr`/`load.ptr`). Writing one used to make invalid TIR (an i64 store of
// a pointer), which the TIR verifier rejected. What's checked here is that the right one is called, from a table of
// them in raw memory, through a `Ptr`'s `add`, and through a pointer kept in a class.
import { toU64, u64, type usize } from "@tsl/core";
import { ptrAt, ref, sourcePages, type Ptr } from "@tsl/unsafe";

type Op = (n: usize) => usize;

function twice(n: usize): usize {
  return n * 2;
}
function thrice(n: usize): usize {
  return n * 3;
}
function plusOne(n: usize): usize {
  return n + 1;
}

// SAFETY: a fresh page from the registered source, and nothing else uses it.
function page(): u64 {
  return sourcePages(1);
}

/** One function written and read back, chosen at run time. */
// SAFETY: at is a fresh page, big enough for one function value.
export function one(k: usize, x: usize): usize {
  const at = page();
  ptrAt(ref<Op>(), at).write(k === 0 ? twice : thrice);
  const f = ptrAt(ref<Op>(), at).read();
  return f(x);
}

/** A table of three, by index, overwritten in place, then applied in turn. */
// SAFETY: at is a fresh page, big enough for three function values.
export function table(x: usize): usize {
  const at = page();
  const t = ptrAt(ref<Op>(), at);
  t.write(twice);
  t.add(1).write(thrice);
  t.add(2).write(plusOne);
  t.add(1).write(plusOne); // the middle one replaced
  let v = x;
  for (let i: usize = 0; i < 3; i++) {
    const f = t.add(i).read();
    v = f(v);
  }
  return v;
}

class Holder {
  constructor(public slot: Ptr<Op>) {}
}

/** A function value next to scalars: the words around it are left as they were. */
// SAFETY: at is a fresh page; the three words written are inside it.
export function between(x: usize): u64 {
  const at = page();
  ptrAt(u64, at).write(0x1111n);
  ptrAt(u64, at + toU64(16)).write(0x3333n);
  const h = new Holder(ptrAt(ref<Op>(), at + toU64(8)));
  h.slot.write(thrice);
  const f = h.slot.read();
  return ptrAt(u64, at).read() + ptrAt(u64, at + toU64(16)).read() + toU64(f(x));
}
