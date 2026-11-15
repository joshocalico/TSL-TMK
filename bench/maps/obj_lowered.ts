// Object keys, no strings (strkeys, D72): the maps benchmarks' work, a table grown to n, read, then a mix of sets, gets and
// deletes, then iterated, with every key an object, the same by identity. So `Map<Node, Node>` and `Set<Node>` printed as
// @tsl/jsrt's JsMap and JsSet are judged on their own, apart from string keys. Each takes a size and gives a digest, which
// the harness compares with V8's.
class Node {
  constructor(public id: number) {}
}

function lcg(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}

export function objWork(n: number): number {
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push(new Node(i));
  const m = new Map<Node, Node>();
  // Growth, through every move: each node's value the next one.
  for (let i = 0; i < n; i++) m.set(nodes[i]!, nodes[(i + 1) % n]!);
  let h = 0;
  // Gets of what's there.
  for (let i = 0; i < n; i++) {
    const v = m.get(nodes[i]!);
    if (v !== undefined) h = (h + v.id) | 0;
  }
  // Sets, gets and deletes mixed.
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = lcg(x);
    const k = nodes[x % n]!;
    const op = (x >>> 27) & 3;
    if (op <= 1) m.set(k, nodes[i]!);
    else if (op === 2) {
      const v = m.get(k);
      if (v !== undefined) h = (h + v.id) | 0;
    } else m.delete(k);
  }
  // Iteration, in insertion order.
  for (const [k, v] of m) h = (Math.imul(h, 31) + k.id + v.id) | 0;
  const s = new Set<Node>();
  for (let i = 0; i < n; i++) s.add(nodes[(i * 13) % (n >> 1)]!);
  for (const k of s) h = (h + k.id) | 0;
  return (h + m.size + s.size) | 0;
}
