// Every fixture through V8 (or JSC) and through Wasm on the same engine: jpegSize, decodeJpeg, and
// decodeJpeg with maxEdge at sizes on both sides of the 1/8 threshold (SPEC M2, acceptance).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  source: string;
  glue: string;
  wasm: string;
  dirs: string[];
}
interface Image {
  rgba: Uint8Array;
  width: number;
  height: number;
}
interface Api {
  decodeJpeg(b: Uint8Array, o?: { maxEdge?: number }): Image;
  jpegSize(b: Uint8Array): { width: number; height: number } | null;
}

const job = JSON.parse(process.argv[2]!) as Job;
const source = (await import(pathToFileURL(job.source).href)) as Api;
const glue = (await import(pathToFileURL(job.glue).href)) as {
  instantiate(b: Uint8Array): Promise<Api>;
};
const lowered = await glue.instantiate(readFileSync(job.wasm));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const same = (a: Image, b: Image): boolean =>
  a.width === b.width && a.height === b.height && sha(a.rgba) === sha(b.rgba);

const results: {
  fixture: string;
  rgba: string;
  size: string;
  checks: string[];
  fails: string[];
}[] = [];
for (const dir of job.dirs) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jpg")) continue;
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    const fails: string[] = [];
    const checks: string[] = [];
    const a = source.decodeJpeg(bytes);
    if (!same(a, lowered.decodeJpeg(bytes))) fails.push("decodeJpeg differs");
    checks.push("decodeJpeg");
    if (JSON.stringify(source.jpegSize(bytes)) !== JSON.stringify(lowered.jpegSize(bytes))) {
      fails.push("jpegSize differs");
    }
    checks.push("jpegSize");
    const long = Math.max(a.width, a.height);
    for (const maxEdge of [
      1,
      Math.ceil(long / 16),
      Math.floor(long / 8),
      Math.floor(long / 8) + 1,
      long,
      0,
    ]) {
      const x = source.decodeJpeg(bytes, { maxEdge });
      if (!same(x, lowered.decodeJpeg(bytes, { maxEdge })))
        fails.push(`maxEdge ${maxEdge} differs`);
      checks.push(`maxEdge ${maxEdge}:${x.width}x${x.height}`);
    }
    if (!same(a, lowered.decodeJpeg(bytes, {}))) fails.push("empty options differ");
    results.push({
      fixture: name,
      rgba: sha(a.rgba),
      size: `${a.width}x${a.height}`,
      checks,
      fails,
    });
  }
}
process.stdout.write(JSON.stringify(results));
