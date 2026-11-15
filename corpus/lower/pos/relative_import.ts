// Relative imports resolve through the checker, so a whole module graph lowers together.
import { FACTOR, scale, STATIC, type Pt } from "../lib/helper.ts";
export function viaImport(a: number): number {
  const p: Pt = { x: a | 0 };
  return scale(p) + FACTOR + STATIC[1]!;
}
