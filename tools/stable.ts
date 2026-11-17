// Stable orders for what a box's detail quotes (R20). A suite that runs its programs on a pool collects failures, rows and
// counts in the order its jobs finish, and a detail that quoted "the first failure", or printed a count map as it was
// filled, said something different from run to run with every count the same (R19's sample: lang-a/9, pipe-d/39). The
// order is fixed here, where the lists are made, not by loosening the gate's comparison (tools/gate.ts normalizeDetail).

/**
 * Text order with runs of digits compared as numbers: "a.ts f#2" before "a.ts f#10", so failures sort by file, then mode
 * and level, then function and case index, as they're written. Not locale-dependent: code units outside the digit runs.
 */
export function naturalCompare(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? [];
  const rb = b.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i]!;
    const y = rb[i]!;
    if (x === y) continue;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      // As numbers, without a parse that loses digits: shorter (leading zeros aside) is smaller.
      const sx = x.replace(/^0+(?=\d)/, "");
      const sy = y.replace(/^0+(?=\d)/, "");
      if (sx.length !== sy.length) return sx.length - sy.length;
      if (sx !== sy) return sx < sy ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (ra.length !== rb.length) return ra.length - rb.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Sorts a list of texts in place into the stable order, and returns it. */
export function inStableOrder<T extends string>(xs: T[]): T[] {
  return xs.sort(naturalCompare);
}

/** The first of a list in the stable order (not the first pushed), or undefined for an empty list. */
export function firstInOrder(xs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const x of xs) if (best === undefined || naturalCompare(x, best) < 0) best = x;
  return best;
}

/** A copy of a record with its keys in the stable order, so `JSON.stringify` or `Object.entries` print it the same each run. */
export function sortedCounts<V>(r: Readonly<Record<string, V>>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of Object.keys(r).sort(naturalCompare)) out[k] = r[k]!;
  return out;
}
