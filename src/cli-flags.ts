// The flag guard lives in `@a11ign/toolchain/lib/cli-flags`, the one copy this fleet, the core and agent-org share (#4425). This file keeps the
// published `@a11ign/screenreader-fleet/cli-flags` subpath and this package's own `./cli-flags.ts` imports working unchanged.
//
// NAMED, NOT `export *`: Rslib turns a star re-export of an external into an empty namespace object that the sibling bundles import from, so
// `dist/fleet-env.mjs` read `refuseUnknownFlags` off nothing and `fleet-env`'s test failed with "is not a function" (measured, #4592).
export { didYouMean, flagValue, nameOf, refuseUnknownFlags, unknownFlags } from "@a11ign/toolchain/lib/cli-flags";
