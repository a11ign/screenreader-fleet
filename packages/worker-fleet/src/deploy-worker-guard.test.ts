/**
 * `deploy-worker.mjs`'s entry-point guard, proven through a REAL symlinked argv — WITHOUT running the
 * binary itself.
 *
 * Every other bin fixed alongside this one (`a11y-doctor`, `a11y-worker-code`, `a11y-worker-compare`) was
 * proven by packing the real tarball, installing it into a throwaway consumer directory, and invoking the
 * installed `.bin` symlink directly — the same thing `npx` does. `a11y-worker-deploy` was deliberately
 * NOT run that way: its `main()` reaches for fleet and SSH state even under `--help`, and doing that from
 * a test would be the exact resource-touching action this repo's own agent conventions ban. "Fixed and
 * not executed is correct, but it must not become 'not verified'" — so this proves the MECHANISM the fix
 * depends on dynamically, through a real symlink, without ever importing or spawning deploy-worker.mjs.
 *
 * TWO CHECKS. The first pins that deploy-worker.mjs's own guard is still the exact realpath'd expression —
 * so if it ever drifts, this file's second test is proving a mechanism the real file no longer uses. The
 * second reproduces that exact expression in a THROWAWAY script (never deploy-worker.mjs) and runs it
 * through a real symlink, the same shape `/var/folders/...`'s `/private/var/...` realpath created in
 * production: `import.meta.url` is resolved by Node's ESM loader, a raw `process.argv[1]` is not, and only
 * `realpathSync` closes that gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_WORKER = fileURLToPath(new URL("./deploy-worker.mjs", import.meta.url));

/** The exact guard expression this file's second test reproduces and proves. Kept as one string so a
 *  drift between the two is a diff, not a re-derivation. */
const GUARD_EXPRESSION =
  'import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href';

test("deploy-worker.mjs's own guard is still the exact expression this file proves", () => {
  const src = readFileSync(DEPLOY_WORKER, "utf8");
  assert.ok(src.includes(GUARD_EXPRESSION),
    "deploy-worker.mjs's entry-point guard has changed — update GUARD_EXPRESSION above to match it (after "
    + "checking the change is not a regression back to the un-realpath'd form), then re-run this file");
});

test("that guard expression resolves TRUE through a real symlink — reproduced, never executed", () => {
  // A standalone script that reproduces the guard byte for byte and reports which branch it took.
  // Deliberately its own file, never deploy-worker.mjs: this proves the MECHANISM (realpathSync closes
  // the gap between import.meta.url's symlink-resolved form and a raw argv[1]) without ever running
  // deploy-worker's own main(), which is what makes this safe to run under the standing resource ban.
  const dir = mkdtempSync(join(tmpdir(), "a11y-deploy-guard-probe-"));
  try {
    const target = join(dir, "target.mjs");
    writeFileSync(target,
      'import { pathToFileURL } from "node:url";\n'
      + 'import { realpathSync } from "node:fs";\n'
      + `console.log(${GUARD_EXPRESSION} ? "MAIN RAN" : "SILENTLY SKIPPED");\n`);

    // A symlink one level below a directory whose name is unrelated to any real OS symlink (this test
    // must not depend on macOS's /var or /tmp specifically, or it would pass for the wrong reason on a
    // host where TMPDIR happens not to be symlinked). `dir` itself may or may not sit under a symlink;
    // `link` is a symlink REGARDLESS of the host, which is the one fact this test needs to be true.
    const link = join(dir, "via-symlink.mjs");
    symlinkSync(target, link);

    const throughSymlink = execFileSync("node", [link], { encoding: "utf8" }).trim();
    assert.equal(throughSymlink, "MAIN RAN",
      "the realpath'd guard did not resolve TRUE through a symlinked invocation path — this is exactly "
      + "the mechanism that made five published bins silently do nothing");

    // The negative control: without realpathSync, the same invocation must SILENTLY SKIP — proving this
    // test can tell the two states apart, not merely asserting the value it hopes for.
    const unfixedTarget = join(dir, "target-unfixed.mjs");
    writeFileSync(unfixedTarget,
      'import { pathToFileURL } from "node:url";\n'
      + 'console.log(import.meta.url === pathToFileURL(process.argv[1] ?? "").href ? "MAIN RAN" : '
      + '"SILENTLY SKIPPED");\n');
    const unfixedLink = join(dir, "via-symlink-unfixed.mjs");
    symlinkSync(unfixedTarget, unfixedLink);
    const unfixedThroughSymlink = execFileSync("node", [unfixedLink], { encoding: "utf8" }).trim();
    assert.equal(unfixedThroughSymlink, "SILENTLY SKIPPED",
      "the un-realpath'd guard unexpectedly resolved TRUE through a symlink on this host — this test's "
      + "own negative control is not exercising the bug it exists to catch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
