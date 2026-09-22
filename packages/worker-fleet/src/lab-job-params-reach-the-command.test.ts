/**
 * Can a parameter a job's command READS ever actually be supplied — and is every derived fact BUILT?
 *
 * ## The two holes the existing guards structurally cannot see
 *
 * `lab-job.test.ts` already pins that a job's `params:` declaration equals what its own argv reads, and
 * that every name on `lab_caller_params` is taken by some job. Both are real and both are blind to the
 * failure recorded in #113, because the derivation iterates `lab_caller_params` to decide what a command
 * reads. A name that is NOT on that list is therefore invisible to it: `derivedParams` returns `{}`, the
 * job declares `params: {}`, the two agree exactly, and **the parameter can never arrive**. Ansible
 * discards an extra var no play reads, without a word.
 *
 * Measured 2026-09-06 while sizing #22's arms. `fleet:hours` was dispatched with a directory and reported
 * the whole corpus:
 *
 *     -e dir=/opt/a11y/runs/screenreader-dataset/captures-arm-ten
 *       "dir": "/opt/a11y/runs"      <- the DEFAULT
 *       "capturesBilled": 7690       <- every arm and every protocol version, not the arm's 98
 *
 * Every field was present and every value was plausible. **A per-arm median computed over 7,690 captures
 * was one paste away from a board paper**, and what caught it was somebody happening to know the arm holds
 * 98. That is the shape this repo pays for most: a correct answer about a population other than the one
 * the reader thinks.
 *
 * The second hole is its sibling. `lab_param_aliases` tells the derivation which caller parameter produced
 * a derived fact; **it does not create the fact.** Declaring one with no `set_fact` behind it fails at
 * render with `'lab_capture_root' is undefined` — after the job is dispatched and the fleet is committed.
 *
 * ## Why these are tests rather than a runtime assert
 *
 * The SRE Workbook is direct about where the check belongs: *"We recommend validating the generated config
 * data immediately after configuration execution. Syntactic validation alone (i.e., checking whether JSON
 * is parsable) won't find many bugs."* Every guard this catalogue had validated the DECLARATION — the
 * schema. Nobody validated what the declaration GENERATES. It also notes that *"configuration changes tend
 * to dominate outage root causes over time"*, which is this playbook's own history in one sentence.
 *
 * A render-time assert would be too late by exactly the margin that matters: `lab:job` dispatches, the
 * lab pulls, systemd starts the unit, and only then does anything look at the value. These run in `npm
 * test` and in the pre-push hook, which is before the dispatch exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ANSIBLE = fileURLToPath(new URL("../../control/ansible/", import.meta.url));
const RAW = readFileSync(`${ANSIBLE}lab-job.yml`, "utf8");

/**
 * The play that DECLARES the catalogue, found by the attribute rather than by its index.
 *
 * `[0]` was the spelling everywhere until 2026-09-06, when a `hosts: localhost` refusal play was added at
 * the top of every `lab-*.yml` and five readers broke at once. See `ansible/vars/lab-catalogue.yml`.
 */
const DOC = parseYaml(RAW) as { vars?: Record<string, unknown>; tasks?: unknown }[];
const CATALOGUE_PLAY = DOC.find((play) => play?.vars && "lab_jobs" in play.vars) as
  { vars: Record<string, unknown>; tasks?: unknown };
const PLAY = CATALOGUE_PLAY?.vars as {
    lab_jobs: Record<string, unknown>;
    lab_caller_params: string[];
    lab_param_aliases: Record<string, string>;
    lab_case_id_shape: string;
  };

/**
 * Jinja's own vocabulary, which appears inside `{{ }}` and names nothing a caller could supply.
 *
 * Deliberately a fixed list rather than a clever parser. The alternative — implementing enough of Jinja to
 * tell a variable from a filter — is the "ad hoc language features" trap the SRE Workbook names about
 * config languages, and this file exists because of one of those. A new filter appearing here fails the
 * test with the filter's own name in the message, which is a two-second fix and a correct refusal: a name
 * nobody recognises SHOULD stop the build until somebody classifies it.
 */
const JINJA_VOCABULARY = new Set([
  "default", "defined", "undefined", "string", "int", "list", "join", "trim", "lower", "upper", "map",
  "select", "selectattr", "reject", "rejectattr", "unique", "sort", "first", "last", "length", "replace",
  "regex_findall", "regex_search", "regex_replace", "from_yaml", "to_yaml", "from_json", "to_json",
  "lookup", "hostvars", "groups", "combine", "difference", "union", "intersect", "flatten", "batch",
  "truncate", "count", "min", "max", "sum", "abs", "round", "bool", "quote", "basename", "dirname",
  "splitext", "zip", "range", "items", "attr", "ternary", "if", "else", "elif", "endif", "for", "endfor",
  "in", "not", "and", "or", "is", "true", "false", "none", "True", "False", "None", "omit", "item",
  "number", "mapping", "sequence", "match", "search", "equalto", "eq", "ne", "lt", "gt", "le", "ge",
]);

/** Every bare identifier a template reads, with filters, tests, literals and attribute suffixes removed. */
function namesRead(templates: string): string[] {
  const withoutLiterals = templates
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    // `| filter` and `is test` name Jinja's vocabulary, never a variable.
    .replace(/\|\s*[a-zA-Z_][\w]*/g, " ")
    .replace(/\bis\s+[a-zA-Z_][\w]*/g, " ")
    // `foo.bar` and `foo['bar']` read `foo`; the suffix is an attribute of it, not a second variable.
    .replace(/\.[a-zA-Z_][\w]*/g, " ");
  return [...new Set((withoutLiterals.match(/[a-zA-Z_][\w]*/g) ?? [])
    .filter((name) => !JINJA_VOCABULARY.has(name))
    .filter((name) => !/^\d/.test(name)))];
}

/**
 * Every name something in this playbook SETS — walked from the parsed document, not matched out of its
 * text, and this is the second time that distinction has decided a result in this file's short life.
 *
 * A first version scraped `set_fact:` blocks with a regex keyed on indentation. It reported eighteen
 * unreachable names that are all set perfectly well (`lab_python`, `lab_fleet_workers`, `lab_tsx`), which
 * is a guard failing loudly against correct code — the fastest route to a guard being deleted. Reading the
 * structure Ansible reads removes the whole class.
 *
 * `run-job.yml` and the other task files are included WITH vars, so a name handed to them is provided
 * there; the walk follows `block`/`rescue`/`always` for the same reason `playbook-variables.test.ts` does.
 */
type Task = Record<string, unknown> & { vars?: object; register?: unknown; tasks?: unknown };
function namesProvided(doc: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (tasks: Task[]) => {
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      for (const key of Object.keys((task["ansible.builtin.set_fact"] ?? {}) as object)) names.add(key);
      for (const key of Object.keys((task["set_fact"] ?? {}) as object)) names.add(key);
      for (const key of Object.keys((task.vars ?? {}) as object)) names.add(key);
      if (typeof task.register === "string") names.add(task.register);
      for (const key of ["block", "rescue", "always"]) {
        if (Array.isArray(task[key])) walk(task[key] as Task[]);
      }
    }
  };
  for (const play of (Array.isArray(doc) ? doc : [doc]) as Task[]) {
    if (!play || typeof play !== "object") continue;
    for (const key of Object.keys((play.vars ?? {}) as object)) names.add(key);
    if (Array.isArray(play.tasks)) walk(play.tasks as Task[]);
  }
  return names;
}

const FACTS_SET = namesProvided(DOC);

/**
 * Inventory group vars, which are global to every play — `lab_python`, `lab_tsx`, `lab_repo_path` and the
 * rest of the lab's own environment. A job reading one of these is reading a fact, not a parameter.
 */
const PLAY_VAR_NAMES = new Set(readdirSync(`${ANSIBLE}group_vars`)
  .flatMap((name) => [...readFileSync(`${ANSIBLE}group_vars/${name}`, "utf8")
    .matchAll(/^\s*([a-z][a-z0-9_]*):/gm)].map(([, key]) => key)));

test("every name a job's command reads is one a caller can supply, or a fact something sets", () => {
  // The whole catalogue, not a sample. A name nothing can supply is INVISIBLE from the outside: the
  // dispatch succeeds, the default renders, and the run reports a number about the wrong population.
  const supplyable = new Set([
    ...PLAY.lab_caller_params,
    ...Object.keys(PLAY.lab_param_aliases),
    ...FACTS_SET,
    ...PLAY_VAR_NAMES,
  ]);
  const unreachable: string[] = [];
  let checked = 0;
  for (const [job, entry] of Object.entries(PLAY.lab_jobs)) {
    const templates = (JSON.stringify(entry).match(/\{\{[\s\S]*?\}\}/g) ?? []).join(" ");
    for (const name of namesRead(templates)) {
      checked += 1;
      if (!supplyable.has(name)) unreachable.push(`${job}: {{ ${name} }}`);
    }
  }
  // A scan that finds nothing passes having examined nothing — the failure this whole file is about,
  // committed inside the guard against it.
  assert.ok(checked > 20, `only ${checked} templated name(s) found across `
    + `${Object.keys(PLAY.lab_jobs).length} job(s); the extraction has broken, not the catalogue`);
  assert.deepEqual(unreachable, [],
    "These names are read by a job's command and NOTHING can supply them: they are not on "
    + "`lab_caller_params`, not a `lab_param_aliases` fact, and no `set_fact` builds them. Ansible "
    + "discards an extra var no play reads WITHOUT A WORD, so `-e <name>=...` dispatches cleanly, the "
    + "default renders, and the run reports a confident number about the wrong population — measured at "
    + "`capturesBilled: 7690` for an arm holding 98. Either add the name to `lab_caller_params`, or it is "
    + "not a parameter.");
});

test("every fact lab_param_aliases names is actually built by a set_fact", () => {
  // A DECLARED FACT IS NOT A BUILT FACT, and the two failure times are hours apart. `lab_param_aliases`
  // tells the params derivation which caller parameter produced a derived fact; it creates nothing. A fact
  // declared here with no `set_fact` behind it renders as `'<name>' is undefined` — on the lab, after the
  // dispatch, with the fleet already committed to the run.
  for (const fact of Object.keys(PLAY.lab_param_aliases)) {
    assert.ok(FACTS_SET.has(fact),
      `\`lab_param_aliases\` declares '${fact}' and no \`set_fact:\` builds it. The declaration only tells `
      + `the params derivation which caller parameter this fact came from — it does not create the fact, `
      + `and the difference is only discovered at render time, on the lab, after the fleet is committed.`);
  }
});

test("every caller parameter an alias expression reads is itself a published parameter", () => {
  // The values in `lab_param_aliases` are EXPRESSIONS, not names — `workers | default('the whole fleet')`
  // — because the derivation has to see the fallback to report the parameter as optional. So each one
  // reads a caller parameter, and that parameter has the same reachability question as any other.
  const published = new Set(PLAY.lab_caller_params);
  for (const [fact, expression] of Object.entries(PLAY.lab_param_aliases)) {
    const names = namesRead(expression);
    assert.ok(names.length > 0, `the alias for '${fact}' names no parameter at all`);
    for (const name of names) {
      assert.ok(published.has(name),
        `the alias for '${fact}' reads '${name}', which is not on \`lab_caller_params\` — so the fact is `
        + `built from a value no caller can ever set, and it will always take its fallback`);
    }
  }
});

/**
 * ## The third hole: a flag the COMMAND forwards that the DECLARATION never mentions
 *
 * The two guards above answer "can this name arrive" and "is this fact built". Neither looks at the other
 * direction — whether a job's own argv forwards a `--flag=` that `params:` does not publish, so
 * `-e describe=1` never names it and the generic refusal above turns a correct usage into an error. That
 * is not hypothetical: `evidence-check.mjs` has read `--only=` since it was written, and for months the
 * catalogue entry forwarded no such flag, so the only dispatchable form of the check sampled 24 cases at
 * random across the whole corpus. Measured 2026-09-22 on #1908, whose acceptance is ten reads of ONE
 * family (`media-autoplay-audio`): the family it asks about need not have been in the sample at all, and
 * the gap was one release blocker deep (#1918's condition 1).
 *
 * Derived from each entry's own argv, never a hand-written list of which jobs take what — the same rule
 * the rest of this catalogue's guards follow, and for the same reason: a list beside the command drifts
 * from the command.
 */
type Entry = { params?: Record<string, "required" | "optional"> };
const PARAMS = (entry: unknown) => ((entry as Entry).params ?? {});

/** Every `--flag=` a job's own entry forwards, read out of the entry rather than declared beside it. */
function flagsForwarded(entry: unknown): Set<string> {
  return new Set([...JSON.stringify(entry).matchAll(/--([a-z][a-z0-9-]*)=/g)].map(([, flag]) => flag));
}

test("a job forwarding --only= publishes `only`, and a job publishing it forwards it", () => {
  const forwards = Object.entries(PLAY.lab_jobs)
    .filter(([, entry]) => flagsForwarded(entry).has("only")).map(([job]) => job).sort();
  const publishes = Object.entries(PLAY.lab_jobs)
    .filter(([, entry]) => "only" in PARAMS(entry)).map(([job]) => job).sort();
  // The positive control this file's own header demands: an extraction that matched nothing would make
  // both lists empty and the comparison below pass having examined no job at all.
  assert.deepEqual(forwards, ["capture-only", "evidence-check"],
    "these are the two jobs whose argv forwards --only=; if this list has changed, the check below is "
    + "still the real assertion — update this control to what the catalogue now says");
  assert.deepEqual(publishes, forwards,
    "a job whose command forwards --only= must declare `only` in its own `params:`, and one that "
    + "declares it must forward it. Declaring too little makes `-e only=` a refusal on a job that would "
    + "have honoured it (the generic `Refuse a parameter this job does not read` fires); declaring too "
    + "much accepts a value Ansible then discards without a word.");
});

/** The assert tasks guarded on one job — `when: job == 'x'` or `when: job in [... 'x' ...]`. */
function assertClausesFor(job: string): string[] {
  const clauses: string[] = [];
  const walk = (tasks: Record<string, unknown>[]) => {
    for (const task of tasks ?? []) {
      if (!task || typeof task !== "object") continue;
      const body = task["ansible.builtin.assert"] as { that?: string[] | string } | undefined;
      const when = typeof task.when === "string" ? task.when : "";
      if (body && new RegExp(`job == '${job}'|job in \\[[^\\]]*'${job}'`).test(when)) {
        const that = body.that ?? [];
        clauses.push(...(Array.isArray(that) ? that : [that]).map(String));
      }
      for (const key of ["block", "rescue", "always"]) {
        if (Array.isArray(task[key])) walk(task[key] as Record<string, unknown>[]);
      }
    }
  };
  walk(CATALOGUE_PLAY.tasks as Record<string, unknown>[]);
  return clauses;
}

test("every job that takes -e only= validates its shape, from the one shared expression", () => {
  // `--only=` reaches an argv list and never a shell, but the value comes from the wire, and this
  // playbook's rule is containment by SHAPE: a path or a flag must be INEXPRESSIBLE rather than rejected.
  // Stated once as `lab_case_id_shape` because two jobs now assert it — a fact stated twice drifts.
  const shape = PLAY.lab_case_id_shape;
  const accepts = new RegExp(shape);
  assert.ok(accepts.test("media-autoplay-audio"), "#1908's family must be expressible");
  assert.ok(accepts.test("route-title-stale+"), "a trailing + is how this corpus spells a whole family");
  assert.ok(accepts.test("a.b-1,c.d-2"), "comma-separated ids are what check-signals prints");
  // `.hidden` and `/opt` are here because they SURVIVED: widening only the shape's first character class
  // to `[a-z0-9/.]` left every multi-segment path still refused (a second `/` fails the body), so the
  // longer examples above could not tell the two shapes apart. The leading character is a distinct rule
  // and needs its own control.
  for (const refused of ["../../etc/passwd", "/opt/a11y/runs", "/opt", ".hidden", "-only",
                         "--sample=200", "a b", "A", ""]) {
    assert.ok(!accepts.test(refused), `the shape must make '${refused}' inexpressible, not merely wrong`);
  }

  const takers = Object.entries(PLAY.lab_jobs).filter(([, entry]) => "only" in PARAMS(entry));
  assert.ok(takers.length >= 2, `only ${takers.length} job(s) take -e only=; this scan has broken`);
  for (const [job, entry] of takers) {
    const validates = assertClausesFor(job)
      .filter((clause) => /\bonly\b/.test(clause) && clause.includes("lab_case_id_shape"));
    assert.equal(validates.length, 1,
      `job '${job}' takes -e only= and ${validates.length} of its asserts check it against `
      + "`lab_case_id_shape`. A job that reads a wire value without asserting its shape is the hole "
      + "`--worker=http://:8765` went through, which cost 29 minutes of an idle fleet.");
    // An OPTIONAL `only` must TOLERATE absence — `capture-only` refuses an empty one because an
    // unnarrowed capture is the four-hour corpus run it exists to avoid, while an unnarrowed
    // evidence-check is the corpus-wide read every existing caller already gets.
    assert.equal(/only is not defined or/.test(validates[0]), PARAMS(entry).only === "optional",
      `job '${job}' declares only: ${PARAMS(entry).only}, and its shape assert disagrees about whether `
      + "an absent value is allowed: an optional one must be guarded by `only is not defined or`, a "
      + "required one must not be, or the assert refuses the very usage `params:` publishes.");
  }
});

test("a parameter a job does not publish is still refused, whoever else takes it", () => {
  // `only` is now OPTIONAL on a second job, and the fear that raises is that it stops being refused on
  // the thirty-odd that ignore it. It does not, and this pins why: the refusal loops the PUBLISHED
  // INTERFACE and tests membership of the job's OWN params, so widening one job's declaration narrows
  // nothing anywhere else. Ansible discards an extra var no play reads without a word.
  const refusal = (CATALOGUE_PLAY.tasks as Record<string, unknown>[])
    .find((task) => task?.name === "Refuse a parameter this job does not read");
  assert.ok(refusal, "the generic refusal task has been renamed or removed");
  assert.equal(refusal.loop, "{{ lab_caller_params }}",
    "it must loop every published parameter, not a per-job list");
  assert.deepEqual((refusal["ansible.builtin.assert"] as { that?: unknown }).that, "item in job_params",
    "and decide by membership of the job's own declaration, so one job gaining a parameter cannot "
    + "silently admit it everywhere else");
  assert.equal(refusal.when, "vars[item] is defined", "checked exactly when the caller supplied one");
});
