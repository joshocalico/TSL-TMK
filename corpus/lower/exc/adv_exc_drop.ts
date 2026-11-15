// rc-stack: 65536
// A million-node list held only by a frame that an exception leaves, and another carried by the thrown error itself and
// dropped when the catch is done: the freeing bound holds with exceptions flowing (SPEC 3.5, D39, D49).
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}

class Loaded extends Error {
  constructor(public payload: Node | null) {
    super("loaded");
  }
}

function build(n: number): Node | null {
  let h: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  return h;
}

function holdAndThrow(n: number): number {
  const local = build(n);
  if (local !== null) throw new RangeError(`dropping ${local.v + 1}`);
  return 0;
}

export function frameDrop(n: number): string {
  try {
    return `none ${holdAndThrow(n)}`;
  } catch (e) {
    return e instanceof Error ? e.message : "?";
  }
}

export function errorDrop(n: number): number {
  try {
    throw new Loaded(build(n));
  } catch (e) {
    if (e instanceof Loaded && e.payload !== null) return e.payload.v;
    return -1;
  }
}

export function allocAfter(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + new Node(i).v) | 0;
  return t;
}
