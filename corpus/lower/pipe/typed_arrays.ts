// memory-pages: 64
// R9: typed arrays made in a function, printed as TSL makes them (SPEC 4.5, M5's R9 record). TSL has no `new Int32Array(n)`
// in a function (TSL1001): the array is a view of an object's storage, a layout class's `array(i32, 8)` for a constant
// length (on the stack where tslc's escape analysis says so) and a tail (D69) for any other, which tslc puts in the per-call
// region where no export call outlives it (compiler/host/region.ts). Each case reads what an earlier one kept after calls
// that churn far more than the 64 pages hold, so an array put in the region that a later call reads is overwritten by then.
class Holder {
  bytes = new Uint8Array(0);
  constructor(public tag: number) {}
}

let kept: Holder | null = null;

/** Constant lengths, on the stack: zeroed, written and summed. */
export function small(n: number): number {
  const a = new Int32Array(8);
  const b = new Uint8Array(16);
  const c = new Float64Array(3);
  let s = 0;
  for (let i = 0; i < 8; i++) a[i] = i * n;
  for (let i = 0; i < 16; i++) b[i] = i * 37 + n;
  c[1] = n / 4;
  for (let i = 0; i < 8; i++) s += a[i]!;
  for (let i = 0; i < 16; i++) s += b[i]!;
  return s + c[0]! + c[1]! + c[2]! + a.length + b.length + c.length;
}

/** A length known only at run time: a tail. A zero length too, and a fractional one. */
export function sized(n: number): number {
  const a = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < a.length; i++) a[i] = i + 0.5;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s + a.length;
}

/** A literal and a copy. */
export function literalCopy(k: number): number {
  const a = new Int16Array([1, -2, 300, k]);
  const b = new Int32Array(a);
  b[0] = 70000;
  return a[0]! + a[1]! + a[2]! + a[3]! + b[0]! + b[3]! + b.length;
}

function made(n: number): Uint16Array {
  const t = new Uint16Array(n);
  for (let i = 0; i < n; i++) t[i] = 65535 - i;
  return t;
}

/** Made in a helper and given back: on the heap or the region, never a dead frame. */
export function viaHelper(n: number): number {
  const a = made(n | 0);
  const b = made(3);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s + b[0]! + b[2]!;
}

/** Made in a loop, one kept across iterations: tslc moves it off the stack. */
export function inLoop(n: number): number {
  let keep = new Int32Array(4);
  let s = 0;
  for (let k = 0; k < (n | 0); k++) {
    const t = new Int32Array(4);
    t[0] = k;
    t[3] = k * 2;
    if (k === 2) keep = t;
    s += t[0]! + t[3]!;
  }
  return s * 1000 + keep[0]! + keep[3]!;
}

/** Bigger than the stack takes: a tail, in the region. */
export function big(n: number): number {
  const a = new Uint8Array(70000);
  a[69999] = n;
  a[0] = n + 1;
  return a[69999]! + a[0]! + a[35000]! + a.length;
}

/** Kept in an object kept in module state: the array outlives the call, so it's never in the region. */
export function keepBytes(n: number): number {
  const h = new Holder(n);
  const b = new Uint8Array(n | 0);
  for (let i = 0; i < b.length; i++) b[i] = i + 7;
  h.bytes = b;
  kept = h;
  return b.length;
}

export function readKept(): number {
  if (kept === null) return -1;
  let s = 0;
  for (let i = 0; i < kept.bytes.length; i++) s += kept.bytes[i]!;
  return s * 100 + kept.tag;
}

/** Arrays made and dropped, many more than 64 pages hold without the region giving them back. */
export function churn(rounds: number, size: number): number {
  let s = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const t = new Float64Array(size | 0);
    t[0] = r;
    t[t.length - 1] = r * 2;
    s += t[0]! + t[t.length - 1]!;
  }
  return s;
}

/** subarray, fill, set and slice on arrays made here. */
export function views(n: number): number {
  const a = new Int32Array(10).fill(n);
  const s = a.subarray(2, 5);
  s[0] = 99;
  a.set(new Int32Array([7, 8]), 8);
  const c = a.slice(1, 4);
  c[0] = -1;
  return a[2]! + a[8]! + a[9]! + s.length + c[0]! + c[1]! + a[1]! + c.length;
}

/** A constant length kept in module state: tslc moves its object off the stack, as nothing follows the pointer it keeps. */
export function keepSmall(n: number): number {
  const h = new Holder(n);
  const b = new Uint8Array(4);
  b[0] = n;
  b[3] = n + 1;
  h.bytes = b;
  kept = h;
  return b[0]! + b[3]!;
}

/** Made where an earlier call's arrays were: zero until written, whatever the memory held. */
export function fresh(n: number): number {
  const a = new Float64Array(n | 0);
  a[0] = 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}
