// file: ex-messages.ts
import { array, assertSize, enumOf, over, pad, u32, u64, u8 } from "@tsl/core";

export enum EventKind { Irq = 1, Block = 2 }

export class EventWire {
  kind = u32(); // a raw u32, not enumOf: this came from outside, so it's validated below
  reserved = pad(4);
  payload = array(u8, 16);
}
assertSize(EventWire, 24);

export class IrqPayload {
  intid = u32();
}
export class BlockPayload {
  sector = u64();
  status = u8();
}
assertSize(BlockPayload, 16);

export type Event =
  | { readonly kind: "irq"; readonly intid: u32 }
  | { readonly kind: "block"; readonly sector: u64; readonly status: u8 }
  | { readonly kind: "bad" };

export function decode(w: EventWire): Event {
  switch (w.kind) {
    case EventKind.Irq:
      return { kind: "irq", intid: over(IrqPayload, w.payload, 0).intid };
    case EventKind.Block: {
      const b = over(BlockPayload, w.payload, 0);
      return { kind: "block", sector: b.sector, status: b.status };
    }
    default:
      return { kind: "bad" };
  }
}

export function statusOf(e: Event): u32 {
  switch (e.kind) {
    case "irq":
      return e.intid;
    case "block":
      return e.status; // u8 widens to u32
    case "bad":
      return 0xffffffff;
  }
}

export enum BlkType { In = 0, Out = 1, Flush = 4 }

// Device-owned memory we wrote ourselves, so enumOf is safe here.
export class BlkRequest {
  type = enumOf(u32, BlkType);
  reserved = pad(4);
  sector = u64();
}
assertSize(BlkRequest, 16);
