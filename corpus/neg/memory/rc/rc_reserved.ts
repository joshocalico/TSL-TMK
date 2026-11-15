// "memory": "rc" was reserved for lowered code until D74; tslc now expands an rc package onto @tsl/gc, and what's written
// there is still TSL proper, checked where it's written, before anything is expanded.
// expect: TSL2005 at 4:22
export function f(): number {
  return 1;
}
