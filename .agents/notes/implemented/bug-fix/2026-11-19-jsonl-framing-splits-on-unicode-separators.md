# 决策记录: 只按 LF 切分桥接管道，防止 U+2028/U+2029 拆断 JSONL 帧

Status: implemented

## 问题

桥接两端此前通过 `node:readline` 读取 JSONL 管道，把合法 JSON 字符串里的原始 `U+2028`（行分隔符）与 `U+2029`（段分隔符）也当作换行切开，导致含这两个字符的请求或历史回复被拆成两截无法解析的残片，Paseo 打开会话固定报 `Couldn't refresh agent history.`（Daemon 日志报 `DSH bridge request timed out: session.open` 并刷出大量 `ignored dsh stdout`）。

根因是分帧规则与 JSONL 不一致，既不是传输损坏，也不是会话历史过大。`JSON.stringify` 不会转义 `U+2028` 和 `U+2029`。只要源码文件、工具输出或粘贴进提示词的正文含有这两个原始字符，单条 JSON-RPC 帧就会被切成两半：回复方向被 `acceptLine` 当作 dsh 自身日志丢弃，请求方向返回 `id: null` 的 `-32600` 错误又被客户端直接忽略，调用方只能等到请求超时。实测（合成 200 行语料、每行插入 `U+2028`/`U+2029`）中，`session.read` 稳定超时并产生 34 条 `ignored dsh stdout`；原始字节显示 `e2 80 a8` 位于合法 `{"jsonrpc":"2.0",...}` 帧内部第 666 字节处，把同一帧拆成了多行。

同时存在两处日志泄露风险：无法解析的 stdout 行会把前 2000 字符原样写入 stderr，而 `id: null` 错误中的 V8 `JSON.parse` `error.message` 会夹带约 20 字符的原始输入片段，两者都可能包含历史正文、源码或凭证。

## 决定

- `server/jsonl-frames.ts` 的 `createJsonlFramer` 只按 LF（`\n`）切帧，剥离行尾 CR，将 `U+2028`、`U+2029` 等其余字符留在帧内；请求方向（`server/dsh/bridge.ts` 读 stdin）与回复方向（`server/bridge-client.ts` 读子进程 stdout）共用该分帧器。分帧器按块累积、每完成一帧只拼接一次，并在流结束时刷出尾帧，避免多 MB 大帧重复拷贝。
- `server/bridge-client.ts` 的 `describeIgnoredFrame()` 对无法解析为协议对象的 stdout 行仅向 stderr 记录字符数与 SHA-256 前 12 位十六进制摘要，跳过该行并保持桥接存活（dsh 自身也会向 stdout 输出日志）。
- `describeNullIdResponse()` 对桥接返回的 `id: null` 错误响应仅向 stderr 记录数字错误码，不输出 `error.message`。
- `server/jsonl-frames.test.ts` 覆盖 `U+2028`/`U+2029` 保留在帧内、CRLF、跨块拼接与 `flush()`；`server/bridge-client.test.ts` 覆盖非协议行与 `id: null` 错误响应的脱敏诊断。

## 考虑过的其他做法

- **只在写入侧转义 U+2028/U+2029**（`JSON.stringify(...).replace(...)`）：能绕过当前触发点，但读取端仍不符合 JSONL 规范，请求与回复两侧任一写入路径遗漏就会再次拆行——放弃，直接修正分帧规则。
- **改用 socket 或额外 stdio fd 传输协议**：能同时隔离「其他写入者插进帧中间」的风险，但要改启动参数、清理路径与 profile 契约，超出本次证据范围（实测字节证明帧本身完整合法，只是被拆行而非交错）——不做。
- **给 `session.open` 单独加长超时**：34 条丢弃日志均出现在超时之前，失败与耗时无关，加长只会让超时晚发生——放弃。
- **解析失败时把原始行写进日志排障**：正是本次要消除的正文与凭证泄露路径——放弃，只保留长度与摘要。

## 后果

- 含 `U+2028`/`U+2029` 的提示词、工具输出与历史会话可正常收发和回放；其余会话行为不变。
- Daemon 日志不再带出协议负载正文或 `JSON.parse` 输入片段，排障时通过「字符数 + SHA-256 摘要」或数字错误码定位。
- 未覆盖真正的跨写入者字节交错（本轮无证据也无复现）；若日后出现，应改为独立传输通道，而非在读取端做容错拼接。
