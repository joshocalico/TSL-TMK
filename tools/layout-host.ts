// The host's side of the layout check (M3's box): capture mode's sizes and offsets, for tslc's to be compared with.
import { pathToFileURL } from "node:url";
import { alignOf, layoutOf, sizeOf } from "@tsl/core";

const job = JSON.parse(process.argv[2]!) as { file: string; classes: string[] };
const mod = (await import(pathToFileURL(job.file).href)) as Record<string, new () => object>;
const out: Record<string, { size: number; align: number; fields: Record<string, number> } | null> =
  {};
for (const name of job.classes) {
  const c = mod[name];
  if (c === undefined) {
    out[name] = null;
    continue;
  }
  const fields: Record<string, number> = {};
  for (const f of layoutOf(c as never).fields) fields[f.name] = f.at;
  out[name] = { size: sizeOf(c), align: alignOf(c), fields };
}
process.stdout.write(JSON.stringify(out));
