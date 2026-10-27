# Changelog

## 0.2.12

- Choose which models subagents may use from the DeepSeek Harness settings page. Search by model or provider, select individual models, select all, clear the list, or disable model selection. Saved choices go directly into the DSH profile and apply to new sessions.
- On first initialization, select all currently available models when the profile has no explicit subagent model settings. Preserve existing choices, including disabled settings and empty lists; models added later require selection. Show unavailable providers and retain selected models missing from the current catalog.
- Reject stale settings edits and drafts from a different executable, DSH home or profile. Refresh the daemon-resolved launch configuration before opening settings bridges, and release each bridge after the operation.
- Verified with DSH `0.2.1-rc.2` in an isolated home: initialization, persistence, stale-edit rejection and existing session policies. Tested the real Paseo `0.13.2` Web UI at desktop and narrow widths, in light and dark themes, including search, selection, validation and save/reload. Screenshots were captured; native mobile devices and image-based aesthetic review were not tested.

## 0.2.11

- The context-window meter now drops as soon as a compaction finishes on dsh 0.2.1 or later, instead of waiting for the next request. The bridge reads the `projectedTokens` projection, which folds the compaction's shadow price into the last request's prompt size, and falls back to the raw prompt size on older dsh. Compaction cards also gain the real token count on dsh 0.2.1+, because they read the same shadow price.
- The import session list no longer times out on large histories. Title folding decodes each session's log, which cost about 30 seconds on a 350-session history and overran the bridge's 30-second request deadline, so `session.list` failed and the picker came up empty. The bridge now filters by cwd, matches the query and applies the limit before folding titles, folds only the rows it returns, caches folded titles for the bridge's lifetime, and gives the request a 120-second deadline.
- Verified against dsh `0.2.1-rc.2` (bridge handshake, catalogs and `session.list` over a real 350-session history) and Paseo `0.12.0` (provider availability, diagnostics and model catalog through the daemon).

## 0.2.10

- The settings screen no longer shows "Save" twice. The row is now labelled "Apply settings" with the note "Changes apply to new sessions.", and its button says "Save". The per-field hints keep only the environment-variable override.
- Goal cards no longer repeat what dsh's own `/goal` output already shows. A goal change made while a `/goal` command runs (create, edit, pause, resume, clear) gets no card, because dsh prints "Goal created", "Goal paused" and so on itself. Changes made by the model's goal tool or by dsh's goal driver still get cards for every operation (create, edit, pause, resume, complete, block, clear), and the "Goal continued" card for automatic rounds is unchanged. Old cards in replayed history still render.

## 0.2.9

- The plugin loads in Paseo again. 0.2.8 passed the icon name `terminal` for the settings screen, and Paseo only accepts Lucide export names such as `Settings`, so it showed the plugin as "Failed" with "Unknown Lucide icon: terminal". That dropped the whole client contribution: the settings screen and the timeline cards added in 0.2.8 were missing, and cards showed "Plugin timeline item unavailable.". The settings screen now uses the `Settings` icon, available in Paseo 0.11.0 and later, and a test pins client icons to names Paseo accepts.

## 0.2.8

- Paseo has a settings screen for the plugin (Settings → DeepSeek Harness) where you set the dsh executable path and profile; it works in the mobile apps too. `PASEO_DSH_EXECUTABLE` and `PASEO_DSH_PROFILE` still take precedence, and changes apply to new sessions (#9).
- Goal changes (set, edit, pause, resume, complete, block, clear and auto-continue rounds), plan mode switches and permission preset changes appear as compact cards in the Paseo timeline, including in replayed history (#8).
- The plugin is built against the Paseo plugin SDK 0.12.0 and still supports Paseo 0.11 and later.

## 0.2.7

- The dsh provider works with dsh `0.2.1`. dsh writes some of its own logs to stdout, such as the model-catalog line from a DeepSeek account login, and the bridge used to fail on that line with "DSH bridge wrote invalid JSON". The bridge now forwards any stdout line that is not a JSON object to stderr and keeps reading (contributed by @rayzart in #74).
- Tested by @rayzart with dsh `0.2.1-rc.2` on Paseo 0.11.4, signed in with a DeepSeek account and no API key: `paseo provider diagnostic dsh-pi` reports the provider available with its models, and a real turn completes. Unit tests cover protocol messages, log lines, truncated JSON and non-object JSON.

## 0.2.6

- Paseo's context-window ring fills and stays filled for dsh sessions. The plugin published a per-assistant-message usage reading beside the bridge's cumulative one; Paseo replaces `lastUsage` whole, and that reading carried neither the context window nor the folded cache totals, so it overwrote the complete reading. The bridge is now the only source of session usage.
- A regression test asserts that an assistant message reports no session usage, and that the bridge's reading passes through with all five fields.
- Verified against dsh `0.2.0-rc.2` and Paseo daemon 0.11.2: before the change a dsh agent's `lastUsage` held only `inputTokens` and `outputTokens`; after it, 91 consecutive readings of a real tool-using session each carried `cachedInputTokens`, `contextWindowMaxTokens` and `contextWindowUsedTokens`.

## 0.2.5

- dsh starts on Windows when it is installed through npm (`dsh.cmd` / `dsh.ps1`), with DSH Desktop's registered `dsh`, or with only DSH Desktop installed: the plugin runs the command the wrapper runs, without a shell. A `dsh` on `PATH` takes precedence over Desktop (#48).
- Text files check out with LF on every platform (`.gitattributes`), so the docs and notes gates pass on Windows.
- Tested on Windows 11 with dsh `0.2.0-rc.2` (npm `dsh.cmd`, DSH Desktop only, mise `dsh.exe`: bridge handshake, catalogs, session list, no leftover processes) and on Linux. No real model turn was run for this release.

## 0.2.4

- Paseo shows token usage and context-window fill for dsh sessions: the bridge forwards dsh's `tokenUsage` and `contextPressure` projections as Paseo session usage (contributed by @TyposBro in #54).
- The provider and plugin icons are the DeepSeek whale from dsh's own web frontend (`@deepseek-ai/dsh-web-frontend`, MIT). The provider icon is a single-colour glyph that follows Paseo's theme colour; the previous gradient icon drew only its eye and smile.
- The build works on Windows, where esbuild reports output paths with backslashes (contributed by @LionGG in #49).
- Tested with dsh `0.2.0-rc.2`: profile and handshake checks, catalogs and session list. Usage forwarding is covered by unit tests; a real model turn was not run for this release.

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
