// Rule: closure selected among known targets at run time: a tag and a switch on it.
// expect-tir: switch
type Op = (a: number) => void;
export function select(which: number, n: number): number {
  let acc = 1;
  const add: Op = (a) => {
    acc += a;
  };
  const mul: Op = (a) => {
    acc *= a;
  };
  const clear: Op = (_a) => {
    acc = 0;
  };
  const op: Op = which === 0 ? add : which === 1 ? mul : clear;
  for (let i = 1; i <= (n | 0); i++) op(i);
  return acc;
}
export function reassign(flag: boolean): number {
  const a = (x: number): number => x + 1;
  const b = (x: number): number => x * 10;
  let f = a;
  if (flag) f = b;
  return f(4);
}
