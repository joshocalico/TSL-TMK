// Where a run writes its scratch (SPEC 9.2): `build/`, or, for one job of `tmk gate`, that job's own directory under
// `build/jobs/`, named by TMK_BUILD_DIR, so jobs running at once never share a file: images, logs, the QEMU record, fuzz
// programs. Nothing in it is read by another job. `build/cache/v8` stays shared: V8 keys it on the source.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const BUILD = process.env.TMK_BUILD_DIR ?? join(ROOT, "build");

export function buildPath(...parts: string[]): string {
  return join(BUILD, ...parts);
}
