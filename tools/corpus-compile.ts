// Compiles a batch of corpus programs in one process, reusing the parsed library files, and writes
// each one's artifacts. Runs under Node or Bun: the bytes must not care which (M1 acceptance).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkFile, compileTyped } from "../compiler/host/tslc.ts";
import type { Diag } from "../compiler/host/diag.ts";
import { reuseChecked } from "./lowering.ts";

interface Job {
  files: string[];
  outDir: string;
  checkOnly?: boolean;
}

export interface BuildResult {
  file: string;
  diags: Diag[];
  tirHash?: string;
  wasmSha?: string;
  crash?: string;
}

declare const WebAssembly: { validate(bytes: Uint8Array): boolean };

const job = JSON.parse(process.argv[2]!) as Job;
mkdirSync(job.outDir, { recursive: true });
const results: BuildResult[] = [];
// A sixteenth of these compiled again with tslc's reuse across compiles off, and compared (T2, tools/lowering.ts).
const compile = (file: string): { diags: Diag[]; o: ReturnType<typeof compileTyped> | null } =>
  reuseChecked(
    `tsl ${file} ${job.checkOnly === true} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    () => {
      const { diags, typed } = checkFile(file);
      return { diags, o: typed !== null && job.checkOnly !== true ? compileTyped(typed) : null };
    },
    ({ diags, o }) =>
      JSON.stringify([
        diags,
        o === null
          ? null
          : [
              o.tirText,
              o.glue,
              o.jsChecked,
              o.meta,
              createHash("sha256").update(o.wasm).digest("hex"),
            ],
      ]),
  );

for (const file of job.files) {
  try {
    const { diags, o: built } = compile(file);
    const r: BuildResult = { file, diags };
    if (built !== null) {
      const o = built;
      const base = join(job.outDir, basename(file, ".ts"));
      writeFileSync(`${base}.wasm`, o.wasm);
      writeFileSync(`${base}.glue.mjs`, o.glue);
      writeFileSync(`${base}.checked.mjs`, o.jsChecked);
      writeFileSync(`${base}.meta.json`, JSON.stringify(o.meta));
      writeFileSync(`${base}.tir`, o.tirText);
      // The level that made it, which the text doesn't carry: the backend's -O1 and -O2 code shape reads it (D75).
      writeFileSync(`${base}.opt`, String(o.tir?.opt ?? 0));
      r.tirHash = o.tirHash;
      r.wasmSha = createHash("sha256").update(o.wasm).digest("hex");
      if (o.wasm.length > 0 && !WebAssembly.validate(o.wasm))
        r.crash = "WebAssembly.validate rejected the output";
    }
    results.push(r);
  } catch (e) {
    results.push({
      file,
      diags: [],
      crash: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
process.stdout.write(JSON.stringify(results));
