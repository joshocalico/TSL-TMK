// expect: TSL3005 at 4:5
import { type Result, type u32 } from "@tsl/core";
type R = Result<u32, "bad">;
let r: R = { ok: false, error: "bad" };
export const u32Unused = 0;
class Unused {}
