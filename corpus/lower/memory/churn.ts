// memory-pages: 96
// Far more allocated in total than 96 pages hold, with a small live set: what `rc` is for. `leak` runs out, as it says
// it does (SPEC 3.5), `manual`'s lowered form frees only an array's own old buffers, and `rc` completes under the same limit.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
let held: Node | null = null;
let heldArray: number[] = [];
let heldFn: () => number = (): number => 0;
let heldBytes = new Uint8Array(1);
const queue: Node[] = [];

export function objects(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = held;
    held = c;
    if (i % 8 === 7) held = null;
    t = (t + c.v) | 0;
  }
  held = null;
  return t;
}
export function arrays(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    heldArray = [i, i + 1, i + 2];
    t = (t + heldArray[1]!) | 0;
  }
  return t;
}
export function arraysOfObjects(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = [new Node(i), new Node(i + 1)];
    held = a[1]!;
    t = (t + a[0]!.v) | 0;
  }
  held = null;
  return t;
}
export function closures(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const p = new Node(i);
    heldFn = (): number => p.v + 1;
    t = (t + heldFn()) | 0;
  }
  heldFn = (): number => 0;
  return t;
}
export function mutatedCaptures(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    let c = i;
    heldFn = (): number => {
      c = c + 1;
      return c;
    };
    t = (t + heldFn()) | 0;
  }
  heldFn = (): number => 0;
  return t;
}
export function arraysGrowing(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a: number[] = [];
    for (let j = 0; j < 600; j++) a.push(j + i);
    heldArray = a;
    t = (t + a[599]!) | 0;
  }
  heldArray = [];
  return t;
}
export function typedArrays(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    heldBytes = new Uint8Array(1024);
    heldBytes[i % 1024] = 7;
    t = (t + heldBytes.subarray(i % 1024)[0]!) | 0;
  }
  return t;
}
export function queues(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    queue.push(new Node(i));
    if (queue.length > 16) t = (t + queue.shift()!.v) | 0;
  }
  while (queue.length > 0) t = (t + queue.shift()!.v) | 0;
  return t;
}
export function localsInALoop(n: number): number {
  // Nothing here escapes the call. In `leak` and `manual` each one is in the call arena until the caller resets it, so
  // this runs that out, at 96 MiB. It's why `rc` counts what a loop allocates (SPEC 4.5, D39).
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    t = (t + c.v) | 0;
  }
  return t;
}
