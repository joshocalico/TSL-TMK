// One micro-benchmark on V8 or Wasm, in one fresh process (SPEC 8.4). It only measures.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WORKLOADS } from "./workloads.ts";

interface Job {
  name: string;
  source: string;
  glue?: string;
  wasm?: string;
  warm: number;
  iter: number;
}
const job = JSON.parse(process.argv[2]!) as Job;
const w = WORKLOADS.find((x) => x.name === job.name)!;
type Fn = (...a: unknown[]) => unknown;
let ex: Record<string, Fn>;
if (job.glue !== undefined) {
  const glue = (await import(pathToFileURL(job.glue).href)) as {
    instantiate(b: Uint8Array): Promise<Record<string, Fn>>;
  };
  ex = await glue.instantiate(readFileSync(job.wasm!));
} else ex = (await import(pathToFileURL(job.source).href)) as Record<string, Fn>;
const f = ex[w.fn]!;
const args = w.args();
const saved = w.restore.map((i) => (args[i] as Int32Array).slice());
const restore = (): void => {
  w.restore.forEach((a, i) => {
    (args[a] as Int32Array).set(saved[i]!);
  });
};
let result: unknown;
for (let i = 0; i < job.warm; i++) {
  restore();
  result = f(...args);
}
const t: number[] = [];
for (let i = 0; i < job.iter; i++) {
  restore();
  const s = performance.now();
  result = f(...args);
  t.push(performance.now() - s);
}
t.sort((a, b) => a - b);
const digest = createHash("sha256");
digest.update(String(result ?? 0));
for (const a of args)
  if (typeof a !== "number") digest.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
process.stdout.write(JSON.stringify({ median: t[t.length >> 1]!, digest: digest.digest("hex") }));
