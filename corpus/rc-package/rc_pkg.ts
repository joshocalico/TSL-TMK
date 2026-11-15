// `"memory": "rc"` in a package: ordinary TS, which tmk lower lowers in rc (SPEC 3.5, 9.2). tslc refuses it, with TSL9001.
class P {
  constructor(public x: number) {}
}
let kept: P | null = null;
export function keep(n: number): number {
  kept = new P(n | 0);
  return kept.x;
}
