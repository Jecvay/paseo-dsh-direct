# paseo-dsh-direct

English | [中文](README.zh.md)

Native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) provider for [Paseo](https://github.com/getpaseo/paseo) — drive a local `dsh` agent across Paseo Desktop, Web, iOS, and Android with streamed thinking, native plan approvals, subagents, tool images, and live metrics.

`Paseo >= 0.11.0` · `dsh 0.2.x` · `npm:paseo-dsh-direct` · [MIT License](LICENSE)

## Install

Install `dsh` (`0.2.x`) on the machine running the Paseo daemon (macOS, Linux, or Windows). On Windows, a DSH Desktop installation is detected automatically when `dsh` is not on `PATH`.

In Paseo, open **Settings → Plugins → Install Plugin** and paste one of the sources below:

- **npm (latest, recommended):** `npm:paseo-dsh-direct`
- **Paseo plugin registry (reviewed release):** `jecvay/paseo-dsh-direct` — [official listing](https://paseo.sh/plugins/jecvay/paseo-dsh-direct), installs the exact version the listing pins (CLI: `paseo plugin add jecvay/paseo-dsh-direct`)
- **Git:** `https://github.com/Jecvay/paseo-dsh-direct`

To update, run these commands on the daemon machine (the Paseo app has no in-app update button). An npm install follows its dist-tag (`latest` by default), a Git install follows the remote's default branch, and a registry install stays on the release its listing pins until the listing updates.

```bash
paseo plugin update paseo-dsh-direct --check   # check for a newer release
paseo plugin update paseo-dsh-direct --yes     # install the available release
```

<details>
<summary>Older versions, <code>pluginsEnabled</code>, and installing from source</summary>

- **DSH `0.1.x`:** paste `npm:paseo-dsh-direct@dsh-0.1` in Settings, or run `paseo plugin install https://github.com/Jecvay/paseo-dsh-direct --ref rel/0.1`.
- **Paseo `0.8`–`0.10`:** install `npm:paseo-dsh-direct@0.2.1`.
- **Plugin loading disabled:** if your Paseo daemon disables plugins by default, set `"pluginsEnabled": true` at the top level of `config.json` and run `paseo daemon reload`.
- **Install a specific Git ref via CLI:**
  ```bash
  paseo plugin install github:Jecvay/paseo-dsh-direct --ref <tag-or-commit>
  ```
- **Install from a local checkout:**
  ```bash
  git clone https://github.com/Jecvay/paseo-dsh-direct.git
  cd paseo-dsh-direct
  paseo plugin install "$PWD"
  paseo plugin ls
  paseo provider models dsh-pi
  ```

</details>

See the [installation guide](docs/en/installation.md) for CLI options and environment variables, or [compatibility](docs/en/compatibility.md) for tested version combinations.

## Why "Direct"

Most `dsh` integrations go through ACP, a generic protocol that every agent can speak. In practice, ACP strips away runtime-specific features and leaves streaming, approvals, and session controls feeling rough. This plugin skips ACP and talks to `dsh` natively, so what `dsh` does shows up in Paseo the way Paseo expects:

| Capability | Native Paseo experience |
|---|---|
| **Streaming & reasoning** | Replies and thinking stream smoothly as true incremental output instead of arriving in chopped pieces, and concurrent sessions are batched so parallel subagents stay smooth over WebSocket and relay links. |
| **Tools, plans & media** | Native tool approval and question cards, full Markdown plan review cards (`Approve` / `Keep planning`), image and file attachments, and inline rendering of tool-returned images (such as `read_image`). |
| **Subagents** | DSH subagents appear in Paseo's subsession track, side panels, and parent launch cards, with per-model allowlist controls in settings. |
| **Sessions & runtime** | Import and resume local DSH sessions while keeping their native session IDs. On Paseo 0.14+, idle runtimes are safely reclaimed only when DSH reports no pending agents, jobs, goals, inboxes, or reminders. |
| **Commands & MCP** | DSH slash commands (`/compact`, `/plan`, `/goal`, …) and user skills appear in Paseo's `/` menu. Paseo stdio and streamable HTTP MCP servers mount directly into DSH. |
| **Usage & metrics** | Live token and context-window meter (updating immediately after compaction on DSH 0.2.1+), plus timeline cards for goal, plan-mode, permission, and compaction events. On Paseo 0.17.2+, completed turns show model, elapsed time, tokens, and cache hit rate, and session details show cumulative turns and totals. |

## Use & Configure

Start a new conversation and pick **DeepSeek Harness** (`dsh-pi`). Existing local DSH sessions appear under **Import session** and keep their native history.

On first start, the plugin creates an isolated `paseo` profile from DSH's official `web` template at `~/.dsh/profiles/paseo` (or under `$DSH_HOME` when set), without modifying Paseo or DSH core. Configure model routes, default model, and permission presets in that profile's `cordis.patch.yml`.

Adjust plugin settings in Paseo under **Settings → DeepSeek Harness** (changes apply to new sessions or newly started bridges):

| Setting | What it controls |
|---|---|
| **Executable** | Path or command for `dsh`. Overridden by `PASEO_DSH_EXECUTABLE`. |
| **Profile** | DSH profile name (default: `paseo`). Overridden by `PASEO_DSH_PROFILE`. Named profiles are not auto-created. |
| **Startup timeout** | Seconds (`1`–`600`, default `15`) to wait for the bridge ready signal after spawning `dsh`. See [timeout limits](docs/en/installation.md#startup-timeout). |
| **Subagents** | Search and pick which models subagents may use via **Edit models**. Selects all available models on first initialization; models added later require opt-in. See [subagent models](docs/en/installation.md#subagent-models). |

**Executable lookup order:** `PASEO_DSH_EXECUTABLE` → Settings (`Executable`) → `agents.providers.dsh-pi.command` → `dsh` on `PATH` (on Windows, falls back to the `dsh` bundled with DSH Desktop).

> **Note:** If a native DSH session is still open in another client (such as the DSH terminal UI), release it there before importing or resuming it in Paseo.

## Versioning & Compatibility

- The plugin's `major.minor` tracks the DSH line it supports (`0.2.x` ↔ `dsh 0.2.*`); `patch` is the plugin's own release counter.
- Minimum Paseo version is `0.11.0`. Newer host features (idle runtime cleanup on `0.14+`, provider turn/session metrics on `0.17.2+`) activate automatically via capability negotiation and degrade cleanly on older hosts.

See [compatibility](docs/en/compatibility.md) for the full version policy and tested Paseo / DSH combinations.

## Development

```bash
npm ci
npm run setup:hooks
npm run verify:generated
npm run typecheck
npm test
npm run verify:package
npm run verify:notes
npm run verify:docs
```

**Documentation:** [English installation guide](docs/en/installation.md) · [English compatibility](docs/en/compatibility.md) · [Documentation index](docs/README.md) · [中文 README](README.zh.md)

## License

[MIT](LICENSE)
