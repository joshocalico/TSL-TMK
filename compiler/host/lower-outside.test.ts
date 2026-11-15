// `tmk lower` takes any strict TS file (SPEC 4.5), including one outside the repo with no package.json.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lowerFile } from "./tslc.ts";

test("lowers a file outside the repo, with its relative imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmk-outside-"));
  try {
    writeFileSync(join(dir, "z.ts"), "export function h(x: number): number { return x * 2; }\n");
    writeFileSync(
      join(dir, "y.ts"),
      'import { h } from "./z.ts";\nexport function g(x: number): number { return h(x) + 1; }\n',
    );
    const o = lowerFile(join(dir, "y.ts"));
    assert.deepEqual(o.diags, []);
    assert.equal(o.fallbackDiags.length, 0);
    assert.ok(o.tirText.includes("func @g("));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
