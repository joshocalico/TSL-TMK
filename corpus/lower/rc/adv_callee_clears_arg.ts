// A callee clears the only other holder of its own argument. Each holder here is reached a different way. The callee
// allocates after clearing, so a freed argument would already be reused, and a poisoning build would trap on it.
class P {
  constructor(public x: number) {}
}
class H {
  p: P | null = null;
}
let g: P | null = null;
const h = new H();
let list: P[] = [];

function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}

function viaG(p: P): number {
  g = null;
  const c = churn();
  return p.x + c;
}
export function throughGlobal(n: number): number {
  g = new P(n | 0);
  return viaG(g);
}

function viaH(p: P): number {
  h.p = null;
  const c = churn();
  return p.x + c;
}
export function throughField(n: number): number {
  h.p = new P(n | 0);
  return viaH(h.p);
}

function viaList(p: P): number {
  list.pop();
  const c = churn();
  return p.x + c;
}
export function throughElement(n: number): number {
  list = [new P(n | 0)];
  return viaList(list[0]!);
}

function viaLength(p: P): number {
  list.length = 0;
  const c = churn();
  return p.x + c;
}
export function throughLength(n: number): number {
  list = [new P(n | 0), new P(2)];
  return viaLength(list[1]!);
}

export function throughCapture(n: number): number {
  let held: P | null = new P(n | 0);
  const clear = (): void => {
    held = null;
  };
  const use = (p: P, k: () => void): number => {
    k();
    return p.x + churn();
  };
  return use(held, clear);
}

function viaLater(p: P, q: number): number {
  return p.x + q + churn();
}
export function laterArgumentAssigns(n: number): number {
  let local: P = new P(n | 0);
  return viaLater(local, ((local = new P(1)), churn()));
}

function viaNested(p: P): number {
  return inner(p) + p.x;
}
function inner(p: P): number {
  g = null;
  churn();
  return p.x;
}
export function throughTwoCalls(n: number): number {
  g = new P(n | 0);
  return viaNested(g);
}
