// Which classes can be in a cycle (SPEC 3.5, D41, R1c): the type graph `@tsl/gc`'s cycle collector is told about. A
// node is a class declaration that isn't generic; an edge goes from a class to every class a field of it can refer to,
// through unions, `Counted<T>`, and the type arguments of what it holds (a `Vec<T>`, an `Rc<T>`, anything generic), as
// what a field holds in place is the holder's own. A class is in a cycle if its strongly connected component has two
// classes or an edge to itself, and that component's number, from 1, is its *group*: `cycleGroup<T>()` natively, a
// constant. A scan of the collector follows a reference only within one group, so a ring holding a long-lived object
// of another class doesn't drag that object's graph in. A class in no cycle is group 0, and nothing it does reaches the
// collector. A mistake here can only make an edge look external, which leaks, and can't free anything (D41).
//
// The numbering is deterministic: components in the order Tarjan's algorithm closes them, over classes sorted by file
// and position, so the host's simulation, given the same table by class name, decides exactly as native code does.
import ts from "typescript";
import { findTslJson } from "./program.ts";
import { isRcModule } from "./expand-rc.ts";

interface Graph {
  groups: Map<ts.ClassDeclaration, number>;
  byName: Map<string, number>; //  for the host: a class's group by its name (a name two classes share is ambiguous)
  ambiguous: Set<string>;
  counted: boolean; //             some counted class is in a cycle: the collector is linked
  countedSet: Set<ts.ClassDeclaration>; // what's counted: an rc package's classes, and every Rc<T>'s T
}

const cache = new WeakMap<ts.Program, Graph>();

function isGenericClass(d: ts.ClassDeclaration): boolean {
  return (d.typeParameters?.length ?? 0) > 0;
}

function classDeclsOf(
  t: ts.Type,
  checker: ts.TypeChecker,
  out: Set<ts.ClassDeclaration>,
  depth = 0,
): void {
  if (depth > 8) return;
  if (t.isUnion() || t.isIntersection()) {
    for (const u of t.types) classDeclsOf(u, checker, out, depth + 1);
    return;
  }
  for (const a of t.aliasTypeArguments ?? []) classDeclsOf(a, checker, out, depth + 1);
  const s = t.getSymbol();
  for (const d of s?.declarations ?? []) if (ts.isClassDeclaration(d)) out.add(d);
  const flags = (t as ts.ObjectType).objectFlags ?? 0;
  if ((flags & ts.ObjectFlags.Reference) !== 0 && (t as ts.TypeReference).target !== undefined)
    for (const a of checker.getTypeArguments(t as ts.TypeReference))
      classDeclsOf(a, checker, out, depth + 1);
}

/** Whether the collector is on for the program rooted at `root`: `"cycles"` in its package, on by default (D41). */
export function cyclesEnabled(root: string): boolean {
  const env = process.env.TMK_TEST_RC_CYCLES;
  if (env === "off") return false;
  if (env === "on") return true;
  return findTslJson(root)?.cycles !== false;
}

/** The type graph's groups for a program, computed once. With the collector off, every class is group 0. */
export function cycleGraph(program: ts.Program, root: string): Graph {
  const hit = cache.get(program);
  if (hit !== undefined) return hit;
  const checker = program.getTypeChecker();
  const decls: ts.ClassDeclaration[] = [];
  const countedTs: ts.Type[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name !== undefined && !isGenericClass(n)) decls.push(n);
    // `new Rc<T>(…)`: T is counted, so its being in a cycle links the collector
    if (ts.isNewExpression(n) && n.expression.getText() === "Rc" && n.typeArguments?.length === 1)
      countedTs.push(checker.getTypeFromTypeNode(n.typeArguments[0]!));
    ts.forEachChild(n, visit);
  };
  const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile);
  files.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  for (const f of files) visit(f);
  const index = new Map(decls.map((d, i) => [d, i]));
  const edges: number[][] = decls.map(() => []);
  decls.forEach((d, i) => {
    const out = new Set<ts.ClassDeclaration>();
    for (const m of d.members) {
      if (
        ts.isPropertyDeclaration(m) &&
        !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static)
      )
        classDeclsOf(checker.getTypeAtLocation(m.name), checker, out);
      if (ts.isConstructorDeclaration(m))
        for (const p of m.parameters)
          if (ts.isParameterPropertyDeclaration(p, m))
            classDeclsOf(checker.getTypeAtLocation(p.name), checker, out);
    }
    for (const t of out) {
      const j = index.get(t);
      if (j !== undefined) edges[i]!.push(j);
    }
  });
  // Tarjan's strongly connected components, iteratively
  const groups = new Map<ts.ClassDeclaration, number>();
  const on = cyclesEnabled(root);
  const idx = Array.from({ length: decls.length }, () => -1);
  const low = Array.from({ length: decls.length }, () => 0);
  const onStack = Array.from({ length: decls.length }, () => false);
  const stack: number[] = [];
  let next = 0;
  let group = 0;
  for (let s = 0; s < decls.length; s++) {
    if (idx[s] !== -1) continue;
    const work: [number, number][] = [[s, 0]];
    idx[s] = low[s] = next++;
    stack.push(s);
    onStack[s] = true;
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const [v, ei] = top;
      if (ei < edges[v]!.length) {
        top[1]++;
        const w = edges[v]![ei]!;
        if (idx[w] === -1) {
          idx[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v]!, idx[w]!);
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const u = work[work.length - 1]![0];
        low[u] = Math.min(low[u]!, low[v]!);
      }
      if (low[v] === idx[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
          if (w === v) break;
        }
        const cyclic = comp.length > 1 || edges[v]!.includes(v);
        if (cyclic && on) {
          group++;
          for (const w of comp) groups.set(decls[w]!, group);
        }
      }
    }
  }
  const countedSet = new Set<ts.ClassDeclaration>();
  for (const d of decls) if (isRcModule(d.getSourceFile().fileName)) countedSet.add(d);
  for (const t of countedTs) classDeclsOf(t, checker, countedSet);
  let counted = false;
  for (const d of countedSet) if ((groups.get(d) ?? 0) !== 0) counted = true;
  const byName = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const d of decls) {
    if (!countedSet.has(d)) continue;
    const n = d.name!.text;
    const g = groups.get(d) ?? 0;
    if (byName.has(n) && byName.get(n) !== g) ambiguous.add(n);
    byName.set(n, g);
  }
  const g: Graph = { groups, byName, ambiguous, counted, countedSet };
  cache.set(program, g);
  return g;
}

/** A class's group: 0 if it can't be in a cycle, or the collector is off. */
export function cycleGroupOf(program: ts.Program, root: string, decl: ts.ClassDeclaration): number {
  return cycleGraph(program, root).groups.get(decl) ?? 0;
}

/** The table the host's simulation of `cycleGroupOf` reads, by class name (`TSL_CYCLE_GROUPS`, JSON). */
export function hostCycleTable(program: ts.Program, root: string): Record<string, number> {
  const g = cycleGraph(program, root);
  if (g.ambiguous.size > 0)
    throw new Error(`classes named alike in different groups: ${[...g.ambiguous].join(", ")}`);
  const out: Record<string, number> = {};
  for (const [n, v] of g.byName) if (v !== 0) out[n] = v;
  return out;
}
