---
"@a11ign/screenreader-fleet": minor
---

The package exports four more subpaths that `control` imports by relative path today: `./git-safe-env`, `./protocol-guard`, `./npm-cli-executable` and `./code-drift` (ADR 0045 rule 2, the producer half of the `control` cut 7b). Each is built to `dist` beside the twelve existing subpaths and declares its `types` and `default`. None of the four imports a package: `git-safe-env` and `npm-cli-executable` import `node:` built-ins only, `protocol-guard` and `code-drift` import their siblings `worker-http` and `git-safe-env` on top, so each runs from an unpacked tarball with nothing installed.
