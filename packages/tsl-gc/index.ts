// @tsl/gc: reference counting as ordinary TSL library code (SPEC 3.5, D63). Pause-free, with no tracing collector: an
// object goes when its count reaches zero, freed a bounded number of steps at a time. The module below is the spec's
// `// file:` block, byte for byte, and tools/spec-extract.ts checks it stays so.
export {
  Rc,
  RC_BUDGET,
  rcAllocSteps,
  rcCcFreed,
  rcCcGaveUp,
  rcCcScans,
  rcCcSteps,
  rcCcTouched,
  rcCcWalks,
  rcCollect,
  rcLive,
  rcScanning,
  rcSetBudget,
  rcSetPacing,
  rcSetWalk,
  rcSteps,
  Room,
  roomAddr,
  roomDrop,
  roomMake,
  Visit,
  Weak,
  type Counted,
  type Release,
} from "./ex-gc-rc.ts";
export { JsRoomArray } from "./ex-gc-roomarray.ts";
