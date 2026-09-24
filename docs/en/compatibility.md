# Compatibility

## Validated alpha combination

| Component | Validated version | Role |
|---|---|---|
| Paseo | `0.8.0` | Plugin host and Direct Provider protocol |
| DeepSeek Harness | `0.1.7-rc.1` | Agent runtime, persistence, and interaction services |
| `@xmoon76/dsh-pi-tui` | `0.4.8` | Reused profile and extension registration |
| Node.js | `24.13.0` | Plugin and DSH runtime |

The repository manifest requires Paseo `>=0.8.0`; the table above is the tested alpha baseline. Other Paseo, DSH, or pi-tui versions are not implied to be tested by that lower-bound declaration.

Local validation covers the real profile, model/preset/permission discovery, real model responses, reasoning output, tool execution and approval, question answers and rejection, native history import, cancellation followed by another turn, Daemon restart and session recovery, and clean shutdown. The mobile client’s Daemon interfaces have been exercised; a physical phone has not been tested. See the repository's [Chinese compatibility notes](../compatibility.md) and [alpha acceptance criteria](../alpha-acceptance.md) for the detailed evidence boundary.

Paseo `0.9.1` has additionally passed local Daemon startup, plugin loading, model discovery, and a real text conversation; the user confirmed receiving the test reply on their phone. The complete interaction test baseline remains the combination listed above.

The DSH and pi-tui versions above are validated directly at the bridge with a real model: appended system prompt, tool approval allow and reject, questions, file attachments, stdio MCP tools, slash commands and skills, `/compact`, `/plan`, permission switching, cancellation followed by another turn, and session resume. pi-tui `0.4.8` requires DSH `>=0.1.7-rc.1`. The Paseo daemon fixes its `PATH` at startup; after upgrading DSH, run `paseo daemon stop` then `paseo daemon start`, because `paseo daemon restart` keeps the old environment.

## Runtime boundaries

The plugin reuses the user's existing DSH installation, credentials, profile configuration, and native session storage. It does not upgrade or replace DSH or pi-tui, and it does not write credentials or machine-specific paths into the repository.

The `dsh-pi` provider is separate from any existing provider named `dsh`. Models, provider routes, and presets are queried from the active profile rather than hard-coded. Terminal menus, keyboard shortcuts, themes, and layout from pi-tui do not become Paseo UI components.

If the profile cannot load, a required DSH service is unavailable, or a native session is locked by another client, the operation reports an error. Release validation must distinguish automated checks and Linux Daemon evidence from platform or real-model tests that have not been run.

## Alpha limits

Prompts accept text, images, and uploaded files; images and files are stored in the DSH attachment store, and image prompts fail explicitly when the current model does not accept images. Paseo context attachments such as PRs, issues, and reviews are sent as text. Archiving is handled by Paseo and does not change the native DSH session. A Paseo system prompt is appended to the session agent's DSH system prompt. MCP servers (stdio and streamable HTTP) are mounted in the session's DSH process with tools named `mcp__<server>__<tool>`; tools preapproved by the Paseo tool policy run without an approval prompt, and SSE servers fail explicitly. Non-persistent sessions are stored in the session process's temporary directory, deleted on close, and never enter DSH history. Plan mode is a session toggle backed by DSH `/plan`. Compaction appears as compaction cards, and turns that hit the output limit, are blocked by a plugin, or were cut off by a stopped process show a warning. Rewind and Paseo provider options are not supported. Unsupported inputs fail explicitly. Existing configuration inside the DSH profile remains managed by DSH. The Paseo `/` menu lists DSH registered commands (such as `/compact`, `/goal`, `/plan`) and user-invocable skills; commands owned by the pi-tui terminal UI (such as `/model`, `/sessions`) are not included. Titles are forwarded when creating a native session; later Paseo renames do not rename the DSH history.
