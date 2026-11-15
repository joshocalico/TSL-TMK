// expect: TSL1021 at 13:1
// expect-msg: the first is at corpus/memory/nostd-helpers/source_one.ts:10:1
// expect-file: corpus/neg/std/two_modules_a.ts
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";
import { one } from "../../memory/nostd-helpers/source_one.ts";

function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
const two = globalAllocator(none);

export function f(): boolean {
  return one === two;
}
