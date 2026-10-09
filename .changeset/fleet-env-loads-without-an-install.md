---
"@a11ign/screenreader-fleet": patch
---

`fleet-env` loads from a raw checkout with no `npm install` again. 0.7.0 made `cli-flags.ts` a re-export of `@a11ign/toolchain/lib/cli-flags` and `fleet-env.ts` still imported it, so `control` (which imports `fleet-env` by path, ADR 0012) died loading the laid fleet with `ERR_MODULE_NOT_FOUND`. `fleet-env.ts` now imports no package: it reads `--inventory=`/`--group-vars=` with its own four-line `flagValue` and refuses an unknown flag from `main()`, the CLI-entry path, with the same verdict and exit code 2 as the toolchain's guard (a test pins that the two agree on every flag shape). Importing it as a library never inspects the importer's flags, as before. New export: `unknownFlagsOf`. The `./cli-flags` subpath is unchanged and still the toolchain's copy.
