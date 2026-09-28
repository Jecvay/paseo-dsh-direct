# Compatibility

## Validated alpha combination

| Component | Validated version | Role |
|---|---|---|
| Paseo | `0.9.2` | Plugin host and Direct Provider protocol |
| DeepSeek Harness | `0.2.0-rc.1` | Agent runtime, persistence, and interaction services |
| Node.js | `24.13.0` | Plugin and DSH runtime |

The repository manifest requires Paseo `>=0.8.0`; the table above is the tested alpha baseline. Other Paseo or DSH versions are not implied to be tested by that lower-bound declaration.

Plugin `0.2.x` targets DSH `0.2.*`. Under DSH `0.2.0-rc.1`, the real provider path (`createDshProvider` + `launchDshBridge`, outside the Paseo Daemon) was checked with a real model: automatic creation of the `paseo` profile, model/preset/permission discovery, a real turn with a bash tool call, tool approval allow and reject, question answer and rejection, a slash menu that includes `/compact` and `/plan`, and resuming a closed session from its persistence handle. `npm run smoke:bridge -- --prompt` passes, and the DSH child opens no TCP port and no browser. Image and file attachments, MCP, cancellation, and loading and restart inside the Paseo Daemon have not been rechecked on the `0.2` line. For DSH `0.1.*`, install tag `v0.1.3`. The `0.1` line has fixed the issue where tool approvals and questions never reached Paseo and the turn kept waiting: `v0.1.1` fails to load and must not be installed, `v0.1.2` has the issue, and `v0.1.3` has passed real-model testing of approval allow/reject and question answer/reject under DSH `0.1.7-rc.2`.

DSH `0.2.0-rc.1` installs cleanly with `npm install @deepseek-ai/dsh@0.2.0-rc.1`. mise 2026.9.8's npm backend fails to install `@deepseek-ai/dsh@0.2.0-rc.1`, reporting a peer-dependency resolution error (`aube install failed: ... peer-context fixed-point did not converge`); use npm instead — globally (`npm install -g @deepseek-ai/dsh@0.2.0-rc.1`) or in a separate directory with `PASEO_DSH_EXECUTABLE` pointing to it. The mobile client's Daemon interfaces have been exercised; a physical phone has not been tested. See the repository's [Chinese compatibility notes](../compatibility.md) and [alpha acceptance criteria](../alpha-acceptance.md) for the detailed evidence boundary.

Paseo `0.9.2` has passed local Daemon startup, plugin loading, model discovery, a real text conversation, and a real tool call.

The Paseo daemon fixes its `PATH` at startup; after upgrading DSH, run `paseo daemon stop` then `paseo daemon start`, because `paseo daemon restart` keeps the old environment.

## npm releases and dist-tags

The plugin publishes to npm as `paseo-dsh-direct` (unscoped). The current dsh line (`main`) publishes as `latest`; older lines (such as `release/0.1`) publish with `--tag dsh-<major.minor>` (for example `dsh-0.1`), installed as `npm:paseo-dsh-direct@dsh-<major.minor>`. See [AGENTS.md](../../AGENTS.md) for the release steps.

Paseo's Install Plugin field has no Git ref input, so pasting a Git URL there always installs the `main` branch (the current dsh line); installing an older line's Git tag needs the CLI, `paseo plugin install <url> --ref <tag>`. The npm source has no such limit — a dist-tag is part of the `npm:<package>@<tag>` string itself, so it works from both the Settings field and the CLI.

## Runtime boundaries

The plugin reuses the user's existing DSH installation, credentials, and native session storage. It runs its own `paseo` profile, created from DSH's official `web` template, and needs no third-party DSH add-on. It does not upgrade or replace DSH, and it does not write credentials or machine-specific paths into the repository.

The `dsh-pi` provider is separate from any existing provider named `dsh`. Models, provider routes, and presets are queried from the active profile rather than hard-coded. DSH interface extensions, such as browser UI plugins in the profile, do not become Paseo UI components.

If the profile cannot load, a required DSH service is unavailable, or a native session is locked by another client, the operation reports an error. Release validation must distinguish automated checks and Linux Daemon evidence from platform or real-model tests that have not been run.

## Alpha limits

Prompts accept text, images, and uploaded files; images and files are stored in the DSH attachment store, and image prompts fail explicitly when the current model does not accept images. Paseo context attachments such as PRs, issues, and reviews are sent as text. Archiving is handled by Paseo and does not change the native DSH session. A Paseo system prompt is appended to the session agent's DSH system prompt. MCP servers (stdio and streamable HTTP) are mounted in the session's DSH process with tools named `mcp__<server>__<tool>`; tools preapproved by the Paseo tool policy run without an approval prompt, and SSE servers fail explicitly. Non-persistent sessions are stored in the session process's temporary directory, deleted on close, and never enter DSH history. Plan mode is a session toggle backed by DSH `/plan`. Compaction appears as compaction cards, and turns that hit the output limit, are blocked by a plugin, or were cut off by a stopped process show a warning. Rewind and Paseo provider options are not supported. Unsupported inputs fail explicitly. Existing configuration inside the DSH profile remains managed by DSH. The Paseo `/` menu lists DSH registered commands (such as `/compact`, `/goal`, `/plan`) and user-invocable skills; commands that belong only to a terminal UI (such as `/model`, `/sessions`) are not included. Titles are forwarded when creating a native session; later Paseo renames do not rename the DSH history.
