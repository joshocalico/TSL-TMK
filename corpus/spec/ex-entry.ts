// file: ex-entry.ts
import { array, assertSize, u64 } from "@tsl/core";
import { asmFn, fnAddr } from "@tsl/unsafe";
import { writeVbarEl1 } from "@tsl/arch-aarch64";

export class TrapFrame {
  regs = array(u64, 31); // x0..x30
  spEl0 = u64();
  elr = u64();
  spsr = u64();
}
assertSize(TrapFrame, 272);

export const switchContext = asmFn<(from: u64, to: u64) => void>`
  stp x19, x20, [x0, #0]
  stp x21, x22, [x0, #16]
  stp x23, x24, [x0, #32]
  stp x25, x26, [x0, #48]
  stp x27, x28, [x0, #64]
  stp x29, x30, [x0, #80]
  mov x9, sp
  str x9, [x0, #96]
  ldp x19, x20, [x1, #0]
  ldp x21, x22, [x1, #16]
  ldp x23, x24, [x1, #32]
  ldp x25, x26, [x1, #48]
  ldp x27, x28, [x1, #64]
  ldp x29, x30, [x1, #80]
  ldr x9, [x1, #96]
  mov sp, x9
  ret
`;

export const vectors = asmFn<() => never>`
  .balign 2048
  // 16 slots of 128 bytes: each saves registers into a TrapFrame and calls a handler
  .space 2048
`;

export let lastSyndrome: u64 = 0n;

/** @tsl.noalloc @tsl.nosleep @tsl.export-c trap_sync_lower */
export function trapSyncLower(frame: TrapFrame): void {
  lastSyndrome = frame.spsr;
}

export function installVectors(): void {
  // SAFETY: vectors is part of this image and aligned to 2 KiB.
  writeVbarEl1(fnAddr(vectors));
}
