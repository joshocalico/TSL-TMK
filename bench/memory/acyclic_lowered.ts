// A program no type of which can be in a cycle, for `tmk bench memory`: with the collector on, the module is the same module
// byte for byte, which the tirhash says. Arrays of records, and closures over numbers.
interface Rec {
  a: number;
  b: number;
}
export function acyclicWork(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const r: Rec[] = [
      { a: i, b: i + 1 },
      { a: i + 2, b: i + 3 },
    ];
    const f = (): number => r.length + i;
    t = (t + r[1]!.b + f()) | 0;
  }
  return t | 0;
}
