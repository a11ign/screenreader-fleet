---
"@a11ign/screenreader-fleet": patch
---

`bootstrap-windows-worker.ps1` pins Edge `155.0.4283.45` (version, MSI URL and SHA-256 together), the build the worker role pins in `ansible/roles/worker/defaults/main.yml`, so a box built from the bootstrap matches the fleet. It pinned `152.0.4191.66` before, which made every capture run refuse to start on such a box (`browserVersion` is first in `fleet-consistency`'s MUST_MATCH).
