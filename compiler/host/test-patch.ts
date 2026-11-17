// An injected bug's patch (TSL_TEST_PATCH, SPEC 8.3's fault rule, R18): the one place a patch's text is put into a source.
// A patch applies exactly as many times as it says (once unless `times` says more), or it's a harness failure: the bug
// it stands for isn't in the build, so nothing that fails afterwards can count as catching it.

export interface TestPatch {
  file: string; // a path under the repo, or the end of one (`ex-jsrt-map.ts`), matched at a `/`
  from: string; // the text the bug replaces, as it is in the source now
  to: string;
  times?: number; // how many times `from` is in the file, each replaced; 1 unless said
}

/** What every harness failure of a patch says, so a runner can tell it from a case the bug failed. */
export const PATCH_HARNESS = "TSL_TEST_PATCH:";

/** How many times `from` is in `text`, not overlapping. */
export function occurrences(text: string, from: string): number {
  if (from === "") return 0;
  let n = 0;
  for (let at = text.indexOf(from); at >= 0; at = text.indexOf(from, at + from.length)) n++;
  return n;
}

/** Whether a source file's name is the patch's file: the same path, or one ending in it at a `/`. */
export function patchNames(fileName: string, p: TestPatch): boolean {
  return fileName === p.file || fileName.endsWith(`/${p.file}`);
}

/** Why the patch doesn't apply to `text` as it says, or undefined if it does. */
export function patchProblem(text: string, p: TestPatch): string | undefined {
  const want = p.times ?? 1;
  const n = occurrences(text, p.from);
  if (n === want) return undefined;
  const what = JSON.stringify(p.from.length > 120 ? `${p.from.slice(0, 120)}…` : p.from);
  return n === 0
    ? `${PATCH_HARNESS} no ${what} in ${p.file} (a stale injected bug: a harness failure, not caught)`
    : `${PATCH_HARNESS} ${n} of ${what} in ${p.file}, not ${want} (an ambiguous injected bug: a harness failure, not caught)`;
}

/** `text` with the patch put in, or a throw saying why it can't be: never a silent no-op. */
export function applyTestPatch(text: string, p: TestPatch): string {
  const problem = patchProblem(text, p);
  if (problem !== undefined) throw new Error(problem);
  // split and join: a `$` in `to` is text, not one of String.replace's patterns
  return text.split(p.from).join(p.to);
}

/** The patches TSL_TEST_PATCH holds: one, or a list. */
export function testPatches(env: string | undefined): TestPatch[] {
  return env === undefined ? [] : ([JSON.parse(env)].flat() as TestPatch[]);
}
