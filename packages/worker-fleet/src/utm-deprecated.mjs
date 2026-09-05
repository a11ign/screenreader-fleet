// @ts-check
// One deprecation notice, said the same way everywhere it applies.
//
// architecture-audit.md §8: "the deprecated UTM path is still the CLI's default" — ~2,460 lines of
// UTM-only code still ship, and until this file existed, using any of them said nothing about it. The
// repository owner stated plainly on 2026-09-05: "The UTM is deprecated, that was a testing thing." This
// is the loud half CLAUDE.md's own rule calls for: "a deprecated path that is still the first one
// documented is not deprecated" — printing nothing at the point of use is the runtime version of that
// same mistake.
//
// A notice, not a refusal: some of these entry points are still how an existing UTM guest is reached
// (worker-ctl.sh status, for instance), and this file does not decide which are safe to keep working —
// that is a separate proposal. This only makes sure nobody reaches any of them without being told.

/**
 * @param {string} what The command or module the caller is about to run — named so the message is
 *   specific to what actually fired, not a generic banner every UTM-adjacent file prints identically.
 */
export function warnUtmDeprecated(what) {
  process.stderr.write(
    `DEPRECATED: ${what} manages a local UTM worker VM. UTM was a testing path and is not the fleet.\n` +
    "Capture on the bare-metal fleet instead: npm run fleet:status, npm run fleet:deploy. See CLAUDE.md's\n" +
    '"Working on a Mac" section.\n',
  );
}
