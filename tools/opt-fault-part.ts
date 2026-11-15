// One part of opt-a box 12 (tools/opt-tests.ts faultsInParts): the run with no bug in, or one bug's, in a process of its own,
// as the bug is the process's TMK_OPT_FAULT. `node tools/opt-fault-part.ts <accel> <jobs> <fault|(none)>`; its row is the
// last line, after "TMK-PART ".
import { faultPart } from "./opt-tests.ts";
import type { Accel } from "./qemu-run.ts";

const [accel, jobs, fault] = process.argv.slice(2) as [Accel, string, string];
const row = await faultPart(accel, Number(jobs), fault);
process.stdout.write(`\nTMK-PART ${JSON.stringify(row)}\n`);
process.exit(0);
