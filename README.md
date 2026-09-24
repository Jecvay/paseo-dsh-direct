# paseo-dsh-pi

English | [中文](README.zh.md)

`paseo-dsh-pi` connects an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `pi-tui` profile to [Paseo](https://github.com/getpaseo/paseo) through a Direct Provider.

Version `0.1.0-alpha.1` registers the provider `dsh-pi`, shown in Paseo as **DeepSeek Harness (pi-tui)**. The plugin id is `paseo-dsh-pi`.

## Install locally

The validated alpha combination is Paseo `0.8.0`, DSH `0.1.7-rc.1`, `@xmoon76/dsh-pi-tui` `0.4.8`, and a supported Node.js runtime. DSH and the `pi-tui` profile must already be installed and configured on the Paseo Daemon host.

```bash
git clone https://github.com/Jecvay/paseo-dsh-pi.git
cd paseo-dsh-pi
npm ci
npm run build
paseo plugin install "$PWD"
paseo plugin ls
paseo provider models dsh-pi
```

The same local source can be installed directly with `paseo plugin install /absolute/path/to/paseo-dsh-pi` after building. Git installation is available for an existing remote ref:

```bash
paseo plugin add Jecvay/paseo-dsh-pi --ref <tag-or-commit>
```

## Use

Create a conversation with the **DeepSeek Harness (pi-tui)** provider. Models and presets come from the configured DSH profile. Existing native DSH sessions are available through Paseo's **Import session** flow and retain their native session identity.

The provider supports streamed assistant and reasoning output, tool execution and approval, user questions, model/preset configuration, interruption, and session recovery. It starts DSH with the `pi-tui` profile and does not rewrite the user's persistent profile or modify Paseo or DSH core.

The default profile is `pi-tui`. Set `PASEO_DSH_EXECUTABLE` to use a different `dsh` executable, or `PASEO_DSH_PROFILE` to select another profile. If the Paseo Daemon has plugin loading disabled, enable `pluginsEnabled` in its configuration before installing the plugin.

If a native session is still held by a terminal TUI, release it there before importing or resuming it from Paseo.

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
