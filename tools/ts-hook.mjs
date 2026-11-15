// Load hook for running TSL on Node: `node --import ./tools/ts-hook.mjs file.ts` (SPEC 3.1, 9.2).
// TSL may use enum and parameter properties, which Node's type stripping rejects. This involves no
// tslc code, which is what keeps V8 an independent oracle.
//
// Inside a run with a build store (TMK_STORE, SPEC 8.3, D76), what TypeScript makes of a file is kept in the run's store, by
// TypeScript's version, these options, the file's URL and its text, so the thousands of reference runs a gate makes don't
// each load typescript.js to transpile the same packages again (T2). It's checked as the store's are: one reuse in 16, by
// the key and the run, is transpiled again and compared, and a difference fails the run (TMK_STORE_VERIFY as for the store).
import { registerHooks, createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const require = createRequire(import.meta.url);
let ts = null;
const typescript = () => (ts ??= require("typescript"));

const options = () => ({
  target: typescript().ScriptTarget.ESNext,
  module: typescript().ModuleKind.ESNext,
  verbatimModuleSyntax: true,
  useDefineForClassFields: true,
});

const transpile = (source, url) =>
  typescript().transpileModule(source, { compilerOptions: options(), fileName: url }).outputText;

const store = process.env.TMK_STORE;
const kept =
  store !== undefined && store !== "" && store !== "off" ? join(store, "transpile") : null;
// TypeScript's version without loading it: its package.json.
const tsVersion =
  kept === null
    ? ""
    : JSON.parse(readFileSync(require.resolve("typescript/package.json"), "utf8")).version;
const sha = (s) => createHash("sha256").update(s).digest("hex");

function note(what, ms = 0) {
  try {
    mkdirSync(join(store, "events"), { recursive: true });
    appendFileSync(
      join(store, "events", `${process.pid}-hook`),
      `${what} transpile ${Math.round(ms)}\n`,
    );
  } catch {
    // counted or not, the answer is the same
  }
}

function sampled(key) {
  const v = process.env.TMK_STORE_VERIFY ?? "sample";
  if (v === "off") return false;
  if (v === "all") return true;
  return parseInt(sha(`${key}\0${process.env.TMK_STORE_RUN ?? ""}`).slice(0, 4), 16) % 16 === 0;
}

function transpiled(source, url) {
  if (kept === null) return transpile(source, url);
  // The options are fixed above; they're named here so a change to them is a change to the key.
  const key = sha(
    `tmk-transpile/1\0${tsVersion}\0ESNext ESNext verbatim define\0${url}\0${source}`,
  );
  const file = join(kept, key.slice(0, 2), key);
  if (existsSync(file)) {
    const have = readFileSync(file, "utf8");
    if (!sampled(key)) {
      note("hit");
      return have;
    }
    const t = performance.now();
    const fresh = transpile(source, url);
    if (fresh !== have) {
      note("mismatch");
      try {
        mkdirSync(join(store, "mismatches"), { recursive: true });
        writeFileSync(
          join(store, "mismatches", `transpile-${key}.json`),
          JSON.stringify({ kind: "transpile", url, pid: process.pid }),
        );
      } catch {
        // the throw below says it anyway
      }
      throw new Error(
        `the build store's transpile of ${url} was made again and differs from what was stored`,
      );
    }
    note("verified", performance.now() - t);
    return fresh;
  }
  const out = transpile(source, url);
  note("miss");
  try {
    mkdirSync(join(kept, key.slice(0, 2)), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch {
    // not kept: still right
  }
  return out;
}

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(new URL(url), "utf8");
    return { format: "module", source: transpiled(source, url), shortCircuit: true };
  },
});
