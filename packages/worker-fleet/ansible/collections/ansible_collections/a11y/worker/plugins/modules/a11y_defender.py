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
module: a11y_defender
short_description: Windows Defender real-time monitoring, with an honest refusal under Tamper Protection
description:
- There is no Defender module in ansible.windows or community.windows.
- The important behaviour is the refusal. Tamper Protection silently reverts Set-MpPreference: the call
    succeeds, the setting appears to change, and Defender puts it back. This module checks Tamper Protection
    first and reports rather than fights, because a module that claimed `changed` there would be lying
    on every run.
- It does not FAIL when tamper-protected - the box is still a usable worker, it just costs the memory.
  Failing would block provisioning over an optimisation.
options:
  realtime_monitoring:
    description:
    - Whether real-time monitoring should be on.
    type: bool
    default: false
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: Reclaim Defender's memory if allowed
  a11y.worker.a11y_defender:
"""

RETURN = r"""
tamper_protected:
  description: Whether Tamper Protection blocked the change.
  returned: always
  type: bool
present:
  description: False on a trimmed image with no Defender, which is not an error.
  returned: always
  type: bool
"""
