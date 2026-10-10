# DeepSeek Harness for Paseo

Runs DeepSeek Harness (`dsh`) as a native Paseo agent provider. Paseo clients (desktop, web, iOS, Android) drive a local `dsh` agent with streamed responses, visible reasoning, tool approvals, user questions and session lifecycle management, without going through a generic ACP adapter.

## Requirements

- Paseo 0.11.0 or newer.
- DeepSeek Harness `dsh` on the 0.2 line, installed and configured on the machine that runs the Paseo daemon (model API key and settings are read by `dsh` from its own configuration).

## Features

- Streaming assistant text and reasoning ("thinking") as Paseo timeline items.
- Tool calls with Paseo approval prompts, and `dsh` user questions answered from the Paseo UI.
- Create, resume, cancel and close sessions; model list and mode switching from the Paseo UI.
- DSH branding (name and icon) in the provider list.

## Processes and environment

- **Child process.** For each session the plugin starts the `dsh` executable as a child process and loads a small bridge plugin into it. The two communicate over the child's stdio.
- **Executable lookup.** In order: the `PASEO_DSH_EXECUTABLE` environment variable, then the Paseo setting `agents.providers.dsh-pi.command`, then `dsh` on `PATH`.
- **Profile.** The plugin launches `dsh --profile paseo`. If `<DSH_HOME>/profiles/paseo` does not exist, it is created once by running `dsh --profile paseo --from-default-profile web --dump-config`. `DSH_HOME` defaults to `~/.dsh`. Setting `PASEO_DSH_PROFILE` selects another existing profile instead; a missing one is reported as an error, not created.
- **Environment variables read by the plugin.** `PASEO_DSH_EXECUTABLE`, `PASEO_DSH_PROFILE`, and `DSH_HOME` (to locate the profile directory).
- **Environment passed to `dsh`.** The child inherits the Paseo daemon's environment.
- **Network.** The plugin makes no network requests itself. Model API calls are made by `dsh` according to its own configuration.
