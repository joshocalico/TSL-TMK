// A returned field of an object that dies on return, and chained calls on temporaries.
class Inner {
  constructor(public h: number) {}
  g(): Inner {
    return new Inner(this.h + 1);
  }
}
class Holder {
  inner: Inner;
  next: Holder | null = null;
  constructor(v: number) {
    this.inner = new Inner(v);
  }
  g(): Inner {
    return this.inner;
  }
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new Inner(i).h;
  return s;
}
function makeHolder(v: number): Holder {
  return new Holder(v);
}
function fieldOfTemp(v: number): Inner {
  return makeHolder(v).inner;
}
export function returnedField(n: number): number {
  const i = fieldOfTemp(n | 0);
  churn();
  return i.h;
}
export function chained(n: number): number {
  const x = makeHolder(n | 0)
    .g()
    .g().h;
  churn();
  return x;
}
export function longChain(n: number): number {
  return (
    makeHolder(n | 0)
      .g()
      .g()
      .g()
      .g()
      .g().h + churn()
  );
}
export function asArgument(n: number): number {
  return use(makeHolder(n | 0).inner, makeHolder(1).g());
}
function use(a: Inner, b: Inner): number {
  churn();
  return a.h * 10 + b.h;
}
export function inCondition(n: number): number {
  if (makeHolder(n | 0).inner.h > 0) return churn() - churn() + 1;
  return 0;
}
export function discarded(n: number): number {
  makeHolder(n | 0);
  makeHolder(n | 0).g();
  return churn() > 0 ? 1 : 0;
}
export function literalDies(n: number): number {
  const v = { a: { b: new Inner(n | 0) } }.a.b;
  churn();
  return v.h;
}
export function arrayDies(n: number): number {
  const v = [new Inner(n | 0), new Inner(2)][0]!;
  churn();
  return v.h;
}
function pairOf(v: number): [Inner, Inner] {
  return [new Inner(v), new Inner(v + 1)];
}
export function destructured(n: number): number {
  const [a, b] = pairOf(n | 0);
  churn();
  return a.h + b.h;
}
function objectOf(v: number): { p: Inner; q: Inner } {
  return { p: new Inner(v), q: new Inner(v + 1) };
}
export function destructuredObject(n: number): number {
  const { p, q } = objectOf(n | 0);
  churn();
  return p.h + q.h;
}
export function nestedTemporaries(n: number): number {
  return new Inner(new Inner(n | 0).g().h).g().g().h;
}
