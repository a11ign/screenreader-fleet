---
"@a11ign/screenreader-fleet": patch
---

`cli-flags` imports no package again, so the eight `control` modules that import it by relative path (`fleet-auto-off`, `fleet-discover`, `fleet-playbook`, `fleet-status`, `fleet-wake`, `lab-failed-units`, `lab-pipeline`, `post-qualification-status`) load from a raw checkout with no `npm install`. 0.5.0 made `src/cli-flags.ts` a re-export of `@a11ign/toolchain/lib/cli-flags` and 0.7.1 fixed only `fleet-env.ts`, so those eight died loading with `ERR_MODULE_NOT_FOUND`. `src/cli-flags.ts` is again an in-package copy (`didYouMean`, `flagValue`, `nameOf`, `refuseUnknownFlags`, `unknownFlags`, `node:` built-ins only); the toolchain copy stays the one every other consumer uses, and `fleet-env.test.ts` pins that the two reach the same answer and the same refusal. The published `./cli-flags` subpath is built from this file, so it is now the in-package copy rather than a re-export; its exports and signatures are unchanged.
