// A noStd package that's fine by itself, unless what it imports isn't.
import type { u32 } from "@tsl/core";
import { viaCount } from "../via.ts";

export function libCount(): u32 {
  return viaCount();
}
