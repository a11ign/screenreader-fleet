/**
 * No task may read a variable nothing sets.
 *
 * This is the general form of a defect that reached the real fleet on 2026-08-26 and refused a correct
 * command. Rewriting the parameter gate deleted the `set_fact` that produced `job_reads`, and left a task
 * behind that still read it. Ansible's `error_on_undefined_vars` would have caught that — except the task
 * said `job_reads | default([])`, so the missing fact became an EMPTY LIST and the assertion quietly
 * inverted: `"only" in []` refused the one job that requires `-e only=`.
 *
 * **The default was not the bug**, and that matters for what the fix has to be. `job_reads` was
 * accumulated by a loop with a `when:`, so for a job matching no parameters the fact genuinely never
 * existed — `default([])` was correct in the code it was written for. Making it louder would have changed
 * nothing. What was wrong is that the task outlived the fact, and only a check that knows what the
 * playbook SETS can see that.
 *
 * ## Why this is keyed on a naming convention rather than being a general Jinja linter
 *
 * The general version was tried first and produced 65 "unresolved" names — filters (`join`, `map`),
 * keywords (`if`, `is`), fragments of string literals (`http`, `mjs`), and Ansible magic vars. A guard
 * that noisy gets an allowlist bolted on until it examines nothing, which is this repo's most-repeated
 * failure. Every variable these playbooks define for themselves is `lab_*` or `job_*`, so checking only
 * those is precise, has no allowlist to rot, and catches exactly the class that bit us.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ANSIBLE = fileURLToPath(new URL("../../control/ansible/", import.meta.url));
const OWN_NAME = /\b((?:lab|job)_[a-z0-9_]+)\b/g;

type Task = Record<string, unknown>;

/** Keys whose value is Jinja WITHOUT `{{ }}`, so a reference in them is invisible to a template scan. */
const BARE_EXPRESSION = ["when", "until", "changed_when", "failed_when", "that"];

/** Names this file creates: play vars, set_facts, task-level vars, and registered results. */
function provided(doc: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (tasks: Task[]) => {
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      for (const key of Object.keys((task["ansible.builtin.set_fact"] ?? {}) as object)) names.add(key);
      for (const key of Object.keys((task.vars ?? {}) as object)) names.add(key);
      if (typeof task.register === "string") names.add(task.register);
      // A task file included WITH vars hands those names to the file it includes, so they are provided
      // there — this is how `run-job.yml` receives `job_argv` and friends.
      for (const key of ["block", "rescue", "always"]) {
        if (Array.isArray(task[key])) walk(task[key] as Task[]);
      }
    }
  };
  for (const play of (Array.isArray(doc) ? doc : [doc]) as Task[]) {
    if (!play || typeof play !== "object") continue;
    for (const key of Object.keys((play.vars ?? {}) as object)) names.add(key);
    if (Array.isArray(play.tasks)) walk(play.tasks as Task[]);
    else if (Array.isArray(doc)) walk([play]);
  }
  return names;
}

/** Every `lab_*`/`job_*` this file reads, from templates and from the bare-expression keywords. */
function referenced(text: string, doc: unknown): Set<string> {
  const names = new Set<string>();
  const add = (value: string) => {
    for (const [, name] of value.matchAll(OWN_NAME)) names.add(name);
  };
  for (const [, expr] of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) add(expr);
  // `when:`/`until:` are Jinja WITHOUT braces, so a reference there is invisible to the scan above.
  const scan = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(scan);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Task)) {
      // `that:` BELONGS HERE and was missing from the first version — which is how I discovered this
      // guard would not have caught the very defect it was written for: the stale assertion was
      // `that: item in (job_reads | default([]))`. A guard must be shown to fail before it is trusted,
      // and mutation is the only thing that shows it.
      if (BARE_EXPRESSION.includes(key)) add(Array.isArray(value) ? value.join(" ") : String(value));
      scan(value);
    }
  };
  scan(doc);
  return names;
}

const playbooks = readdirSync(ANSIBLE).filter((name) => name.endsWith(".yml"))
  .concat(readdirSync(join(ANSIBLE, "tasks")).map((name) => `tasks/${name}`));

/** Inventory group_vars are global, and so are the vars an include site hands to a task file. */
const GLOBAL = new Set<string>([
  ...readdirSync(join(ANSIBLE, "group_vars")).flatMap((name) =>
    [...readFileSync(join(ANSIBLE, "group_vars", name), "utf8").matchAll(/^\s*((?:lab|job)_[a-z0-9_]+):/gm)]
      .map(([, key]) => key)),
  ...playbooks.flatMap((name) =>
    [...readFileSync(join(ANSIBLE, name), "utf8").matchAll(/^\s*((?:lab|job)_[a-z0-9_]+):/gm)]
      .map(([, key]) => key)),
]);

test("every lab_*/job_* a playbook reads is set somewhere", () => {
  let scanned = 0;
  const orphans: string[] = [];
  for (const name of playbooks) {
    const text = readFileSync(join(ANSIBLE, name), "utf8");
    const doc = parseYaml(text);
    const known = new Set([...provided(doc), ...GLOBAL]);
    const reads = referenced(text, doc);
    scanned += reads.size;
    for (const ref of reads) if (!known.has(ref)) orphans.push(`${name}: ${ref}`);
  }
  // A scan that finds nothing passes having examined nothing. These playbooks are built out of these
  // variables, so a low count means the extraction broke, not that the code got simpler.
  assert.ok(scanned > 30, `only ${scanned} reference(s) found across ${playbooks.length} playbook(s)`);
  assert.deepEqual(orphans, [],
    "these read a variable no vars: block, set_fact, register or group_vars provides. Ansible would "
    + "raise — unless the reference carries `| default(...)`, in which case it silently becomes an empty "
    + "value and the surrounding assertion inverts. That is exactly how a stale task refused `-e only=` "
    + "on the one job that requires it");
});
