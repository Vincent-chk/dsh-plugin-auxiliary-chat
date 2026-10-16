# 上游接缝需求（提交给 DSH 官方）

> 来源：《DSH 辅助会话插件体验改造规划 v2》P3/WP3.3。
> 现状：本插件用公开接缝模拟"临时辅助会话"，其中两条体验差距在插件内**无解**，
> 根因是宿主把"可见性"与"可运行性"耦合、且会话没有一等临时身份。本文是需求规格，
> 插件侧已备好切换实现（`src/host/hide.ts` 的 `HideChannel` 接口，`native` 实现位）。

## S1 · 会话元数据：列表隐藏但完全可运行（最高优先）

**问题**：宿主唯一的行级隐藏通道是 workspace 归档集，而 `ArchivedSessionGate` 对归档会话的
`agent/pre-step` 直接 reject。插件要让它跑就必须回合起步时解档、空闲时重归档 —— 左栏会话列表
因此每回合插入再删除一行 `[辅助]`（闪烁与回合锁相，用户实测报告）。理想的对等能力是
存储层会话类型 + 索引静态过滤，与运行时完全解耦。

**需求**：会话元数据增加 `visibility: 'normal' | 'hidden-temporary'`（或等价标志）：
- 列表、搜索、@候选、计数派生时排除 `hidden-temporary`；
- **不得**影响 `agent/pre-step` 门禁与任何运行能力；
- 提供客户端服务面（建议名 `sessionVisibility`，方法 `hideFromLists(id)` /
  `revealInLists(id)`），供插件在创建/销毁时调用；
- 持久化，重启后仍隐藏。

**切换**：接缝到位后本插件配置 `hideChannel: 'native'` 即切换；`HideChannel` 接口保证零重构。
验收：每回合列表行插入+删除计数 = 0（现值 1+1，e2e 断言已就位）。

## S2 · 行级隐藏插槽（备选/补充）

若 S1 的元数据改动过大，退而求其次：`dsh-client-ui-workspace` 的行过滤器 `sessionVisible`
开放扩展点（插件可贡献谓词），同样要求"只影响可见性、不影响可运行性"。

## S3 · 错误码 → 用户文案映射层

**问题**：宿主错误以技术文本直达界面（本插件曾被迫上桌 "sessions.fork 未装配" 一类文案）。
**需求**：公开错误携带稳定错误码（如 `dsh/session/fork-unavailable`），并提供宿主级本地化
映射表；插件只渲染映射结果与兜底句。

## S4 · 关闭处理器否决契约的日志口径（复核后新增，2026-10-16）

**问题（已实锤）**：`ISidebarRight.registerCloseHandler` 的调用是同步的，处理器返回值被忽略
（`removeAfterCleanup`：`handler(sessionId, tab); commit()`），因此"抛错=保留标签"是**唯一**的
否决通道——本插件静默关闭协议正是靠它实现"先销毁后移标签"。但宿主 UI 路径在自己的
`closeTab` 包装里 `console.error("Sidebar tab close failed:", error)`，于是每次合法否决都会在
控制台打一条错误级日志（用户界面不可见，但污染诊断输出且容易被误读为故障）。

**需求**：其一，对处理器抛错按契约语义降噪（warn 级或可识别的 veto 类名跳过）；其二（更优），
给处理器一个显式否决返回值或 Promise 语义（如返回 `{ keepOpen: true }` 或 await 后视结果
commit），让"清理先于移除"不再必须走异常通道。

## 长期愿望（记录，不阻塞）

- 事件级 `uiVisibility/providerVisibility` 投影标志；
  到位后本插件的 form-A 隐藏消息注入可升级为结构化继承。
