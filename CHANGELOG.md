# Changelog

## 0.2.0

- Targets dsh `0.2.*`; tested with dsh `0.2.0-rc.1`. For dsh `0.1.*`, install tag `v0.1.2`.
- dsh 0.2 needed no bridge or profile changes: the `web` template row ids, the four agent presets and the DSH services and events the bridge uses are the same as in 0.1. The bridge protocol version stays `1`.
- Fixed: tool approvals and user questions never reached Paseo and the turn kept waiting. The `web` template's `api-remotes` row forwards those requests to browser clients before the bridge sees them; the launcher now disables it along with the other browser-surface rows. `v0.1.2` has this bug under the `paseo` profile.
- dsh `0.2.0-rc.1` installs cleanly from npm (`npm install @deepseek-ai/dsh@0.2.0-rc.1`); see `docs/compatibility.md` for a mise install caveat.

## 0.1.3

- Fixed: tool approvals and user questions never reached Paseo and the turn stayed running. The `api-remotes` row of the web template forwarded both requests to browser clients ahead of the bridge; the plugin now disables it along with the other web surface rows.

## 0.1.2

- Fixed: 0.1.1 failed to load in Paseo because a server module imported `package.json`, which lies outside `client/`, `server/` and `shared/`. The plugin version is now generated into `server/generated-version.ts` by `npm run build`. Do not install the `v0.1.1` tag.
- Added a test that fails when a plugin module imports a file outside those three directories.

## 0.1.1

- Dropped the `@xmoon76/dsh-pi-tui` dependency; the plugin now runs its own `paseo` DSH profile instead of injecting into a pi-tui profile.
- Renamed the repository and plugin id to `paseo-dsh-direct`.
- The plugin's version now tracks the dsh version line (`major.minor`); a mismatched or unconfirmed dsh version shows a warning in the Paseo timeline instead of blocking the session.
