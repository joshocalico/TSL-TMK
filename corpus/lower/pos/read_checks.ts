// R6: a vector read's checks printed once each (D66, M5's R6 record): `xs[i]!` is the lowering's bounds check and the
// source's `!`, a null check, which the TSL route prints as JsArray's `get` (its own bounds check, trap 2) and TSL's checked
// `!` (trap 6). Each read here is in and out of range, and of a hole, so a printing that drops either check, or folds one
// into a read that doesn't make it, gives another result or trap than the direct route's. Each trap is the lowering's, pinned
// (`lowered_trap`), where V8 reads `undefined`.
class P {
  constructor(public v: number) {}
}

function made(n: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < (n | 0); i++) out.push(new P(i * 10));
  return out;
}

export function numAt(n: number, i: number): number {
  const xs: number[] = [];
  for (let k = 0; k < (n | 0); k++) xs.push(k * 2);
  return xs[i | 0]!;
}

export function objAt(n: number, i: number): number {
  return made(n)[i | 0]!.v;
}

export function holeAt(n: number, i: number): number {
  const xs: (P | null)[] = [];
  for (let k = 0; k < (n | 0); k++) xs.push(k % 3 === 0 ? null : new P(k));
  const p = xs[i | 0]!;
  return p === xs[1] ? -1 : 7;
}

export function sumAt(n: number, i: number, j: number): number {
  const xs = made(n);
  return xs[i | 0]!.v + xs[j | 0]!.v;
}
