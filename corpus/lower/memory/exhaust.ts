// memory-pages: 16
// Running out against a small page limit traps with code 14, and V8 has no such limit (SPEC 3.10, divergence 4).
class Cell {
  next: Cell | null = null;
  constructor(public v: number) {}
}
let head: Cell | null = null;
let bytes = new Uint8Array(1);

export function fits(n: number): number {
  for (let i = 0; i < (n | 0); i++) {
    const c = new Cell(i);
    c.next = head;
    head = c;
  }
  let k = 0;
  for (let c = head; c !== null; c = c.next) k++;
  return k;
}

export function keepsWorking(): number {
  return head === null ? -1 : head.v;
}

export function tooMany(n: number): number {
  return fits(n);
}

export function tooLarge(n: number): number {
  bytes = new Uint8Array(n | 0);
  return bytes.length;
}
