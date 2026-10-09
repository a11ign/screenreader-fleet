// ESLint flat config — the MECHANICAL half of the Clean Code limits, carried over from a11ign/a11ign's
// `eslint.config.js` when `nvda-worker` and `nvda-speech` moved here (#2701). The move dropped this gate silently:
// CI ran `pnpm test` alone until #3179.
//
// Errors block CI. The five limits below are a11ign/a11ign's, at the same values; what is NOT carried over, and why:
//   - the four `local/*` rules (`bounded-window-reads`, `uncontrolled-emptiness`, `git-spawn-scrubbed`,
//     `max-physical-lines-per-function`) import a11ign/a11ign's own guard modules, and the first three police that
//     repository's tree (merge-queue rollup reads, its test corpus, its git spawns), none of which exists here.
//   - `no-magic-numbers` is a non-blocking warning there, so it would gate nothing here either.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "**/dist/**", "**/*.json"],
  },

  // Baseline for every source file (.ts tests and the .mjs worker).
  js.configs.recommended,
  {
    files: ["**/*.{ts,mjs,js}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "max-lines-per-function": ["error", { max: 70, skipBlankLines: true, skipComments: true }],
      "complexity": ["error", 15], // "do one thing": decision points (stricter than ESLint's default 20)
      "max-depth": ["error", 3], // "indent level should not be greater than one or two"
      "max-params": ["error", 4], // flag/polyadic args -> use an argument object
      // A bare `catch {}` swallows the failure; record a diagnostic or rethrow with `{ cause }`.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },

  // TypeScript-specific recommendations (unused vars, no-explicit-any, etc.).
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["**/*.ts"] })),

  // The conversion from JSDoc to TypeScript (#4280) wrote `any` wherever the JSDoc named no type (a pool entry, a probe result, a caught
  // error), and these six files hold all 68 of them. A warning, not an error, so the debt stays visible without blocking CI; the rule is
  // an error everywhere else, and a file that gets real types drops out of this list.
  {
    files: ["src/capture-client.ts", "src/compare-workers.ts", "src/doctor.ts", "src/measure-guard.ts", "src/probe-outcome.ts", "src/worker-http.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
);
