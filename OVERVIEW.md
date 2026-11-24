# DeepSeek Harness for Paseo

Runs DeepSeek Harness (`dsh`) as a native Paseo agent provider. Paseo clients (desktop, web, iOS, Android) drive a local `dsh` agent with streamed responses, visible reasoning, native plan approvals, subagents, tool approvals, tool images, user questions, and session lifecycle management, without going through a generic ACP adapter.

## Requirements

- Paseo 0.11.0 or newer.
- DeepSeek Harness `dsh` on the 0.2 line, installed and configured on the machine that runs the Paseo daemon (model API key and settings are read by `dsh` from its own configuration). On Windows, a DSH Desktop installation is detected automatically when `dsh` is not on `PATH`.

## Features

- Incremental streaming for assistant text and reasoning ("thinking"), batched across concurrent sessions so parallel subagents stay smooth.
- Tool calls with Paseo approval prompts, inline rendering of tool-returned images (such as `read_image`), full Markdown plan review cards, and `dsh` user questions answered from the Paseo UI.
- Native DSH subagents shown in Paseo's subsession track, panels, and parent launch cards, with subagent model allowlist controls on the plugin settings screen.
- Create, import, resume, cancel, and close sessions (preserving native DSH session IDs); model, preset, reasoning, permission, and plan-mode controls from the Paseo UI.
- DSH slash commands and skills in Paseo's `/` menu, plus stdio and streamable HTTP MCP server passthrough from Paseo into DSH.
- Token usage and context-window fill in Paseo's usage meter, timeline cards for goal/plan/permission/compaction events, and per-turn and per-session provider metrics on Paseo 0.17.2 and later.
- DSH branding (name and icon) in the provider list.
- Safe idle cleanup on Paseo 0.14 and later: allows Paseo to reclaim idle session processes only when DSH reports no pending work (agents, inboxes, maintenance, background jobs, subagent completions, goals, or reminders). Sending a new message after cleanup resumes the same native DSH session.

## Processes and environment

- **Child process.** The plugin starts `dsh` as a child process for each active session (and briefly when querying model catalogs, session history, or subagent settings), loading a small bridge plugin that communicates over stdio.
- **Executable lookup.** In order: the `PASEO_DSH_EXECUTABLE` environment variable, the `Executable` field of the DeepSeek Harness settings screen, the Paseo setting `agents.providers.dsh-pi.command`, then `dsh` on `PATH` (on Windows, falls back to the `dsh` bundled with DSH Desktop).
- **Profile.** The plugin launches `dsh --profile paseo`. If `<DSH_HOME>/profiles/paseo` does not exist, it is created once by running `dsh --profile paseo --from-default-profile web --dump-config`. `DSH_HOME` defaults to `~/.dsh`. Setting `PASEO_DSH_PROFILE`, or the `Profile` field of the DeepSeek Harness settings screen (the variable wins), selects another existing profile instead; a missing one is reported as an error, not created.
- **Environment variables read by the plugin.** `PASEO_DSH_EXECUTABLE`, `PASEO_DSH_PROFILE`, and `DSH_HOME` (to locate the profile directory).
- **Settings screen.** Configure `Executable`, `Profile`, and `Startup timeout` (`1`–`600` seconds, default `15` seconds for the bridge ready signal), and search or select the models subagents may use under **Subagents**. Changes apply to new sessions or newly started bridges. When the DSH profile has no explicit subagent model settings, the plugin initially selects all currently available models and persists the choice in that profile. Existing choices are preserved; newly added models require selection. Profiles without writable subagent settings show this feature as unavailable.
- **Environment passed to `dsh`.** The child inherits the Paseo daemon's environment, plus any provider or session environment variables passed by Paseo.
- **Network.** The plugin makes no network requests itself. Model API calls are made by `dsh` according to its own configuration.
