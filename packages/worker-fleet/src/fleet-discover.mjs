/**
 * Find every capture worker on the network, and reconcile it against the inventory.
 *
 *     npm run fleet:discover
 *     npm run fleet:discover -- --cidr=192.168.1 --json
 *
 * ## Why this is a reconciler and NOT the source of truth
 *
 * The tempting design is "discover the fleet each run and forget the inventory". It cannot work, for one
 * reason that is not going away: **Wake-on-LAN needs the MAC, and a sleeping box announces nothing.** A
 * fleet meant to be powered down between runs must therefore carry a static record per machine, so the
 * inventory stays canonical and this tells you where it has drifted.
 *
 * The drift is not hypothetical. The single bare-metal worker moved from .83 to .102 by DHCP, and a
 * probe of the old address returned nothing — which is indistinguishable from a powered-off machine.
 * That is the worst kind of staleness, because the fleet gets QUIETER as it happens rather than louder.
 *
 * ## Identity is the MAC, taken from ARP
 *
 * Matching on IP is what broke; matching on `/health` contents cannot distinguish two identical guests.
 * So after a worker answers, its MAC is read from the host's ARP table — no worker change needed, which
 * matters because a new `/health` field would change `codeVersion()` and mark the whole fleet stale.
 *
 * ## What it deliberately does not do
 *
 * By default it does not touch the inventory. A tool that REWRITES the file describing your fleet, based
 * on what happened to answer a broadcast, is a tool that quietly drops the machine that was asleep.
 *
 * ## `--enroll`, and why it does not contradict the paragraph above
 *
 * The danger named there is DELETION, not addition, and the two separate cleanly. Enrolment only ever
 * APPENDS a worker whose MAC this file has never seen; it never edits or removes an existing entry, and
 * it only ever looks at `unknown` findings. A sleeping box is `absent`, which enrolment does not read —
 * so the machine that was asleep cannot be dropped, because nothing here can drop anything.
 *
 * That is the whole safety argument, and it is why the tempting-but-wrong design and the useful one can
 * live in the same file: only one of them removes.
 *
 * It appends TEXT rather than round-tripping through a YAML library. Half the value of `inventory.yml` is
 * its comments — every one of them paid for by an incident — and a parse-and-dump deletes all of them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";

import { requestJson } from "./worker-http.mjs";

const DEFAULT_PORT = 8765;
const PROBE_TIMEOUT_MS = 2_000;
const LAST_HOST_IN_SUBNET = 254;

/**
 * Every `ansible_host` / `mac` pair the inventory declares.
 *
 * A deliberately narrow reader, matching `fleet-env.mjs`: anything resembling a host entry that does not
 * parse is an error naming the line, because a fleet list that silently comes up short is invisible.
 *
 * The final filter guarantees every returned entry has an address, which the type states so callers do
 * not have to re-check what this function already decided.
 *
 * @param {string} text
 * @returns {Array<{name: string, host: string, mac: string | null, line: number}>}
 */
export function inventoryHosts(text) {
  const hosts = [];
  let current = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith("#")) continue;
    const name = line.match(/^\s{8}([A-Za-z0-9][\w-]*):\s*$/);
    if (name) {
      current = { name: name[1], host: null, mac: null, line: index + 1 };
      hosts.push(current);
      continue;
    }
    const host = line.match(/^\s*ansible_host\s*:\s*(\S+)\s*$/);
    if (host && current) current.host = host[1].replace(/^["']|["']$/g, "");
    const mac = line.match(/^\s*mac\s*:\s*(\S*)\s*$/);
    if (mac && current) current.mac = normaliseMac(mac[1].replace(/^["']|["']$/g, ""));
  }
  return hosts.filter((h) => h.host);
}

/**
 * Lower-case, colon-separated, so `00-1A-2B` and `00:1a:2b` are the same machine.
 *
 * Accepts null/undefined and returns null: an inventory entry with no `mac:` is the normal state for a
 * box nobody has read the address off yet, and this is called on that value directly.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normaliseMac(value) {
  if (!value) return null;
  const hex = String(value).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

/** The MAC the host's ARP table has for an address, or null. Populated by having just talked to it. */
export function macOf(ip) {
  try {
    const out = execFileSync("arp", ["-n", ip], { encoding: "utf8", timeout: 3000 });
    const found = out.match(/([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})/);
    // macOS prints single-digit octets ("0:1a:..."), which normaliseMac would reject; pad them.
    return found ? normaliseMac(found[1].split(":").map((o) => o.padStart(2, "0")).join(":")) : null;
  } catch {
    return null;
  }
}

/** The /24 this host is on, e.g. "192.168.1". Guessing a subnet is worse than being told. */
export function localSubnet() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === "IPv4" && !a.internal && a.netmask === "255.255.255.0") {
        return a.address.split(".").slice(0, 3).join(".");
      }
    }
  }
  return null;
}

async function probe(ip, port) {
  try {
    const response = await requestJson(`http://${ip}:${port}/health`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!response.ok || !response.json) return null;
    return { ip, health: response.json, mac: macOf(ip) };
  } catch {
    return null;
  }
}

/** Everything answering /health on the subnet. */
export async function scan(subnet, port = DEFAULT_PORT) {
  const addresses = Array.from({ length: LAST_HOST_IN_SUBNET }, (_, i) => `${subnet}.${i + 1}`);
  const found = await Promise.all(addresses.map((ip) => probe(ip, port)));
  return found.filter(Boolean);
}

/**
 * Compare what answered against what the inventory claims.
 *
 * Pure, and separated from the scan so the interesting cases can be tested without a network — which
 * matters, because the interesting cases are the ones that only occur when something has gone wrong.
 *
 * @param {Array<{name: string, host: string, mac: string|null}>} declared
 * @param {Array<{ip: string, mac: string|null, health: object}>} discovered
 */
export function reconcile(declared, discovered) {
  const findings = [];
  const claimed = new Set();

  for (const entry of declared) {
    const atItsAddress = discovered.find((d) => d.ip === entry.host);
    if (atItsAddress) {
      claimed.add(atItsAddress.ip);
      findings.push({ state: "ok", name: entry.name, ip: entry.host, health: atItsAddress.health });
      continue;
    }
    // The case that cost us: nothing at the declared address, but a worker with this MAC elsewhere.
    const moved = entry.mac ? discovered.find((d) => d.mac && d.mac === entry.mac) : null;
    if (moved) {
      claimed.add(moved.ip);
      findings.push({ state: "moved", name: entry.name, ip: entry.host, foundAt: moved.ip, health: moved.health });
      continue;
    }
    // Absent is NOT a fault on a fleet that is meant to be powered down between runs.
    findings.push({ state: "absent", name: entry.name, ip: entry.host, mac: entry.mac });
  }

  for (const d of discovered) {
    if (claimed.has(d.ip)) continue;
    findings.push({ state: "unknown", ip: d.ip, mac: d.mac, health: d.health });
  }
  return findings;
}

/**
 * The next free `a11y-worker-N`.
 *
 * Numbers are never reused, even when a lower one has been retired: `wake.yml`, run summaries and this
 * project's own notes refer to boxes by that name for a long time, and handing a new machine a dead
 * machine's name makes every one of those references silently wrong.
 *
 * @param {string[]} existingNames
 */
export function nextWorkerName(existingNames) {
  const used = existingNames
    .map((name) => name.match(/^a11y-worker-(\d+)$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return `a11y-worker-${(used.length ? Math.max(...used) : 0) + 1}`;
}

/**
 * One inventory entry, as text.
 *
 * `today` is a parameter rather than read from the clock so this is pure and can be asserted on.
 *
 * A worker with no MAC is still enrolled. That looks wrong until you read `inventory.yml`'s own comment:
 * "A worker with no `mac` is skipped by wake.yml and NAMED, rather than silently not woken." The missing
 * fact is therefore already a LOUD state, so recording the box is strictly better than refusing to — the
 * alternative leaves a real machine in no file at all, which is the quiet failure.
 *
 * @param {{name: string, ip: string, mac: string|null, health: object, today: string}} entry
 */
export function enrolmentBlock({ name, ip, mac, health, today }) {
  const env = health?.environment ?? {};
  const identity = `${env.screenReaderVersion ? `NVDA ${env.screenReaderVersion}` : "no NVDA reported"}, `
    + `${env.windowsVersion ?? "unknown OS"}/${env.architecture ?? "?"}`;
  const lines = [
    "",
    `        ${name}:`,
    `          # Enrolled by \`fleet:discover --enroll\` on ${today}: ${identity}`,
    `          ansible_host: ${ip}`,
  ];
  if (mac) {
    lines.push(`          mac: "${mac}"`);
    return lines.join("\n");
  }
  lines.push("          # NO mac -- ARP had none for this address, so wake.yml will SKIP and NAME this box");
  lines.push("          # rather than silently not wake it. Read it off the machine and add it here:");
  lines.push(`          #   ansible ${name} -m win_shell -a "(Get-NetAdapter -Physical | ? Status -eq Up).MacAddress"`);
  return lines.join("\n");
}

/**
 * Append an entry for every unknown worker. ADDITIVE ONLY -- see this module's header for why that is
 * what makes writing to the inventory safe at all.
 *
 * A discovered MAC the inventory already declares is skipped rather than added. `reconcile` calls that a
 * MOVE and it needs a human: the box changed address, and appending it would put the SAME machine in the
 * file twice under two names, which is worse than the drift it was trying to fix.
 *
 * @param {string} text
 * @param {Array<{ip: string, mac: string|null, health: object}>} unknowns
 * @param {string} today
 * @returns {{text: string, added: Array<{name: string, ip: string, mac: string|null}>, skipped: Array<{ip: string, mac: string}>}}
 */
export function enrol(text, unknowns, today) {
  const declared = inventoryHosts(text);
  const knownMacs = new Set(declared.map((host) => host.mac).filter(Boolean));
  const names = declared.map((host) => host.name);
  const added = [];
  const skipped = [];
  let out = text.endsWith("\n") ? text : `${text}\n`;

  for (const worker of unknowns) {
    if (worker.mac && knownMacs.has(worker.mac)) {
      skipped.push({ ip: worker.ip, mac: worker.mac });
      continue;
    }
    const name = nextWorkerName([...names, ...added.map((entry) => entry.name)]);
    out += `${enrolmentBlock({ name, ip: worker.ip, mac: worker.mac, health: worker.health, today })}\n`;
    added.push({ name, ip: worker.ip, mac: worker.mac });
    if (worker.mac) knownMacs.add(worker.mac);
  }
  return { text: out, added, skipped };
}

/** A worker's identity in one line, so two boxes can be told apart at a glance. */
function describe(health) {
  const e = health?.environment ?? {};
  if (!health?.code && !e.screenReaderVersion) {
    // The retired Proxmox VM answers exactly this. Saying so beats printing a row of dashes.
    return "pre-dates /health.code and /health.environment — NOT a current worker";
  }
  return `code=${health.code ?? "?"} NVDA=${e.screenReaderVersion ?? "?"} `
    + `${e.browser ?? "?"} ${e.browserVersion ?? "?"} ${e.windowsVersion ?? "?"}/${e.architecture ?? "?"}`;
}

function render(findings) {
  const lines = [];
  for (const f of findings) {
    if (f.state === "ok") {
      lines.push(`  OK       ${f.name.padEnd(16)} ${f.ip.padEnd(15)} ${describe(f.health)}`);
    } else if (f.state === "moved") {
      lines.push(`  MOVED    ${f.name.padEnd(16)} ${f.ip.padEnd(15)} -> now at ${f.foundAt}`);
      lines.push(`           ${" ".repeat(16)} ${" ".repeat(15)} ${describe(f.health)}`);
      lines.push(`           inventory.yml says ${f.ip}. Fix it, and give this box a DHCP RESERVATION —`);
      lines.push("           a drifting address is the one staleness that looks exactly like a dead machine.");
    } else if (f.state === "absent") {
      lines.push(`  ASLEEP?  ${f.name.padEnd(16)} ${f.ip.padEnd(15)} not answering`);
      lines.push(f.mac
        ? `           ${" ".repeat(32)} wake it: ansible-playbook wake.yml -l ${f.name}`
        : `           ${" ".repeat(32)} and it has NO mac in inventory.yml, so it cannot be woken either`);
    } else {
      lines.push(`  UNKNOWN  ${" ".repeat(16)} ${f.ip.padEnd(15)} ${describe(f.health)}`);
      lines.push(`           not in inventory.yml. If it is a worker, add it:`);
      lines.push(`             a11y-worker-N:`);
      lines.push(`               ansible_host: ${f.ip}`);
      lines.push(`               mac: "${f.mac ?? "<unknown — read it from the box>"}"`);
    }
  }
  return lines;
}

/**
 * Write the enrolments and say what happened, including when nothing did.
 *
 * Reports rather than returns quietly: `--enroll` that adds nothing must be distinguishable from
 * `--enroll` that was never reached, which is this project's most expensive recurring shape.
 *
 * @param {string} inventoryPath
 * @param {Array<{ip: string, mac: string|null, health: object}>} unknowns
 */
function writeEnrolments(inventoryPath, unknowns) {
  const today = new Date().toISOString().slice(0, 10);
  const before = readFileSync(inventoryPath, "utf8");
  const { text, added, skipped } = enrol(before, unknowns, today);

  if (added.length) writeFileSync(inventoryPath, text, "utf8");

  const lines = added.map((e) => `  ENROLLED ${e.name.padEnd(16)} ${e.ip.padEnd(15)} mac ${e.mac ?? "MISSING — see the comment written beside it"}`);
  for (const s of skipped) {
    lines.push(`  SKIPPED  ${" ".repeat(16)} ${s.ip.padEnd(15)} its mac is already declared — this is a MOVE, fix the address by hand`);
  }
  if (!added.length && !skipped.length) lines.push("  nothing to enrol — every worker that answered is already declared");
  if (added.length) lines.push(`  wrote ${inventoryPath} — review and commit it, then: ansible-playbook provision-role.yml -l ${added.map((e) => e.name).join(",")}`);
  process.stdout.write(`\n${lines.join("\n")}\n`);
  return { added, skipped };
}

async function main() {
  const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? "").split("=")[1];
  const subnet = arg("cidr") || localSubnet();
  if (!subnet) {
    process.stderr.write("Could not work out which /24 to scan. Pass --cidr=192.168.1\n");
    process.exit(2);
  }
  const port = Number(arg("port") || DEFAULT_PORT);

  const inventoryPath = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url));
  const declared = inventoryHosts(readFileSync(inventoryPath, "utf8"));

  process.stderr.write(`scanning ${subnet}.1-${LAST_HOST_IN_SUBNET} on :${port} ...\n`);
  const discovered = await scan(subnet, port);
  const findings = reconcile(declared, discovered);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ subnet, port, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${render(findings).join("\n")}\n\n`);
    const counts = findings.reduce((acc, f) => ({ ...acc, [f.state]: (acc[f.state] ?? 0) + 1 }), {});
    process.stdout.write(`  ${declared.length} declared, ${discovered.length} answering — `
      + `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}\n`);
  }
  const enrolled = process.argv.includes("--enroll")
    ? writeEnrolments(inventoryPath, findings.filter((f) => f.state === "unknown"))
    : { added: [], skipped: [] };

  // Exit 1 only on a MISMATCH — a moved or unknown worker is something to act on. An absent one is not:
  // this fleet is meant to be off between runs, which doctor already refuses to treat as a fault.
  // An unknown worker that has just been ENROLLED is no longer something to act on, so it stops counting.
  const outstanding = findings.filter((f) => f.state === "unknown").length - enrolled.added.length;
  const mismatched = findings.some((f) => f.state === "moved") || outstanding > 0;
  process.exit(mismatched ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
