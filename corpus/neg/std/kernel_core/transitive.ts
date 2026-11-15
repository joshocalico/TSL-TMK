// Through a package that isn't noStd itself: the error's at the import of @tsl/std, in that package's module.
// expect: TSL1018 at 3:1
// expect-file: corpus/memory/nostd-helpers/uses_std.ts
import type { u32 } from "@tsl/core";
import { count } from "../../../memory/nostd-helpers/uses_std.ts";

export function f(): u32 {
  return count();
}
