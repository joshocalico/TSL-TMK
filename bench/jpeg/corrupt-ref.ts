// The reference for native corrupt-input runs: the same seeded mutations as corrupt.ts, through the
// source on this engine, one result per case (SPEC 4.6).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  source: string;
  dir: string;
  seed: number;
  total: number;
}
interface Api {
  decodeJpeg(b: Uint8Array): { rgba: Uint8Array; width: number; height: number };
}
const job = JSON.parse(process.argv[2]!) as Job;
const source = (await import(pathToFileURL(job.source).href)) as Api;
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
const out: { bytes: string; ok?: string; threw?: string; message?: string }[] = [];
for (let i = 0; i < job.total; i++) {
  const base = rand(bases.length);
  const n = 1 + rand(16);
  const edits: [number, number][] = [];
  for (let k = 0; k < n; k++) edits.push([rand(bases[base]!.length), rand(256)]);
  const cut = rand(8) === 0 ? rand(bases[base]!.length) : -1;
  let bytes = bases[base]!.slice();
  for (const [at, v] of edits) bytes[at] = v;
  if (cut >= 0) bytes = bytes.subarray(0, cut);
  const hex = Buffer.from(bytes).toString("hex");
  try {
    const r = source.decodeJpeg(bytes);
    const sha = createHash("sha256").update(r.rgba).digest("hex");
    out.push({ bytes: hex, ok: `${r.width} ${r.height} ${sha}` });
  } catch (e) {
    const err = e as Error;
    out.push({ bytes: hex, threw: err.constructor.name, message: err.message });
  }
}
process.stdout.write(JSON.stringify(out));
