// @ts-check
// Bring every local guest to the same baseline, elevated, and prove it took.
//
//   npm run fleet:normalise
//
// Fleet CONSISTENCY is the point, more than any individual setting. Measured today:
// StartupBoostEnabled was 1 on two guests and 0 on a third, and Edge had auto-updated from 150 to 151
// on one before the others. Two guests with different browser behaviour producing into one corpus is
// the same class of problem as a mixed OS image -- the cache key cannot see it, and the evidence is
// quietly heterogeneous.
//
// Runs scripts/guest/normalise-fleet.cmd on each guest through guest-run.mjs, which is the only
// channel that can do elevated work on these VMs (see that file for why the obvious ones cannot).
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { refuseUnknownFlags } from "./cli-flags.mjs";
import { warnUtmDeprecated } from "./utm-deprecated.mjs";

/**
 * takes no flags: it brings every local guest to one baseline.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags([], { entry: import.meta.url, command: "npm run fleet:normalise" });

// A SIBLING in this package, resolved from this module. It was the cwd-relative path `scripts/guest-run.mjs`,
// which stopped existing when M8 moved the fleet tooling — and was only ever right when the cwd happened to be
// the repo root.
const GUEST_RUN = fileURLToPath(new URL("./guest-run.mjs", import.meta.url));

const run = promisify(execFile);
const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";

// Only when RUN, never on import. Unguarded, importing this file SHELLED OUT to `utmctl list` and then
// drove DISM across every registered guest -- so `node -e "import('./normalise-fleet.mjs')"`, which
// CLAUDE.md makes the only real check that this file still loads, normalised the fleet as a side effect.
//
// This file has already been broken once by a path that nothing exercised: it read
// `scripts/guest/normalise-fleet.cmd`, which the packages/ restructure moved, and `npm run fleet:normalise`
// stayed broken while `doctor` printed it as the FIX for a failed consistency check. The import check is
// what catches that class, so it has to be safe to run.
async function main() {
  warnUtmDeprecated("npm run fleet:normalise");
  const { stdout } = await run(UTMCTL, ["list"]);
  const vms = stdout.split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3 && c[2].startsWith("a11y-worker"))
    .map((c) => ({ uuid: c[0], state: c[1], name: c[2] }));

  if (!vms.length) {
    process.stderr.write("no a11y-worker VMs registered\n");
    process.exit(2);
  }

  // Resolved from THIS module, never the cwd. It read `scripts/guest/normalise-fleet.cmd` -- a path the
  // packages/ restructure moved and nothing noticed, so `npm run fleet:normalise` has been broken, and
  // doctor printed it as the FIX for a failed consistency check. A path spelled relative to the working
  // directory is a path that breaks the moment anyone runs the command from somewhere else.
  const script = fileURLToPath(new URL("./guest/normalise-fleet.cmd", import.meta.url));
  const failures = [];
  for (const vm of vms) {
    // One at a time. Three guests doing DISM and service work simultaneously is exactly the disk
    // contention this project spent a day diagnosing.
    try {
      const { stdout: out } = await run("node", [GUEST_RUN, vm.name, script, "--timeout=900"],
        { maxBuffer: 1 << 24 });
      process.stdout.write(out);
    } catch (error) {
      failures.push(vm.name);
      process.stdout.write(`==> ${vm.name}: FAILED — ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}\n`);
    }
  }

  process.stdout.write(`\n${vms.length - failures.length}/${vms.length} guest(s) normalised` +
    (failures.length ? `; failed: ${failures.join(", ")}\n` : "\n"));
  process.stdout.write("Verify with: npm run doctor\n");
  if (failures.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
