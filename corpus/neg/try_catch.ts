// expect: TSL1004 at 3:3
export function f(): void {
  try {
    f();
  } catch {
    f();
  }
}
