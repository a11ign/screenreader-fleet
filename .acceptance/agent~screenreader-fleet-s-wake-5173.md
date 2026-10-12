`WAKE_HINT` (`src/probe-outcome.ts`) told a reader to wake a sleeping box from "a checkout of the a11ign repo" with `npm run fleet:wake`. The core no longer carries `fleet:wake` (it lives in `a11ign/control` since ADR 0045 cut 8), so the hint led to "Missing script". It now names `a11ign/control` and `pnpm run fleet:wake -- <name>`, with the inventory as control's `ansible/inventory.yml`. The substring `fleet:wake -- <name>` is kept, which is what the core's probe-outcome test pins.

- **Fix:** the constant's text and its doc comment; a patch changeset.
- **Test:** no test pins the sentence (`git grep WAKE_HINT` finds the definition and one use), so the check is the grep pair below, not a test that goes red before and green after.
- **Mutation:** restoring the old text makes the first count 1 and the Acceptance exit 1.

Acceptance: node -e "const s=require('fs').readFileSync('src/probe-outcome.ts','utf8');if(s.includes('a checkout of the a11ign repo')||!s.includes('fleet'+':wake -- <name>'))process.exit(1)"
