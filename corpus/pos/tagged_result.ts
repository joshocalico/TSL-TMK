import {
  type Err,
  type f64,
  type Ok,
  type Result,
  type u16,
  type u32,
  type u64,
  type u8,
} from "@tsl/core";

export type ProbeError = "bad-magic" | "bad-version" | "empty-slot";

export function probe(magic: u32, version: u32, id: u32): Result<u32, ProbeError> {
  if (magic !== 0x74726976) return { ok: false, error: "bad-magic" };
  if (version !== 2) return { ok: false, error: "bad-version" };
  if (id === 0) return { ok: false, error: "empty-slot" };
  return { ok: true, value: id };
}

export function idOrZero(magic: u32, version: u32, id: u32): u32 {
  const r = probe(magic, version, id);
  if (r.ok) return r.value;
  return r.error === "empty-slot" ? 1 : 0;
}

export type Event =
  | { readonly kind: "irq"; readonly intid: u32 }
  | { readonly kind: "block"; readonly sector: u64; readonly status: u8 }
  | { readonly kind: "ratio"; readonly value: f64 }
  | { readonly kind: "bad" };

export function decode(kind: u32, payload: u32): Event {
  switch (kind) {
    case 1:
      return { kind: "irq", intid: payload };
    case 2:
      return { kind: "block", sector: 77n, status: payload & 0xff };
    case 3:
      return { kind: "ratio", value: 0.5 };
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
    case "ratio":
      return e.value > 0 ? 3 : 4;
    case "bad":
      return 0xffffffff;
  }
}

export function roundTrip(kind: u32, payload: u32): u32 {
  return statusOf(decode(kind, payload));
}

// The two "x" fields have different TIR types, so reading one depends on narrowing.
type Shape = { readonly tag: 1; readonly x: u32 } | { readonly tag: 2; readonly x: f64 };

function shape(which: u32): Shape {
  return which === 0 ? { tag: 1, x: 5 } : { tag: 2, x: 1.5 };
}

export function shapeValue(which: u32): f64 {
  const s = shape(which);
  if (s.tag === 2) return s.x;
  return 0;
}

export function shapeInt(which: u32): u32 {
  const s = shape(which);
  if (s.tag === 1) return s.x;
  return 0;
}

export function makeOk(x: u16): Ok<u16> {
  return { ok: true, value: x }; // on its own, a variant is a plain value record
}

export function makeErr(x: u32): Err<u32> {
  return { ok: false, error: x };
}

export function chain(a: u32): Result<u32, ProbeError> {
  const first = probe(0x74726976, 2, a);
  if (!first.ok) return first;
  return { ok: true, value: first.value + 1 };
}
