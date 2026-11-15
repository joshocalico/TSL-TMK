// expect: TSL3009 at 16:10
// expect-msg: a was moved at 15:14
import { type u32, type usize } from "@tsl/core";
import { Rc, Visit } from "@tsl/gc";
class Node {
  constructor(public v: u32) {}
}
function releaseNode(_n: Node, _at: usize, _op: Visit): usize { return 0; }
const nodes = new Rc<Node>(releaseNode);
export function f(flag: boolean): u32 {
  const a = nodes.make(new Node(1));
  if (flag) {
    return 0;
  }
  nodes.drop(a);
  return a.v;
}
