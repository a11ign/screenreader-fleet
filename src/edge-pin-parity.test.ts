// Relocated from control/src/fleet-layer/edge-pin-parity.test.ts by a11ign#5350 (the fleet-owned half).
/**
 * THE BOOTSTRAP MUST STOP THE EDGE UPDATER BEFORE IT INSTALLS, AND COMPLETE WHAT THE INSTALLER LEAVES UNDONE.
 *
 * `bootstrap-windows-worker.ps1` carries a port of the Ansible role's Edge pin, because a pin that arrives
 * after the box has updated itself is not a pin -- which is what happened to a11y-worker-7 on 2026-09-04.
 * Nothing in first boot mentioned Edge; the box came up with a network, Edge updated itself to 152 while
 * `npm install` was still running, and the role then refused correctly: Chromium will not install over a
 * newer build. One box reimaged.
 *
 * These tests read only the bootstrap, so they live with it. It holds NO version of its own (A11-205): Edge and
 * Node come from control's pins manifest, `deploy-pins.json`, which `serve-bootstrap.sh` serves beside it, so there
 * is nothing here for the role's `defaults/main.yml` to be held equal to.
 *
 * They assert on the SCRIPT'S TEXT because there is no Windows host here to run a first boot on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_URL = new URL("./provisioning/bootstrap-windows-worker.ps1", import.meta.url);
const BOOTSTRAP = readFileSync(BOOTSTRAP_URL, "utf8");
const SERVE = fileURLToPath(new URL("./provisioning/bare-metal/serve-bootstrap.sh", import.meta.url));
const UNATTEND = readFileSync(new URL("./provisioning/bare-metal/autounattend.xml", import.meta.url), "utf8");

test("the bootstrap stops the updater BEFORE installing, and by PREFIX", () => {
  // Both are load-bearing and both were learned the hard way. Order: a live updater finishes the update it
  // had started, in the window between installing and believing it. Prefix: a fresh guest carried a third
  // task, `MicrosoftEdgeUpdateBrowserReplacementTask`, that an enumerated list could not see.
  assert.match(BOOTSTRAP, /MicrosoftEdgeUpdate\*/,
    "the bootstrap enumerates updater tasks by NAME; it must match the prefix, or it cannot see a task "
    + "nobody listed — which is the one that replaced the browser");
  const disableAt = BOOTSTRAP.search(/Disable-ScheduledTask/);
  // ANCHORED ON THE EDGE INSTALL, not on `msiexec` — step 2 installs Node with msiexec too, so the first
  // version of this assertion measured that one and reported the order backwards. A test matching the
  // wrong occurrence of a common token is the same defect it is here to catch, one layer out.
  const installAt = BOOTSTRAP.search(/'install pinned Edge'/);
  assert.ok(disableAt > 0 && installAt > 0, "the bootstrap no longer disables the updater or installs Edge");
  assert.ok(disableAt < installAt,
    "the bootstrap installs Edge BEFORE disabling the updater. That leaves a live updater to finish the "
    + "update it had already begun — the drift the pin exists to prevent, arriving in the gap.");
  assert.match(BOOTSTRAP, /Stop-ScheduledTask[\s\S]{0,400}Disable-ScheduledTask/,
    "`Disable-ScheduledTask` stops a task STARTING again; it does not terminate one already RUNNING. Stop "
    + "before disable, or a running updater is marked disabled and carries on.");
});

test("the bootstrap completes the RENAME, which the installer does not", () => {
  // A Chromium install stages `new_msedge.exe` and leaves the running `msedge.exe` alone; the rename is a
  // separate operation the updater performs later — and the updater has just been disabled. Measured on
  // a11y-worker-3: the install reported success, left the old build, and a full reboot did not finish it.
  assert.match(BOOTSTRAP, /--rename-chrome-exe/,
    "without the rename the install reports success and leaves the OLD build in place, which is the "
    + "failure that looks most like the pin working");
});

test("it ROLLS BACK a box already newer than the pin, rather than stranding it", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and its own failure message carried the reason: "Windows will
  // not let Edge be uninstalled". That is false. `ALLOWDOWNGRADE=1` is Microsoft's supported enterprise
  // rollback, and the role's refusal message has listed it as remedy (2) since it was corrected — the
  // bootstrap was ported from that message BEFORE the correction, and this test pinned the wrong half in
  // place. A test can hold a refuted belief steady just as well as a correct one.
  //
  // What made it matter: `browserVersion` is first in `fleet-consistency`'s MUST_MATCH, so a box that
  // loses the first-boot race — fresh Windows ships consumer Edge and it self-updates while `npm install`
  // is still running — could never join the fleet. And "follow the pin forward" is not always available:
  // measured 2026-09-04, one box came up at 152.0.4191.66 and the enterprise channel publishes no such
  // build, so the preferred remedy did not exist.
  assert.match(BOOTSTRAP, /\$rollingBack\s*=\s*\$have -ne '\(absent\)' -and \[version\]\$have -gt \[version\]\$EdgeVersion/,
    "the bootstrap no longer detects an Edge newer than the pin by comparing VERSIONS. A string compare "
    + "would read 152.0.4191.9 as newer than 152.0.4191.62.");
  // A BARE /ALLOWDOWNGRADE=1/ ASSERTION WAS HERE AND IT WAS WORTHLESS. Mutation-checked by deleting the
  // code that passes the flag: it still PASSED, because the word also appears in the comment explaining
  // why the flag is used. It matched PROSE, not behaviour — this repo's "a test must not derive its
  // expectations from source TEXT" rule, reproduced by the person who wrote the rule down. The assertion
  // below matches the code construct and strictly implies it, so the bare one is deleted rather than kept
  // as reassurance.

  // THE FLAG MUST BE CONDITIONAL. Passing it unconditionally would work today and would hide the case it
  // exists for: a fresh install and a rollback would become the same command, so nothing downstream could
  // report which one happened — the repo's own "two faults must not print the same word" rule.
  assert.match(BOOTSTRAP, /if \(\$rollingBack\) \{ \$msiArgs \+= 'ALLOWDOWNGRADE=1' \}/,
    "ALLOWDOWNGRADE is not gated on actually rolling back, so a first install and a rollback are "
    + "indistinguishable in the log.");

  // And the refuted claim must not come back. This is the sentence that sent an operator to reimage a
  // machine one flag fixes.
  assert.doesNotMatch(BOOTSTRAP, /will not let Edge be uninstalled/,
    "the bootstrap has regained the claim that a newer Edge cannot be brought back. It can: "
    + "ALLOWDOWNGRADE=1, which this script now uses.");
  assert.doesNotMatch(BOOTSTRAP, /REIMAGE this box/,
    "the bootstrap tells the operator to reimage a box that a supported rollback repairs in place.");
});

const MANIFEST = {
  edge: { version: "156.0.4314.42", msiUrl: "https://example.test/MicrosoftEdgeEnterpriseX64.msi", msiSha256: "a".repeat(64) },
  node: { version: "v24.20.0", sha256: { x64: "b".repeat(64), arm64: "c".repeat(64) } },
};

test("the bootstrap holds no Edge or Node version, URL or hash: it reads every one from the manifest", () => {
  // The literals this replaced: a dotted Edge build, a Node tag, the MSI's delivery URL and any 64-hex hash. Matched
  // on CODE LINES only -- a comment may name the history ("it used to carry 24.20"), and a comment is not a pin.
  const code = BOOTSTRAP.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /\b\d{3}\.0\.\d{4}\.\d+\b/, "an Edge build literal is back in the bootstrap");
  assert.doesNotMatch(code, /\bv\d+\.\d+\.\d+\b/, "a Node version literal is back in the bootstrap");
  assert.doesNotMatch(code, /\b[0-9a-f]{64}\b/i, "a SHA-256 literal is back in the bootstrap");
  assert.doesNotMatch(code, /delivery\.mp\.microsoft\.com/, "the Edge MSI URL literal is back in the bootstrap");
  // And each value is read from the manifest's key, with its own A11Y_* override.
  for (const [variable, override, key] of [
    ["EdgeVersion", "A11Y_EDGE_VERSION", "edge.version"], ["EdgeMsiUrl", "A11Y_EDGE_MSI_URL", "edge.msiUrl"],
    ["EdgeMsiSha", "A11Y_EDGE_MSI_SHA256", "edge.msiSha256"], ["NodeVersion", "A11Y_NODE_VERSION", "node.version"],
  ]) {
    assert.match(BOOTSTRAP, new RegExp(`^\\$${variable}\\s*=\\s*Get-Pin '${override}' \\$pins\\.${key.replace(".", "\\.")}\\b`, "m"), `${variable} is not read from ${key}`);
  }
  // The hash is per architecture, and only the running architecture's is asked for: A11Y_NODE_SHA256_X64 / _ARM64, node.sha256.x64 / .arm64.
  assert.match(BOOTSTRAP, /\$NodeSha = @\{ \$nodeArch = Get-Pin "A11Y_NODE_SHA256_\$\(\$nodeArch\.ToUpper\(\)\)" \$pins\.node\.sha256\.\$nodeArch /);
  assert.match(BOOTSTRAP, /\$PinsFile = if \(\$env:A11Y_PINS_FILE\) \{ \$env:A11Y_PINS_FILE \} else \{ 'C:\\a11y\\deploy-pins\.json' \}/,
    "the manifest is read from C:\\a11y\\deploy-pins.json, where autounattend.xml puts it");
});

const HAVE_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;

/**
 * Run the bootstrap's own pin-reading lines (from `$PinsFile =` to the Node comment) against a manifest and environment, then the Node hash line for an
 * architecture, and print the values. `manifest` is an object (written as JSON), raw text (written as is) or null (no file).
 */
function readPins(manifest: unknown | null, env: Record<string, string>, nodeArch = "x64") {
  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-pins-"));
  try {
    const pinsFile = join(scratch, "deploy-pins.json");
    if (manifest !== null) writeFileSync(pinsFile, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    const lines = `$text = Get-Content -Raw -LiteralPath $env:BOOTSTRAP
$start = $text.IndexOf('$PinsFile = ')
$end = $text.IndexOf('# THE NODE BUILD THIS FLEET RUNS')
Invoke-Expression $text.Substring($start, $end - $start)
$nodeArch = '${nodeArch}'
$hashStart = $text.IndexOf('$NodeSha = @{')
Invoke-Expression $text.Substring($hashStart, $text.IndexOf([Environment]::NewLine, $hashStart) - $hashStart)
"$EdgeVersion $($NodeSha[$nodeArch])"`;
    const run = spawnSync("pwsh", ["-NoProfile", "-Command", lines], {
      encoding: "utf8", env: { ...process.env, A11Y_PINS_FILE: pinsFile, BOOTSTRAP: fileURLToPath(BOOTSTRAP_URL), NO_COLOR: "1", ...env },
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("Get-Pin: the manifest's value, an A11Y_* override wins, and neither is a refusal that names what to give it", { skip: !HAVE_PWSH && "no pwsh on this host" }, () => {
  const fromManifest = readPins(MANIFEST, {});
  assert.equal(fromManifest.status, 0, fromManifest.out);
  assert.equal(fromManifest.out.trim(), `156.0.4314.42 ${"b".repeat(64)}`);
  assert.equal(readPins(MANIFEST, { A11Y_EDGE_VERSION: "157.0.1.1" }).out.trim(), `157.0.1.1 ${"b".repeat(64)}`);
  // With no manifest at all, the overrides alone are enough: that is how a box with no control repo is bootstrapped.
  const overrides = { A11Y_NODE_VERSION: "v24.20.0", A11Y_EDGE_VERSION: "156.0.4314.42", A11Y_EDGE_MSI_URL: "https://example.test/e.msi", A11Y_EDGE_MSI_SHA256: "a".repeat(64), A11Y_NODE_SHA256_X64: "b".repeat(64) };
  assert.equal(readPins(null, overrides).out.trim(), `156.0.4314.42 ${"b".repeat(64)}`);
  // NEGATIVE CONTROLS: no manifest, and a manifest without the key, must stop -- never fall back to a version of its own.
  for (const manifest of [null, { edge: {}, node: {} }]) {
    const refused = readPins(manifest, {});
    assert.notEqual(refused.status, 0, "a bootstrap with no pin for Edge carried on");
    assert.match(refused.out, /no pinned Node version: set A11Y_NODE_VERSION, or put the fleet's pins manifest at /);
  }
});

test("every pin but the Node hash is asked for before anything is installed, and an x64 box asks for no arm64 hash", { skip: !HAVE_PWSH && "no pwsh on this host" }, () => {
  // Edge's pins used to be read at Step 5, after Node, Git and sshd were on the box: a missing Edge override then failed an hour in.
  const noEdge = readPins({ node: MANIFEST.node }, {});
  assert.notEqual(noEdge.status, 0);
  assert.match(noEdge.out, /no pinned Edge version: set A11Y_EDGE_VERSION/);
  // NEGATIVE CONTROL for the arm64 case: the same manifest with the x64 hash gone does refuse an x64 box, naming the x64 hash.
  const noArm64 = { ...MANIFEST, node: { ...MANIFEST.node, sha256: { x64: MANIFEST.node.sha256.x64 } } };
  assert.equal(readPins(noArm64, {}, "x64").status, 0, "an x64 box needs no arm64 hash");
  const noX64 = readPins({ ...MANIFEST, node: { ...MANIFEST.node, sha256: { arm64: "c".repeat(64) } } }, {}, "x64");
  assert.notEqual(noX64.status, 0);
  assert.match(noX64.out, /no pinned Node x64 SHA-256: set A11Y_NODE_SHA256_X64/);
  assert.equal(readPins(MANIFEST, {}, "arm64").out.trim(), `156.0.4314.42 ${"c".repeat(64)}`);
});

test("a manifest that is there and is not JSON stops the bootstrap naming the file, not with the parser's own words alone", { skip: !HAVE_PWSH && "no pwsh on this host" }, () => {
  for (const partial of ['{"edge": {"version": "156.0', "", "not json"]) {
    const run = readPins(partial, {});
    assert.notEqual(run.status, 0, JSON.stringify(partial));
    assert.match(run.out, /the pins manifest at .*deploy-pins\.json.* is not valid JSON|no pinned Node version/, JSON.stringify(partial));
  }
  assert.match(readPins('{"edge": {"version": "156.0', {}).out, /is not valid JSON/);
});

test("the bootstrap still parses as PowerShell", { skip: !HAVE_PWSH && "no pwsh on this host" }, () => {
  const run = spawnSync("pwsh", ["-NoProfile", "-Command",
    "$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:BOOTSTRAP,[ref]$t,[ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }"],
  { encoding: "utf8", env: { ...process.env, BOOTSTRAP: fileURLToPath(BOOTSTRAP_URL) } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("the media fetches the manifest with the other files, into C:\\a11y where the bootstrap looks for it", () => {
  const fetched = /foreach\(\$f in ([^)]*)\)/.exec(UNATTEND)?.[1];
  assert.ok(fetched, "autounattend.xml no longer fetches a list of files");
  assert.deepEqual(fetched.split(",").map((name) => name.trim().replace(/'/g, "")),
    ["first-boot.cmd", "bootstrap-windows-worker.ps1", "deploy-pins.json", "operator-key.pub"]);
  assert.match(UNATTEND, /\$d='C:\\a11y'/);
});

/** A throwaway public key and a manifest file for the server script. */
function servedFiles(manifest: unknown) {
  const scratch = mkdtempSync(join(tmpdir(), "serve-bootstrap-"));
  const key = join(scratch, "fleet.pub");
  const pins = join(scratch, "deploy-pins.json");
  writeFileSync(key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly test@example\n");
  writeFileSync(pins, JSON.stringify(manifest));
  return { scratch, key, pins };
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

test("serve-bootstrap.sh refuses to start without the manifest, or with a file that is not the fleet's", () => {
  const { scratch, key, pins } = servedFiles({ edge: { version: "156.0.4314.42" } });
  try {
    const noManifest = spawnSync("bash", [SERVE, key], { encoding: "utf8" });
    assert.equal(noManifest.status, 2);
    assert.match(noManifest.stderr, /usage: .* <path-to-public-key> <path-to-deploy-pins\.json>/);
    const notFleets = spawnSync("bash", [SERVE, key, pins], { encoding: "utf8" });
    assert.equal(notFleets.status, 1);
    assert.match(notFleets.stderr, /is not the fleet's pins manifest/);
    // The old call, `<key> <port>`: told the port moved, not that the port is "not a manifest".
    const oldCall = spawnSync("bash", [SERVE, key, "8099"], { encoding: "utf8" });
    assert.equal(oldCall.status, 2);
    assert.match(oldCall.stderr, /'8099' is a port\. The pins manifest is now the second argument/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("serve-bootstrap.sh serves the manifest as deploy-pins.json, and serves an edit made after it started", async () => {
  const { scratch, key, pins } = servedFiles(MANIFEST);
  const port = await freePort();
  const server = spawn("bash", [SERVE, key, pins, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serve-bootstrap.sh never said it was serving")), 15_000);
      server.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Serving on port")) { clearTimeout(timer); resolve(); } });
      server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`serve-bootstrap.sh exited ${code}`)); });
    });
    const fetchPins = async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { return await (await fetch(`http://127.0.0.1:${port}/deploy-pins.json`)).text(); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      throw new Error("the served manifest never answered");
    };
    assert.deepEqual(JSON.parse(await fetchPins()), MANIFEST);
    // The upgrade run edits the manifest; a snapshot taken at start would hand the next box the version the fleet just left.
    writeFileSync(pins, JSON.stringify({ ...MANIFEST, edge: { ...MANIFEST.edge, version: "157.0.1.1" } }));
    assert.equal(JSON.parse(await fetchPins()).edge.version, "157.0.1.1");
  } finally {
    server.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
});
