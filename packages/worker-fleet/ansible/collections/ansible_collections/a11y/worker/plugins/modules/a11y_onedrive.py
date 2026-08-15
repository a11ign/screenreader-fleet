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
module: a11y_onedrive
short_description: Evict OneDrive, including the Run entry policy leaves behind
description:
- Policy alone stops OneDrive starting again. It does not remove the per-user Run entry that relaunches
  it at logon, and it does not dismiss a toast already on screen - observed on a guest, with the policy
  applied cleanly and "Turn On Windows Backup" still over the desktop.
- That matters because a notification stealing focus mid-capture corrupts the evidence, and one that merely
  sits over the page does it silently.
options:
  state:
    description:
    - Only absent is supported; there is no reason to install OneDrive on a capture worker.
    type: str
    default: absent
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: No OneDrive
  a11y.worker.a11y_onedrive:
"""

RETURN = r"""
actions:
  description: What was actually done - one of stopped, run-entry:NAME, uninstalled.
  returned: always
  type: list
"""
