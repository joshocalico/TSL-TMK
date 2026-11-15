// A method whose `this` loses its last holder during the call.
class P {
  constructor(public x: number) {}
}
function churn(): number {
  let s = 0;
  for (let i = 0; i < 64; i++) s += new P(i).x;
  return s;
}
class M {
  next: M | null = null;
  constructor(public v: number) {}
  dropsGlobal(): number {
    g = null;
    churn();
    return this.v;
  }
  dropsOwner(o: Owner): number {
    o.m = null;
    churn();
    return this.v;
  }
  callsSelf(): number {
    g = null;
    return this.read() + churn();
  }
  read(): number {
    churn();
    return this.v;
  }
  get viaGetter(): number {
    g = null;
    churn();
    return this.v;
  }
  chain(): M {
    g = null;
    churn();
    return this;
  }
}
class Owner {
  m: M | null = null;
}
let g: M | null = null;
export function globalReceiver(n: number): number {
  g = new M(n | 0);
  return g.dropsGlobal();
}
export function fieldReceiver(n: number): number {
  const o = new Owner();
  o.m = new M(n | 0);
  return o.m.dropsOwner(o);
}
export function nestedCall(n: number): number {
  g = new M(n | 0);
  return g.callsSelf();
}
export function getterReceiver(n: number): number {
  g = new M(n | 0);
  return g.viaGetter;
}
export function returnedThis(n: number): number {
  g = new M(n | 0);
  return g.chain().chain().v;
}
export function temporaryReceiver(n: number): number {
  return new M(n | 0).read();
}
