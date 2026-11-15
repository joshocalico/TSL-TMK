// expect: TSL3001 at 10:3
// expect-msg: stored by its own constructor
let last: Item | null = null;
class Item {
  constructor() {
    last = this;
  }
}
export function f(): void {
  new Item();
}
