// R14's micro-benchmark (pile item 9): one function per reshape `auto` trusts, each a loop whose body holds the lowering's
// statement-expression (an inlined callback is a loop; a pop is a branch) where the printer has to reshape it: after an
// operand with an effect, on the right of &&, in an arm of ?:, and in a sequence after its first part. Each takes a count
// and gives a number V8 gives too (`tmk bench memory --reshapes`). Nothing outlives a call, so `strict` lowers it too.
let tick = 0;

function bump(d: number): number {
  tick = (tick + d) | 0;
  return d;
}

class Bag {
  v = 0;
  items: number[] = [];
}

function tableOf(): number[] {
  return [9, 3, 7, 1, 8, 2, 6, 4, 5, 0];
}

export function operandWork(n: number): number {
  const table = tableOf();
  let s = 0;
  for (let i = 0; i < (n | 0); i++)
    s = (s + bump(i & 7) * 3 + table.filter((v) => v > (i & 7)).length) | 0;
  return s + tick;
}

export function logicalWork(n: number): number {
  const table = tableOf();
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    const k = i & 15;
    if (k > 3 && table.some((v) => v === k - 4)) s = (s + k) | 0;
  }
  return s;
}

export function armWork(n: number): number {
  const table = tableOf();
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    const k = i & 15;
    s =
      (s + (k % 2 === 0 ? table.findIndex((v) => v === k >> 1) : table.findIndex((v) => v > k))) |
      0;
  }
  return s;
}

export function sequenceWork(n: number): number {
  const bag = new Bag();
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    bag.items.push(i & 31);
    bag.v = bump(1) + (bag.items.pop() ?? 0) * 2;
    s = (s + bag.v) | 0;
  }
  return s + tick;
}
