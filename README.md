# paseo-dsh-direct

English | [中文](README.zh.md)

`paseo-dsh-direct` connects a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to [Paseo](https://github.com/getpaseo/paseo) through a Direct Provider.

## Install

You need Paseo 0.11 or later and `dsh` on the machine that runs the Paseo daemon, with the same `major.minor` as the plugin line you install. On Paseo 0.8 to 0.10, install `npm:paseo-dsh-direct@0.2.1`.

In Paseo, open **Settings → Plugins → Install Plugin** and paste either the npm or the Git source:

| Your dsh | npm | Git |
|---|---|---|
| `0.2.x` | `npm:paseo-dsh-direct` | `https://github.com/Jecvay/paseo-dsh-direct` |
| `0.1.x` | `npm:paseo-dsh-direct@dsh-0.1` | CLI only: `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref rel/0.1` |

To update, run on the daemon machine (the app's plugin menu has no update entry):

```bash
paseo plugin update paseo-dsh-direct --check   # see if a new version exists
paseo plugin update paseo-dsh-direct --yes     # update to the latest
```

More: [compatibility](docs/en/compatibility.md) · [CLI and local install, environment variables](docs/en/installation.md)

## Why "Direct"

Most dsh integrations go through ACP, a generic protocol that every agent can speak. This plugin skips it and talks to dsh natively, so what dsh does shows up in Paseo the way Paseo expects:

- Replies and thinking stream smoothly instead of arriving in chopped pieces.
- Tool approvals and dsh's questions to you appear as Paseo's own approval and question cards.
- Your existing dsh sessions can be imported and resumed in Paseo.
- dsh's slash commands (`/compact`, `/plan`, ...) appear in Paseo's `/` menu.
- Paseo's usage meter shows dsh's token counts and how full the context window is.
- Goal changes that dsh does not already report in a `/goal` command's own output, plan mode switches and permission preset changes show up in the conversation as small timeline cards.

## Versioning

The plugin's `major.minor` tracks the dsh line it supports; the patch number is the plugin's own release count and does not follow dsh. Install the line matching your local dsh version — see the table above, or the [compatibility notes](docs/compatibility.md) for the full rule and the dsh versions actually tested.

## Use

Create a conversation with the **DeepSeek Harness** provider. Models and presets come from the configured DSH profile. Existing native DSH sessions are available through Paseo's **Import session** flow and retain their native session identity.

The provider supports streamed assistant and reasoning output, tool execution and approval, user questions, model/preset configuration, interruption, and session recovery. It starts DSH with its own `paseo` profile and does not modify Paseo or DSH core.

The plugin uses the DSH profile `paseo`. On first start it creates that profile from DSH's official `web` template (`~/.dsh/profiles/paseo`, or under `$DSH_HOME` when set). Model routes, the default model, and permission presets go in `~/.dsh/profiles/paseo/cordis.patch.yml`. The executable and the profile can be set on the **DeepSeek Harness** screen in Paseo's settings (fields `dsh executable` and `dsh profile`). The executable is chosen in this order: `PASEO_DSH_EXECUTABLE`, the settings screen, `agents.providers.dsh-pi.command` in the Paseo configuration, then `dsh` on `PATH`. The profile is chosen from `PASEO_DSH_PROFILE`, then the settings screen, then `paseo`; a profile named explicitly is not created automatically. Changed settings apply to new sessions; running sessions keep their `dsh`. If the Paseo Daemon has plugin loading disabled, enable `pluginsEnabled` in its configuration before installing the plugin.

The **Subagent models** section on that settings screen lets you search models by name or provider, select individual models, select all, clear the list, or disable model selection. On first initialization, the plugin selects all currently available models and saves the choice in the DSH profile. Existing choices, including an explicit disabled setting, are preserved; newly added models require selection. Changes apply to new sessions with a supported preset. See [settings behavior](docs/client-architecture.md#设置页).

If a native session is still held by another DSH client (such as a terminal UI), release it there before importing or resuming it from Paseo.

## Install from source

For local development, or to install without going through the Settings UI:

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

The same local source can be installed directly with `paseo plugin install /absolute/path/to/paseo-dsh-direct` after building. The CLI also accepts a Git ref that the Settings UI cannot:

```bash
paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify:notes
npm run verify:docs
```

Read the [documentation index](docs/README.md), [English installation guide](docs/en/installation.md), [English compatibility notes](docs/en/compatibility.md), or the [Chinese documentation](README.zh.md).

## License

[MIT](LICENSE)
