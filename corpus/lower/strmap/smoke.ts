export function concat(a: string): string {
  return a + "x";
}
export function len(a: string): number {
  return a.length;
}
export function tpl(n: number, s: string): string {
  return `n=${n} s=${s}`;
}
export function m1(a: number): number {
  const m = new Map<number, number>();
  m.set(1, a);
  m.set(2, a + 1);
  m.delete(1);
  return m.get(2)! + m.size;
}
