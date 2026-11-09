# PR #93：让 Paseo 展示 DSH 子代理

## 问题与范围

[PR #93](https://github.com/Jecvay/paseo-dsh-direct/pull/93) 为 DSH 子代理接入 Paseo 原生轨道、详情面板和父时间线启动卡片。目标分支是 `main`，审查基线为 `31e25a39856077afe83475f7bbd4f2c60b495725`，原始候选为 `a2e46ce6e39e32f97a496361a4e901c7ef2822b9`。

本次直接续办 PR，不创建或重开普通 issue。桥接与呈现适配属于插件职责；保留 Direct Provider、server/client/shared 边界与 Paseo `>=0.11.0` 下限。共享桥协议增加可选子会话快照和通知，正式合并与发布仍须本人批准。

## 三路证据

核对日期：2026-11-09。独立调研与四路 simplify 均针对同一原始候选，随后对修订另做独立 code review。

- 官方：[Paseo Provider 文档](https://paseo.sh/docs/plugins/providers.md) 说明 `session.subsession` 协商、`restoration: "parent"` 与父会话关联；开发 SDK 固定为 `@getpaseo/plugin@0.14.0`。DSH 已安装版本为 `0.2.2-rc.1`。公开文档没有保证 DSH 内部事件格式，不能把 npm 版本存在当作 `subagent/catalog`、`subagent/descriptor` 或 fork 序号语义的验证。
- 社区：[ACP 子会话提案](https://agentclientprotocol.com/rfds/subagents) 强调显式身份、先宣布再投递与恢复顺序。它提供设计参考，具体协议仍以 Paseo 为准。搜索所得社区工单摘要仅作为待查线索，不据此认定本仓存在缺陷。
- 本项目：[历史 issue #11](https://github.com/Jecvay/paseo-dsh-direct/issues/11) 的前提是 DSH 提供子会话生命周期，不从桥侧猜测子会话边界。该 issue 已关闭；本 PR 使用原生父 ID、catalog 和子会话快照。当前实现与[服务端架构](../../../docs/server-architecture.md)的桥接/投影职责一致，无需客户端新增运行时。

## 实现与修订

`BridgeService` 从原生创建事件追踪后代会话，裁掉 fork 的继承前缀，恢复时读取持久子会话快照。Provider 把这些事件送入独立 `TimelineProjector`，在准入后发出 Paseo 子会话事件；没有协商能力时保留父启动卡片。根会话仍独占用量读数。

本轮修订：

1. 恢复子历史前核对快照自己的 ID 与直接父 ID。父事件只提供待查询 ID，持久会话头才确认归属。
2. 添加父 ID 不匹配时拒绝导入的回归测试。
3. 用 `childSessionId` 表达关联状态，移除重复的 `matched` 标志；精确绑定后释放临时调用记录，终态无子会话的调用也不继续等待。
4. 准备版本 `0.2.17`、锁文件与 changelog，保留贡献者原始实现与署名。

四路 simplify 的其余意见：结果解析和元数据扫描可进一步复用，但两层目前处理不同输入形态，暂不为了减少几行扫描扩大跨层依赖。未绑定子会话的事件缓冲、后代历史规模与图片并发仍无显式预算；本次没有声称这些边界已经解决。

## 验证与剩余工作

修订后的构建、四个 TypeScript target、测试、notes/docs 门禁及 diff 检查均需针对最终提交重跑。原始候选的 GitHub CI 已通过；修订推送后须等新的 CI 完成事件。

本轮单元测试覆盖实时子会话、历史回放、旧宿主降级、同名并发、启动回滚、external 过滤、失败工具结算和持久父 ID 校验。作者在 PR 提供 Paseo 0.15.3 Web 截图与 Docker E2E 说明；这是作者证据。本轮不把它当成自己重跑过的结果。

真实 Paseo 0.14 集成测试依赖的固定运行时包在当前环境不可用；移动端原生设备、多层恢复、取消级联与无界缓冲场景没有完成验收。进一步的真实 DSH 结果若取得，在 PR 总结注明版本与覆盖范围。

## 替代方案与回退

只改父工具卡不能提供子代理详情；另造客户端轨道会重复宿主能力并增加跨端维护成本。提高宿主下限无证据必要，因此使用能力协商降级。

候选未合并、未发布，不改变用户现用插件。撤回候选无需迁移用户数据；后续正式发布通过现有 Publish 工作流，并以当前完整 HEAD、版本和目标分支另请本人明确批准。
