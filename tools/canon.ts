// The canonical JSON results are compared in: bigints as strings, floats as hex bit patterns with NaN
// canonicalised, and typed arrays by SHA-256 (SPEC 8.1). Numbers are read through the declared type
// because a JS number can't say whether it's an integer: V8's -0 for an i32 is just 0.
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface DescLike {
  k: string;
  name?: string;
  fields?: { name: string; ty: DescLike; slots?: number[] }[];
  tag?: string;
  variants?: { tag: boolean | string | number; fields: { name: string; ty: DescLike }[] }[];
}

function floatHex(v: number, width: 4 | 8): string {
  if (Number.isNaN(v)) return width === 8 ? "f64:nan" : "f32:nan";
  const view = new DataView(new ArrayBuffer(8));
  if (width === 8) {
    view.setFloat64(0, v);
    return `f64:${view.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  view.setFloat32(0, v);
  return `f32:${view.getUint32(0).toString(16).padStart(8, "0")}`;
}

const INT_RANGE: Record<string, readonly [number, number]> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
  usize: [0, 9007199254740991],
};

/** Canonicalises a value by its declared type. Out-of-range values stay visibly wrong. */
export function canon(d: DescLike | undefined, v: unknown): Json {
  if (d === undefined) return canonUntyped(v);
  switch (d.k) {
    case "void":
      return v === undefined ? null : `not void: ${String(v)}`;
    case "scalar": {
      const name = d.name!;
      if (name === "bool") return typeof v === "boolean" ? v : `not bool: ${String(v)}`;
      if (name === "u64" || name === "i64") {
        return typeof v === "bigint" ? `${v}n` : `not bigint: ${String(v)}`;
      }
      if (name === "f64") return typeof v === "number" ? floatHex(v, 8) : `not f64: ${String(v)}`;
      // An f32 is a double on V8 that happens to be exact in f32; compare the double's bits.
      if (name === "f32") return typeof v === "number" ? floatHex(v, 8) : `not f32: ${String(v)}`;
      const r = INT_RANGE[name]!;
      if (typeof v !== "number" || !Number.isInteger(v) || v < r[0] || v > r[1]) {
        return `not ${name}: ${String(v)}`;
      }
      return v === 0 ? 0 : v;
    }
    case "enum":
    case "nums":
      return typeof v === "number" ? v : `not a number: ${String(v)}`;
    case "strs":
      return typeof v === "string" ? v : `not a string: ${String(v)}`;
    case "rec":
      return canonFields(d.fields!, v);
    case "union": {
      const o = v as Record<string, unknown>;
      const tag = o[d.tag!];
      const variant = d.variants!.find((x) => x.tag === tag);
      if (variant === undefined) return `no variant: ${String(tag)}`;
      const out = canonFields(variant.fields, v) as { [k: string]: Json };
      out[d.tag!] = tag as Json;
      return sortKeys(out);
    }
    default:
      return canonUntyped(v);
  }
}

function canonFields(fields: { name: string; ty: DescLike }[], v: unknown): Json {
  const o = v as Record<string, unknown>;
  const out: { [k: string]: Json } = {};
  for (const f of fields) out[f.name] = canon(f.ty, o[f.name]);
  return sortKeys(out);
}

function sortKeys(o: { [k: string]: Json }): Json {
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k]!;
  return out;
}

function canonUntyped(v: unknown): Json {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? (v === 0 ? 0 : v) : floatHex(v, 8);
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[k] = canonUntyped(x);
    return sortKeys(out);
  }
  return `unsupported: ${typeof v}`;
}

type AnyTyped =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigUint64Array
  | BigInt64Array;

/** SHA-256 of a typed array's bytes, with NaNs canonicalised because payloads may differ. */
export function arrayDigest(a: AnyTyped): string {
  let bytes: Uint8Array;
  if (a instanceof Float64Array || a instanceof Float32Array) {
    const copy = a.slice();
    const nan =
      a instanceof Float64Array ? new Float64Array([Number.NaN]) : new Float32Array([Number.NaN]);
    for (let i = 0; i < copy.length; i++) if (Number.isNaN(copy[i])) copy[i] = nan[0]!;
    bytes = new Uint8Array(copy.buffer);
  } else bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  return createHash("sha256").update(bytes).digest("hex");
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decodes the argument forms of .cases.json (SPEC 8.1). */
export function decodeArg(x: unknown): unknown {
  if (typeof x === "string") return /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x;
  if (Array.isArray(x)) return x.map((e) => (typeof e === "object" ? decodeArg(e) : e));
  if (x === null || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  const num = (v: unknown): number => decodeFloat(v);
  if ("bytes" in o) return hexBytes(o.bytes as string);
  if ("zeros" in o) return new Uint8Array(o.zeros as number);
  if ("u8s" in o) return Uint8Array.from(o.u8s as number[]);
  if ("i8s" in o) return Int8Array.from(o.i8s as number[]);
  if ("u16s" in o) return Uint16Array.from(o.u16s as number[]);
  if ("i16s" in o) return Int16Array.from(o.i16s as number[]);
  if ("u32s" in o) return Uint32Array.from(o.u32s as number[]);
  if ("i32s" in o) return Int32Array.from(o.i32s as number[]);
  if ("f32s" in o) return Float32Array.from((o.f32s as unknown[]).map(num));
  if ("f64s" in o) return Float64Array.from((o.f64s as unknown[]).map(num));
  if ("u64s" in o)
    return BigUint64Array.from((o.u64s as string[]).map((s) => BigInt(s.slice(0, -1))));
  if ("i64s" in o)
    return BigInt64Array.from((o.i64s as string[]).map((s) => BigInt(s.slice(0, -1))));
  if ("f64" in o) return decodeFloat(o.f64);
  if ("map" in o) {
    return new Map((o.map as unknown[][]).map(([k, v]) => [decodeArg(k), decodeArg(v)]));
  }
  if ("set" in o) return new Set((o.set as unknown[]).map(decodeArg));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = decodeArg(v);
  return out;
}

function decodeFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "f64" in v)
    return decodeFloat((v as { f64: unknown }).f64);
  switch (v) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    default:
      return Number(v);
  }
}

/** A pinned expectation either names a return value, or `{ "args": [...] }` final contents. */
export function checkPin(
  c: { expect?: unknown },
  retDesc: Json,
  args: unknown[],
  ret: Parameters<typeof canon>[0],
): string | null {
  if (c.expect === undefined || c.expect === null) return null;
  const e = c.expect;
  if (typeof e === "object" && !Array.isArray(e) && "args" in (e as object)) {
    const wanted = (e as { args: unknown[] }).args;
    for (let i = 0; i < wanted.length; i++) {
      if (wanted[i] === null) continue;
      const w = decodeArg(wanted[i]);
      const got = args[i];
      if (!isTypedArray(w) || !isTypedArray(got) || arrayDigest(w) !== arrayDigest(got)) {
        return `arg ${i} differs from the pinned value`;
      }
    }
    return "ok";
  }
  const want = JSON.stringify(canon(ret, decodeArg(e)));
  const got = JSON.stringify(retDesc);
  return want === got ? "ok" : `pinned ${want}, got ${got}`;
}

export function isTypedArray(v: unknown): v is AnyTyped {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}
