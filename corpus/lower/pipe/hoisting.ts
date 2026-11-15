// The TSL route (D62) on what the printer has to restructure: statement-expressions with loops in them (an inlined
// callback is a loop) in a condition, on the right of && and ||, in a branch of ?:, after an operand with an effect, in a
// for loop's step, and a `continue` in a loop printed as a block and a while. Order matters in every one: a counter
// records which parts ran, in which order.
let trace = 0;

function note(d: number): number {
  trace = (trace * 10 + d) % 1000000007;
  return d;
}

function sumTo(a: number[], n: number): number {
  return a.filter((x) => x < n).reduce((s, x) => s + x, 0);
}

export function inCondition(n: number): number {
  trace = 0;
  const a = [1, 2, 3, 4, 5, 6];
  let i = 0;
  let out = 0;
  while (a.some((x) => x > i + note(1))) {
    i++;
    out += a.map((x) => x * i).find((x) => x > 7) ?? -1;
    if (i > (n | 0)) break;
  }
  return out * 1000 + (trace % 1000);
}

export function shortCircuit(k: number): number {
  trace = 0;
  const a = [3, 1, 4, 1, 5, 9, 2, 6];
  const x = (k | 0) > 2 && a.findIndex((v) => v === (k | 0) + note(2)) >= 0;
  const y = (k | 0) < 2 || a.filter((v) => v > (k | 0) + note(3)).length > 2;
  const z = (k | 0) % 2 === 0 ? a.map((v) => v + note(4)).length : sumTo(a, k | 0);
  return (x ? 1 : 0) + (y ? 10 : 0) + z * 100 + trace * 100000;
}

export function orderOfOperands(k: number): number {
  trace = 0;
  const a = [5, 4, 3, 2, 1];
  const r = note(1) * 100 + a.filter((v) => v > (k | 0) + note(2)).length * 10 + note(3);
  return r * 10000 + (trace % 10000);
}

export function loopWithContinue(n: number): number {
  let s = 0;
  const a = [2, 7, 1, 8, 2, 8];
  for (let i = 0, j = 10; i < (n | 0); i++, j += a.filter((v) => v > i).length) {
    if (i % 3 === 0) continue;
    s += i * j;
  }
  return s;
}

export function doWhileEffect(n: number): number {
  const a = [1, 2, 3];
  let i = 0;
  let s = 0;
  do {
    i++;
    if (i % 2 === 0) continue;
    s += i;
  } while (a.map((v) => v * i).some((v) => v < (n | 0)));
  return s * 100 + i;
}
