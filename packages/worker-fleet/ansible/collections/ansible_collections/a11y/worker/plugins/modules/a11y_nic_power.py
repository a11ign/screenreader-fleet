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
module: a11y_nic_power
short_description: Stop Windows powering the network adapter down
description:
- The second of two mechanisms that make a worker vanish; fixing only the sleep timers leaves the fault
  intermittent. Selective suspend powers the adapter down while the OS stays up.
- Uses Set-NetAdapterPowerManagement where the SKU has it, and falls back to the registry value that cmdlet
  writes (PnPCapabilities 24, disabling both power-down and wake-armed).
- Fails when no physical adapter is Up, rather than reporting ok having adjusted nothing - this module
  exists because the network disappears.
options:
  interface:
    description:
    - Adapter name or wildcard to adjust.
    type: str
    default: '*'
author:
- a11y-witness
"""

EXAMPLES = r"""
- name: Keep the NIC awake
  a11y.worker.a11y_nic_power:
"""

RETURN = r"""
adjusted:
  description: Adapters this run changed.
  returned: always
  type: list
via_registry:
  description: Adapters that needed the registry fallback because the cmdlet was absent.
  returned: always
  type: list
"""
