#!/usr/bin/env python3
"""Check every module invocation against the module's REAL documented options.

    python3 check-modules.py

`ansible-playbook --syntax-check` parses YAML and resolves module NAMES. It does not look at module
ARGUMENTS at all, so a mistyped or invented option sails through it and fails on the box — which, for
this fleet, means finding out after an SSH round trip to a Windows machine you may have to walk to.

Two failure modes this catches, both of which are easy to write and impossible to see by reading:

  - an option that does not exist (`restart_interval` vs `restart_delay`)
  - an option that moved between collections, so the name you remember belongs to a different module

It reads the options from `ansible-doc -j`, which is the module's own documentation rather than a list
maintained here — a second list would drift, which is the failure this repo keeps paying for.

NOT part of `npm test`: it needs ansible installed, and the control plane is the machine that has it.
Run it after editing any playbook. Exit 0 clean, 1 if anything is wrong.
"""
import glob
import json
import re
import subprocess
import sys

import yaml

# Any fully-qualified collection name, rather than a list of namespaces we happen to use today.
#
# This WAS a three-namespace tuple, and when the a11y.worker collection arrived it silently skipped all
# eight of its tasks while still reporting "0 problems" — the exact shape this script exists to catch,
# in the script itself. A hardcoded list is a list that goes stale; a shape does not.
FQCN = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$")

# `set_fact` takes arbitrary user-chosen names as its options, so there is nothing to check it against.
FREEFORM_OPTIONS = {"ansible.builtin.set_fact"}

_docs = {}


def options_for(module):
    """The set of documented option names (and aliases) for a module, or None if unreadable."""
    if module in _docs:
        return _docs[module]
    try:
        out = subprocess.run(["ansible-doc", "-j", module], capture_output=True, text=True, timeout=60)
        spec = json.loads(out.stdout)[module]["doc"].get("options", {})
        names = set(spec)
        for option in spec.values():
            names.update(option.get("aliases") or [])
    except Exception:
        names = None
    _docs[module] = names
    return names


def walk(tasks, path, report):
    for task in tasks:
        if not isinstance(task, dict):
            continue
        for key, value in task.items():
            if FQCN.match(key) and isinstance(value, dict):
                report(path, key, set(value))
        for nested in ("block", "rescue", "always"):
            if isinstance(task.get(nested), list):
                walk(task[nested], path, report)


def main():
    problems = []
    checked = 0

    def report(path, module, used):
        nonlocal checked
        if module in FREEFORM_OPTIONS:
            return
        documented = options_for(module)
        if documented is None:
            problems.append(f"{path}: could not read docs for {module} — is its collection installed?")
            return
        checked += 1
        unknown = sorted(used - documented)
        if unknown:
            problems.append(f"{path}: {module} has undocumented option(s): {unknown}")

    for path in sorted(glob.glob("**/*.yml", recursive=True)):
        try:
            docs = yaml.safe_load(open(path))
        except Exception as error:
            problems.append(f"{path}: does not parse as YAML — {error}")
            continue
        if isinstance(docs, list):
            walk(docs, path, report)
            # A playbook is a list of PLAYS, whose tasks live under these keys.
            for play in docs:
                if isinstance(play, dict):
                    for section in ("tasks", "pre_tasks", "post_tasks", "handlers"):
                        if isinstance(play.get(section), list):
                            walk(play[section], path, report)

    for line in problems:
        sys.stdout.write(f"  {line}\n")
    sys.stdout.write(f"\n  {checked} module invocation(s) checked, {len(problems)} problem(s)\n")
    # A run that checked nothing is not a pass. The glob or the walk would have to be broken, and the
    # symptom would be a silent green — this repo's most-repeated shape.
    if not problems and checked < 20:
        sys.stdout.write(f"  REFUSING to report success: only {checked} invocations found, expected 20+.\n")
        return 1
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
