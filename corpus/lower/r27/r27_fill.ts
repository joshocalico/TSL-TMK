// R27 (SPEC 3.5, D77): lowered arrays and maps filled where @tsl/jsrt's JsArray keeps its elements in a separated field's
// block (compiler/host/separate.ts): a map grown well past its first table while keys are deleted and overwritten partway
// through each move, an array filled from another while one of them grows or shrinks, through calls that write only
// blocks and calls that change a length. Every answer is V8's, through both routes, at every level.

/** A map grown to n, with every third key deleted and every fifth overwritten as it grows: the moves run between. */
export function growMoving(n: number): number {
  const m = new Map<number, number>();
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    m.set(i, i * 7);
    if (i % 3 === 2) m.delete(i - 1);
    if (i % 5 === 4) m.set(i - 2, -i);
  }
  for (const [k, v] of m) t = (t + k * 3 + v) | 0;
  return (t + m.size) | 0;
}

/** Keys of objects, grown past several tables, then each read back. */
export function objectKeysGrown(n: number): number {
  const keys: { id: number }[] = [];
  const m = new Map<{ id: number }, number>();
  for (let i = 0; i < (n | 0); i++) {
    const k = { id: i };
    keys.push(k);
    m.set(k, i * 2 + 1);
  }
  let t = 0;
  for (let i = 0; i < keys.length; i++) t = (t + (m.get(keys[i]!) ?? -1000)) | 0;
  return (t + m.size) | 0;
}

/** One array filled from another, the source read up to its own length as it's written elsewhere. */
export function copyInto(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i * 3 + 1);
  const b: number[] = [];
  for (let i = 0; i < a.length; i++) b.push(a[i]! + 1);
  let t = 0;
  for (let i = 0; i < b.length; i++) t = (t + b[i]!) | 0;
  return t;
}

let cut = 0;

/** Shortens an array, out of the way of the loop that calls it: its length is read again after. */
function shorten(a: number[], to: number): void {
  for (let k = 0; k < 3; k++) cut = (cut + k) | 0;
  if (cut > -1) a.length = to;
}

/** A fill that cuts its source partway: what's past the cut reads as missing, as JS has it. */
export function cutWhileCopying(n: number, at: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(i + 10);
  const b: number[] = [];
  const m = a.length;
  let missing = 0;
  for (let i = 0; i < m; i++) {
    if (i === (at | 0)) shorten(a, at | 0);
    const x = a[i];
    if (x === undefined) missing++;
    else b.push(x);
  }
  return b.length * 1000 + missing;
}

/** A source that grows as it's read: the loop reads the length again after each push. */
export function growWhileReading(n: number): number {
  const a: number[] = [1, 2, 3];
  let t = 0;
  for (let i = 0; i < a.length && i < (n | 0); i++) {
    t = (t + a[i]!) | 0;
    if (a.length < (n | 0)) a.push((a[i]! * 2) % 97);
  }
  return (t + a.length) | 0;
}
