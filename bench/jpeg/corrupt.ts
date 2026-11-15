// Randomly mutated fixtures with a fixed seed, on V8 and on Wasm. Lowered code must never crash the
// host, and must either match V8 or trap (SPEC 4.6). A chunk of the cases per process keeps a slow
// decode, or a huge one a corrupt header asks for, inside its guard.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  source: string;
  glue: string;
  wasm: string;
  dir: string;
  seed: number;
  total: number;
  from: number;
  to: number;
}
interface Image {
  rgba: Uint8Array;
  width: number;
  height: number;
}
interface Api {
  decodeJpeg(b: Uint8Array, o?: { maxEdge?: number }): Image;
}

const job = JSON.parse(process.argv[2]!) as Job;
const source = (await import(pathToFileURL(job.source).href)) as Api;
const glue = (await import(pathToFileURL(job.glue).href)) as {
  instantiate(b: Uint8Array): Promise<Api>;
};
const lowered = await glue.instantiate(readFileSync(job.wasm));

let state = job.seed >>> 0 || 1;
const rand = (n: number): number => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state % n;
};
const names = readdirSync(job.dir)
  .filter((n) => n.endsWith(".jpg"))
  .sort();
const bases = names.map((n) => new Uint8Array(readFileSync(join(job.dir, n))));
// Cases come from the seed alone, whichever process runs them.
const cases: { base: number; edits: [number, number][]; cut: number }[] = [];
for (let i = 0; i < job.total; i++) {
  const base = rand(bases.length);
  const n = 1 + rand(16);
  const edits: [number, number][] = [];
  for (let k = 0; k < n; k++) edits.push([rand(bases[base]!.length), rand(256)]);
  const cut = rand(8) === 0 ? rand(bases[base]!.length) : -1;
  cases.push({ base, edits, cut });
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
type Out = { ok: string } | { threw: string; message: string; name: string; code?: number };
const run = (f: Api, b: Uint8Array): Out => {
  try {
    const r = f.decodeJpeg(b);
    return { ok: `${r.width}x${r.height}:${sha(r.rgba)}` };
  } catch (e) {
    const err = e as {
      message?: string;
      name?: string;
      code?: number;
      constructor?: { name?: string };
    };
    const out: Out = {
      threw: err.constructor?.name ?? "?",
      message: err.message ?? "",
      name: err.name ?? "",
    };
    if (typeof err.code === "number") out.code = err.code;
    return out;
  }
};

const tally = { matched: 0, matchedError: 0, trapped: 0, mismatched: 0, crashed: 0 };
const trapCodes: Record<string, number> = {};
const details: string[] = [];
for (let i = job.from; i < job.to; i++) {
  const c = cases[i]!;
  let bytes = bases[c.base]!.slice();
  for (const [at, v] of c.edits) bytes[at] = v;
  if (c.cut >= 0) bytes = bytes.subarray(0, c.cut);
  const a = run(source, bytes);
  const b = run(lowered, bytes);
  if ("ok" in b) {
    if ("ok" in a && a.ok === b.ok) tally.matched++;
    else {
      tally.mismatched++;
      details.push(
        `case ${i} (${names[c.base]}): V8 ${JSON.stringify(a).slice(0, 120)}, Wasm ${b.ok.slice(0, 60)}`,
      );
    }
  } else if (b.threw === "TslTrap") {
    tally.trapped++;
    trapCodes[String(b.code)] = (trapCodes[String(b.code)] ?? 0) + 1;
  } else if (b.threw === "RuntimeError" || b.threw === "RangeError" || b.name === "InternalError") {
    // The Wasm engine stopped us, which means a compiler bug, not a trap we meant.
    tally.crashed++;
    details.push(`case ${i} (${names[c.base]}): ${b.threw}: ${b.message}`);
  } else if ("threw" in a && a.message === b.message) tally.matchedError++;
  else {
    tally.mismatched++;
    details.push(
      `case ${i} (${names[c.base]}): V8 ${JSON.stringify(a).slice(0, 120)}, Wasm threw ${b.message}`,
    );
  }
}
process.stdout.write(JSON.stringify({ ...tally, trapCodes, details }));
