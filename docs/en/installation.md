# Install and use

## Requirements

The validated alpha combination is:

| Component | Version |
|---|---|
| Paseo | `0.8.0` |
| DeepSeek Harness | `0.1.7-rc.1` |
| `@xmoon76/dsh-pi-tui` | `0.4.8` |
| Node.js | `24.13.0` |

DSH and the `pi-tui` profile must already be installed and configured on the host running the Paseo Daemon. This repository does not publish an npm package.

## Install from source

```bash
git clone https://github.com/Jecvay/paseo-dsh-pi.git
cd paseo-dsh-pi
npm ci
npm run build
paseo plugin install "$PWD"
```

For an existing checkout, use `paseo plugin install /absolute/path/to/paseo-dsh-pi` after `npm run build`. Verify registration with:

```bash
paseo plugin ls
paseo provider models dsh-pi
```

Git installation supports an existing remote tag or commit:

```bash
paseo plugin add Jecvay/paseo-dsh-pi --ref <tag-or-commit>
```

If the Paseo Daemon has plugin loading disabled, set `pluginsEnabled` to `true` in its `config.json`, then run `paseo daemon reload`. Preserve the other configuration fields.

## Start a conversation

Select **DeepSeek Harness (pi-tui)** when creating a conversation. The provider id is `dsh-pi`; the plugin id is `paseo-dsh-pi`. Models and presets are read from the selected DSH profile.

Existing native DSH sessions are exposed through Paseo's **Import session** flow. Resuming a session keeps its native DSH session id and history. A session held by a terminal TUI must be released there first.

The default profile is `pi-tui`. Configure overrides in the Daemon environment:

| Variable | Effect |
|---|---|
| `PASEO_DSH_EXECUTABLE` | Selects the `dsh` executable. |
| `PASEO_DSH_PROFILE` | Selects the DSH profile; default: `pi-tui`. |

The provider exposes streamed assistant and reasoning output, tool execution and approval, user questions, configuration, interruption and persistent session recovery through Paseo's native UI.

## Update a local checkout

```bash
npm run build
paseo plugin reload paseo-dsh-pi
```

For a Git-installed plugin, update with `paseo plugin update paseo-dsh-pi`.
