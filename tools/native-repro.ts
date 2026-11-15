// Builds native images for a list of programs and prints each image's SHA-256, so two runs, or two
// engines hosting the compiler, can be compared byte for byte (SPEC 4.4). Also usable with an empty
// PATH, which proves no external tool is in the path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkFile, compileTyped, lowerFile } from "../compiler/host/tslc.ts";
import { buildCheckImage, type Reference } from "./native-jpeg.ts";
import { buildDownImage, buildTslImage } from "./native-exec.ts";

interface Job {
  pos: string[];
  lower: string[];
  jpegRefs: string | null;
}
const job = JSON.parse(process.argv[2]!) as Job;
const out: Record<string, string> = {};
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
for (const file of job.pos) {
  const { typed, diags } = checkFile(file);
  if (typed === null) throw new Error(`${file}: ${JSON.stringify(diags)}`);
  const o = compileTyped(typed);
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
  out[file] = sha(buildTslImage(o.tir, o.meta as never, cases).bytes);
}
for (const file of job.lower) {
  const o = lowerFile(file);
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8")) as never[];
  if (o.tir === null || o.fallbackDiags.length > 0) continue;
  out[file] = sha(buildDownImage(o.tir, o.meta as never, cases).image.bytes);
}
if (job.jpegRefs !== null) {
  const refs = JSON.parse(readFileSync(job.jpegRefs, "utf8")) as Reference[];
  out.jpeg = sha(buildCheckImage(refs).image.bytes);
}
process.stdout.write(JSON.stringify(out));
