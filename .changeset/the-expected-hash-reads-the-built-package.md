---
"@a11ign/screenreader-fleet": minor
---

`expectedWorkerCode()` asks the installed `@a11ign/screenreader-worker` for its code hash with `codeVersion()` and no directory, where it hashed `workerSourceDir()`, which is `dist/` in the built package and made `a11ign-worker-code` and every capture's fleet check throw ENOENT. It works on the raw 0.1.0 as well. `a11ign-worker-code` no longer prints the "your working tree has an uncommitted `CAPTURE_PROTOCOL_VERSION` bump" note, which read a git working tree of the worker's source and so could not fire against an installed package.
