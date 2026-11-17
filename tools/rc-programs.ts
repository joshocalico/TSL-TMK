// R16: rc's corpus programs that lower whole (tools/rc-tests.ts's rcPrograms), worked out in a process of its own and printed
// as JSON. Lowering every program to see which are usable put the test process's heap at about a gigabyte for the rest of
// its run, the larger part of native-e box 3's peak (2.84 GiB in R15's gate against the 3 GiB watchdog); here it's given back
// when this process ends. The same list, by the same code, as rcPrograms in the test process gives.
//
//   node tools/rc-programs.ts [filter]
import { rcPrograms } from "./rc-tests.ts";

process.stdout.write(JSON.stringify(rcPrograms(process.argv[2])));
process.exit(0);
