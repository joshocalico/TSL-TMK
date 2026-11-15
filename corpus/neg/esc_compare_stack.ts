// expect: TSL2020 at 6:10
class Item {}
export function f(): boolean {
  const a = new Item();
  const b = new Item();
  return a === b;
}
