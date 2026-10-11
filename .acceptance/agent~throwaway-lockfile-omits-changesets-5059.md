Done-when 2 of a11ign/a11ign#5059: a pull request that changes `pnpm-lock.yaml` so that it omits `@changesets/cli` must turn `release-dry-run` RED. Its base is the branch of #33, so the merge ref carries the job. **Never merge this; close it once #33's row has the check run linked.**

Draft-because: throwaway, do not review and do not merge
Closes: none — a throwaway pull request that exists to be red; a11ign/screenreader-fleet#33 carries the `Closes`.

Acceptance: bash -c 'git diff --quiet origin/agent/a11ign-screenreader-fleet-a-5059 -- pnpm-lock.yaml; test $? -eq 1'
