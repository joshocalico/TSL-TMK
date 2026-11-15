// Runs ex-messages.ts as the spec has it.
import { over, set, sizeOf, toU32, type u32, type u64 } from "@tsl/core";
import {
  BlkRequest,
  BlkType,
  BlockPayload,
  decode,
  EventKind,
  EventWire,
  IrqPayload,
  statusOf,
} from "./ex-messages.ts";

export function irq(buf: Uint8Array): u32 {
  const w = over(EventWire, buf, 0);
  w.kind = EventKind.Irq;
  over(IrqPayload, w.payload, 0).intid = 27;
  return statusOf(decode(w));
}

export function block(buf: Uint8Array): u64 {
  const w = over(EventWire, buf, 0);
  w.kind = EventKind.Block;
  const b = over(BlockPayload, w.payload, 0);
  set(b, { sector: 9n, status: 3 });
  const d = decode(w);
  return d.kind === "block" ? d.sector * 100n + BigInt.asUintN(64, 0n) + 3n : 0n;
}

export function status(buf: Uint8Array): u32 {
  const w = over(EventWire, buf, 0);
  w.kind = EventKind.Block;
  over(BlockPayload, w.payload, 0).status = 200;
  return statusOf(decode(w));
}

export function badTag(buf: Uint8Array): u32 {
  const w = over(EventWire, buf, 0);
  w.kind = 77;
  return statusOf(decode(w));
}

export function enumField(buf: Uint8Array): u32 {
  const r = over(BlkRequest, buf, 0);
  r.type = BlkType.Flush;
  return toU32(r.type) + toU32(sizeOf(BlkRequest)) * 100;
}

export function enumUnknown(buf: Uint8Array): u32 {
  return toU32(over(BlkRequest, buf, 0).type);
}
