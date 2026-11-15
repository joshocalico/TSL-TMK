// R9's benchmark: typed arrays made inside functions under `leak` and `manual` (SPEC 4.5, M5's R9 record). A small scratch
// array of a constant length in a hot function (a layout class's `array(…)` through the TSL route, on the stack in both
// routes), digits taken out of a number into one as number text does, and arrays of a length known only at run time (a
// tail, D69, in the per-call region through the TSL route, in the call arena through the direct route), sieved and summed;
// and an array of booleans (a JsArray of bytes through the TSL route) sieved the same way.
function digitSum(v: number): number {
  const d = new Int32Array(12);
  let k = 0;
  let x = v | 0;
  if (x < 0) x = -x;
  do {
    d[k] = x % 10;
    x = (x / 10) | 0;
    k++;
  } while (x > 0 && k < 12);
  let s = 0;
  for (let i = 0; i < k; i++) s = (s * 3 + d[i]!) | 0;
  return s;
}

function primes(n: number): number {
  const sieve = new Uint8Array(n);
  let count = 0;
  for (let i = 2; i < n; i++) {
    if (sieve[i] !== 0) continue;
    count++;
    for (let j = i * 2; j < n; j += i) sieve[j] = 1;
  }
  return count;
}

function window(n: number, w: number): number {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 7) % 13;
  let best = 0;
  for (let i = 0; i + w <= n; i++) {
    let s = 0;
    for (let j = 0; j < w; j++) s += a[i + j]!;
    if (s > best) best = s;
  }
  return best;
}

function flagSieve(n: number): number {
  const composite: boolean[] = [];
  for (let i = 0; i < n; i++) composite.push(false);
  let count = 0;
  for (let i = 2; i < n; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * 2; j < n; j += i) composite[j] = true;
  }
  return count;
}

export function typedWork(n: number): number {
  const m = n | 0;
  let t = 0;
  for (let i = 0; i < m; i++) t = (t + digitSum(i * 7919)) | 0;
  for (let r = 0; r < 8; r++) t = (t + primes(256 + r * 64)) | 0;
  for (let r = 0; r < 4; r++) t = (t + flagSieve(256 + r * 32)) | 0;
  return (t + window((m >> 6) + 16, 8)) | 0;
}
