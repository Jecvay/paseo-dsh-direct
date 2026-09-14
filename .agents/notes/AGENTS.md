# notes — 决策记录

本目录是 agent 写的 RFC:为什么这么做、放弃了什么、怎么算做完。一件事一个文件。

- **目录即状态 × 分类**:`{lifecycle}/{kind}/yyyy-mm-dd-<标题>.md`——lifecycle 说时态(proposed 打算做 / implemented 已做完 / rejected 决定不做 / archived 冻结),kind 说性质(六类见 [README.md](README.md) 分类表)。空白上下文的 agent 看路径就知道时态与性质。
- **每篇新笔记触发 supersession 检查**:先查旧账,已有笔记覆盖该决策就更新它,不建重复;要推翻一个决策,写新笔记 supersede 并交叉链接,不改写旧笔记。
- **archived 是冻结快照,不是现行权威**;需要引用可以链接进去,结论以现行记录为准。

规则全文见 [README.md](README.md);检查:`npm run verify:notes`。
