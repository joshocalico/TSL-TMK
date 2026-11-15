// expect: TSL3005 at 5:3
import { type Result, type u32 } from "@tsl/core";
type R = Result<u32, "bad">;
class Holder {
  r: R = { ok: false, error: "bad" };
}
