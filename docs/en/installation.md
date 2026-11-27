# Install and use

## Requirements

- **Paseo:** `>=0.11.0` (newer host capabilities such as idle runtime cleanup on `0.14+` and provider metrics on `0.17.2+` negotiate automatically).
- **DeepSeek Harness (`dsh`):** installed on the host running the Paseo daemon, matching the plugin's `major.minor` line (`0.2.x` plugin ↔ `dsh 0.2.*`). No other DSH add-on is required.
- **Node.js:** `22` or `24`.

Install DSH with npm (`npm install -g @deepseek-ai/dsh`, or in a separate directory pointed to by `PASEO_DSH_EXECUTABLE`). See [Compatibility](compatibility.md) for the full version policy, tested Paseo/DSH combinations, and a caveat for mise's npm backend.

## Install from the Settings UI

In Paseo, go to **Settings → Plugins → Install Plugin** and paste `npm:paseo-dsh-direct` (recommended) or `https://github.com/Jecvay/paseo-dsh-direct`. See the root [README](../../README.md#install) for update commands and older DSH lines, and [npm releases and dist-tags](compatibility.md#npm-releases-and-dist-tags) for how dist-tags map to DSH releases.

## Install from source

To install from a local checkout, or without going through the Settings UI:

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
paseo plugin install "$PWD"
```

For an existing checkout, use `paseo plugin install /absolute/path/to/paseo-dsh-direct` directly; run `npm run build` first if you changed any source that enters the bridge bundle, or the version. Verify registration with:

```bash
paseo plugin ls
paseo provider models dsh-pi
```

The CLI also accepts a Git ref that the Settings UI field cannot:

```bash
paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

If the Paseo daemon has plugin loading disabled, set `pluginsEnabled` to `true` in its `config.json`, then run `paseo daemon reload`. Preserve the other configuration fields.

## Start a conversation

Select **DeepSeek Harness** when creating a conversation. The provider ID is `dsh-pi`; the plugin ID is `paseo-dsh-direct`. Models and presets are read from the DSH profile the plugin runs.

Existing native DSH sessions are exposed through Paseo's **Import session** flow. Resuming a session keeps its native DSH session ID and history. A session held by another DSH client, such as a terminal UI, must be released there first.

The plugin runs the DSH profile `paseo`. On first start it creates that profile from DSH's official `web` template, at `~/.dsh/profiles/paseo` (or under `$DSH_HOME` when set). Put model routes, the default model, and permission presets in `~/.dsh/profiles/paseo/cordis.patch.yml`; the file is a YAML list of DSH patch entries, for example `llm-pi-ai` for provider routes, `agent-default-model`, and `permission`.

Through Paseo's native UI, the provider supports streamed text and reasoning, tool approvals, native plan review, tool-returned images, and user questions. It also supports subagent subsessions, MCP server passthrough, slash commands, usage and turn metrics, cancellation, and persistent session recovery.

## Settings and environment variables

Configure the plugin on the **Settings → DeepSeek Harness** screen in Paseo (available across desktop, web, and mobile) or via daemon environment variables. An environment variable wins over the corresponding setting. Setting changes apply to new sessions or newly started bridges; running sessions keep their existing `dsh`.

| Variable | Effect |
|---|---|
| `PASEO_DSH_EXECUTABLE` | Selects the `dsh` executable; takes precedence over the settings screen and the Paseo setting below. |
| `PASEO_DSH_PROFILE` | Selects another existing DSH profile; default: `paseo`. Takes precedence over the settings screen. A profile named here is not created automatically. |

The provider registers `command: ["dsh"]`, so Paseo's own provider configuration can override the executable and its environment without an environment variable:

```json
{ "agents": { "providers": { "dsh-pi": { "command": ["/opt/dsh/bin/dsh"], "env": { "DSH_HOME": "/srv/dsh" } } } } }
```

The executable is chosen in this order: `PASEO_DSH_EXECUTABLE`, then the settings screen (`Executable`), then `agents.providers.dsh-pi.command`, then `dsh` from `PATH`. Restart the Paseo daemon after changing environment variables or Paseo configuration.

On Windows, npm's `dsh.cmd` / `dsh.ps1` and the `dsh` that DSH Desktop registers both work. With only DSH Desktop installed, no separate `dsh` is needed: when `PATH` has no `dsh`, the plugin uses the `dsh` bundled in Desktop's default install. A `dsh` on `PATH` takes precedence over Desktop.

### Startup timeout

The **Startup timeout** field under **Connection** sets how long to wait for the bridge to become ready after spawning `dsh`. It accepts whole seconds from `1` to `600`; leaving it blank uses the `15`-second default. It has no environment variable override and applies to every newly started bridge (session creation/recovery, model catalog and session history queries, and subagent settings reads/writes); running bridges keep their configuration.

Creating the default profile (`60`s), checking startup configuration (`20`s), and the subsequent initialization request (`bridge.initialize`, `30`s) keep separate deadlines. Longer ready waits can also delay connection close.

Paseo `0.11`, `0.14`, and `0.15.3` impose an outer `30`-second timeout on establishing a Provider connection and on generic plugin RPC requests, so a larger bridge timeout does not guarantee that a model catalog query or subagent settings operation can wait that long. After a host request times out, the underlying task or settings save may still finish; check current state before retrying. The event path for opening a session after connecting (`session.open`) does not have an equivalent outer timer in those versions, and `600` seconds is only an input bound rather than a whole-operation guarantee.

### Subagent models

In the **Subagents** section, select **Edit models** to open the model picker (a dialog on wide layouts, or a bottom sheet on narrow layouts). You can search by model name, ID, or provider, toggle individual models, select all, clear the list, or turn off **Use selected models**. On first initialization, the plugin selects all currently available models and writes the choice to the DSH profile. Existing choices (including an explicit disabled setting) are preserved, while newly added models require manual selection. Changes apply to new sessions using a preset that supports subagent model selection.

## Update a local checkout

```bash
paseo plugin reload paseo-dsh-direct
```

The generated modules are already in the checkout. If you changed source that enters the bridge bundle, or the version, run `npm run build` first (after one `npm ci`); otherwise reload is enough. For a Git- or npm-installed plugin, update with `paseo plugin update paseo-dsh-direct --yes`.
