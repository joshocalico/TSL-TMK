// Unreached functions and globals removed (SPEC 4.3, D73, R1d). A module is a set of functions and globals that the
// runtime, the drivers and other modules find by name, so what may go is decided from roots: every function marked
// `export` (a TSL module's exports, which include `@tsl.export-c`'s), and every function and global whose name starts
// with `__`, which is how the runtime and the drivers name what they call (`__init`, `__statics`, `__heap_alloc`, a
// page source's `__pages_*`, `__rc_*`). From the roots, any symbol an instruction names is reached: a call, a function's
// address taken (`funcaddr`, so a function value or a page source stays), a global's address. A function nothing reaches
// goes. A global goes only if something named it before and nothing that's left does, so a global no function names, which
// a driver may read by name, stays. Only for modules whose producer asks for it (tslc's, `OptOptions.prune`), at -O1 and
// -O2: -O0's module is the input untouched, and its tirhash with it.
import type { Module } from "../ir.ts";

export interface UnreachedStats {
  funcs: number; // functions removed
  globals: number; // globals removed
}

export interface UnreachedFaults {
  /** `tmk milestone pipe-d`'s injected bug: a name the runtime calls (`__...`) isn't a root, only exports are. */
  dropRuntime?: boolean;
}

function isRuntimeName(name: string): boolean {
  return name.startsWith("__");
}

export function removeUnreached(
  m: Module,
  stats: UnreachedStats,
  faults: UnreachedFaults = {},
): boolean {
  const funcs = new Map(m.funcs.map((f) => [f.name, f]));
  const named = new Set<string>(); // every symbol any function names, before
  const reached = new Set<string>();
  const work: string[] = [];
  const reach = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    if (funcs.has(name)) work.push(name);
  };
  for (const f of m.funcs) {
    if (f.attrs.includes("export") || (faults.dropRuntime !== true && isRuntimeName(f.name)))
      reach(f.name);
    for (const b of f.blocks)
      for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "sym") named.add(o.name);
  }
  for (let guard = 0; work.length > 0 && guard <= m.funcs.length; guard++) {
    const f = funcs.get(work.pop()!)!;
    for (const b of f.blocks)
      for (const ins of b.instrs) for (const o of ins.ops) if (o.t === "sym") reach(o.name);
  }
  const before = { funcs: m.funcs.length, globals: m.globals.length };
  m.funcs = m.funcs.filter((f) => reached.has(f.name));
  m.globals = m.globals.filter(
    (g) => reached.has(g.name) || !named.has(g.name) || isRuntimeName(g.name),
  );
  stats.funcs += before.funcs - m.funcs.length;
  stats.globals += before.globals - m.globals.length;
  return before.funcs !== m.funcs.length || before.globals !== m.globals.length;
}
