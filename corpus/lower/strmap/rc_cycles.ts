// Cycles through a Map, a Set and strings: real cycles, which the collector has to find, and which are garbage once dropped.
class Holder {
  m: Map<string, Holder> | null = null;
  s: Set<Holder> | null = null;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Reg {
  items = new Map<number, Reg>();
  id: number;
  cb: (() => number) | null = null;
  constructor(id: number) {
    this.id = id;
  }
}
export function mapHoldsObjectHoldsMap(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<string, Holder>();
    const h = new Holder(`h${i}`);
    h.m = m;
    m.set(h.name, h);
    t += m.size;
  }
  return t;
}
export function setRing(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const a = new Holder("a");
    const b = new Holder("b");
    a.s = new Set<Holder>([b]);
    b.s = new Set<Holder>([a]);
    t += a.s.size + b.s.size;
  }
  return t;
}
export function selfRegistry(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const r = new Reg(i);
    r.items.set(i, r);
    r.items.set(i + 1, new Reg(i + 1));
    r.items.get(i + 1)!.items.set(0, r);
    t += r.items.size;
  }
  return t;
}
export function closureInMap(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<string, () => number>();
    m.set("size", () => m.size);
    t += m.get("size")!();
  }
  return t;
}
export function liveCycleSurvives(n: number): number {
  const m = new Map<string, Holder>();
  const h = new Holder("kept");
  h.m = m;
  m.set("kept", h);
  let t = 0;
  for (let i = 0; i < n; i++) t += new Holder(`x${i}`).name.length;
  return t + m.get("kept")!.m!.size;
}
let kept: Map<string, Holder> | null = null;
export function setGlobalCycle(): number {
  const m = new Map<string, Holder>();
  const h = new Holder("g");
  h.m = m;
  m.set("g", h);
  kept = m;
  return m.size;
}
export function dropGlobalCycle(): number {
  const n = kept === null ? 0 : kept.size;
  kept = null;
  return n;
}
export function cycleThroughCompaction(n: number): number {
  const m = new Map<number, Holder>();
  for (let i = 0; i < n; i++) {
    const h = new Holder(String(i));
    h.m = new Map<string, Holder>([["self", h]]);
    m.set(i, h);
    if (i > 8) m.delete(i - 8);
  }
  let t = 0;
  for (const h of m.values()) t += h.m!.size;
  return t;
}
