// The real package by a relative path: the path gives it away.
// expect: TSL1018 at 3:1
import { Vec } from "../../../../packages/tsl-std/index.ts";
export type V = Vec<number>;
