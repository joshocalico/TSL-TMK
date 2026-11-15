// @tsl/jsrt: JavaScript's run-time classes in TSL, for lowered code and for a person who wants JS's rules (D67). A `leak`
// package: what it makes is never freed, as lowered `leak` and `manual` code's strings never are (3.5, D42), so a method
// can return a new object. The modules below are the spec's `// file:` blocks, byte for byte, and tools/spec-extract.ts
// checks they stay so.
export { JsArray } from "./ex-jsrt-array.ts";
export {
  JsMap,
  JsMapCursor,
  JsMapGen,
  JsSet,
  jsKeyNum,
  jsMapKey,
  jsNumKey,
  type TableSteps,
} from "./ex-jsrt-map.ts";
export { JsBuf, JsFlat, JsView, jsEq } from "./ex-jsrt-string.ts";
export type { JsOwner, JsString } from "./ex-jsrt-string.ts";
