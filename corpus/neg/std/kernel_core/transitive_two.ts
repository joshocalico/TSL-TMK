// Two steps away.
// expect: TSL1018 at 3:1
// expect-file: corpus/memory/nostd-helpers/uses_std.ts
import type { u32 } from "@tsl/core";
import { viaCount } from "../../../memory/nostd-helpers/via.ts";

export function f(): u32 {
  return viaCount();
}
