// `--changed`'s declarations (tools/deps.ts, D76): a change shows in the node it's in, and only there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFINE, INIT, MAIN, parseModule } from "./deps.ts";

const ms = `import { timedModule as helper } from "../timing.ts";
const LIST = ["a", "b"];
const STARTED = Date.now();
export function used(): number { return LIST.length; }
export async function defineX(M: any): Promise<void> {
  const shared = 1;
  // a box
  M.unit("1", async () => { used(); });
  M.unit("2", async () => { helper(shared); });
}
if (import.meta.main) { used(); }
`;
const hashes = (t: string): Map<string, string> =>
  new Map([...parseModule("tools/milestones/x.ts", t).nodes].map(([k, v]) => [k, v.hash]));
const changed = (a: string, b: string): string[] => {
  const x = hashes(a);
  const y = hashes(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).sort();
};

test("a unit's own block, the shared define code and the module's own code are nodes", () => {
  const m = parseModule("tools/milestones/x.ts", ms);
  assert.ok(
    m.nodes.has("unit:1") && m.nodes.has("unit:2") && m.nodes.has(DEFINE) && m.nodes.has(MAIN),
  );
  assert.ok(m.nodes.get("unit:1")!.refs.has("tools/milestones/x.ts#used"));
  assert.ok(m.nodes.get("unit:2")!.refs.has("tools/timing.ts#\0timedModule"));
  // Date.now() runs at load: the module's own code. A plain list is only its readers'.
  assert.ok(m.nodes.get(INIT)!.refs.has("tools/milestones/x.ts#STARTED"));
  assert.ok(!m.nodes.get(INIT)!.refs.has("tools/milestones/x.ts#LIST"));
  // Code only the module run as a script runs isn't loaded with it.
  assert.ok(!m.nodes.get(INIT)!.refs.has("tools/milestones/x.ts#used"));
});

test("an edit shows in its own node: a box, a box added, a constant, the shared code", () => {
  assert.deepEqual(changed(ms, ms.replace("used(); });", "used(); used(); });")), ["unit:1"]);
  assert.deepEqual(
    changed(ms, ms.replace('  M.unit("2"', '  M.unit("3", async () => {});\n  M.unit("2"')),
    ["unit:3"],
  );
  assert.deepEqual(changed(ms, ms.replace('"b"]', '"c"]')), ["LIST"]);
  assert.deepEqual(changed(ms, ms.replace("shared = 1", "shared = 2")), [DEFINE]);
});

test("whitespace and comments change no node", () => {
  assert.deepEqual(
    changed(
      ms,
      ms.replace("// a box", "// a box, renamed").replace("  const shared", "\n\n  const shared"),
    ),
    [],
  );
});
