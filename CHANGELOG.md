# Changelog

## 0.1.5

- Paseo shows token usage and context-window fill for dsh sessions: the bridge forwards dsh's `tokenUsage` and `contextPressure` projections as Paseo session usage (contributed by @TyposBro in #56).
- The provider icon is the DeepSeek whale from dsh's own web frontend (`@deepseek-ai/dsh-web-frontend`, MIT), drawn as a single-colour glyph that follows Paseo's theme colour; the previous gradient icon drew only its eye and smile.
- Pushing a `vX.Y.Z` tag on this branch publishes to npm under the `dsh-0.1` dist-tag from GitHub Actions.

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
