/**
 * This plugin's own version, taken from `package.json` by `npm run build`
 * (Paseo refuses plugin modules outside client/, server/ and shared/, so it
 * cannot be imported at runtime) — the single source for the dsh version
 * line it supports (see `versionLine` in `./version-line.js`).
 */
export { PLUGIN_VERSION } from "./generated-version.js";
