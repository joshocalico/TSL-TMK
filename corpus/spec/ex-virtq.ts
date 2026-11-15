// file: ex-virtq.ts
import { array, arrayOf, assertSize, atomic, bits, u16, u32, u64, type usize } from "@tsl/core";
import { dmbIsh } from "@tsl/arch-aarch64";
import type { VirtioMmio } from "./ex-mmio.ts";

export const QUEUE_SIZE = 128;

export class VirtqDesc {
  addr = u64(); // offset 0, guest-physical buffer address
  len = u32(); //  offset 8
  flags = bits(u16, { next: 1, write: 1, indirect: 1 }); // offset 12
  next = u16(); // offset 14

  isLast(): boolean {
    return !this.flags.next;
  }
}
assertSize(VirtqDesc, 16);

export class VirtqAvail {
  flags = u16();
  idx = u16();
  ring = array(u16, QUEUE_SIZE);
  usedEvent = u16();

  /** Publish a descriptor chain head to the device and notify queue 0. */
  publish(regs: VirtioMmio, head: u16): void {
    const slot: usize = this.idx & (QUEUE_SIZE - 1);
    this.ring[slot] = head;
    atomic.store(this, "idx", (this.idx + 1) & 0xffff, "release"); // free-running mod 2^16
    dmbIsh(); // idx must be visible before the notify write
    regs.queueNotify.write(0);
  }
}
assertSize(VirtqAvail, 6 + 2 * QUEUE_SIZE);

export class VirtqUsedElem {
  id = u32();
  len = u32();
}

export class VirtqUsed {
  flags = u16();
  idx = u16();
  ring = arrayOf(VirtqUsedElem, QUEUE_SIZE);
  availEvent = u16();
}
