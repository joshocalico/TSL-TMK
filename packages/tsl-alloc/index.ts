// @tsl/alloc: allocation as ordinary TSL library code (SPEC 3.5, D30). The three modules below are the spec's
// `// file:` blocks, byte for byte, and tools/spec-extract.ts checks they stay so.
export { alloc, copyElems, free, Heap, PAGE, type PageSource } from "./ex-heap.ts";
export { Slab } from "./ex-slab.ts";
export { Vec } from "./ex-vec.ts";
// A Vec of references needs this descriptor, and it isn't a memory operation, so safe code can have it here.
export { ref } from "@tsl/unsafe";
