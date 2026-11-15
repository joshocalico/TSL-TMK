// The program's root is an ordinary package, and it imports a noStd package whose import reaches @tsl/std: still wrong.
// expect: TSL1018 at 3:1
// expect-file: corpus/memory/nostd-helpers/uses_std.ts
import type { u32 } from "@tsl/core";
import { libCount } from "../../../memory/nostd-helpers/core_like/lib.ts";

export function f(): u32 {
  return libCount();
}
