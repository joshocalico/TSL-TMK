// @tsl/std: the standard layer for TSL programs that aren't the kernel or a driver (SPEC 3.5, D43). The modules below
// are the spec's `// file:` blocks, byte for byte, and tools/spec-extract.ts checks they stay so.
export { globalAllocator, heap, ref, setHashKey } from "./ex-std-global.ts";
export { ExactMap, Map, Set } from "./ex-std-map.ts";
export { Slab } from "./ex-std-slab.ts";
export { Str, StrBuilder } from "./ex-std-str.ts";
export { Vec } from "./ex-std-vec.ts";
