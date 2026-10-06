// The hash `worker:code` and every capture's preflight EXPECT is the layer CLONE's, the same one `fleet:deploy` and the lab ask for
// (`layerCodeVersion("nvda-worker")`, a11ign/a11ign#3781, found by `orchestrator` on #3455/#3733).
//
// Before this, both read the INSTALLED `@a11ign/screenreader-worker`. A guest deployed at a layer sha whose `.mjs` differs from the
// installed release (which is what `--layer-ref` is for) serves the clone's hash, and every worker then read STALE against a remedy
// ("redeploy") that could not clear it. Equal only while the clone's sources equal the release, which is the reading that hid it.
//
// The fixture is a CHECKOUT ROOT: `packages/control/layers.json` declaring `nvda-worker` at `packages/nvda-worker`, and a clone there
// whose `src/` is the installed package's with ONE `.mjs` byte appended. The expected value is computed the way `layerCodeVersion` does
// (the clone's own `code-version.mjs` over the clone's `src/`), never by the code under test, so the assertion is independent of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codeVersion, workerSourceDir } from "@a11ign/screenreader-worker/code-version";
import { assertFleetRunsThisCheckout } from "./worker-code-check.mjs";

const CHECK = join(import.meta.dirname, "check-worker-code.mjs");
const CLONE_PATH = "packages/nvda-worker";

function withoutClone(): string {
  const root = mkdtempSync(join(tmpdir(), "worker-code-clone-"));
  mkdirSync(join(root, "packages", "control"), { recursive: true });
  writeFileSync(join(root, "packages", "control", "layers.json"),
    JSON.stringify({ layers: { "nvda-worker": { path: CLONE_PATH, remote: "https://example.invalid/nvda.git" } } }));
  return root;
}

/** A checkout root whose clone differs from the installed copy by one byte of `capture-core.mjs`. */
function withDivergedClone(): string {
  const root = withoutClone();
  cpSync(workerSourceDir(), join(root, CLONE_PATH, "src"), { recursive: true });
  appendFileSync(join(root, CLONE_PATH, "src", "capture-core.mjs"), "\n");
  return root;
}

/** `layerCodeVersion`, as `packages/control` computes it: the CLONE's own hasher over the CLONE's `src/`. */
async function cloneHash(root: string): Promise<string> {
  const src = `${join(root, CLONE_PATH, "src")}/`;
  const hasher = await import(pathToFileURL(join(src, "code-version.mjs")).href);
  return hasher.codeVersion(src);
}

/** A worker that serves `/health` with `{ code }`. */
async function workerServing(code: string): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code })); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server };
}

/** `a11ign-worker-code` run from `cwd` against one worker. Async, because a sync spawn would block the worker's own event loop. */
function runCheck(cwd: string, workerUrl: string): Promise<{ status: number; out: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [CHECK], { cwd, env: { ...process.env, A11Y_WORKERS: workerUrl, A11Y_WORKER: "" } }, (error, stdout, stderr) =>
      done({ status: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout + stderr }));
  });
}

async function checkAgainst(root: string, servedCode: string) {
  const { url, server } = await workerServing(servedCode);
  try { return await runCheck(root, url); } finally { server.close(); }
}

/** `assertFleetRunsThisCheckout` with `process.exit` turned into a throw, reading `served` from the one worker. */
async function preflight(root: string, served: string): Promise<{ exitCode: number | null; out: string }> {
  const realExit = process.exit, realOut = process.stdout.write, realErr = process.stderr.write;
  let out = "";
  const capture = (chunk: string | Uint8Array) => { out += String(chunk); return true; };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error("exit"), { exitCode: code }); }) as typeof process.exit;
  try {
    await assertFleetRunsThisCheckout(["http://worker.invalid"], { read: async () => served, checkoutRoot: root });
    return { exitCode: null, out };
  } catch (e) {
    if ((e as { exitCode?: number }).exitCode === undefined) throw e;
    return { exitCode: (e as { exitCode: number }).exitCode, out };
  } finally {
    process.exit = realExit; process.stdout.write = realOut; process.stderr.write = realErr;
  }
}

test("the control: the diverged clone really hashes differently from the installed copy", async () => {
  const root = withDivergedClone();
  try {
    assert.notEqual(await cloneHash(root), codeVersion(), "one appended byte must change the hash, or the fixture proves nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("`worker:code` expects the CLONE's hash: a worker serving it matches, and the output names the clone", async () => {
  const root = withDivergedClone();
  try {
    const clone = await cloneHash(root);
    const { status, out } = await checkAgainst(root, clone);
    assert.match(out, new RegExp(`this checkout: ${clone}`), out);
    assert.match(out, /layer clone/i, out);
    assert.match(out, /matches/, out);
    assert.equal(status, 0, out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("`worker:code` against the clone calls a worker serving the INSTALLED copy's hash stale (the other direction)", async () => {
  const root = withDivergedClone();
  try {
    const { status, out } = await checkAgainst(root, codeVersion());
    assert.match(out, /STALE/, out);
    assert.equal(status, 1, out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with NO clone, `worker:code` expects the installed copy's hash and SAYS that it did", async () => {
  const root = withoutClone();
  try {
    const { status, out } = await checkAgainst(root, codeVersion());
    assert.match(out, new RegExp(`this checkout: ${codeVersion()}`), out);
    assert.match(out, /installed/i, out);
    assert.match(out, /no layer clone/i, out);
    assert.equal(status, 0, out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the capture preflight asks the SAME question: the clone's hash passes, the installed copy's is refused", async () => {
  const root = withDivergedClone();
  try {
    const clone = await cloneHash(root);
    const passes = await preflight(root, clone);
    assert.equal(passes.exitCode, null, passes.out);
    assert.match(passes.out, new RegExp(clone), passes.out);
    assert.match(passes.out, /layer clone/i, passes.out);
    const refused = await preflight(root, codeVersion());
    assert.equal(refused.exitCode, 3, refused.out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a clone that is THERE but cannot hash is refused, never answered for by the installed copy", async () => {
  const root = withoutClone();
  try {
    mkdirSync(join(root, CLONE_PATH, "src"), { recursive: true });
    const { status, out } = await checkAgainst(root, codeVersion());
    assert.notEqual(status, 0, out);
    assert.match(out, new RegExp(CLONE_PATH.replace("/", "[/\\\\]")), out);
    assert.doesNotMatch(out, /matches/, out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
