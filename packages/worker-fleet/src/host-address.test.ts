/**
 * `host-address.mjs` had no test at all -- the one definition four harnesses used to reimplement inline
 * as the `x.y.z.1` assumption this file's own header explains is wrong on a bare-metal fleet. `ipv4ToInt`
 * and `hostAddressForWorker`/`hostPagesBase`'s error and env-var paths are fully deterministic; only
 * `hostAddressFor`'s SUCCESS path depends on this machine's real interfaces, so it is exercised only
 * against addresses guaranteed unreachable from any real interface (RFC 5737 documentation ranges),
 * which must always return `undefined` regardless of what this host's network looks like.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ipv4ToInt, hostAddressFor, hostAddressForWorker, hostPagesBase,
} from "./host-address.mjs";

test("ipv4ToInt: a well-formed dotted quad converts to a comparable integer", () => {
  assert.equal(ipv4ToInt("0.0.0.0"), 0);
  assert.equal(ipv4ToInt("255.255.255.255"), 0xffffffff);
  // RFC 5737 documentation range, not a real private-LAN address -- the tracked-source leak guard
  // flags exactly this shape, correctly, and this arithmetic check does not need a real-looking one.
  assert.equal(ipv4ToInt("203.0.113.5"), ((203 * 256 + 0) * 256 + 113) * 256 + 5);
});

test("ipv4ToInt: refuses a hostname, IPv6, or a malformed address, returning null rather than NaN", () => {
  assert.equal(ipv4ToInt("localhost"), null);
  assert.equal(ipv4ToInt("::1"), null);
  assert.equal(ipv4ToInt("1.2.3"), null, "three octets is not a real address");
  assert.equal(ipv4ToInt("1.2.3.4.5"), null, "five octets is not a real address");
  assert.equal(ipv4ToInt("1.2.3.256"), null, "an octet over 255 is not a real address");
  assert.equal(ipv4ToInt("1.2.3.-1"), null, "a negative octet is not a real address");
  assert.equal(ipv4ToInt(""), null);
});

test("hostAddressFor: a guest address with no local interface sharing its subnet returns undefined", () => {
  // 203.0.113.0/24 is RFC 5737 documentation space -- guaranteed to share a subnet with no real
  // interface on any machine this test runs on, local or CI.
  assert.equal(hostAddressFor("203.0.113.5"), undefined);
});

test("hostAddressFor: a malformed guest address returns undefined rather than throwing", () => {
  assert.equal(hostAddressFor("not-an-address"), undefined);
});

test("hostAddressForWorker: a worker URL whose host is not an IPv4 literal returns undefined", () => {
  assert.equal(hostAddressForWorker("http://localhost:8765"), undefined);
  assert.equal(hostAddressForWorker("http://a11y-worker-2.local:8765"), undefined);
});

test("hostAddressForWorker: an unparseable URL returns undefined rather than throwing", () => {
  assert.equal(hostAddressForWorker("not a url at all"), undefined);
});

test("hostAddressForWorker: an IPv4 worker with no shared subnet returns undefined, same as hostAddressFor", () => {
  assert.equal(hostAddressForWorker("http://203.0.113.5:8765"), undefined);
});

test("hostPagesBase: DATASET_BASE_URL, when set, wins outright and is trimmed of a trailing slash", () => {
  const env = process.env.DATASET_BASE_URL;
  process.env.DATASET_BASE_URL = "http://example.test:5050/";
  try {
    assert.equal(hostPagesBase("http://203.0.113.5:8765"), "http://example.test:5050");
  } finally {
    if (env === undefined) delete process.env.DATASET_BASE_URL; else process.env.DATASET_BASE_URL = env;
  }
});

test("hostPagesBase: with no override and no resolvable address, throws naming the worker and the escape hatch", () => {
  const env = process.env.DATASET_BASE_URL;
  delete process.env.DATASET_BASE_URL;
  try {
    assert.throws(() => hostPagesBase("http://203.0.113.5:8765"),
      /Cannot work out this host's address as seen from http:\/\/203\.0\.113\.5:8765.*DATASET_BASE_URL/s);
  } finally {
    if (env !== undefined) process.env.DATASET_BASE_URL = env;
  }
});
