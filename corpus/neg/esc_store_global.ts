// expect: TSL3001 at 8:10
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
let last: Domain | null = null;
export function f(): void {
  last = new Domain(1);
}
