// What a call that throws must not let happen after it (SPEC 4.5, D49): each call to a function that can throw is followed
// at once by an effect on module state, a store or a push, with no other call in between. A missing test after a call
// would let that effect happen, where in V8 the exception has already left; everything else in the corpus has a later call
// that sees the exception still in flight, which hides a missing test.
const trail: number[] = [];
let count = 0;

class Fault extends Error {}

function boom(n: number, at: number): number {
  if (n === at) throw new Fault("boom");
  return n;
}

class Acc {
  total = 0;
  add(n: number, at: number): void {
    if (n === at) throw new Fault("add");
    this.total += n;
  }
}

function stepA(at: number): void {
  const x = boom(1, at);
  trail.push(x);
  const y = boom(2, at);
  count += 7 + y;
  const z = boom(3, at);
  trail.push(z * 10);
}

function stepB(at: number, acc: Acc): void {
  acc.add(4, at);
  trail.push(4);
  acc.add(5, at);
  count += 5;
  const w = boom(6, at);
  acc.total += w;
  trail.push(acc.total);
}

function stepC(at: number): number {
  let s = 0;
  for (let i = 7; i <= 9; i++) {
    s += boom(i, at);
    trail.push(s);
  }
  return s;
}

export function run(at: number): number {
  trail.length = 0;
  count = 0;
  const acc = new Acc();
  let caught = 0;
  try {
    stepA(at);
    stepB(at, acc);
    stepC(at);
  } catch {
    caught = 1;
  }
  let sum = count * 1000 + caught * 100000 + acc.total;
  for (const t of trail) sum = sum * 3 + t;
  return sum;
}
