// @ts-check
/**
 * This host's address as a WORKER sees it — one definition, because there were five.
 *
 * A worker cannot reach the host's `localhost`, so anything the host serves to a worker (the dataset
 * page server, above all) must be addressed by the host's LAN IP. `local-vm.ts` worked this out
 * correctly and said why:
 *
 *   > Derived by matching interfaces against the guest's address rather than assuming the usual
 *   > `x.y.z.1`, because guessing an address that silently does not answer is worse than reporting
 *   > that we could not find one.
 *
 * Four harnesses then reimplemented it inline as exactly the assumption that comment rejects:
 *
 *     new URL(worker).hostname.replace(/\.\d+$/, ".1")
 *
 * That is right for UTM, where the Mac really is the `.1` gateway of the shared network, and wrong
 * for every other network. Measured: against a bare-metal worker on the fleet's own LAN it produced
 * the ROUTER's address instead — so `evidence:check` refused to run because the pages
 * were not being served. On a fleet of bare-metal boxes it fails every time.
 *
 * The failure mode is why this matters more than tidiness. `guestReachableUrl`'s own note records
 * what happened last time this was wrong: the guest fetched its own localhost, Edge showed
 * "localhost refused to connect", the title check rejected the capture, and three attempts were
 * burned per page before giving up — a page-server problem wearing a capture problem's costume.
 *
 * Plain `.mjs` on purpose: `capture-check.mjs` runs under bare node on the guest (see
 * `run-capture-check.cmd`) and cannot import TypeScript.
 */
import { networkInterfaces } from "node:os";

const IPV4_OCTETS = 4;

/** Dotted quad to a comparable integer, or null if it is not one (a hostname, IPv6, nonsense). */
/** @param {string} ip */
export function ipv4ToInt(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== IPV4_OCTETS || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts.reduce((acc, octet) => acc * 256 + octet, 0);
}

/**
 * This host's address on the same subnet as `guestIp`, or undefined if we have no interface onto it.
 *
 * Undefined rather than a guess: a caller that is told "we do not know" can ask to be told, whereas
 * a caller handed a plausible-but-dead address discovers it as a timeout somewhere else entirely.
 *
 * @param {string} guestIp
 * @returns {string | undefined}
 */
export function hostAddressFor(guestIp) {
  const guest = ipv4ToInt(guestIp);
  if (guest === null) return undefined;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const host = ipv4ToInt(a.address);
      const mask = ipv4ToInt(a.netmask);
      if (host === null || mask === null) continue;
      // Both sides go through the same coercion, so addresses above 2^31 comparing as negative
      // is harmless here.
      if ((host & mask) === (guest & mask)) return a.address;
    }
  }
  return undefined;
}

/**
 * This host's address as seen from a worker at `workerUrl`, when the two share a subnet.
 *
 * @param {string} workerUrl
 * @returns {string | undefined}
 */
export function hostAddressForWorker(workerUrl) {
  try {
    const { hostname } = new URL(workerUrl);
    return ipv4ToInt(hostname) === null ? undefined : hostAddressFor(hostname);
  } catch {
    return undefined;
  }
}

/**
 * The base URL a worker should use to fetch host-served pages.
 *
 * Throws rather than returning something unusable. The four call sites all feed this straight into a
 * capture request, and a wrong page URL does not present as a page-server fault — it presents as
 * captures that read an error page, which is evidence rot rather than an outage.
 *
 * @param {string} workerUrl
 * @param {number | string} [port]
 * @returns {string}
 */
export function hostPagesBase(workerUrl, port = process.env.DATASET_PAGES_PORT || 5050) {
  if (process.env.DATASET_BASE_URL) return process.env.DATASET_BASE_URL.replace(/\/$/, "");
  const address = hostAddressForWorker(workerUrl);
  if (!address) {
    throw new Error(
      `Cannot work out this host's address as seen from ${workerUrl}: no local interface shares its subnet. `
      + "Set DATASET_BASE_URL to the URL the worker should fetch dataset pages from.");
  }
  return `http://${address}:${port}`;
}
