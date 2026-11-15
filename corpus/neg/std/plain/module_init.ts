// Naming an allocator isn't a way to run code as a module loads: nothing else is.
// expect: TSL1010 at 5:1
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
new Vec(u32);
