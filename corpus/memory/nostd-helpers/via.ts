// One step further from @tsl/std.
import type { u32 } from "@tsl/core";
import { count } from "./uses_std.ts";

export function viaCount(): u32 {
  return count();
}
