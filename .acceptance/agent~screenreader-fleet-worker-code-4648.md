`src/worker-code-clone.test.ts` stops copying the INSTALLED `@a11ign/screenreader-worker`'s `src/` (`workerSourceDir()`), which 0.9.0 no longer ships (`dist/` only), so its 4 of 4 clone tests no longer fail with ENOENT once the pin moves.

- The fixture builds a SYNTHETIC raw-`src` clone in its temp checkout root: a `code-version.mjs` hasher (the test's own small copy, so the expected hash is still computed by the clone's hasher and never by the code under test) and a `capture-core.mjs`; the diverged case appends one byte, as before.
- The "equal to installed" controls are re-derived: the control test now asserts both that the appended byte changes the clone's hash AND that the clone's hash is not the installed `codeVersion()` (without that, the "stale" direction would prove nothing). All six tests keep their assertions; none dropped.
- Test-only change: no changeset.

Evidence (measured at this head, in the fleet worktree):
- Acceptance 1 prints nothing and exits 0; Acceptance 2: `VERDICT pass: 6 tests in 1 file` at the pin `0.1.0`.
- One-time, with `@a11ign/screenreader-worker` at the registry's latest, `0.9.0` (installed in the worktree, `node_modules/@a11ign/screenreader-worker` holds `dist/` and no `src/`): `VERDICT pass: 6 tests in 1 file`. `package.json` and the lockfile were restored byte-identical afterwards.
- `pnpm test` at `0.1.0`: `VERDICT pass: 226 tests in 35 files (4 skipped)`; `pnpm run typecheck` clean; `pnpm run lint` 0 errors (68 pre-existing warnings).
- Mutation, both directions: dropping the appended byte fails only the control (1 of 6); making the clone hasher ignore file contents fails 4 of 6. Fixture restored from a copy and diffed identical.

Acceptance: bash -c '! grep -n "workerSourceDir" src/worker-code-clone.test.ts' && pnpm exec rstest run src/worker-code-clone.test.ts

Closes a11ign/a11ign#4648

🤖 Generated with [Claude Code](https://claude.com/claude-code)
