// expect: TSL3009 at 19:12
// expect-msg: h was moved at 20:53
import { type u32, type usize } from "@tsl/core";
import { Rc, Visit, type Counted } from "@tsl/gc";
class Node {
  next: Counted<Node> | null = null;
  constructor(public v: u32) {}
}
function releaseNode(n: Node, at: usize, op: Visit): usize {
  const next = n.next;
  if (at === 0 && next !== null) nodes.visit(next, op); return 1;
}
const nodes = new Rc<Node>(releaseNode);
export function f(n: u32): u32 {
  const head = nodes.make(new Node(0));
  const h = nodes.make(new Node(1));
  let sum: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    sum += h.v;
    head.next = nodes.replace(head.next, nodes.take(h));
  }
  nodes.drop(head);
  return sum;
}
