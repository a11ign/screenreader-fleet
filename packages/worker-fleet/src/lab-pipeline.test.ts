/**
 * A pipeline is an ORDER over jobs that live somewhere else, so the two can drift — and this repo's record
 * on a fact stated twice is unambiguous: five instances in one day, every one silent.
 *
 * The drift here has a specific cost that makes it worth pinning rather than trusting. A pipeline naming a
 * job that no longer exists fails at that STAGE, which for `corpus` is after a multi-hour capture; and a
 * pipeline that captures without `fleet: true` runs against whatever the boxes happen to be serving, which
 * is the exact fault `worker-code-check.mjs` was written for one layer down.
 *
 * The catalogue is YAML and the pipelines are JS, so a copy cannot be deleted here. That leaves the third
 * option — pin them equal with a test — which is what `name-normalisation.test.ts` does for the same
 * reason, and which failed twice on its first run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { PIPELINES, validRef } from "./lab-pipeline.mjs";

type Job = { argv?: unknown; setenv?: string[]; timeout?: number };

/** The job catalogue, read from the playbook that owns it. */
function catalogue(): Record<string, Job> {
  const text = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");
  const doc = parseYaml(text) as Array<{ vars?: { lab_jobs?: Record<string, Job> } }>;
  const jobs = doc.flatMap((play) => (play?.vars?.lab_jobs ? [play.vars.lab_jobs] : []))[0];
  // A guard that parses the wrong shape passes while examining nothing — the signal-type scrape that
  // matched an empty set and the `sweepLog` test that read a field which does not exist.
  if (!jobs) throw new Error("lab_jobs not found in lab-job.yml — this guard is parsing the wrong shape");
  return jobs;
}

const JOBS = catalogue();

/** A job that reads a worker address needs the fleet deployed before it runs. */
const usesWorkers = (job: Job) =>
  (job?.setenv ?? []).some((entry) => /^A11Y_WORKERS?=/.test(String(entry)));

test("the catalogue parsed, and parsed enough of it to be worth asserting on", () => {
  assert.ok(Object.keys(JOBS).length > 10,
    `only ${Object.keys(JOBS).length} jobs parsed out of the catalogue; the shape changed and this is blind`);
  assert.ok(Object.values(JOBS).some(usesWorkers),
    "no job in the catalogue reads A11Y_WORKER(S) — the fleet check below would then be vacuous");
});

test("every job a pipeline names exists in the catalogue", () => {
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    for (const job of pipeline.jobs) {
      assert.ok(Object.hasOwn(JOBS, job),
        `pipeline '${name}' names job '${job}', which lab-job.yml does not have. It would be refused at `
        + `that stage — for 'corpus' that is after a multi-hour capture has already run.`);
    }
  }
});

test("a pipeline that captures deploys the fleet first", () => {
  // Otherwise it captures with whatever the workers happen to be serving, and the evidence is stamped with
  // a commit that did not produce it. `assertFleetRunsThisCheckout` would now REFUSE such a run at the
  // worker level, which is the belt; this is the braces, and it fails at dispatch rather than an hour in.
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const needs = pipeline.jobs.filter((job) => usesWorkers(JOBS[job]));
    if (!needs.length) continue;
    assert.equal(pipeline.fleet, true,
      `pipeline '${name}' runs ${needs.join(", ")}, which read A11Y_WORKER(S), but does not deploy the `
      + "fleet first. Set fleet: true, or the run captures with whatever the boxes are running.");
  }
});

test("a pipeline that needs no worker does NOT wake the fleet", () => {
  // The other direction, and it matters as much: deploying restarts every guest, so a gates-only pipeline
  // that declared `fleet: true` would take the fleet offline to run something that reads from disk.
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    if (pipeline.jobs.some((job) => usesWorkers(JOBS[job]))) continue;
    assert.equal(pipeline.fleet, false,
      `pipeline '${name}' needs no worker, so deploying would restart the fleet for nothing.`);
  }
});

test("at least one pipeline of each kind exists, so neither branch is untested by construction", () => {
  const values = Object.values(PIPELINES);
  assert.ok(values.some((p) => p.fleet), "no pipeline deploys the fleet; the check above is vacuous");
  assert.ok(values.some((p) => !p.fleet), "no pipeline skips the fleet; the check above is vacuous");
});

test("every pipeline names what it is for, and orders at least two stages", () => {
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    assert.ok((pipeline.what ?? "").length > 20, `pipeline '${name}' does not say what it is for`);
    assert.ok(pipeline.jobs.length >= 2,
      `pipeline '${name}' has ${pipeline.jobs.length} stage(s) — a pipeline of one is a job, so use lab:job`);
    assert.deepEqual([...new Set(pipeline.jobs)], pipeline.jobs,
      `pipeline '${name}' runs a job twice; each stage is idempotent, so that is almost certainly a slip`);
  }
});

test("a ref is contained by SHAPE, because it reaches a shell on the box holding the fleet key", () => {
  // Same rule as `isValidCaptureId` and `fleet-playbook.mjs`: inexpressible rather than rejected.
  assert.ok(validRef("main"));
  assert.ok(validRef("feature/np-calibration"));
  assert.ok(validRef("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"));
  for (const bad of ["a;rm -rf /", "$(whoami)", "a b", "../../etc", "a..b", "`id`", "", "x".repeat(65)]) {
    assert.equal(validRef(bad), false, `validRef must refuse ${JSON.stringify(bad)}`);
  }
});

test("a stage runs the npm script, never a second spelling of the ansible command", () => {
  // `lab:job` sets ANSIBLE_CONFIG; a hand-spelled `ansible-playbook` here would silently use different
  // collections and host-key settings. Asserted structurally because running a stage means running a job.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  const executable = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.ok(!/ansible-playbook/.test(executable),
    "lab-pipeline.mjs spells out ansible-playbook again. Go through `npm run lab:job`, which owns the "
    + "invocation and its ANSIBLE_CONFIG.");
  assert.match(executable, /"run", "lab:job"/);
  assert.match(executable, /"run", "fleet:deploy"/);
});

test("stages are run with their status READ, never piped", () => {
  // Two real `ANSIBLE_EXIT=2` failures were masked by `| tail` in one day, because a pipeline's status is
  // the last command's. `stdio: "inherit"` is what makes the child's status the one that is read.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  assert.match(source, /stdio: "inherit"/);
  assert.ok(!/stdio: "pipe"/.test(source),
    "a piped stage hides the output the operator needs and invites reading the wrong status");
});
