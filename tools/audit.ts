// `tmk audit` (SPEC 3.8): unsafe modules, unsafe lines as a share of the total, and what S8 counts. Lines of code
// are lines with something on them other than a comment. There's no kernel yet, so the kernel's numbers are empty.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./corpus.ts";

export interface AuditModule {
  path: string;
  loc: number;
  unsafeCalls: number;
  safetyComments: number;
  listed: boolean; // under "unsafeModules" in its package's tsl.json
}

export interface Audit {
  modules: AuditModule[];
  unsafeLoc: number;
  totalLoc: number;
  percent: number;
  alloc: { loc: number; modules: { path: string; loc: number }[] };
  manual: { path: string; loc: number; listed: boolean }[]; // modules of "memory": "manual" packages, anywhere
  hostRuntime: { path: string; loc: number }[];
  privilegedIntrinsicUses: number;
  assemblyLoc: number;
  note: string;
}

function locOf(text: string): number {
  let n = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2).trim();
      inBlock = false;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) {
        inBlock = true;
        continue;
      }
      if (line.endsWith("*/")) continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    n++;
  }
  return n;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** TSL packages count: the host's stand-ins for @tsl/core and @tsl/unsafe are built-ins natively, not TSL. */
export function audit(): Audit {
  const hostOnly = ["packages/tsl-core", "packages/tsl-unsafe", "packages/tsl-arch-aarch64"];
  const modules: AuditModule[] = [];
  let totalLoc = 0;
  const pkgRoots = readdirSync(join(ROOT, "packages")).map((n) => join("packages", n));
  for (const pkg of pkgRoots) {
    if (hostOnly.includes(pkg)) continue;
    const json = join(ROOT, pkg, "tsl.json");
    const listed = existsSync(json)
      ? ((JSON.parse(readFileSync(json, "utf8")) as { unsafeModules?: string[] }).unsafeModules ??
        [])
      : [];
    for (const f of tsFiles(join(ROOT, pkg))) {
      const text = readFileSync(f, "utf8");
      const loc = locOf(text);
      totalLoc += loc;
      const isListed = listed.includes(relative(join(ROOT, pkg), f));
      const importsUnsafe = /from "@tsl\/(unsafe|arch-aarch64)"/.test(text);
      if (!isListed && !importsUnsafe) continue;
      modules.push({
        path: relative(ROOT, f),
        loc,
        unsafeCalls: (
          text.match(
            /\b(ptrAt|sliceOf|copyBytes|placeObject|objectAt|slotOf|genOf|retireObject|unsafeFree|setPageSource|viewAt|bytesAt|addrOf)\s*[<(]/g,
          ) ?? []
        ).length,
        safetyComments: (text.match(/\/\/ SAFETY:/g) ?? []).length,
        listed: isListed,
      });
    }
  }
  // A manual package is unsafe code all through (SPEC 3.8). One in packages/ is in the total above already.
  const manual: Audit["manual"] = [];
  const seek = (dir: string): void => {
    if (!existsSync(dir)) return;
    const json = join(dir, "tsl.json");
    if (existsSync(json)) {
      const cfg = JSON.parse(readFileSync(json, "utf8")) as {
        memory?: unknown;
        unsafeModules?: string[];
      };
      if (cfg.memory === "manual") {
        for (const f of tsFiles(dir)) {
          manual.push({
            path: relative(ROOT, f),
            loc: locOf(readFileSync(f, "utf8")),
            listed: (cfg.unsafeModules ?? []).includes(relative(dir, f)),
          });
        }
        return;
      }
    }
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (name !== "node_modules" && name !== "build" && statSync(p).isDirectory()) seek(p);
    }
  };
  for (const d of ["packages", "bench", "corpus/memory", "corpus/mem"]) seek(join(ROOT, d));
  for (const m of manual) {
    if (m.path.startsWith("packages/") && !modules.some((x) => x.path === m.path)) {
      modules.push({
        path: m.path,
        loc: m.loc,
        unsafeCalls: 0,
        safetyComments: 0,
        listed: m.listed,
      });
    }
  }
  const unsafeLoc = modules.reduce((n, m) => n + m.loc, 0);
  const allocMods = modules.filter((m) => m.path.startsWith("packages/tsl-alloc/"));
  return {
    modules,
    unsafeLoc,
    totalLoc,
    percent: totalLoc > 0 ? (unsafeLoc * 100) / totalLoc : 0,
    alloc: {
      loc: allocMods.reduce((n, m) => n + m.loc, 0),
      modules: allocMods.map((m) => ({ path: m.path, loc: m.loc })),
    },
    manual,
    hostRuntime: hostOnly.flatMap((p) =>
      tsFiles(join(ROOT, p)).map((f) => ({
        path: relative(ROOT, f),
        loc: locOf(readFileSync(f, "utf8")),
      })),
    ),
    privilegedIntrinsicUses: 0,
    assemblyLoc: 0,
    note: "No kernel or drivers yet, so @tsl/alloc is all the TSL there is, and it's almost all unsafe by design: this share only means something at M4 and M7 (S8). No privileged intrinsics or assembly are compiled yet.",
  };
}

export function auditText(a: Audit): string {
  const lines = ["unsafe modules:"];
  for (const m of a.modules) {
    lines.push(
      `  ${m.path}: ${m.loc} LOC, ${m.unsafeCalls} unsafe calls, ${m.safetyComments} SAFETY comments${m.listed ? "" : ", NOT LISTED in tsl.json"}`,
    );
  }
  lines.push(
    `unsafe LOC: ${a.unsafeLoc} of ${a.totalLoc} in TSL packages (${a.percent.toFixed(1)}%)`,
  );
  lines.push(
    `@tsl/alloc: ${a.alloc.loc} LOC, all of it counting toward S8 where it's linked at EL1 (SPEC 3.8)`,
  );
  const manualLoc = a.manual.reduce((n, m) => n + m.loc, 0);
  lines.push(
    `"memory": "manual" modules: ${a.manual.length}, ${manualLoc} LOC, each one unsafe code (tests and benches here)${
      a.manual.some((m) => !m.listed)
        ? `; NOT LISTED: ${a.manual
            .filter((m) => !m.listed)
            .map((m) => m.path)
            .join(", ")}`
        : ""
    }`,
  );
  lines.push(`host runtime, not TSL: ${a.hostRuntime.map((h) => `${h.path} ${h.loc}`).join(", ")}`);
  lines.push(
    `privileged intrinsic uses: ${a.privilegedIntrinsicUses}; assembly LOC: ${a.assemblyLoc}`,
  );
  lines.push(a.note);
  return lines.join("\n");
}
