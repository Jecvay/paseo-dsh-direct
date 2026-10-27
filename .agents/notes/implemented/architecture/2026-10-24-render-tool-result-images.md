# 决策记录: 把工具结果里的图片渲染成助手消息

Status: implemented

## 问题

DSH 的 `read_image` 把图片放在 `tool/result` 事件的 `content` 里，是一个带 `attachment` 的 `image` block。插件只读同级的文本 block，图片被丢掉。所以在 Paseo 里看不到图，卡片也没有打开原图的入口。

Paseo 自带的 Claude 和 Pi provider 会渲染这类图片：它们把图片转成一条 `assistant_message`，text 是 markdown 图片，前端据此显示内联大图和「在新标签页打开」。

## 决定

桥接进程负责把图片写到磁盘，插件进程负责发消息。

**桥接进程侧**（新增 `server/dsh/tool-images.ts`）：

1. 从 `tool/result` 的 `message.content` 里挑出 `type: "image"` 的 block，保持原顺序。只接受严格的 `sha256:<64 位小写十六进制>` 和已知的 `mediaType`，`bytes`、`width`、`height` 必须为正。
2. 用 `ctx.get("attachments").readImage(ref)` 读字节。它会重新校验 digest、大小和尺寸；直接拼磁盘路径会跳过校验，也假定了一种 profile 可以改的存储布局。
3. 写到 `<缓存目录>/<sha256hex>.<ext>`，扩展名按 `mediaType` 定。目标已存在且大小相符时复用，不再读 store。
4. 先写同目录的临时文件再 `rename`，避免并发读到半截文件。目录 `0700`，文件 `0600`。

**传输**：`session.event` 通知加必填字段 `images: ToolImageOutcome[]`。每张图的结果是 `ready`（带路径）、`failed`（带错误码）或 `unavailable`（profile 没有 `readImage`）。

**顺序**：图片写盘是异步的，而 `provider.ts` 依赖「通知先到、RPC 响应后到」。桥接进程的全部出站消息改走一条有序链，通知在链上等图片写完再写，响应排在它后面。字段传 `Promise`，由出口 `await` 掉再序列化。

**插件侧**：`images` 里每张 `ready` 的图片生成一条 `assistant_message`，text 是 `\n\n![名字](file:///路径)\n\n`，item id 和 `messageId` 都用 `tool-image:<事件 seq>:<block 下标>`，重复回放落到同一行。`failed` 生成警告通知，`unavailable` 跳过。

## 考虑过的其他做法

1. **对照 `paseo-attachments` 目录名和 64 位哈希文件名的正则**：那是 Claude provider 做历史回放筛选用的，Direct Provider 的输出不经过它。复刻它只会增加无谓的约束。
2. **直接读 `<dshHome>/attachments/v1/objects/<前两位>/<hash>`**：省一次服务调用；但 `attachment-local` 有自己的 `dshHome` 配置，子进程环境也可能覆盖，而且绕过校验。
3. **用 `imageHostPath(ref)` 拿路径**：返回的是无扩展名的对象文件，而 Paseo 的文件服务按扩展名判断是不是图片，建软链也解决不了；非本地存储时它还返回 `undefined`。
4. **放到 `os.tmpdir()`**：Paseo 0.12 的时间线在内存里，daemon 重启后靠回放重建。系统清临时目录会让旧行变成坏图，所以改用稳定的每用户缓存目录。
5. **在插件侧用异步队列等图片**：会让响应越过排队中的通知，回合被错记成自动回合。顺序只能由桥接进程的唯一出口保证。
6. **把 `images` 放进 `tool_call` 的 detail**：Paseo 的 `ProviderToolCallDetail` 没有图片字段，而那套类型在插件侧是只读契约。

## 后果

- 图片文件落在 `$XDG_CACHE_HOME/paseo-dsh-direct/images`（未设置时 `~/.cache`），进程重启后目录还在，同一张图按内容哈希复用，不会重复写。
- 旧版 DSH 没有 `readImage` 时，图片结果是 `unavailable`，界面上不显示图，回合照常进行，不报错。
- 图片失败不影响工具卡片结算，也不影响同批其他图片。
- 时间线里每条图片是一个普通助手消息，所以「在标签页打开」的标题是哈希文件名，与 Paseo 自带的 Claude 图片一致。
- `protocolVersion` 保持 1：桥接进程和插件进程同包发布，不跨版本通信。
