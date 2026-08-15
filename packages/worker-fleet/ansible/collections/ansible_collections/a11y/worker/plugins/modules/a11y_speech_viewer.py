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
module: a11y_speech_viewer
short_description: Turn NVDA's Speech Viewer off across an install, and prove it took
description:
- NVDA's Speech Viewer window is ANNOUNCED when it takes focus, so it lands in the spokenPhraseLog delta
  captured right after a probe activates a control. Every interaction probe then returns "NVDA Speech
  Viewer" instead of the page's response, which makes an accessible page and an inaccessible one indistinguishable.
- It fails silently: capture-check asserts that the probe fired, not what it heard. So this module re-reads
    every nvda.ini after patching and fails if any still has it enabled.
- guidepup's bundled config ships it ON, and reinstalling NVDA resets it, so this is idempotent and meant
  to run after every install.
options:
  path:
    description:
    - Root of the NVDA install to patch. Every nvda.ini beneath it is considered.
    type: path
    required: true
  enabled:
    description:
    - Whether the Speech Viewer should be on. Effectively always no on a capture worker.
    type: bool
    default: false
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: Speech Viewer off
  a11y.worker.a11y_speech_viewer:
    path: C:\\Users\\witness\\AppData\\Local\\guidepup\\nvda
"""

RETURN = r"""
patched:
  description: The nvda.ini files this run changed.
  returned: always
  type: list
examined:
  description: How many nvda.ini files were found. Zero is a failure, not a no-op.
  returned: always
  type: int
"""
