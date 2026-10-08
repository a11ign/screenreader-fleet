// The expected worker hash is computable from the BUILT `@a11ign/screenreader-worker` (a11ign/a11ign#3740, orchestrator Ruling 2 on #3552).
//
// Its 0.2.0 is a build: `workerSourceDir()` is the package's `dist/`, which holds none of the files a guest runs (a guest runs the raw
// `src/*.mjs`, ADR 0031), so `resolveExpectedWorkerCode()` as it was, `codeVersion(workerSourceDir())`, threw ENOENT, and `a11ign-worker-code` and
// every capture's `assertFleetRunsThisCheckout` with it. This repository pins 0.1.0 (raw `src`), where that call works, so a test against
// the INSTALLED package cannot be red here; the fixture below is a package laid out the way the build emits it, and is what can be.
//
// NOT HERE: the equality with the layer's own `codeVersion()` over its `src`. That needs the layer's checkout, which this repository does
// not have; it is read from a PACKED install on the pull request, and pinned in `screenreader-worker`'s `scripts/built-package.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SIBLINGS = ["worker-code-check.mjs", "code-drift.mjs", "git-safe-env.mjs", "worker-http.mjs"];
const BAKED = "0123456789abcdef";

// `dist/code-version.mjs` as the build emits it, which is `src/code-version.mjs` bundled, with `codeVersion()`'s default the baked hash
// (`scripts/write-code-version.mjs` in the worker). `WORKER_FILES` is one name that is NOT in `dist`, as in the real package, where
// Rspack names the chunks `src_capture-core_mjs.mjs`.
const BUILT_CODE_VERSION = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const WORKER_FILES = ["capture-core.mjs"];
const workerSourceDir = ()=>fileURLToPath(new URL("./", import.meta.url));
const SOURCE_CODE_VERSION = "${BAKED}";
function codeVersion(dir) {
    if (dir === undefined) return SOURCE_CODE_VERSION;
    for (const file of WORKER_FILES) readFileSync(resolve(dir, file), "utf8");
    return "unreached";
}
export { codeVersion, workerSourceDir };
`;

/** A directory holding this package's check beside a `node_modules` whose worker package is built. */
function fixtureWithBuiltWorker(): string {
  const root = mkdtempSync(join(tmpdir(), "worker-code-built-"));
  for (const file of SIBLINGS) copyFileSync(join(import.meta.dirname, file), join(root, file));
  const packageDir = join(root, "node_modules", "@a11ign", "screenreader-worker");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@a11ign/screenreader-worker", type: "module", exports: { "./code-version": "./dist/code-version.mjs" },
  }));
  writeFileSync(join(packageDir, "dist", "code-version.mjs"), BUILT_CODE_VERSION);
  return root;
}

test("`resolveExpectedWorkerCode()` is the hash a BUILT worker package carries, and the old expression against that package throws (control)", async () => {
  const root = fixtureWithBuiltWorker();
  try {
    const built = await import(pathToFileURL(join(root, "node_modules/@a11ign/screenreader-worker/dist/code-version.mjs")).href);
    // The control: the fixture is shaped like the build, so the expression this row replaced fails on it as it failed on 0.2.0.
    assert.throws(() => built.codeVersion(built.workerSourceDir()), { code: "ENOENT" });
    const { resolveExpectedWorkerCode } = await import(pathToFileURL(join(root, "worker-code-check.mjs")).href);
    // `checkoutRoot: root` holds no `layers.json`, so the installed (here: built) package answers.
    assert.equal((await resolveExpectedWorkerCode({ checkoutRoot: root })).code, BAKED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`resolveExpectedWorkerCode()` answers with the package that is installed, whatever shape that is", async () => {
  const { resolveExpectedWorkerCode } = await import("./worker-code-check.mjs");
  const expected = await resolveExpectedWorkerCode({ checkoutRoot: tmpdir() });
  assert.equal(expected.source, "installed");
  assert.match(expected.code, /^[0-9a-f]{16}$/);
});
