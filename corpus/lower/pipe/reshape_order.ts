// R14 (pile item 9): the reshapes `auto` trusts, each where the order of what runs shows in the result. A statement-
// expression (an inlined callback is a loop; a pop is a branch) after an operand with an effect, on the right of && and ||,
// in an arm of ?:, and in a sequence after its first part. A counter records which parts ran, and in which order, and no
// loop's condition or step has one, so `auto` takes the program reshaped.
let trace = 0;

function note(d: number): number {
  trace = (trace * 10 + d) % 1000000007;
  return d;
}

class Box {
  v = 0;
  items: number[] = [];
}

const box = new Box();

export function operands(k: number): number {
  trace = 0;
  const a = [5, 4, 3, 2, 1];
  const r = note(1) * 100 + a.filter((v) => v > (k | 0) + note(2)).length * 10 + note(3);
  return r * 10000 + (trace % 10000);
}

export function logical(k: number): number {
  trace = 0;
  const a = [3, 1, 4, 1, 5, 9, 2, 6];
  const x = (k | 0) > 2 && a.findIndex((v) => v === (k | 0) + note(2)) >= 0;
  const y = (k | 0) < 2 || a.filter((v) => v > (k | 0) + note(3)).length > 2;
  return (x ? 1 : 0) + (y ? 10 : 0) + trace * 100;
}

export function arms(k: number): number {
  trace = 0;
  const a = [3, 1, 4, 1, 5];
  const z =
    (k | 0) % 2 === 0 ? a.map((v) => v + note(4)).length : a.filter((v) => v > note(5)).length;
  return z * 1000000 + trace;
}

export function sequence(k: number): number {
  trace = 0;
  box.items = [note(1), note(2), k | 0];
  box.v = note(3) + (box.items.pop() ?? note(9)) * 10;
  const w = note(4) + box.items.length * 100 + (box.items.pop() ?? 0);
  return box.v * 1000 + w + trace * 100000;
}
