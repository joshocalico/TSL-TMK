// Checks tools/deps.ts against what a job really ran (SPEC 8.3, D51): run under NODE_V8_COVERAGE, every function of tools/
// that ran in the job's process, its workers or its children has to be in the unit's dependencies, as a node or as a file
// reached whole. `node tools/deps-check.ts <coverage dir> <milestone> <unit>`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { analysable, INIT, moduleInfo, nodeAt } from "./deps.ts";
import { fineUnitDeps, HARNESS, loadDef } from "./registry.ts";

const ROOT = join(fileURLToPath(import.meta.url), "../..");

export async function checkCoverage(
  dir: string,
  milestone: string,
  unit: string,
): Promise<{ ran: number; missing: string[] }> {
  const def = await loadDef(milestone);
  const slot = def.units().find((u) => u.id === unit);
  if (slot === undefined) throw new Error(`no unit ${unit} in ${milestone}`);
  const deps = fineUnitDeps(def, slot);
  const ran = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const cov = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      result: {
        url: string;
        functions: { functionName: string; ranges: { startOffset: number; count: number }[] }[];
      }[];
    };
    for (const s of cov.result) {
      if (!s.url.startsWith("file://")) continue;
      const file = relative(ROOT, fileURLToPath(s.url));
      if (!analysable(file)) continue;
      const m = moduleInfo(file);
      if (m === null) continue;
      for (const fn of s.functions) {
        const r = fn.ranges[0];
        if (r === undefined || r.count === 0) continue;
        // The module's own function is its top-level code.
        const name =
          fn.functionName === "" && r.startOffset === 0 ? INIT : nodeAt(m, r.startOffset);
        ran.add(`${file}#${name}`);
      }
    }
  }
  const missing = [...ran].filter((n) => {
    const file = n.slice(0, n.lastIndexOf("#"));
    // The harness's own files select everything when they change.
    if (HARNESS.includes(file)) return false;
    return !deps.nodes.has(n) && !deps.nodes.has(`${file}#*`) && !deps.files.has(file);
  });
  return { ran: ran.size, missing };
}

if (import.meta.main) {
  const [dir, m, u] = process.argv.slice(2) as [string, string, string];
  const r = await checkCoverage(dir, m, u);
  console.log(
    `${m}/${u}: ${r.ran} nodes ran, ${r.missing.length} not in its dependencies${r.missing.length > 0 ? `:\n  ${r.missing.join("\n  ")}` : ""}`,
  );
  process.exit(r.missing.length === 0 ? 0 : 1);
}
