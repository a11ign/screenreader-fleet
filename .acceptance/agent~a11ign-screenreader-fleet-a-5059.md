`ci.yml` gains a `release-dry-run` job (the job of a11ign/agent-org#967, adapted to this repository's `release.yml`), and `gate` needs it and reads `needs.release-dry-run.result` with the other two. A pull request that touches `package.json`, `pnpm-lock.yaml`, `.npmrc` or `.github/workflows/` now runs, in a scratch clone and with `contents: read`, the commands the release's `version` job runs: `pnpm install --frozen-lockfile`, `pnpm exec changeset version`, `pnpm install --lockfile-only`. A change touching none of them is a `success` for the job, never a skip, so `gate` still accepts `success` alone.

## Values, read from THIS repository's `release.yml` call (not agent-org's)

- `release.yml` here passes none of `pnpm-version`, `changesets-version`, `node-version`. So the called workflow's (`release-per-merge.yml@05c2418b`) rules apply: pnpm from `packageManager` (`pnpm@10.34.5`; the job's `pnpm/action-setup` has no `version` and reads it), the changesets CLI the lockfile pins (`@changesets/cli@3.0.3`), Node `22` (the input's default).
- `changesets-version` (default `3.0.3`) is only used by the called workflow for a repository with NO lockfile. This one has a lockfile and `checks` already runs `pnpm install --frozen-lockfile`, which refuses without one, so the job has no `pnpm dlx` branch to keep. Deliberately not copied from agent-org#967.

## The consumer's-install step is dropped, as the row allowed

agent-org#967's second step reproduces a11ign's `agent-org-newest-tag`, which clones an agent-org TAG and runs `pnpm install --frozen-lockfile --ignore-scripts`. Nothing clones a tag of this repository: it is published to npm (`kind: npm`) and a11ign consumes `@a11ign/screenreader-fleet` from the registry (`"@a11ign/screenreader-fleet": "^0.7.3"` in a11ign's root `package.json`), and `scripts/agent-org-newest-tag.ts` in a11ign takes its repository from the constant `TOOL_REPO_URL = "https://github.com/a11ign/agent-org"` (read at a11ign's `main` in this session). So there is no install of a tag of this repository to reproduce here.

## Evidence (measured, in a scratch clone of this branch's parent, with pnpm 10.34.5 and Node 24 locally)

- The three commands pass on `origin/main`: `pnpm install --frozen-lockfile`, `changeset v3.0.3` ("All files have been updated"), `pnpm install --lockfile-only`, exit 0.
- **A lockfile that omits `@changesets/cli` is refused:** the importer entry removed from `pnpm-lock.yaml`, `pnpm install --frozen-lockfile` exits 1 with "specifiers in the lockfile don't match specifiers in package.json: 1 dependencies were added: @changesets/cli@3.0.3". That is the first command of the job, so the job is red on the row's throwaway pull request (linked on the row once its run lands).
- **The path filter, run with a control in each direction** (the `grep -E` the job uses, on eight paths): `package.json`, `pnpm-lock.yaml`, `.npmrc`, `.github/workflows/ci.yml` read `touched`; `src/a.ts`, `docs/package.json`, `x/.npmrc`, `.github/dependabot.yml` read `skipped`.
- Parses as YAML: jobs `changeset, checks, release-dry-run, gate`; `gate.needs` is all three.
- **Not measured here:** the job's own run in CI, and a `merge_group` entry. Both are the row's Done-when 2 and 3 and are read off this pull request's checks.

Acceptance: bash -c 'grep -q "release-dry-run:" .github/workflows/ci.yml && grep -q "needs.release-dry-run.result" .github/workflows/ci.yml'

Mutation: this change is a workflow, and the guard is the job's first command. Mutating it "never fires" (the lockfile fed to `--frozen-lockfile` omitting `@changesets/cli`) is the red above; "always fires" is a tree with a consistent lockfile, which the first bullet runs through all three commands and which passes. The path filter is checked in both directions in the third bullet.
