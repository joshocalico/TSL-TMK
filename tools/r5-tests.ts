// R5 (SPEC 4.5's native ABI, D36): exported functions taking or giving objects through the TSL route, each class that
// crosses laid out at D36's listed offsets (checked by tslc), each array placed by an export of the module's own. The bugs
// put into each new transform, and what catches each: the dual route (r2-tests.ts's runner) or tslc's layout check.
import { relative } from "node:path";
import type { R2Fault } from "./r2-tests.ts";
import { ROOT } from "./corpus.ts";

/** The programs whose exports take and give objects and arrays, each printed through the TSL route since R5. */
export const R5_PROGRAMS = [
  "corpus/lower/pipe/boundary.ts",
  "corpus/lower/memory/cycles.ts",
  "corpus/lower/pos/control_flow.ts",
  "corpus/lower/pos/nullable_field_order.ts",
  "corpus/lower/pos/wrap_forms.ts",
  "corpus/lower/pos/object_shape.ts",
  "bench/memory/boundary_lowered.ts",
];

export const R5_FAULTS: R2Fault[] = [
  {
    name: "boundary-unchecked",
    what: "a class crossing an export printed with its first two fields the other way round, so TSL lays each out where D36 lists the other (R6), and tslc's layout check skipped, so the native caller writes a field where the module doesn't read it",
    transform:
      "the printing's layout of a class crossing an export (layBoundary), with tslc's check (checkBoundary) off",
    where: "printer",
    dirs: ["corpus/lower/pipe"],
    modes: ["leak", "manual"],
    classes: true,
    only: "boundary",
  },
  {
    name: "vec-place-long",
    what: "an array a native caller passes placed one hole longer than it asked for",
    transform: "each boundary array's placing export (__vec_place_<id>)",
    where: "printer",
    dirs: ["corpus/lower/pipe"],
    modes: ["leak", "manual"],
    classes: true,
    only: "boundary",
  },
  {
    name: "dead-tail-live",
    what: "the live return before the lowering's dead one left out with it, so the function runs off its end",
    transform: "the lowering's return of nothing after a return, not printed (deadTail)",
    where: "printer",
    dirs: ["corpus/lower/pipe"],
    modes: ["leak", "manual"],
    classes: true,
    only: "boundary",
  },
];

/**
 * The bug tslc's layout check catches, apart from the dual route, which never sees it run: a class crossing an export laid
 * out by TSL's rule. Every such build of R5's programs has to be refused (the reference builds it), naming the field.
 */
export const R5_CHECK_FAULT = {
  name: "boundary-reorder",
  what: "a class crossing an export printed with its first two fields the other way round, so TSL lays each out where D36 lists the other (R6; R5's was a class with no padding after a bool, which since R6 is D36's own layout)",
  transform:
    "the printing's layout of a class crossing an export (layBoundary), against tslc's check",
};

/** R5_CHECK_FAULT through tslc: each R5 program with a class of two fields or more crossing, how many builds the check refused. */
export async function checkFaultRun(): Promise<{ refused: number; builds: number; first: string }> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const was = process.env.TMK_TEST_EMIT;
  process.env.TMK_TEST_EMIT = R5_CHECK_FAULT.name;
  let refused = 0;
  let builds = 0;
  let first = "";
  try {
    for (const rel of ["corpus/lower/pipe/boundary.ts", "bench/memory/boundary_lowered.ts"])
      for (const memory of ["leak", "manual"]) {
        builds++;
        try {
          lowerFile(`${ROOT}/${rel}`, { memory, opt: 2, route: "tsl", classes: true });
          first ||= `${relative(ROOT, `${ROOT}/${rel}`)} in ${memory} built`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/crossing an export .* where D36 lists \d+ \(R5\)/.test(msg)) refused++;
          else first ||= msg.slice(0, 200);
        }
      }
  } finally {
    if (was === undefined) delete process.env.TMK_TEST_EMIT;
    else process.env.TMK_TEST_EMIT = was;
  }
  return { refused, builds, first };
}
