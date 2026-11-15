type K = "a" | "b";
export function lit(): number {
  const m = new Map<K, number>();
  m.set("a", 1);
  m.set("b", 2);
  return m.get("b")! + m.size;
}
class Node2 {
  constructor(
    public kind: "x" | "y",
    public v: number,
  ) {}
}
export function disc(k: string): number {
  const n = new Node2(k === "x" ? "x" : "y", 3);
  switch (n.kind) {
    case "x":
      return n.v;
    case "y":
      return -n.v;
  }
}
export function words(s: string): number {
  return s
    .split(" ")
    .map((w) => w.length)
    .filter((n) => n > 1)
    .reduce((a, b) => a + b, 0);
}
export function sumMap(m: Map<number, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}
export function nested(s: string): string {
  const r = [[1, 2], [3]];
  return `${r} ${[s, s]} ${[true, false]} ${null} ${undefined}`;
}
function optional(a?: string): string {
  return a ?? "none";
}
export function opt(): string {
  return optional() + optional("x");
}
export function cmpNull(a: string | null): boolean {
  return a === null || a === "";
}
export function classTS(): string {
  class P {
    constructor(public x: number) {}
    toString(): string {
      return `P(${this.x})`;
    }
  }
  return `${new P(1)}` + new P(2);
}
export function objText(): string {
  const o = { a: 1 };
  return `${o}`;
}
export function mapText(): string {
  return `${new Map<number, number>()}${new Set<number>()}`;
}
