# DeepSeek Harness for Paseo

Runs DeepSeek Harness (`dsh`) as a native Paseo agent provider. Paseo clients (desktop, web, iOS, Android) drive a local `dsh` agent with streamed responses, visible reasoning, tool approvals, user questions and session lifecycle management, without going through a generic ACP adapter.

## Requirements

- Paseo 0.11.0 or newer.
- DeepSeek Harness `dsh` on the 0.2 line, installed and configured on the machine that runs the Paseo daemon (model API key and settings are read by `dsh` from its own configuration).

## Features

- Streaming assistant text and reasoning ("thinking") as Paseo timeline items.
- Tool calls with Paseo approval prompts, and `dsh` user questions answered from the Paseo UI.
- Create, resume, cancel and close sessions; model list and mode switching from the Paseo UI.
- Token usage and context-window fill in Paseo's usage meter.
- DSH branding (name and icon) in the provider list.
- On Paseo 0.14, answers the host's idle runtime cleanup query and refuses cleanup while supported DSH checks find pending work (agents, inboxes, maintenance, background jobs, subagent completion delivery, goals, reminders). After the host releases a persisted session runtime, the next message resumes the same native DSH session.

## Processes and environment

- **Child process.** For each session the plugin starts the `dsh` executable as a child process and loads a small bridge plugin into it. The two communicate over the child's stdio.
- **Executable lookup.** In order: the `PASEO_DSH_EXECUTABLE` environment variable, the executable field of the DeepSeek Harness settings screen, the Paseo setting `agents.providers.dsh-pi.command`, then `dsh` on `PATH`.
- **Profile.** The plugin launches `dsh --profile paseo`. If `<DSH_HOME>/profiles/paseo` does not exist, it is created once by running `dsh --profile paseo --from-default-profile web --dump-config`. `DSH_HOME` defaults to `~/.dsh`. Setting `PASEO_DSH_PROFILE`, or the profile field of the DeepSeek Harness settings screen (the variable wins), selects another existing profile instead; a missing one is reported as an error, not created.
- **Environment variables read by the plugin.** `PASEO_DSH_EXECUTABLE`, `PASEO_DSH_PROFILE`, and `DSH_HOME` (to locate the profile directory).
- **Settings screen.** Set the executable and profile, and search or select the models subagents may use. Changes apply to new sessions. When the DSH profile has no explicit subagent model settings, the plugin initially selects all currently available models and persists the choice in that profile. Existing choices are preserved; newly added models require selection. Profiles without writable subagent settings show this feature as unavailable.
- **Environment passed to `dsh`.** The child inherits the Paseo daemon's environment.
- **Network.** The plugin makes no network requests itself. Model API calls are made by `dsh` according to its own configuration.
