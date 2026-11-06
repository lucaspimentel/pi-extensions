// Reads the installed shell-ast version/license without importing the wasm.
// Plain JS: this file is .mjs, so Node does not strip type annotations here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "node_modules/@questi0nm4rk/shell-ast/package.json"), "utf8"));

/** Installed shell-ast version. */
export const version = pkg.version;
/** License field from the installed tarball's package.json (MIT as published). */
export const license = pkg.license;
