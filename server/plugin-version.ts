import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/**
 * This plugin's own version, read from `package.json` — the single source
 * for the dsh version line it supports (see `versionLine` in
 * `./version-line.js`). Not a separately maintained constant.
 */
export const PLUGIN_VERSION: string = pkg.version;
