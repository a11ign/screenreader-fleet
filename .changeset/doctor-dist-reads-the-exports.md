---
"@a11ign/screenreader-fleet": patch
---

`a11ign-doctor`'s `dist-freshness` check no longer asks `tsc --build --dry` about `packages/judge`. a11ign builds `judge` with Rslib, whose `tsconfig.json` is `noEmit`, so tsc had no output to call up to date and the check gave a wrong advisory on every run. It now reads the files `judge`'s `exports` promise (`missingExportTargets`): present reads ok, a missing target is named, and an unreadable manifest is "could not read", never clean. It reads existence only: Rslib leaves no stamp of the source it built from, so a present but out-of-date `dist` is not caught, and the detail line says "present", not "up to date".
