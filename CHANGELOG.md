# Changelog

## 0.1.4

- Published to npm as `paseo-dsh-direct` under the `dsh-0.1` dist-tag. In Paseo's **Settings → Plugins → Install Plugin**, paste `npm:paseo-dsh-direct@dsh-0.1`; from Git, use `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref release/0.1`.
- The Paseo build step runs `npm install --include=dev` instead of `npm ci`, because npm packages never contain `package-lock.json`.

## 0.1.3

- Fixed: tool approvals and user questions never reached Paseo and the turn stayed running. The `api-remotes` row of the web template forwarded both requests to browser clients ahead of the bridge; the plugin now disables it along with the other web surface rows.

## 0.1.2

- Fixed: 0.1.1 failed to load in Paseo because a server module imported `package.json`, which lies outside `client/`, `server/` and `shared/`. The plugin version is now generated into `server/generated-version.ts` by `npm run build`. Do not install the `v0.1.1` tag.
- Added a test that fails when a plugin module imports a file outside those three directories.

## 0.1.1

- Dropped the `@xmoon76/dsh-pi-tui` dependency; the plugin now runs its own `paseo` DSH profile instead of injecting into a pi-tui profile.
- Renamed the repository and plugin id to `paseo-dsh-direct`.
- The plugin's version now tracks the dsh version line (`major.minor`); a mismatched or unconfirmed dsh version shows a warning in the Paseo timeline instead of blocking the session.
