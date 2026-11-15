// expect: TSL1009 at 3:10 // expect: TSL1008 at 3:44
export function f(): boolean {
  return import("./dynamic_import.ts") === null;
}
