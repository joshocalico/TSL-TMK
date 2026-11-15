// One of its modules directly.
// expect: TSL1018 at 3:1
import { Slab } from "../../../../packages/tsl-std/ex-std-slab.ts";
export type S = Slab<object>;
