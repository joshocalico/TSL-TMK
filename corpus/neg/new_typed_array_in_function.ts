// expect: TSL1001 at 3:13
export function f(): void {
  const a = new Uint8Array(4);
  a[0] = 1;
}
