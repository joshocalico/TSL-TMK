// The test that matters (SPEC 4.5): closures stored in an array, each with its own iteration's binding.
export function storeClosure(n: number): number {
  const fs: ((x: number) => number)[] = [];
  for (let i = 0; i < 3; i++) fs.push((x) => x + i);
  let t = n;
  for (const f of fs) t = f(t);
  return t;
}
