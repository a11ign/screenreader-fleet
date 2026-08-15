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
module: a11y_power_timeouts
short_description: Stop a worker sleeping on AC power
description:
- A worker that sleeps is a worker that has vanished. On the first bare-metal box this presented as EHOSTUNREACH
  for 48 consecutive requests in one evidence-check run, then a successful curl thirty seconds later -
  which reads as a flaky network rather than as power management.
- AC only, deliberately: a laptop-class worker sleeping on battery is correct behaviour.
- Reads the active scheme's current values before acting, because powercfg exits 0 whether or not anything
  moved, so `changed` would otherwise be meaningless.
options:
  standby_timeout_ac:
    description:
    - Minutes before standby on AC. 0 means never.
    type: int
    default: 0
  hibernate_timeout_ac:
    description:
    - Minutes before hibernate on AC. 0 means never.
    type: int
    default: 0
  disk_timeout_ac:
    description:
    - Minutes before the disk spins down on AC. 0 means never.
    type: int
    default: 0
  hibernate:
    description:
    - Whether hibernation is available at all. Off also reclaims hiberfil.sys, which is RAM-sized.
    type: bool
    default: false
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: Never sleep
  a11y.worker.a11y_power_timeouts:
"""

RETURN = r"""
changes:
  description: Which settings this run moved.
  returned: always
  type: list
before:
  description: The AC timeouts as they were, in minutes.
  returned: always
  type: dict
"""
