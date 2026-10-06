import { readFileSync } from "node:fs";
import { defineConfig } from "@rslib/core";
import { libraryPreset } from "@a11ign/toolchain/rslib-presets";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const [library] = libraryPreset(pkg, { dir: import.meta.dirname }).lib;

// The four `bin` commands are not `exports` keys, so the preset cannot see them: they are built beside the `exports` entries. They stay
// in `dist` beside the modules they share, because `fleet-scripts.mjs` finds `src/local-worker` and `src/provisioning` as `../src/...`
// from its OWN built file (the preset leaves `new URL("../src/local-worker/", import.meta.url)` as written), which only holds while
// every built file is directly under `dist`.
const BIN_ENTRIES = {
  doctor: "./src/doctor.mjs",
  "check-worker-code": "./src/check-worker-code.mjs",
  "compare-workers": "./src/compare-workers.mjs",
};

export default defineConfig({
  lib: [{
    ...library,
    source: { entry: { ...library.source.entry, ...BIN_ENTRIES } },
    // `chunkIds: "named"` keeps the chunks the entries share readable in `dist`: the default writes `8.mjs`, `s.mjs` and `t.mjs`.
    tools: { rspack: { ...library.tools.rspack, optimization: { chunkIds: "named" } } },
  }],
});
