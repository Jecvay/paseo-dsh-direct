# Changelog

## 0.2.3

- The provider registers `command: ["dsh"]`, so the Paseo configuration `agents.providers.dsh-pi.command` and `env` choose the dsh executable. `PASEO_DSH_EXECUTABLE` still takes precedence when set; `status()` checks the same executable a session launches.
- Connecting fails with a clear message when the dsh profile lacks a row the plugin disables, or when dsh lacks a service the bridge uses, instead of misbehaving later.
- An approval and question end-to-end test against real dsh runs when `DEEPSEEK_API_KEY` is set.
- `OVERVIEW.md` describes the plugin for the Paseo plugin registry, including the dsh subprocess and the environment variables it reads.
- Pushing a `vX.Y.Z` tag publishes to npm from GitHub Actions through npm Trusted Publishing.
- Tested with dsh `0.2.0-rc.2`: profile and handshake checks, catalogs and session list.

## 0.2.2

- Requires Paseo `>=0.11.0`. Paseo 0.8 to 0.10 users install `npm:paseo-dsh-direct@0.2.1`.
- The Paseo SDK types are pinned to `0.11.2`.
- `paseo-plugin.json` carries the name `DeepSeek Harness` and the icon `dsh.png`.
- The provider registers `status()`: Paseo shows whether dsh runs and, when it does not, the reason; a dsh on another version line stays available with the same line warning as the session timeline.
- The README's GitHub install uses `github:Jecvay/paseo-dsh-direct`.
- Tested with dsh `0.2.0-rc.2` (bridge handshake, model/preset catalogs, session list, and loading in a Paseo 0.11.2 Daemon). Real turns, tool calls, approvals, questions, `/compact`, `/plan` and resume were last run on dsh `0.2.0-rc.1`; see `docs/compatibility.md`.

## 0.2.1

- Published to npm as `paseo-dsh-direct`. Paseo's **Settings → Plugins → Install Plugin** now accepts `npm:paseo-dsh-direct` or the Git URL; the dsh `0.1` line is `npm:paseo-dsh-direct@dsh-0.1`.
- The Paseo build step runs `npm install --include=dev` instead of `npm ci`, because npm packages never contain `package-lock.json`.
- The README opens with the Settings install and why the plugin talks to dsh natively instead of through ACP.

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
