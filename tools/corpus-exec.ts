// Runs one program's cases on whatever engine is running this file, and prints canonical results.
// Modes: `source` imports the .ts directly (no tslc involved, SPEC 3.10); `wasm` and `checked` run
// tslc's output. On Node, source mode needs --import tools/ts-hook.mjs; Bun needs nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { arrayDigest, canon, checkPin, decodeArg, isTypedArray, type Json } from "./canon.ts";

interface Job {
  mode: "source" | "wasm" | "checked";
  program: string; // the .ts file, the glue .mjs, or the js-checked .mjs
  wasm?: string;
  cases: string;
  meta?: string; // absent means no type information, as when just exercising the source
}

interface Case {
  fn: string;
  args: unknown[];
  expect?: unknown;
  trap?: number;
}

export interface CaseResult {
  fn: string;
  result: Json;
  arrays: Json;
  pin: string | null;
}

type Exports = Record<string, (...args: unknown[]) => unknown>;
type MetaFile = { exports: Record<string, { ret: Parameters<typeof canon>[0] }> };

const job = JSON.parse(process.argv[2]!) as Job & { cycles?: Record<string, number> };
// the type graph's groups, for @tsl/gc's cycle collector on the host (SPEC 3.5, D41): what tslc works out natively
if (job.cycles !== undefined) process.env.TSL_CYCLE_GROUPS = JSON.stringify(job.cycles);
const cases = JSON.parse(readFileSync(job.cases, "utf8")) as Case[];
const meta =
  job.meta !== undefined ? (JSON.parse(readFileSync(job.meta, "utf8")) as MetaFile) : undefined;

let exportsOf: Exports;
if (job.mode === "wasm") {
  const glue = (await import(pathToFileURL(job.program).href)) as {
    instantiate(bytes: Uint8Array): Promise<Exports>;
  };
  exportsOf = await glue.instantiate(readFileSync(job.wasm!));
} else {
  exportsOf = (await import(pathToFileURL(job.program).href)) as Exports;
}

const out: CaseResult[] = [];
for (const c of cases) {
  const f = exportsOf[c.fn];
  if (typeof f !== "function") {
    out.push({ fn: c.fn, result: { missing: true }, arrays: null, pin: null });
    continue;
  }
  const args = c.args.map(decodeArg);
  const retDesc = meta?.exports[c.fn]?.ret;
  let result: Json;
  let pin: string | null = null;
  try {
    const r = f(...args);
    result = canon(retDesc, r);
    pin = checkPin(c, result, args, retDesc);
  } catch (e) {
    const err = e as { name?: string; code?: unknown; constructor?: { name?: string } };
    if (typeof err.code === "number" && err.constructor?.name === "TslTrap") {
      result = { trap: err.code };
    } else result = { throw: err.name ?? "unknown" };
  }
  const arrays: Json[] = [];
  args.forEach((a, i) => {
    if (isTypedArray(a)) arrays.push([i, arrayDigest(a)]);
  });
  out.push({ fn: c.fn, result, arrays, pin });
}
process.stdout.write(JSON.stringify(out));
