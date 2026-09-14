# archived — 冻结的归档区

本目录是封存的历史快照,**不是现行权威**。封存后正文一个字不动。

- 归档一次只允许四种动作:整文件迁入 `archived/{kind}/`、在 `Status: implemented` 下一行插入 `Archived: YYYY-MM-DD`、修复指向它的入链、跑 `npm run verify-archived-agent-notes --write` 封存进 `manifest.json`。
- 此后不编辑、不重排、不移动、不删除;出链不检查(历史快照允许死链,以入链修复为准)。
- `manifest.json` 逐文件记 sha256,append-only:改动已封存内容、删除条目、漏封存新文件,门禁都会拦。
