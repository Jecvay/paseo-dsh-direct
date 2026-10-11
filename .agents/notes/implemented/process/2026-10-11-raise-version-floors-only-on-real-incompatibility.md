# 决策记录: Paseo 与 dsh 的最低版本只在真不兼容时提高

Status: implemented

## 问题

每提高一次 Paseo 或 dsh 的最低版本，就有一批用户被迫先升级宿主或 dsh 才能拿到插件的修复。用户反复升级很烦，而下限一旦提高就很难再降：清单只有一份，没法按宿主版本给出不同写法。

## 决定

- **Paseo 下限**只在两种情况下提高：
  - 插件离不开的宿主能力在旧版本里不存在。
  - 插件的核心展示在旧版本上会导致安装失败。
  
  提高之前，先在旧版本的 daemon 源码或实测里确认确实不行。当前下限 `>=0.11.0` 属于第二种：清单的 `name` 与 `icon` 是插件在 Paseo 里的名字和图标，Paseo 0.8 至 0.10 的清单校验遇到这两个字段会拒绝安装（[0.11 下限的决策](../architecture/2026-10-10-raise-paseo-floor-to-0-11-for-name-icon.md)）。
- **新用到的宿主能力在旧宿主上要能降级**：只用来锦上添花的能力（如 `command`、`status()`、`launch`、`session.usage`）不构成提高下限的理由。
- **dsh** 不设线内下限：
  - 插件 `major.minor` 跟随 dsh 线（[版本线决策](../architecture/2026-09-28-version-line-follows-dsh.md)），线不一致只警告不拦截。
  - 真正拒绝启动的只有握手缺少必需的服务与方法。
  - 新用到的 dsh 服务做成可选（如 `sessionProjections`：没有就不上报用量），线内不要求更新的 rc 或 patch。
  - dsh 跨 `major.minor` 的不兼容用分支承接：旧线在 `release/<major.minor>` 上继续发 patch，不强迫用户升 dsh。

## 考虑过的其他做法

1. **跟随最新宿主，每次用到新能力就提高下限**：代码最简单，不用写降级分支；但每次都逼一批用户升级。否决。
2. **为保最低下限放弃名字和图标，退回 `>=0.8.0`**：0.8 至 0.10 的用户也能拿到之后的修复；但所有 0.11 用户在插件列表里只看到 `paseo-dsh-direct`、没有图标。名字和图标是插件身份的一部分，否决，保留 0.11。
3. **按 dsh 版本号精确限制**：每个组合都有实测背书；但 dsh 预发布节奏快，限制会频繁过期，挡住本可用的组合。[版本线决策](../architecture/2026-09-28-version-line-follows-dsh.md) 已否决。

## 后果

- 提高任何下限前，要拿出旧版本确实不可用的证据，并写进决策记录。
- 用新的宿主或 dsh 能力时，多写一条「没有它时怎样」的路径，并在测试里覆盖。
- 停在 Paseo 0.8 至 0.10 的用户停在 `npm:paseo-dsh-direct@0.2.1`；这是为名字和图标付出的代价。

## 怎么验证的

解包 `@getpaseo/server` 与 `@getpaseo/plugin` 的 0.7.2、0.8.0、0.9.2、0.10.3、0.11.0、0.11.2 核对：

- 0.7.2 没有 `registerProvider`。
- 0.8 至 0.10 的清单对未知字段 `.strict()`，因此拒绝 `name` 与 `icon`。
- 0.8 至 0.10 在序列化 provider 元数据时只取 `id`、`label`、`description`、`iconPath`、`hasCatalogCacheKey`，`command` 与 `status` 被丢掉而不报错；`connect` 请求不带 `launch`，插件回退到 `PASEO_DSH_EXECUTABLE` 和 `PATH`。
- `session.usage` 自 0.8 起被宿主接受。
- 插件声明的 capabilities 都在 0.8 的列表里。

只读源码，未在 0.8 至 0.10 的 daemon 上实测。
