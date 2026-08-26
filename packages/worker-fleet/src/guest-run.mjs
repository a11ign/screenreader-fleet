// Run a script on a guest, elevated, and get its output back.
//
//   node packages/worker-fleet/src/guest-run.mjs <vm-name> <local-script.cmd> [--timeout=600]
//
// This exists because there was no reliable way to do it, and the workarounds each failed differently:
//
//   utmctl exec        runs as NT AUTHORITY\SYSTEM -- fully elevated -- but returns NO OUTPUT and exit
//                      code 0 whether or not the command ran. Fine for firing something, useless for
//                      knowing what happened.
//   the worker's HTTP  unelevated. The worker task is RunLevel Limited on purpose (NVDA does not need
//                      elevation), so DISM, sc.exe and Defender's registry keys are all closed to it.
//   Register-ScheduledTask from the worker  "Access is denied" -- registering an elevated task itself
//                      needs elevation.
//   ssh / WinRM / RDP  not installed; ports 22, 5985, 5986, 3389 and 445 are all closed.
//
// The combination that works: `utmctl exec` (SYSTEM) registers a scheduled task at RunLevel HIGHEST,
// starts it, and the task writes its output to a file we pull back. Elevation from the exec channel,
// results through the file channel, neither depending on the other.
//
// TWO TRAPS, both of which produced wrong answers today and are handled here:
//
//   1. `utmctl exec ... -- a b c` passes a, b and c as SEPARATE argv entries. A cmd line containing
//      parentheses, `&` or quotes gets split across them and cmd receives fragments. A `reg query`
//      written that way reported "key not found" for a key that certainly existed, and nearly led to
//      the conclusion that a real configuration drift was a false alarm. The command is passed as ONE
//      argument here, always.
//   2. A detached child dies with the exec that spawned it. `start /b` looked like it worked -- exit 0,
//      no output -- and the child never ran. A scheduled task survives because the Task Scheduler
//      service owns it.
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * takes a VM name and a script POSITIONALLY, which this guard does not touch, plus `--timeout=`;
 * a mistyped timeout silently falls back to 600s on an operation that may legitimately need longer.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--timeout="], { command: "npm run guest:run" });

const run = promisify(execFile);

const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";
const GUEST_DIR = "C:\\Users\\witness\\a11y-witness";
const TASK_NAME = "a11yguestrun";
/** Written by the wrapper as its last act. Absent means still running, or it died. */
export const DONE_SENTINEL = "---GUEST-RUN-DONE---";
const POLL_MS = 5_000;

/**
 * The cmd line that registers and starts the elevated task.
 *
 * Built as a single string on purpose -- see trap 1 above. Exported so the quoting is testable without
 * a guest, because it is the part that silently produces wrong answers rather than errors.
 */
export function scheduleCommand({ scriptPath, taskName = TASK_NAME }) {
  return `schtasks /create /tn ${taskName} /tr "${scriptPath}" /sc once /st 00:00 ` +
    `/ru SYSTEM /rl HIGHEST /f >nul 2>&1 & schtasks /run /tn ${taskName} >nul 2>&1`;
}

/**
 * Wrap a caller's script so it always terminates with the sentinel.
 *
 * Without this there is no way to distinguish "still running" from "died on line one" -- which is
 * exactly how a trim that crashed immediately looked identical to a trim in progress, for three boots.
 */
export function wrapScript(body, outputFile) {
  const lines = [
    "@echo off",
    `cd /d ${GUEST_DIR}`,
    `set OUT=${outputFile}`,
    `> ${outputFile} echo === guest-run ===`,
    ...body.split(/\r?\n/).filter((l) => !/^@echo off\s*$/i.test(l)).map((l) => l.trimEnd()),
    `>> ${outputFile} echo ${DONE_SENTINEL}`,
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Did the run finish? Exported because "no sentinel" and "no file" are different failures. */
export function isComplete(output) {
  return typeof output === "string" && output.includes(DONE_SENTINEL);
}

async function uuidFor(vmName) {
  const { stdout } = await run(UTMCTL, ["list"]);
  const line = stdout.split("\n").find((l) => l.trim().endsWith(` ${vmName}`) || l.trim().endsWith(`\t${vmName}`));
  const uuid = line?.trim().split(/\s+/)[0];
  if (!uuid) throw new Error(`no VM named '${vmName}'`);
  return uuid;
}

function push(uuid, guestPath, localPath) {
  return new Promise((done, fail) => {
    const child = execFile(UTMCTL, ["file", "push", uuid, guestPath], (error) =>
      error ? fail(new Error(`push failed: ${error.message}`)) : done());
    createReadStream(localPath).pipe(child.stdin);
  });
}

async function pull(uuid, guestPath) {
  try {
    const { stdout } = await run(UTMCTL, ["file", "pull", uuid, guestPath], { maxBuffer: 1 << 24 });
    return stdout;
  } catch {
    return null; // not written yet
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [vmName, scriptFile] = args.filter((a) => !a.startsWith("--"));
  const timeoutS = Number(args.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? 600);
  if (!vmName || !scriptFile) {
    process.stderr.write("usage: node packages/worker-fleet/src/guest-run.mjs <vm-name> <script.cmd> [--timeout=600]\n");
    process.exit(2);
  }
  const local = resolve(scriptFile);
  if (!existsSync(local)) throw new Error(`no such script: ${local}`);

  const name = basename(scriptFile).replace(/\.[^.]+$/, "");
  const guestScript = `${GUEST_DIR}\\${name}.cmd`;
  const guestOutput = `${GUEST_DIR}\\.${name}.out`;
  const wrapped = resolve(process.env.TMPDIR ?? "/tmp", `${name}.wrapped.cmd`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(wrapped, wrapScript(readFileSync(local, "utf8"), guestOutput), "utf8");

  const uuid = await uuidFor(vmName);
  process.stdout.write(`==> ${vmName} (${uuid})\n`);
  await push(uuid, guestScript, wrapped);
  process.stdout.write(`    pushed ${name}.cmd\n`);

  // One argument. See trap 1.
  await run(UTMCTL, ["exec", uuid, "--cmd", "cmd.exe", "--", "/c",
    scheduleCommand({ scriptPath: guestScript })]);
  process.stdout.write("    running as SYSTEM at RunLevel HIGHEST\n");

  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const output = await pull(uuid, guestOutput);
    if (isComplete(output)) {
      process.stdout.write(output.replace(DONE_SENTINEL, "").trimEnd() + "\n");
      process.stdout.write("    done\n");
      return;
    }
  }
  throw new Error(`no ${DONE_SENTINEL} within ${timeoutS}s — the script may still be running; ` +
    `pull ${guestOutput} to see how far it got`);
}

// `import.meta.url === pathToFileURL(process.argv[1])`, not `endsWith("guest-run.mjs")`. The old form
// worked but matched on a SUFFIX, so any entry point whose path happened to end that way -- a
// `my-guest-run.mjs`, a copy under another directory -- would have run this file's main instead of its own.
// Every other entry point in this repo now uses the exact comparison; one idiom, so there is one thing to
// get right.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`guest-run failed: ${error.message}\n`);
    process.exit(1);
  });
}
