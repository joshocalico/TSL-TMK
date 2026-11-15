// for...of over an array whose elements or whose holder are replaced in the loop, and an array growing during iteration.
class P {
  constructor(public x: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
export function replaceCurrent(n: number): number {
  const a = [new P(1), new P(2), new P(3)];
  let t = n | 0;
  let i = 0;
  for (const p of a) {
    a[i] = new P(100);
    churn();
    t += p.x;
    i++;
  }
  return t + a[0]!.x;
}
export function replaceLater(n: number): number {
  const a = [new P(1), new P(2), new P(3)];
  let t = n | 0;
  let i = 0;
  for (const p of a) {
    if (i + 1 < a.length) a[i + 1] = new P(10 * (i + 1));
    churn();
    t += p.x;
    i++;
  }
  return t;
}
let holder: P[] = [];
export function replaceHolderGlobal(n: number): number {
  holder = [new P(1), new P(2), new P(3)];
  let t = n | 0;
  for (const p of holder) {
    holder = [new P(50)];
    churn();
    t += p.x;
  }
  return t + holder.length;
}
export function replaceHolderLocal(n: number): number {
  let a = [new P(4), new P(5), new P(6)];
  let t = n | 0;
  for (const p of a) {
    a = [];
    churn();
    t += p.x;
  }
  return t + a.length;
}
export function growing(n: number): number {
  const a = [new P(1)];
  let t = 0;
  for (const p of a) {
    t += p.x;
    if (a.length < (n | 0)) a.push(new P(p.x + 1));
  }
  return t;
}
export function shrinking(n: number): number {
  const a = [new P(1), new P(2), new P(3), new P(4)];
  let t = n | 0;
  for (const p of a) {
    a.pop();
    churn();
    t += p.x;
  }
  return t;
}
export function breakHolding(n: number): number {
  const a = [new P(1), new P(2), new P(3)];
  let t = n | 0;
  for (const p of a) {
    if (p.x === 2) {
      a.length = 0;
      churn();
      t += p.x;
      break;
    }
    t += p.x;
  }
  return t + a.length;
}
export function forEachClears(n: number): number {
  const a = [new P(1), new P(2)];
  let t = n | 0;
  a.forEach((p) => {
    a[0] = new P(9);
    churn();
    t += p.x;
  });
  return t;
}
