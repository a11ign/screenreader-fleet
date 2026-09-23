/**
 * THE NODE PIN EXISTS IN TWO PLACES, AND THEY MUST NOT DRIFT — #2063.
 *
 * `roles/worker/defaults/main.yml` is the tested copy and the one `provisionRevision` hashes.
 * `bootstrap-windows-worker.ps1` carries a port of it, because a box built from the bootstrap comes up
 * before the fleet can reach it — the same argument `edge-pin-parity.test.ts` makes for Edge, and this
 * file is deliberately that test with `worker_edge_version` swapped for Node.
 *
 * A fact stated twice is this repo's most-repeated defect, and the remedies in order of preference are:
 * delete a copy, derive one from the other, or PIN THEM EQUAL. The first two are unavailable — the
 * bootstrap runs on a box with no Ansible, and reading `defaults/main.yml` would mean a YAML parser in
 * PowerShell at first boot. So: pinned equal, here.
 *
 * ## What made it matter, measured on the live fleet 2026-09-23T06:55Z
 *
 * Workers 2-6 on v24.19.0 and workers 7-11 on v24.20.0, with every other reported field identical across
 * all ten. Neither copy pinned anything: both asked `nodejs.org/dist/index.json` for "the current LTS
 * today", which pins WITHIN a run and never ACROSS runs, and neither replaced an install it found. So
 * two boxes provisioned either side of a Node release diverge permanently — and the fleet did.
 *
 * THE VERSION AND THE BYTES ARE BOTH PINNED, and so is the UPGRADE. A pin that only applies to a box
 * with no Node stops the drift growing and never converges the fleet, which is the half that would be
 * easiest to ship without noticing: every one of these ten boxes already has a `node.exe`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(REPO, path), "utf8");

const ROLE = "packages/control/ansible/roles/worker";
const DEFAULTS = parse(read(`${ROLE}/defaults/main.yml`)) as Record<string, unknown>;
/** One task as the playbook declares it. `unknown` values because a task's shape is per-module. */
type Task = { name?: string, when?: string, register?: string, changed_when?: boolean,
  block?: Task[], [module: string]: unknown };
const PACKAGES = parse(read(`${ROLE}/tasks/packages.yml`)) as Task[];
const BOOTSTRAP = read("packages/worker-fleet/src/provisioning/bootstrap-windows-worker.ps1");

/** The role's tasks, read as STRUCTURE rather than as text — the defaults and the playbook are YAML. */
const task = (name: string) => PACKAGES.find((entry) => entry.name === name);

/** One module's options off a task — `win_get_url`'s `url`, and so on. */
const options = (of: Task | undefined, module: string) =>
  (of?.[module] ?? {}) as Record<string, string>;

test("the bootstrap pins the SAME Node build the role does", () => {
  const version = DEFAULTS.worker_node_version;
  assert.equal(typeof version, "string",
    "worker_node_version is gone from the role defaults — this test examines nothing");
  assert.ok(BOOTSTRAP.includes(`'${version}'`),
    `the role pins Node ${version} and the bootstrap does not. A box built from the bootstrap would come `
    + "up on a different runtime from the fleet, which is exactly the split #2063 measured — and because "
    + "`nodeVersion` is REPORTED_ONLY rather than MUST_MATCH, nothing would refuse a capture over it.");
});

test("the bootstrap verifies the SAME bytes, for EVERY architecture the role names", () => {
  // The URL is a delivery endpoint: what it serves can change under a stable address, so the hash is the
  // real pin. Per architecture because the zip differs per architecture and this fleet has both — one
  // hash could only ever verify one of them, and a copy carrying a subset verifies the other by accident.
  const hashes = DEFAULTS.worker_node_sha256 as Record<string, string> | undefined;
  assert.deepEqual(Object.keys(hashes ?? {}).sort(), ["arm64", "x64"],
    "the role no longer pins a Node checksum per architecture — `packages.yml` indexes this map by the "
    + "box's own arch, so a missing key installs unverified bytes on exactly one kind of box");
  for (const [arch, sha] of Object.entries(hashes ?? {})) {
    assert.match(sha, /^[0-9a-f]{64}$/, `worker_node_sha256.${arch} is not a sha256`);
    assert.ok(BOOTSTRAP.includes(sha),
      `the role verifies the ${arch} archive against ${sha} and the bootstrap does not mention it — the `
      + "two copies would accept different bytes under the same version number");
  }
});

test("NEITHER COPY RESOLVES THE CURRENT LTS ANY MORE — the defect itself, in both places", () => {
  // THE MECHANISM, not the symptom. A resolve gives every box in ONE run the same answer and gives two
  // runs different ones, so a fleet provisioned over a week that straddles a Node release splits — which
  // `packages.yml`'s own header comment predicted before this was fixed. Asserted against both copies
  // because fixing one leaves a bootstrap-built box drifting from a provisioned fleet.
  const resolving = PACKAGES.filter((entry) => JSON.stringify(entry).includes("nodejs.org/dist/index.json"));
  assert.deepEqual(resolving.map((entry) => entry.name), [],
    "a task in packages.yml asks nodejs.org which LTS is current, which is the drift this row removed");
  assert.ok(!BOOTSTRAP.includes("nodejs.org/dist/index.json"),
    "the bootstrap asks nodejs.org which LTS is current, so a box built from it joins the fleet on "
    + "whatever was newest that day");

  // THE POSITIVE CONTROL for both emptiness assertions above: the pinned URL names the same host, so a
  // matcher that had stopped matching anything at all would pass the two lines above and fail this one.
  const download = task("Fetch and unpack Node")?.block?.find((step) => step.name === "Download it");
  assert.match(options(download, "ansible.windows.win_get_url").url ?? "", /nodejs\.org\/dist\//);
  assert.match(BOOTSTRAP, /nodejs\.org\/dist\/\$NodeVersion/);
});

test("THE GATE IS THE VERSION, NOT THE FILE — or the pin never converges the fleet", () => {
  // The half that would be easiest to lose, and losing it is invisible: a pin applied only to a box with
  // no Node leaves all ten of these boxes exactly where they are, for ever, while every playbook run
  // reports success. `win_stat` on node.exe is the shape that did that.
  assert.equal(task("Fetch and unpack Node")?.when, "(node_have.output | first) != worker_node_version",
    "packages.yml no longer installs Node when the box's own version differs from the pin");
  assert.deepEqual(PACKAGES.filter((e) => JSON.stringify(e).includes("nodejs\\\\node.exe")).map((e) => e.name),
    [], "packages.yml still stats node.exe by a hardcoded path rather than asking the binary its version");
  assert.match(BOOTSTRAP, /if \(\$haveNode -eq \$NodeVersion\)/,
    "the bootstrap gates on presence rather than on version, so a box that came up on the wrong build "
    + "keeps it — which is how workers 7-11 got there");

  // THE POSITIVE CONTROL: the role does still ask the box what it is running, so the `when` above is
  // comparing a real reading rather than an always-undefined fact.
  const asked = task("Which Node this box is actually running");
  assert.ok(asked?.register === "node_have" && asked?.changed_when === false,
    "nothing registers `node_have`, so the install gate compares the pin against an undefined value — "
    + "which in Jinja is never equal, and would reinstall Node on every run instead of never");
});
