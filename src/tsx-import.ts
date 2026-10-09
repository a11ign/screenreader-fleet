import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * The arguments that let a plain `node` run a `.ts` file (ADR 0043, Decision 8): the host's Node has no type stripping, so a test that
 * starts a source file as a child process, as an operator would, starts it under `tsx`. Resolved to an absolute URL because those children
 * run from a temporary directory, where a bare `tsx` would not resolve.
 */
export const TSX_ARGS = ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href];
