// expect: TSL5005 at 6:50
import { type u32, type u64 } from "@tsl/core";
import { addrOf } from "@tsl/unsafe";
class Plain { constructor(public x: u32) {} }
// SAFETY: a test of the checker.
export function f(p: Plain): u64 { return addrOf(p); }
