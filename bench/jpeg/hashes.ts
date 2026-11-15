// The reference for native JPEG: every fixture and option through the source on this engine, with no
// tslc code involved (SPEC 3.10). Prints full SHA-256 hashes of the RGBA as JSON.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  source: string;
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
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const out: {
  name: string;
  path: string;
  size: { width: number; height: number } | null;
  decodes: { maxEdge: number | null; width: number; height: number; sha: string }[];
}[] = [];
for (const dir of job.dirs) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jpg")) continue;
    const path = join(dir, name);
    const bytes = new Uint8Array(readFileSync(path));
    const a = source.decodeJpeg(bytes);
    const long = Math.max(a.width, a.height);
    const decodes = [
      { maxEdge: null as number | null, width: a.width, height: a.height, sha: sha(a.rgba) },
    ];
    for (const maxEdge of [
      1,
      Math.ceil(long / 16),
      Math.floor(long / 8),
      Math.floor(long / 8) + 1,
      long,
      0,
    ]) {
      const x = source.decodeJpeg(bytes, { maxEdge });
      decodes.push({ maxEdge, width: x.width, height: x.height, sha: sha(x.rgba) });
    }
    out.push({ name, path, size: source.jpegSize(bytes), decodes });
  }
}
process.stdout.write(JSON.stringify(out));
