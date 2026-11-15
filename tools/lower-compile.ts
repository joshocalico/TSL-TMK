// Lowers a batch of ordinary-TS programs in one process and writes each one's artifacts.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fallbackModuleText, type LowerOutput } from "../compiler/host/tslc.ts";
// Through the run's build store (tools/store.ts): tslc's lowerFile without one.
import { storedLowerFile as lowerFile } from "./lowering.ts";
import type { Diag } from "../compiler/host/diag.ts";

interface Job {
  files: string[];
  outDir: string;
  memory?: string;
  rc?: Record<string, unknown>;
}

export interface LowerBuild {
  file: string;
  diags: Diag[];
  crash?: string;
  tirHash?: string;
  wasmSha?: string;
  rows?: LowerOutput["rows"];
  fallbackDiags?: LowerOutput["fallbackDiags"];
  warnings?: LowerOutput["warnings"];
  allocs?: LowerOutput["allocs"];
  tirPath?: string;
}

declare const WebAssembly: { validate(bytes: Uint8Array): boolean };

const job = JSON.parse(process.argv[2]!) as Job;
mkdirSync(job.outDir, { recursive: true });
const results: LowerBuild[] = [];
for (const file of job.files) {
  try {
    const o = lowerFile(file, {
      ...(job.memory !== undefined ? { memory: job.memory } : {}),
      ...(job.rc !== undefined || process.env.TMK_TEST_RC !== undefined
        ? {
            rc: {
              ...job.rc,
              ...(job.memory === "rc" && process.env.TMK_TEST_RC !== undefined
                ? (JSON.parse(process.env.TMK_TEST_RC) as Record<string, unknown>)
                : {}),
            },
          }
        : {}),
    });
    const r: LowerBuild = { file, diags: o.diags };
    if (o.diags.length === 0) {
      const base = join(job.outDir, basename(file, ".ts"));
      mkdirSync(dirname(base), { recursive: true });
      if (o.wasm !== null) {
        writeFileSync(`${base}.wasm`, o.wasm);
        writeFileSync(`${base}.glue.mjs`, o.glue);
      }
      writeFileSync(`${base}.tir`, o.tirText);
      // The level that made it, which the text doesn't carry: the backend's -O1 and -O2 code shape reads it (D75).
      writeFileSync(`${base}.opt`, String(o.tir?.opt ?? 0));
      writeFileSync(`${base}.meta.json`, JSON.stringify(o.meta));
      if (o.meta!.fallbackFile !== null) {
        writeFileSync(
          join(job.outDir, o.meta!.fallbackFile),
          fallbackModuleText(file, o.meta!.fallbackNames),
        );
      }
      r.tirHash = o.tirHash;
      r.wasmSha = createHash("sha256")
        .update(o.wasm ?? new Uint8Array(0))
        .digest("hex");
      r.rows = o.rows;
      r.fallbackDiags = o.fallbackDiags;
      r.warnings = o.warnings;
      r.allocs = o.allocs;
      r.tirPath = `${base}.tir`;
      if (o.wasm !== null && !WebAssembly.validate(o.wasm))
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
