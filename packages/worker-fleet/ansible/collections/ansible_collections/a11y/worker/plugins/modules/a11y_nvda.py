#!/usr/bin/python
# -*- coding: utf-8 -*-

# Documentation for the PowerShell module of the same name. Ansible requires the pair: the .ps1 is the
# implementation, this is what `ansible-doc` reads and what the argument spec is validated against.
#
# Generated with a YAML dumper rather than hand-formatted, because hand-formatting produced `default: *`
# -- which YAML reads as an ALIAS -- and a description containing ": ", which it reads as a mapping.
# Both failed as "missing documentation", which points at the wrong thing entirely.

from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = r"""
module: a11y_nvda
short_description: Install NVDA via guidepup and refuse a gutted install
description:
- Runs the guidepup installer from the repo, so it reads the LOCAL @guidepup/guidepup manifest and keeps
  the screen reader and its driver in lockstep.
- The integrity assertion is the point. %TEMP% cleanup once deleted library.zip and left nvda.exe as a
  stub that launches and dies, producing "Timed out waiting for NVDA to be running" and no nvda.log at
  all. A healthy install is ~1700+ files; anything under min_files is a corpse.
- Idempotent: an intact install already present reports ok and downloads nothing.
options:
  repo_path:
    description:
    - The checkout to run the installer from; its node_modules decides which NVDA build is fetched.
    type: path
    required: true
  cache_root:
    description:
    - Where guidepup caches screen readers. Defaults to GUIDEPUP_SCREEN_READERS_PATH, then %LOCALAPPDATA%\\guidepup.
      Never %TEMP%, which Windows cleanup empties.
    type: path
  min_files:
    description:
    - Below this many files the install is treated as gutted. A healthy one is ~1700+.
    type: int
    default: 500
  force:
    description:
    - Reinstall even when an intact install is present.
    type: bool
    default: false
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: NVDA, intact
  a11y.worker.a11y_nvda:
    repo_path: C:\\Users\\witness\\a11y-witness
"""

RETURN = r"""
path:
  description: Directory the installed nvda.exe lives in.
  returned: always
  type: str
files:
  description: File count under that directory, the integrity signal.
  returned: always
  type: int
"""
