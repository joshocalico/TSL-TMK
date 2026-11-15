// One benchmark configuration in one fresh process (SPEC 8.4). The caller decides the configuration,
// and this file only measures, so V8 and JSC run the vendored source with no tslc code involved.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Job {
  source: string; // the vendored .ts
  glue?: string; // absent: run the source directly
  wasm?: string;
  fixtures: { name: string; path: string; warm: number; iter: number }[];
  coldOnly?: boolean;
}

type Decode = (b: Uint8Array) => { rgba: Uint8Array; width: number; height: number };

const job = JSON.parse(process.argv[2]!) as Job;
const out: {
  engine: string;
  fixtures: Record<string, { median: number; min: number; p90: number; n: number }>;
  coldMs?: number;
  compileMs?: number;
  rssBytes?: number;
  wasmMemoryBytes?: number;
} = { engine: `${process.release?.name ?? "?"} ${process.version}`, fixtures: {} };

const bytesOf = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
const firstBytes = job.fixtures.map((f) => bytesOf(f.path));
const started = performance.now();
let decode: Decode;
if (job.glue !== undefined) {
  const glue = (await import(pathToFileURL(job.glue).href)) as {
    instantiate(b: Uint8Array): Promise<{ decodeJpeg: Decode }>;
  };
  decode = (await glue.instantiate(readFileSync(job.wasm!))).decodeJpeg;
  out.compileMs = performance.now() - started;
} else {
  const mod = (await import(pathToFileURL(job.source).href)) as { decodeJpeg: Decode };
  decode = mod.decodeJpeg;
}
if (job.coldOnly === true) {
  // Cold start: the first decode in this process, plus compiling and instantiating the Wasm.
  const t0 = performance.now();
  decode(firstBytes[0]!);
  out.coldMs = performance.now() - t0 + (out.compileMs ?? 0);
} else {
  job.fixtures.forEach((f, i) => {
    const b = firstBytes[i]!;
    for (let w = 0; w < f.warm; w++) decode(b);
    const t: number[] = [];
    for (let n = 0; n < f.iter; n++) {
      const s = performance.now();
      decode(b);
      t.push(performance.now() - s);
    }
    t.sort((x, y) => x - y);
    out.fixtures[f.name] = {
      median: t[t.length >> 1]!,
      min: t[0]!,
      p90: t[Math.floor(t.length * 0.9)]!,
      n: t.length,
    };
  });
}
// Node reports maxRSS in KiB and Bun in bytes.
const maxRss = process.resourceUsage().maxRSS;
out.rssBytes = "bun" in process.versions ? maxRss : maxRss * 1024;
process.stdout.write(JSON.stringify(out));
