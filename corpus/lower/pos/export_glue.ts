// Export glue: objects in and out, writes seen by the caller, aliasing, optional and default arguments.
type Cfg = { size: number; rate?: number; name: "x" | "y"; buf: Uint8Array };
export function readCfg(c: Cfg): number {
  return c.size * (c.rate ?? 2) + c.buf.length + (c.name === "x" ? 1 : 0);
}
export function writeCfg(c: Cfg): void {
  c.size = 99.5;
  c.rate = undefined;
  c.buf[0] = 7;
}
export function makeCfg(): Cfg {
  return { size: 1, name: "y", buf: new Uint8Array(2) };
}
export function defaults(a: number = 5, b?: number): number {
  return a + (b ?? 1);
}
export function defaultObj(o: { n?: number } = {}): number {
  return o.n ?? -1;
}
export function aliasing(a: Uint8Array, b: Uint8Array): number {
  a[0] = 9;
  return b[0]!;
}
export function identity(a: Uint8Array): Uint8Array {
  return a;
}
export function sameObject(): { p: { v: number }; q: { v: number } } {
  const p = { v: 1 };
  return { p, q: p };
}
export function negZero(a: number): number {
  return a * -0;
}
export function boolOut(a: number): boolean {
  return a > 1;
}
export function u32Out(a: number): number {
  return (a | 0) >>> 0;
}
export function voidOut(): void {}
export function nullOut(a: number): { v: number } | null {
  return a > 0 ? { v: a } : null;
}
export function undefOut(a: number): number | undefined {
  return a > 0 ? a : undefined;
}
