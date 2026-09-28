# Install and use

## Requirements

The validated alpha combination is:

| Component | Version |
|---|---|
| Paseo | `0.9.2` |
| DeepSeek Harness | `0.2.0-rc.1` |
| Node.js | `24.13.0` |

DSH must already be installed on the host running the Paseo Daemon; no other DSH add-on is needed.

The plugin's `major.minor` tracks the dsh line it supports (this `0.2.x` release works with dsh `0.2.*`); install the line matching your local dsh version. DSH `0.2.0-rc.1` installs cleanly with `npm install @deepseek-ai/dsh@0.2.0-rc.1`; [Compatibility](compatibility.md) shows the full versioning rule and a caveat for mise's npm backend on this package.

## Install from the Settings UI

In Paseo, go to **Settings → Plugins → Install Plugin** and paste an npm or Git source; see the root [README](../../README.md#install) for the short version and the dsh-line-to-source table, and [npm releases and dist-tags](compatibility.md#npm-releases-and-dist-tags) for how dist-tags map to older dsh lines.

## Install from source

For local development, or to install without going through the Settings UI:

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
npm ci
npm run build
paseo plugin install "$PWD"
```

For an existing checkout, use `paseo plugin install /absolute/path/to/paseo-dsh-direct` after `npm run build`. Verify registration with:

```bash
paseo plugin ls
paseo provider models dsh-pi
```

The CLI also accepts a Git ref that the Settings UI field cannot:

```bash
paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

If the Paseo Daemon has plugin loading disabled, set `pluginsEnabled` to `true` in its `config.json`, then run `paseo daemon reload`. Preserve the other configuration fields.

## Start a conversation

Select **DeepSeek Harness** when creating a conversation. The provider id is `dsh-pi`; the plugin id is `paseo-dsh-direct`. Models and presets are read from the DSH profile the plugin runs.

Existing native DSH sessions are exposed through Paseo's **Import session** flow. Resuming a session keeps its native DSH session id and history. A session held by another DSH client, such as a terminal UI, must be released there first.

The plugin runs the DSH profile `paseo`. On first start it creates that profile from DSH's official `web` template, at `~/.dsh/profiles/paseo` (or under `$DSH_HOME` when set). Put model routes, the default model, and permission presets in `~/.dsh/profiles/paseo/cordis.patch.yml`; the file is a YAML list of DSH patch entries, for example `llm-pi-ai` for provider routes, `agent-default-model`, and `permission`.

Configure overrides in the Daemon environment:

| Variable | Effect |
|---|---|
| `PASEO_DSH_EXECUTABLE` | Selects the `dsh` executable. |
| `PASEO_DSH_PROFILE` | Selects another existing DSH profile; default: `paseo`. A profile named here is not created automatically. |

The provider exposes streamed assistant and reasoning output, tool execution and approval, user questions, configuration, interruption and persistent session recovery through Paseo's native UI.

## Update a local checkout

```bash
npm run build
paseo plugin reload paseo-dsh-direct
```

For a Git-installed plugin, update with `paseo plugin update paseo-dsh-direct`.
