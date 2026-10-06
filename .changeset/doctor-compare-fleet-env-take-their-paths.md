---
"@a11ign/screenreader-fleet": patch
---

`a11ign-doctor`, `a11ign-worker-compare` and `fleet-env` no longer resolve monorepo-layout paths from inside an installed package, where `../../../` is `node_modules` and `../../control/ansible/` is a package the tarball does not hold: `doctor` and `worker-compare` would have read and written under the dependency, and `fleet-env --list` died on an ENOENT. `a11ign-doctor` and `a11ign-worker-compare` take `--runs-dir=<the runs directory>` and `fleet-env` takes `--inventory=<file>` and `--group-vars=<file>`; each defaults to the monorepo path only when that exists, and otherwise exits 2 naming the missing path and the flag that supplies it.
