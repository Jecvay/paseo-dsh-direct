# paseo-dsh-direct

English | [中文](README.zh.md)

`paseo-dsh-direct` connects a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to [Paseo](https://github.com/getpaseo/paseo) through a Direct Provider.

Version `0.2.0` registers the provider `dsh-pi`, shown in Paseo as **DeepSeek Harness**. The plugin id is `paseo-dsh-direct`.

## Install locally

The validated alpha combination is Paseo `0.9.2`, DSH `0.2.0-rc.1`, and a supported Node.js runtime. DSH must already be installed on the Paseo Daemon host; no other DSH add-on is needed.

```bash
git clone https://github.com/Jecvay/paseo-dsh-direct.git
cd paseo-dsh-direct
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

The same local source can be installed directly with `paseo plugin install /absolute/path/to/paseo-dsh-direct` after building. Git installation is available for an existing remote ref:

```bash
paseo plugin add Jecvay/paseo-dsh-direct --ref <tag-or-commit>
```

## Versioning

The plugin's `major.minor` tracks the dsh line it supports (`0.2.x` works with dsh `0.2.*`); the patch number is the plugin's own release count and does not follow dsh. Install the tag that matches your local dsh version.

| Plugin line | dsh line | What to install |
|---|---|---|
| `0.2.x` | `0.2.*` | this version |
| `0.1.x` | `0.1.*` | tag `v0.1.2` (`paseo plugin add Jecvay/paseo-dsh-direct --ref v0.1.2`) |

See the [compatibility notes](docs/compatibility.md) for the full rule and the dsh versions actually tested.

## Use

Create a conversation with the **DeepSeek Harness** provider. Models and presets come from the configured DSH profile. Existing native DSH sessions are available through Paseo's **Import session** flow and retain their native session identity.

The provider supports streamed assistant and reasoning output, tool execution and approval, user questions, model/preset configuration, interruption, and session recovery. It starts DSH with its own `paseo` profile and does not modify Paseo or DSH core.

The plugin uses the DSH profile `paseo`. On first start it creates that profile from DSH's official `web` template (`~/.dsh/profiles/paseo`, or under `$DSH_HOME` when set). Model routes, the default model, and permission presets go in `~/.dsh/profiles/paseo/cordis.patch.yml`. Set `PASEO_DSH_EXECUTABLE` to use a different `dsh` executable, or `PASEO_DSH_PROFILE` to use another existing profile; a profile named there is not created automatically. If the Paseo Daemon has plugin loading disabled, enable `pluginsEnabled` in its configuration before installing the plugin.

If a native session is still held by another DSH client (such as a terminal UI), release it there before importing or resuming it from Paseo.

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
