# paseo-dsh-direct

English | [中文](README.zh.md)

`paseo-dsh-direct` connects a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to [Paseo](https://github.com/getpaseo/paseo) through a Direct Provider.

## Install

Prerequisite: `dsh` is installed and on the `PATH` of the machine running the Paseo Daemon, with a `major.minor` matching the line below.

In Paseo: **Settings → Plugins → Install Plugin**, paste one of these sources — npm and Git are two equivalent ways to get the same plugin:

| dsh line | npm source | Git source |
|---|---|---|
| `0.2.x` | `npm:paseo-dsh-direct` | `https://github.com/Jecvay/paseo-dsh-direct` |
| `0.1.x` | `npm:paseo-dsh-direct@dsh-0.1` | see note below |

The Install Plugin field has no ref/branch input, so a Git source always installs the `main` branch (the current, `0.2.x` line). To install the `0.1` line from Git, use the CLI instead: `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref v0.1.3`.

See [Compatibility](docs/en/compatibility.md) for the full version-matching rule, and [Install and use](docs/en/installation.md) for CLI install, local directory install for development, and environment variables.

## Why Direct

The plugin is a Paseo **Direct Provider**, not a generic ACP adapter — it talks to dsh's own internal event bus and RPC services (`server/dsh/bridge.ts`, a line-delimited JSON-RPC 2.0 bridge, see [server architecture](docs/server-architecture.md)). That buys:

- Streamed assistant and reasoning text carries stable item ids and cumulative snapshots, so Paseo slices the increments itself instead of reassembling pre-chopped generic chunks.
- Tool approvals and user questions arrive as native Paseo interaction cards, routed through dsh's own approval and question services.
- Existing native dsh sessions import and resume through Paseo's **Import session** flow, keeping their real dsh session id and history.
- dsh's own slash commands and skills (`/compact`, `/plan`, and others) show up directly in Paseo's `/` menu, read live from the running dsh profile.

## Versioning

The plugin's `major.minor` tracks the dsh line it supports; the patch number is the plugin's own release count and does not follow dsh. Install the line matching your local dsh version — see the table above, or the [compatibility notes](docs/compatibility.md) for the full rule and the dsh versions actually tested.

## Use

Create a conversation with the **DeepSeek Harness** provider. Models and presets come from the configured DSH profile. Existing native DSH sessions are available through Paseo's **Import session** flow and retain their native session identity.

The provider supports streamed assistant and reasoning output, tool execution and approval, user questions, model/preset configuration, interruption, and session recovery. It starts DSH with its own `paseo` profile and does not modify Paseo or DSH core.

The plugin uses the DSH profile `paseo`. On first start it creates that profile from DSH's official `web` template (`~/.dsh/profiles/paseo`, or under `$DSH_HOME` when set). Model routes, the default model, and permission presets go in `~/.dsh/profiles/paseo/cordis.patch.yml`. Set `PASEO_DSH_EXECUTABLE` to use a different `dsh` executable, or `PASEO_DSH_PROFILE` to use another existing profile; a profile named there is not created automatically. If the Paseo Daemon has plugin loading disabled, enable `pluginsEnabled` in its configuration before installing the plugin.

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
paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref <tag-or-commit>
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
