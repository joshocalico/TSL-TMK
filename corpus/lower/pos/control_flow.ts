// Control flow: labels, switch with fallthrough and non-integer cases, comma, conditional, do-while.
export function labelled(n: number): number {
  let c = 0;
  outer: for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (j === (n | 0)) continue outer;
      if (i === 3) break outer;
      c++;
    }
  }
  return c;
}
export function fallthrough(x: number): number {
  let r = 0;
  switch (x | 0) {
    case 1:
      r += 1;
    case 2:
      r += 2;
      break;
    default:
      r = 9;
    case 3:
      r += 3;
  }
  return r;
}
export function floatSwitch(x: number): number {
  switch (x) {
    case 0.5:
      return 1;
    case 2:
      return 2;
    default:
      return 3;
  }
}
export function commas(a: number): number {
  let i = 0;
  let j = 0;
  for (i = 0, j = 10; i < j; i++, j--);
  return (a++, i * j);
}
export function doWhile(n: number): number {
  let i = 0;
  do {
    i += 2;
  } while (i < (n | 0));
  return i;
}
export function logical(a: number, b: number): number {
  const x = a || b;
  const y = a && b;
  return x * 10 + y;
}
export function postfix(a: Int32Array): number[] {
  let i = 0;
  const p = a[i++]!;
  const q = a[++i]!;
  let k = 5;
  const old = k--;
  return [p, q, i, old, k];
}
