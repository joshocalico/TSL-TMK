// One part of a box run in a process of its own (D76, T2), as opt-a box 12's bugs are (tools/opt-fault-part.ts): the
// function `name` of tools/parts.ts with its JSON argument. Its answer is the last line, after "TMK-PART ".
// `node tools/part.ts <name> <json>`
import { PARTS } from "./parts.ts";

const [name, arg] = process.argv.slice(2) as [string, string];
const f = PARTS[name];
if (f === undefined) throw new Error(`no part ${name}`);
const out = await f(JSON.parse(arg) as never);
process.stdout.write(`\nTMK-PART ${JSON.stringify(out)}\n`);
process.exit(0);
