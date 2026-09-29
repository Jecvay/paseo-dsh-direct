# paseo-dsh-direct

English | [中文](README.zh.md)

`paseo-dsh-direct` connects a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to [Paseo](https://github.com/getpaseo/paseo) through a Direct Provider.

## Install

You need `dsh` installed on the machine that runs the Paseo daemon, with the same `major.minor` as the plugin line you install.

In Paseo, open **Settings → Plugins → Install Plugin** and paste either the npm or the Git source:

| Your dsh | npm | Git |
|---|---|---|
| `0.2.x` | `npm:paseo-dsh-direct` | `https://github.com/Jecvay/paseo-dsh-direct` |
| `0.1.x` | `npm:paseo-dsh-direct@dsh-0.1` | CLI only: `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref release/0.1` |

More: [compatibility](docs/en/compatibility.md) · [CLI and local install, environment variables](docs/en/installation.md)

## Why "Direct"

Most dsh integrations go through ACP, a generic protocol that every agent can speak. This plugin skips it and talks to dsh natively, so what dsh does shows up in Paseo the way Paseo expects:

- Replies and thinking stream smoothly instead of arriving in chopped pieces.
- Tool approvals and dsh's questions to you appear as Paseo's own approval and question cards.
- Your existing dsh sessions can be imported and resumed in Paseo.
- dsh's slash commands (`/compact`, `/plan`, ...) appear in Paseo's `/` menu.

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
