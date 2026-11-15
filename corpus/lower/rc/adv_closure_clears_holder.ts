// A stored closure clears or replaces its own holder during its own call, so its environment could die under it.
type F = () => number;
class P {
  constructor(public x: number) {}
}
class Holder {
  f: F | null = null;
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
export function clearsField(n: number): number {
  const h = new Holder();
  const o = new P(n | 0);
  h.f = (): number => {
    h.f = null;
    churn();
    return o.x;
  };
  return h.f();
}
export function replacesField(n: number): number {
  const h = new Holder();
  const o = new P(n | 0);
  h.f = (): number => {
    h.f = (): number => 7;
    churn();
    return o.x;
  };
  const a = h.f();
  return a + h.f();
}
let g: F | null = null;
export function clearsGlobal(n: number): number {
  const o = new P(n | 0);
  g = (): number => {
    g = null;
    churn();
    return o.x;
  };
  return g();
}
export function clearsBox(n: number): number {
  let self: F | null = null;
  const o = new P(n | 0);
  self = (): number => {
    self = null;
    churn();
    return o.x;
  };
  return self();
}
export function fromArray(n: number): number {
  const fs: F[] = [];
  const o = new P(n | 0);
  fs.push((): number => {
    fs.pop();
    churn();
    return o.x;
  });
  return fs[0]!();
}
export function capturedThisLater(n: number): number {
  const h = new Holder();
  let count = n | 0;
  h.f = (): number => {
    count++;
    const before = count;
    h.f = null;
    churn();
    return before + count;
  };
  return h.f();
}
