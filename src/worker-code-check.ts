// @ts-check
/**
 * Is the fleet running the code this checkout expects — asked BEFORE a capture run, not after it.
 *
 * ## The hole this closes
 *
 * `run-job.yml` refuses to run at a commit other than the one asked for, and the comment above that
 * refusal says why: *"a job that quietly runs four commits behind reports success for code you did not
 * ask for."* That guard covers the LAB. It says nothing about the twelve machines that actually take the
 * captures, and those are a second checkout, deployed by a separate command nobody is forced to run.
 *
 * So a capture run could be dispatched at the right commit, on a lab that proved it was at the right
 * commit, and still capture with the PREVIOUS release of `capture-core.mjs`. Measured on 2026-08-25: after
 * `MAX_TAB_STOPS` went 12 -> 150 and `collectByType` started recording `prevCount`, the real-page corpus
 * held both populations at once, and the only way to read it was to bucket captures by whether they
 * carried the new diagnostic mark at all. The evidence was mixed, the run reported success, and the
 * separation had to be done by hand afterwards.
 *
 * `npm run worker:code` has answered this question correctly the whole time. It is a separate command a
 * human must remember, which is this repo's own definition of a check that does not happen — and it was
 * remembered by hand four times in one day before this existed.
 *
 * ## Why a REFUSAL, and why on any difference at all
 *
 * `workerCode` is deliberately outside the capture cache key ("it changes when a comment changes, and
 * invalidating the WHOLE corpus over a reworded comment is how a cache becomes something people turn
 * off") and deliberately outside
 * `fleet-consistency.mjs`'s `MUST_MATCH` for the same reason. Both of those are the right call for
 * the questions they answer — *is this evidence still valid* and *are these guests interchangeable*.
 *
 * This is a third question with a different answer: *am I about to capture with the code I asked for*. A
 * comment-only drift is a false alarm here and it costs one `fleet:deploy`; a real drift costs a corpus and
 * is invisible, because nothing downstream keys on `workerCode`. That asymmetry is the whole argument.
 *
 * It is a PRECONDITION and never a key: nothing here invalidates a cached capture.
 *
 * ## The comparison itself lives in `code-drift.mjs`, and this file is the reason for the split
 *
 * `resolveExpectedWorkerCode` below needs `codeVersion`/`workerSourceDir`, reached through a SUBPATH export
 * (`@a11ign/screenreader-worker/code-version`) rather than a relative path — a relative one drags
 * `nvda-worker`'s `.mjs` files into this package's own tsc project and the build dies with TS5055 ("would
 * overwrite input file"). That subpath resolves through `node_modules`, which is exactly what
 * `packages/control` does not have (ADR 0012) — so when `lab-job.mjs` needed this same comparison BEFORE
 * dispatching to the lab, it could not import this file. `code-drift.mjs` is the part of this file with no
 * opinion about what "expected" means: it takes the hash as a parameter, imports nothing but
 * `node:child_process`, and is safe from both places. This file supplies the one thing only it can compute.
 */
import { codeDrift, describeCodeDrift, describeEmptyPool, readWorkerCode, remedyLines,
  workerSourceDirty, assertWorkersServe } from "./code-drift.ts";

// A SUBPATH export, not a deep relative path: `../../nvda-worker/src/...` drags those .mjs files into
// worker-fleet's tsc project and the build dies with TS5055 "would overwrite input file". The subpath is
// also the shape already in use for the same reason -- `@a11ign/screenreader-fleet/worker-http`.
// The hasher module (`code-version.ts` in the worker repository, built to `dist/code-version.mjs` in the package) imports nothing
// but node stdlib and `worker-files`, which is why it is safe and why it is its own module. Still the ONE hasher: the subpath is
// the same function.
import { codeVersion, workerSourceDir } from "@a11ign/screenreader-worker/code-version";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The layer `layers.json` declares for the worker, which is what `layerCodeVersion("nvda-worker")` asks for on the deploy side. */
const NVDA_WORKER_LAYER = "nvda-worker";

/**
 * Where the layer's CLONE is, or why there is none: the checkout's own `packages/control/layers.json` names it.
 *
 * `packages/control/layer-checkouts.mjs` is the deploy's and the lab's reader of that manifest, and it cannot be imported from here
 * (`@a11ign/control` is never published), so this reads the same FILE and applies the same rule: a layer's directory is
 * `<checkout root>/<declared path>`. The root is an argument, defaulting to the cwd, which is the checkout for every `pnpm`/`npm`
 * script and which a caller that knows better passes in. NOT a path relative to this module: the package lives in `node_modules`.
 *
 * "No clone" is an ANSWER, not an error (the installed copy then stands in, and the caller says so); a manifest that is there and
 * cannot be parsed, or a clone that is there and cannot hash, is an error, because answering with the other tree is the silent wrong
 * reading this exists to remove.
 *
 * @param {string} checkoutRoot
 * @returns {{ dir: string } | { absent: string }}
 */
function layerClone(checkoutRoot: string): { dir: string; } | { absent: string; } {
  const manifestPath = join(checkoutRoot, "packages", "control", "layers.json");
  if (!existsSync(manifestPath)) return { absent: `no packages/control/layers.json under ${checkoutRoot}` };
  const layer = JSON.parse(readFileSync(manifestPath, "utf8")).layers?.[NVDA_WORKER_LAYER];
  if (!layer?.path) return { absent: `${manifestPath} does not declare "${NVDA_WORKER_LAYER}"` };
  const dir = resolve(checkoutRoot, layer.path);
  return existsSync(dir) ? { dir } : { absent: `no layer clone at ${dir}` };
}

/** The clone's hasher, newest form first: `@a11ign/screenreader-worker` 0.9.0 ships `code-version.ts` and no `.mjs`. */
const CLONE_HASHER_EXTENSIONS = ["ts", "mjs"];

/**
 * The clone's own hasher module under `sourceDir`, the `.ts` before the `.mjs`.
 *
 * The `.mjs` stays as a fallback because `--layer-ref` deploys a guest at ANY layer sha, and a sha from before the worker moved to
 * TypeScript has only the `.mjs`; refusing it would turn a guest that is correctly deployed into a check that throws. A clone with
 * NEITHER is refused here, by name, rather than answered for by the installed copy (the silent wrong reading `layerClone` explains).
 */
function cloneHasherPath(sourceDir: string): string {
  const candidates = CLONE_HASHER_EXTENSIONS.map((extension) => join(sourceDir, `code-version.${extension}`));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`the layer clone's src/ holds no hasher to ask for the expected worker code; looked for ${candidates.join(" or ")}`);
  }
  return found;
}

/**
 * The hash every worker is expected to be serving, and WHERE IT CAME FROM. ONE function, asked by `a11ign-worker-code` and by
 * `assertFleetRunsThisCheckout` alike, so the two cannot be given different hashers again (a11ign/a11ign#3781).
 *
 * With a layer clone present it is the CLONE's: the clone's own hasher (`code-version.ts`, or `code-version.mjs` in a clone from
 * before the worker repository moved to TypeScript) over the clone's `src/`, which is what `layerCodeVersion("nvda-worker")`
 * computes for the deploy and the lab, and what a guest is told to be on (`--layer-ref`). Asking the installed package instead made
 * every worker read stale the first time a guest was deployed at a sha whose sources differed from the release, with a remedy
 * ("redeploy") that could not clear it.
 *
 * With none it is the installed package's (a11ign/a11ign#3740: the one the package was RELEASED with, `codeVersion()` and no
 * directory, because the built package's `workerSourceDir()` is `dist/` and holds none of the files a guest runs), and `source` and
 * `note` say so, so a reading is never silent about which it was.
 *
 * ASYNC because the clone's hasher can only be imported dynamically, as `layerCodeVersion` does.
 *
 * @param {{ checkoutRoot?: string }} [options]
 * @returns {Promise<{ code: string, source: "clone" | "installed", sourceDir: string, note: string }>}
 */
export async function resolveExpectedWorkerCode({ checkoutRoot = process.cwd() }: { checkoutRoot?: string; } = {}): Promise<{ code: string; source: "clone" | "installed"; sourceDir: string; note: string; }> {
  const clone = layerClone(checkoutRoot);
  if ("absent" in clone) {
    return { code: codeVersion(), source: "installed", sourceDir: workerSourceDir(),
      note: `the installed @a11ign/screenreader-worker (${clone.absent})` };
  }
  const sourceDir = `${join(clone.dir, "src")}/`;
  const hasher = await import(pathToFileURL(cloneHasherPath(sourceDir)).href);
  return { code: hasher.codeVersion(sourceDir), source: "clone", sourceDir, note: `the layer clone at ${clone.dir}` };
}

// Re-exported rather than duplicated: existing callers (`capture-real-pages.mjs`,
// `capture-screenreader-dataset.mjs`, and this module's own test) import these from here, and moving their
// implementation to `code-drift.mjs` must not become a second place either has to be found.
export { codeDrift, describeCodeDrift, describeEmptyPool, readWorkerCode, remedyLines, workerSourceDirty };

/**
 * Refuse to capture with a fleet that is not running this checkout.
 *
 * Called at the boundary of every capture entry point, for the reason `assertWorkerUrl` is: the
 * alternative is discovering it in the evidence weeks later, where a stale worker looks like a page that
 * changed. **Both entry points, not one** — a remedy that reaches one of several paths is the shape this
 * repo has paid for three times over (`anchorToTop`, `ensureSpeechChannel`, `waitForAnnouncement`), and
 * `capture-preflight.test.ts` pins that both call it.
 *
 * A thin wrapper over `assertWorkersServe`, supplying the one thing only this file can compute: the hash.
 *
 * @param {string[]} workers
 * @param {{when?: string, allow?: boolean, read?: (url: string) => Promise<string|null>, bareMetalUrls?: string[], checkoutRoot?: string}} options
 */
export async function assertFleetRunsThisCheckout(workers: string[], options: { when?: string; allow?: boolean; read?: (url: string) => Promise<string | null>; bareMetalUrls?: string[]; checkoutRoot?: string; } = {}) {
  const { checkoutRoot, ...rest } = options;
  const expected = await resolveExpectedWorkerCode({ checkoutRoot });
  if (!options.allow) process.stdout.write(`Expected worker code ${expected.code}, from ${expected.note}.\n`);
  return assertWorkersServe(expected.code, workers, { ...rest, sourceDir: expected.sourceDir });
}
