// Runs one ordinary-TS program's cases on whichever engine runs this file, and prints results in a
// strict canonical form: -0, NaN, holes and undefined all stay distinct (SPEC 4.5, 8.1).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeArg, isTypedArray } from "./canon.ts";

export interface LowerCase {
  fn: string;
  args: unknown[];
  lowered_trap?: number;
  native_ulp?: number; // the native configuration only: a declared last-bit tolerance
  memory_trap?: { leak?: number; manual?: number; rc?: number }; // this mode, under the program's page limit, runs out
}

export interface LowerCaseResult {
  fn: string;
  result: unknown;
  args: unknown;
}

interface Job {
  mode: "source" | "wasm";
  program: string;
  wasm?: string;
  cases: string;
}

type Exports = Record<string, (...args: unknown[]) => unknown>;

function bits(v: number): string {
  if (Number.isNaN(v)) return "nan";
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v);
  return d.getBigUint64(0).toString(16).padStart(16, "0");
}

export function strictCanon(v: unknown, seen: Map<object, number> = new Map()): unknown {
  if (v === undefined) return { undef: true };
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return { n: bits(v) };
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return { fn: true };
  if (typeof v !== "object") return { other: typeof v };
  const prior = seen.get(v);
  if (prior !== undefined) return { ref: prior };
  seen.set(v, seen.size);
  if (isTypedArray(v)) {
    const items: unknown[] = [];
    for (let i = 0; i < v.length; i++) items.push(strictCanon(v[i], new Map()));
    return { ta: v.constructor.name, items };
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) out.push(i in v ? strictCanon(v[i], seen) : { hole: true });
    return out;
  }
  if (v instanceof Map) {
    return { map: [...v.entries()].map(([k, x]) => [strictCanon(k, seen), strictCanon(x, seen)]) };
  }
  if (v instanceof Set) return { set: [...v.values()].map((k) => strictCanon(k, seen)) };
  const out: Record<string, unknown> = {};
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = strictCanon(o[k], seen);
  return out;
}

/**
 * What a caller sees of a thrown value (SPEC 4.5, D49): an Error's name and message, its constructor where that isn't its
 * name, its cause and a SuppressedError's parts; another object's constructor; or the value itself. `stack` is left out:
 * it's divergence 13.
 */
export function thrownCanon(e: unknown): unknown {
  if (e instanceof Error) {
    const out: Record<string, unknown> = { threw: e.name, message: e.message };
    const ctor = (e.constructor as { name?: string } | undefined)?.name;
    if (ctor !== undefined && ctor !== e.name) out.ctor = ctor;
    if (e.cause !== undefined) out.cause = thrownCanon(e.cause);
    if (typeof SuppressedError === "function" && e instanceof SuppressedError) {
      out.error = thrownCanon(e.error);
      out.suppressed = thrownCanon(e.suppressed);
    }
    return out;
  }
  if (e !== null && typeof e === "object") {
    return {
      threw: "object",
      ctor: (e.constructor as { name?: string } | undefined)?.name ?? "Object",
    };
  }
  return { threw: "value", value: strictCanon(e) };
}

/** The names of JS's own Error classes, which a lowered throw's message keeps (D49). */
export const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

export type ThrownDesc = {
  u?: 1;
  z?: 1;
  s?: string;
  n?: string;
  b?: boolean;
  e?: string;
  o?: string;
  name?: string;
  message?: string;
  cause?: ThrownDesc;
  error?: ThrownDesc;
  suppressed?: ThrownDesc;
};

/** A thrown value as the module described it, as thrownCanon would show the JS one (D49). */
export function thrownFromDesc(d: ThrownDesc): unknown {
  if (d.u !== undefined) return { threw: "value", value: strictCanon(undefined) };
  if (d.z !== undefined) return { threw: "value", value: strictCanon(null) };
  if (d.s !== undefined) return { threw: "value", value: strictCanon(d.s) };
  if (d.n !== undefined)
    return { threw: "value", value: strictCanon(d.n === "-0" ? -0 : Number(d.n)) };
  if (d.b !== undefined) return { threw: "value", value: strictCanon(d.b) };
  if (d.o !== undefined) return { threw: "object", ctor: d.o };
  const out: Record<string, unknown> = { threw: d.name, message: d.message };
  if (d.e !== d.name) out.ctor = d.e;
  if (d.cause !== undefined) out.cause = thrownFromDesc(d.cause);
  if (d.error !== undefined) out.error = thrownFromDesc(d.error);
  if (d.suppressed !== undefined) out.suppressed = thrownFromDesc(d.suppressed);
  return out;
}

/** A message's units that the native trap path escaped as {uXXXX}, back to themselves. */
export function unescapeUnits(t: string): string {
  return t.replace(/\{u([0-9a-f]{4})\}/g, (_, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16)),
  );
}

if (process.argv[1]?.endsWith("lower-exec.ts") === true) {
  const job = JSON.parse(process.argv[2]!) as Job;
  const cases = JSON.parse(readFileSync(job.cases, "utf8")) as LowerCase[];
  let ex: Exports;
  if (job.mode === "wasm") {
    const glue = (await import(pathToFileURL(job.program).href)) as {
      instantiate(bytes: Uint8Array): Promise<Exports>;
    };
    ex = await glue.instantiate(readFileSync(job.wasm!));
  } else ex = (await import(pathToFileURL(job.program).href)) as Exports;
  const out: LowerCaseResult[] = [];
  for (const c of cases) {
    const f = ex[c.fn];
    if (typeof f !== "function") {
      out.push({ fn: c.fn, result: { missing: true }, args: null });
      continue;
    }
    const args = c.args.map(decodeArg);
    let result: unknown;
    try {
      result = { value: strictCanon(f(...args)) };
    } catch (e) {
      const err = e as {
        name?: string;
        message?: string;
        code?: unknown;
        constructor?: { name?: string };
      } | null;
      if (err?.constructor?.name === "TslTrap") result = { trap: err!.code };
      else result = thrownCanon(e);
    }
    out.push({ fn: c.fn, result, args: strictCanon(args) });
  }
  process.stdout.write(JSON.stringify(out));
}
