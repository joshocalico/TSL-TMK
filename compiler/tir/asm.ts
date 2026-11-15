// A small assembler for hand-written TIR: canonical text with names for values and blocks, so a
// helper can be read and edited without renumbering. `%name` and `bb_name` become numbers in order
// of first appearance; everything else is parsed by text.ts as usual.
import type { Module } from "./ir.ts";
import { parseModule } from "./text.ts";

export function assemble(text: string): Module {
  const out: string[] = [];
  let vals = new Map<string, number>();
  let blocks = new Map<string, number>();
  const name = (m: Map<string, number>, n: string): number => {
    let id = m.get(n);
    if (id === undefined) {
      id = m.size;
      m.set(n, id);
    }
    return id;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/;.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (line.startsWith("func ")) {
      vals = new Map();
      blocks = new Map();
    }
    out.push(
      line
        .replace(/%([a-z_]\w*)/g, (_, n: string) => `%${name(vals, n)}`)
        .replace(/\bbb_(\w+)/g, (_, n: string) => `bb${name(blocks, n)}`),
    );
  }
  return parseModule(`${out.join("\n")}\n`);
}
