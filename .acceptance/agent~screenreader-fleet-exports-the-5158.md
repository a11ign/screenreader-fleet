The package exports the four modules `control` imports by relative path (`git-safe-env`, `protocol-guard`, `npm-cli-executable`, `code-drift`), each with `types` and `default` into `dist`, so a consumer can import them by subpath once a release carries them (ADR 0045 Decision 1 rule 2, the producer half of `control` cut 7b).

- **Fix:** four `exports` entries in `package.json`, beside the twelve existing ones. Rslib builds an entry for each through `libraryPreset`, so `dist/<name>.mjs` and `dist/<name>.d.ts` are emitted by the existing build and no `rslib.config.ts` change is needed.
- **Dependency-free, checked by reading the imports:** `git-safe-env` imports nothing; `npm-cli-executable` imports `node:fs` and `node:path`; `protocol-guard` imports the sibling `worker-http`, which imports `node:http` and `node:https`; `code-drift` imports `node:child_process` and the siblings `git-safe-env` and `worker-http`. Nothing needs an install.
- **Changeset:** minor, since the release adds exports.
- **Worktree note:** the row named `/home/agent/repos/wt-5158`, which is the a11y-witness checkout; the code lives in `screenreader-fleet`, so the work is on this branch in `/home/agent/repos/screenreader-fleet-wt-5158`, cut from `origin/main`.

Mutation: deleted `./code-drift` from a scratch copy of `package.json`; the acceptance check exits 1 with `missing ./code-drift`. The real manifest exits 0. `dist` loads all four modules with the expected named exports.

Acceptance: pnpm run build && node -e "const p=require('./package.json'),fs=require('fs');for(const k of ['./git-safe-env','./protocol-guard','./npm-cli-executable','./code-drift']){const t=p.exports[k]&&p.exports[k].default;if(!t||!fs.existsSync(t)){console.error('missing',k);process.exit(1)}}"
