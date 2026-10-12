---
"@a11ign/screenreader-fleet": patch
---

`WAKE_HINT`, printed when a probe times out, names control's checkout and `pnpm run fleet:wake -- <name>`. It said to wake the box "from a checkout of the a11ign repo" with `npm run fleet:wake`, a script the core stopped carrying when its fleet scripts moved to `a11ign/control` (ADR 0045), so the hint sent the reader to "Missing script".
