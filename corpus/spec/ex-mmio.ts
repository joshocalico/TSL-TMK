// file: ex-mmio.ts
import { mmio, reg, type MmioRef, type Result, type u32, type u64 } from "@tsl/core";
import { mmioAt } from "@tsl/unsafe";

export const VirtioMmioRegs = mmio(0x200, {
  magic: reg.ro32(0x000),
  version: reg.ro32(0x004),
  deviceId: reg.ro32(0x008),
  vendorId: reg.ro32(0x00c),
  deviceFeatures: reg.ro32(0x010),
  deviceFeaturesSel: reg.wo32(0x014),
  driverFeatures: reg.wo32(0x020),
  driverFeaturesSel: reg.wo32(0x024),
  queueSel: reg.wo32(0x030),
  queueNumMax: reg.ro32(0x034),
  queueNum: reg.wo32(0x038),
  queueReady: reg.rw32(0x044),
  queueNotify: reg.wo32(0x050),
  interruptStatus: reg.ro32(0x060),
  interruptAck: reg.wo32(0x064),
  status: reg.rw32(0x070),
  queueDescLow: reg.wo32(0x080),
  queueDescHigh: reg.wo32(0x084),
  queueDriverLow: reg.wo32(0x090),
  queueDriverHigh: reg.wo32(0x094),
  queueDeviceLow: reg.wo32(0x0a0),
  queueDeviceHigh: reg.wo32(0x0a4),
  configGeneration: reg.ro32(0x0fc),
});
export type VirtioMmio = MmioRef<typeof VirtioMmioRegs>;

const VIRTIO_MAGIC: u32 = 0x74726976; // "virt", MEASURED on QEMU

export type ProbeError = "bad-magic" | "bad-version" | "empty-slot";

export function probeDevice(base: u64): Result<u32, ProbeError> {
  // SAFETY: base came from the Mmio capability granted to this domain, and is 0x200 bytes long.
  const regs = mmioAt(VirtioMmioRegs, base);
  if (regs.magic.read() !== VIRTIO_MAGIC) return { ok: false, error: "bad-magic" };
  if (regs.version.read() !== 2) return { ok: false, error: "bad-version" }; // QEMU needs force-legacy=false
  const id = regs.deviceId.read();
  if (id === 0) return { ok: false, error: "empty-slot" };
  return { ok: true, value: id };
}
