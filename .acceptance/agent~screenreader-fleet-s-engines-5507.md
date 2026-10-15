`engines.node` is `>=22.15.0`, the floor of the runtime dependency `@a11ign/toolchain` 0.9.0, and `src/engines-floor.test.ts` pins that no runtime dependency's engine floor (read from `pnpm-lock.yaml`) is above `engines.node` (a11ign/a11ign#5507).

Acceptance: pnpm exec rstest run src/engines-floor.test.ts

Mutation (both directions, `isAbove` restored from a copy and `diff`ed identical): forced always-false fails the "a dependency whose floor is above the package's is named" control (1 of 3); forced always-true fails the real-tree test and the "agrees" test (2 of 3); restored, 3 of 3 pass.
