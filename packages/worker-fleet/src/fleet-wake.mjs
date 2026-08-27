// @ts-check
/**
 * Wake the fleet, from the LAB, without holding any credential.
 *
 *     npm run fleet:wake                  # every worker in the inventory
 *     npm run fleet:wake -- a11y-worker-2 # one
 *
 * ## Why this exists next to `wake.yml`, which does the same thing
 *
 * It is not duplication of the interesting kind, and the reason is the whole point of ADR 0012.
 *
 * A magic packet is an unauthenticated UDP broadcast. Waking a machine needs **no secret at all** —
 * which is what lets the lab container start the workers a run needs while holding none of the fleet's
 * SSH key. Shutting one down, provisioning it, or deploying to it all need that key, so they stay in the
 * control container. The privilege split therefore falls out of the physics rather than out of policy:
 * the lab can turn machines ON, and cannot turn them off or reconfigure them.
 *
 * `wake.yml` remains the operator's tool on the control plane, where Ansible already is. This is the
 * same packet, sent by the process that actually wants the worker.
 *
 * ## No dependencies, deliberately
 *
 * `node:dgram` and nothing else. The lab has a 100 MB dependency tree, but a run should not be unable to
 * start its own workers because of an install problem in something unrelated.
 */
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inventoryHosts } from "./fleet-discover.mjs";
import { requestJson } from "./worker-http.mjs";
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * takes no flags: it wakes every box in the inventory.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags([], { entry: import.meta.url, command: "npm run fleet:wake" });

/** Port 9 (discard) by convention; nothing listens, the NIC's firmware matches the frame. */
const WOL_PORT = 9;
/** UDP is unacknowledged, so the only mitigation for a dropped frame is another frame. */
const PACKETS = 3;
const HEALTH_TIMEOUT_MS = 4_000;
const POLL_MS = 5_000;

/**
 * The 102-byte magic packet: six 0xFF bytes, then the target MAC sixteen times.
 *
 * Built here rather than pulled from a package because it is six lines and a dependency in the wake path
 * is a dependency that can stop a run from starting.
 *
 * @param {string} mac
 * @returns {Buffer}
 */
export function magicPacket(mac) {
  const bytes = String(mac).replace(/[^0-9a-fA-F]/g, "");
  if (bytes.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const target = Buffer.from(bytes, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(target)]);
}

/**
 * @param {string} mac
 * @param {string} broadcast
 */
export function sendMagicPacket(mac, broadcast = "255.255.255.255") {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const send = () => socket.send(packet, 0, packet.length, WOL_PORT, broadcast, (error) => {
        if (error) { socket.close(); reject(error); return; }
        sent += 1;
        if (sent < PACKETS) return send();
        socket.close();
        resolve(sent);
      });
      send();
    });
  });
}

/** @param {string} url */
async function answering(url) {
  try {
    const response = await requestJson(`${url}/health`, { timeoutMs: HEALTH_TIMEOUT_MS });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wake the named workers and wait until they serve.
 *
 * Returns per-worker outcomes rather than throwing on the first failure: a fleet where one box has a
 * flat firmware setting should still bring the other eleven up, and the report should name which.
 *
 * DECLARED rather than inferred. With no `@param` here TypeScript builds the options type from the
 * DEFAULTS, so `broadcast` -- the one option with no default -- was simply absent from it, and `log`
 * inferred as zero-arg from `() => {}` while every call passes a string. An options bag documented by
 * its own defaults describes exactly the options that need documenting least.
 *
 * @param {{ name: string, host: string, mac?: string | null }[]} workers
 * @param {{ port?: number, broadcast?: string, deadlineMs?: number,
 *           log?: (line: string) => void }} [options]
 */
export async function wakeFleet(workers, { port = 8765, broadcast, deadlineMs = 300_000, log = () => {} } = {}) {
  const results = await Promise.all(workers.map(async (w) => {
    const url = `http://${w.host}:${port}`;
    if (await answering(url)) return { ...w, state: "already-up" };
    if (!w.mac) return { ...w, state: "no-mac" };

    await sendMagicPacket(w.mac, broadcast);
    log(`  ${w.name}: magic packet sent to ${w.mac}`);

    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      // Waiting for the CONDITION, not sleeping a guess. A cold boot has to POST, start Windows,
      // auto-log-on, fire the at-logon task and warm NVDA up; a deadline that expires early turns
      // "still coming up" into "did not wake", and those have completely different remedies.
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (await answering(url)) return { ...w, state: "woken" };
    }
    return { ...w, state: "timeout" };
  }));
  return results;
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const inventory = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url));
  const declared = inventoryHosts(readFileSync(inventory, "utf8"));
  const workers = wanted.length ? declared.filter((w) => wanted.includes(w.name)) : declared;

  if (!workers.length) {
    process.stderr.write(wanted.length
      ? `No worker named ${wanted.join(", ")} in inventory.yml\n`
      : "No workers in inventory.yml\n");
    process.exit(2);
  }

  const results = await wakeFleet(workers, { log: (l) => process.stdout.write(`${l}\n`) });
  process.stdout.write("\n");
  for (const r of results) {
    const detail = {
      "already-up": "already up",
      woken: "woken and serving",
      timeout: "did NOT come back — check Wake-on-LAN and Deep Sleep in its firmware",
      "no-mac": "no mac in inventory.yml, so it cannot be woken",
    }[r.state];
    process.stdout.write(`  ${r.name.padEnd(16)} ${r.host.padEnd(15)} ${detail}\n`);
  }
  // Non-zero only when a worker we were ASKED to wake did not come back. Nothing here can shut a box
  // down, so the worst case is a run that finds fewer workers than it hoped — which the dispatcher
  // already handles by using the ones that answered.
  process.exit(results.some((r) => r.state === "timeout" || r.state === "no-mac") ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
