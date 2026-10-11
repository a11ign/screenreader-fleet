import { readFileSync } from "node:fs";
import { defineConfig } from "@rslib/core";
import { libraryPreset } from "@a11ign/toolchain/rslib-presets";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const [library] = libraryPreset(pkg, { dir: import.meta.dirname }).lib;

// The `bin` commands that are JavaScript are not `exports` keys, so the preset cannot see them: they are built beside the `exports`
// entries (`a11ign-worker-ctl` is a shell script and ships from `src/local-worker`). They stay in `dist` beside the modules they share,
// because `fleet-scripts.mjs` finds `src/local-worker` and `src/provisioning`, and `normalise-fleet.mjs` finds `src/guest` and its
// sibling `guest-run.mjs`, from their OWN built files (the preset leaves `new URL("../src/local-worker/", import.meta.url)` as
// written), which only holds while every built file is directly under `dist`.
const BIN_ENTRIES = {
  doctor: "./src/doctor.ts",
  "check-worker-code": "./src/check-worker-code.ts",
  "compare-workers": "./src/compare-workers.ts",
  "guest-run": "./src/guest-run.ts",
  "normalise-fleet": "./src/normalise-fleet.ts",
};

export default defineConfig({
  lib: [{
    ...library,
    source: { entry: { ...library.source.entry, ...BIN_ENTRIES }, tsconfigPath: "./tsconfig.build.json" },
    // `chunkIds: "named"` keeps the chunks the entries share readable in `dist`: the default writes `8.mjs`, `s.mjs` and `t.mjs`.
    tools: { rspack: { ...library.tools.rspack, optimization: { chunkIds: "named" } } },
  }],
});
