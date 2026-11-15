// Returned objects under D36 (SPEC 4.5): a result in a long-lived allocation survives the arena's reset, which
// the harness does before every case. Anything a module keeps from its caller is placed in long-lived memory too.
type Rec = { a: number; list: number[]; sub: { b: boolean } | null };
let kept: Rec | null = null;

function fresh(a: number): Rec {
  return { a, list: [a, a + 1], sub: { b: a > 0 } };
}

export function make(a: number): Rec {
  return fresh(a);
}

export function makeAndKeep(a: number): Rec {
  kept = fresh(a);
  return kept;
}

export function readKept(): Rec | null {
  return kept;
}

export function mutateKept(v: number): number {
  if (kept === null) return -1;
  kept.list.push(v);
  kept.a = v;
  return kept.list.length;
}

export function keepArgument(r: Rec): number {
  kept = r;
  return r.list.length;
}

export function identity(r: Rec): Rec {
  return r;
}

export function bytesOut(n: number): Uint8Array {
  const out = new Uint8Array(n | 0);
  out.fill(7);
  return out;
}

export function subOf(x: Uint8Array): Uint8Array {
  return x.subarray(1, 3);
}

export function scratchThenScalar(n: number): number {
  // Stays in the call arena: nothing about it lives past this call.
  const tmp: { v: number }[] = [];
  for (let i = 0; i < (n | 0); i++) tmp.push({ v: i });
  let t = 0;
  for (const o of tmp) t += o.v;
  return t;
}

export function writeIntoArgument(o: { child: { v: number } | null }): number {
  o.child = { v: 3 };
  return o.child.v;
}
