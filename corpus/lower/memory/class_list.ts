// Linked lists and trees of classes that outlive the call that made them (SPEC 4.5).
class Node {
  next: Node | null = null;
  constructor(public value: number) {}
}

class Tree {
  left: Tree | null = null;
  right: Tree | null = null;
  constructor(public key: number) {}
  insert(k: number): void {
    if (k < this.key) {
      if (this.left === null) this.left = new Tree(k);
      else this.left.insert(k);
    } else if (this.right === null) this.right = new Tree(k);
    else this.right.insert(k);
  }
  sum(): number {
    return this.key + (this.left?.sum() ?? 0) + (this.right?.sum() ?? 0);
  }
  depth(): number {
    return 1 + Math.max(this.left?.depth() ?? 0, this.right?.depth() ?? 0);
  }
}

let head: Node | null = null;
let root: Tree | null = null;

function makeList(n: number): Node | null {
  let h: Node | null = null;
  for (let i = 0; i < n; i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  return h;
}

export function buildList(n: number): number {
  head = makeList(n | 0);
  return n | 0;
}

export function pushFront(v: number): void {
  const c = new Node(v);
  c.next = head;
  head = c;
}

export function sumList(): number {
  let t = 0;
  for (let c = head; c !== null; c = c.next) t += c.value;
  return t;
}

export function lengthList(): number {
  let k = 0;
  let c = head;
  while (c !== null) {
    k++;
    c = c.next;
  }
  return k;
}

export function insertTree(k: number): number {
  if (root === null) root = new Tree(k);
  else root.insert(k);
  return root.depth();
}

export function sumTree(): number {
  return root === null ? -1 : root.sum();
}

/** A list returned from a call that made it, used by the caller. */
export function localList(n: number): number {
  const l = makeList(n | 0);
  let s = 0;
  for (let c = l; c !== null; c = c.next) s = s * 2 + c.value;
  return s;
}
