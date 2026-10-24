---
"@a11ign/screenreader-fleet": patch
---

`bootstrap-windows-worker.ps1` pins Edge `156.0.4314.42` (version, MSI URL and SHA-256 together), the newest Stable x64 build in Microsoft's enterprise catalogue (published 2026-10-22), so a box built from the bootstrap matches the build the fleet converges to under A11-183. It pinned `155.0.4283.45` before, a build twelve of fifteen boxes had already moved off.
