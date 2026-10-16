# Issue #2 根因深化：对照 ZCode 侧边栏实现的调研

- 关联：[#2](https://github.com/Vincent-chk/dsh-plugin-auxiliary-chat/issues/2)
- 对照源码：`zai-org/ZCode` @ `aac4755`（2026-10-10，main）
- 本文档回答两个问题：①根因到底在哪一层；②ZCode 的侧边栏为什么结构性地不可能出这个 bug。

## 1. 已确立的事实链（简述）

访问左侧列表的 `[辅助]` 会话 → 座位 `scope:'session'` 切换 → 宿主回收主会话的 tab occurrence
（`TabDomain.sync` 对"从已提交布局中消失的记录"执行 `occurrence.controller.abort()`，
`dsh-client-ui-sidebar-right/lib/client.js:6064-6070`）→ 插件把 abort 当成用户关闭：

- `src/client/store.ts`（改造前 :364-371）— `signal.abort → closeTabSession(tabId, 'tab closed')`
- `src/client/store.ts`（改造前 :772-774）— `closeTabSession` 对未确认关闭执行 `deps.dispose(sessionId)`（真销毁）
- `src/host/dispose.ts:154-172` — `deleteAuxArtifacts` 末步 `detachFromWorkspace → workspace.detachSession`
- 宿主分组（`dsh-client-ui-workspace/lib/client.js:437-439`）：不在任何 `workspace.sessionIds` 里的会话落入「未分组」

宿主侧"用户关闭"的权威通道只有 `registerCloseHandler`；`signal` 表达的是 occurrence
生命周期，不表达用户意图。

## 2. 根因的三层结构

**L1 直接层（误接线）**：`signal.abort`（实例回收）被等同为「用户关闭标签」→ 触发销毁。

**L2 设计层（资源所有权放错位置）**：辅助会话这个**领域资源的生命周期被绑定在 UI 实例
（tab occurrence）上**。资源由视图树持有，视图的任何回收（布局重算、scope 切换、包卸载）
都会顺带杀死资源。宿主座位语义（occurrence 可随时回收）泄漏进了领域生命周期。

**L3 结构层（列表成员资格由生命周期副作用维护）**：会话在左侧列表的归属
（workspace 成员资格）不是一份独立权威事实，而是销毁流程的副作用（detach）+ 归档桥
（archived 标志 + 回合期间解档）拼出来的。任何销毁/刷新竞态都会把"中间态"暴露成
「未分组」残行；回合期间可见的 `[辅助]` 行本身也是同一类问题的温和版本
（可见性派生自运行态，而非用户意图）。

## 3. ZCode 侧边栏架构调研（源码证据）

### 3.1 三层状态权威，行存在与运行态彻底分离

`docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`（"V4 左侧任务状态权威收敛设计"）
与 `2026-07-20-sidebar-task-row-authority-design.md`（"行存在权威收敛设计"）规定：

```text
Host tasks-index.sqlite ──────────────> TaskListRowState -> Sidebar
  行集合 / pin / archive / delete / group / unread / 显式排序
sessions-index（实时投影）──只做字段级 enrich──> 命中的行
  phase / lastActivityAt / attention / 实时标题
Renderer（Zustand）──只留导航态
  activeTaskId / navigation / draft / local UI
```

关键不变量（07-20 文档 Boundary decisions）：

- 持久行存在：`tasks-index` list 结果是**正向权威**——"不由 sessions snapshot 缺失推断删除"；
- 用例 **TSL23-A**：行在 tasks-index、summary 缺失 → **保留静态行**，不消失；
- 负向可见性：只有 `deleted` tombstone（最高优先级），且"不物理删除 CLI transcript"；
- 实时字段只 enrich，"不覆盖 membership/sort/unread"。

### 3.2 右侧栏 tab 是纯状态；关闭 tab 是纯函数

`packages/ui/src/lib/workspaceSidePane.ts:2173` — `closeSidePaneTab()` 只做一件事：
从 `tabs` 数组里删掉记录并选好 fallback 激活项。**没有任何会话操作、RPC 或副作用**。
销毁是调用方按 tab 类型显式附加的（见 3.4）。

### 3.3 资源所有权在视图树之外；「卸载 ≠ 销毁」是成文规则

`packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts:1-5`（注释原文）：

> 如果 xterm、PTY 与订阅由 TerminalSession 组件持有，切换 workspace 触发的卸载就会关闭进程并丢失历史。
> 由模块级 registry 持有这些资源，组件只负责挂载显示，可以让终端会话跨 workspace 切换继续存活。

`packages/ui/src/terminal/TerminalSession.tsx:110-112`：`persistentKey` 路径下
"组件卸载只 detach DOM、不 dispose；重挂按 key 复用"。
`useAppPanels.ts:1439`：**保活注释**——"显式关闭 terminal tab 必须真回收 PTY/xterm
（registry 常驻，不会随卸载自动回收）"。

辅助对话同理：会话本体在 CLI session service 里，UI tab 只持有 id
（`SelectionSideChatPaneTab.childSessionId / parentSessionId / workspaceKey`）。
切换只是 `setActiveSidePaneTab`（改 activeTabId，纯状态），切回来按 id 重新绑定——
**tab 记录从未离开状态**，所以重绑永远有依据。

### 3.4 销毁只有两条显式路径，全部是领域事件，没有视图事件

`packages/ui/src/hooks/useAppPanels.ts`：

1. **用户点 ×**（`handleCloseSidePaneTab`，:1428 起）：对 `selection-side-chat` 类型显式调
   `closeSelectionSideChatRuntime(tab)` → `zcodeSessionService.closeSession({sessionId: tab.childSessionId})`；
2. **父任务结束**（`subscribeTaskLifecycle`，:1211 起）：父 task 终态事件到达时，关闭其名下所有
   `selection-side-chat` tab 并逐个 `closeSelectionSideChatRuntime`。

没有挂组件卸载、没有挂标签切换、没有挂布局重算。`closeSession` 只是停 runtime
（`zcodeTaskServiceAdapter.ts:2646` 注释；即便 `closeTask` 也只是关会话+打 tombstone
overlay，不物理删记录）。

### 3.5 「未分组」是一等公民，不是残渣桶

`docs/ui/task-grouped-view.md:3`：Grouped 视图把"用户自定义跨 workspace task group 和**未分组
task** 放在同一个混排列表里"；`:228`："未分组 task 也需要顶层用户排序"。即：无组 =
一种**显式持久的排序事实**，由 tasks-index 拥有，与任何会话生命周期无关。

### 3.6 辅助对话不进左侧任务列表：靠投影，不靠隐藏

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/task-list-session-membership.ts`：
左侧列表可见性由 `taskType ∈ {interactive, fork, workflow_parent}` 投影决定；注释明确
"辅助对话、subagent 与 workflow child 继续由各自专用投影承载"。所以 ZCode **不需要**
"归档隐藏 + 运行期解档"这类桥——列表从定义上就不含辅助对话。

### 3.7 重复打开 = 聚焦已有

`workspaceSidePane.ts` `openSelectionSideChatPane()`：按
`(workspaceKey, parentSessionId, childSessionId)` 查重，存在则激活原 tab，不新建。

## 4. 逐点对照

| 维度 | ZCode | 本插件（改造前） | 后果 |
| --- | --- | --- | --- |
| 关闭 tab 的语义 | 纯状态删除；销毁由调用方显式附加 | `signal.abort` ⇒ 直接销毁会话 | 看一眼 = 关掉并销毁 |
| 会话资源所有权 | CLI session service / 模块级 registry，UI 只持 id | 生命周期绑在 tab occurrence 上 | 实例回收 = 资源死亡 |
| 卸载/切换 | 只 detach，重挂按 key/id 复用（成文规则） | abort 即 dispose，重挂只能 reclaim 残骸 → ENDED | 辅助会话失效 |
| 销毁触发者 | 仅用户 × 与父任务终态（领域事件） | 任何 abort（视图事件） | 间歇性、难复现 |
| 左列表行存在 | tasks-index 正向权威；summary 缺失不删行（TSL23-A） | 会话销毁的副作用（detach）改变归属 | 「未分组」残行 |
| 负向可见性 | 显式 `deleted` tombstone，且不删 transcript | 无 tombstone 等价物，靠"删得够快" | 竞态窗口暴露中间态 |
| 未分组 | 一等公民，持久 sortOrder | 生命周期残留桶 | 幽灵行无解地难看 |
| 辅助对话的列表可见性 | taskType 投影，从定义上排除 | archived 标志 + 运行期解档桥 | 回合期间漏出 `[辅助]` 行 |
| 父会话结束 | 显式关闭子辅助会话 | 无对应钩子 |（次要差距）|

## 5. 对照后的根因结论

L1 表述（abort 误当用户关闭）正确但只是症状。对照 ZCode 后，根因应表述为：

> **辅助会话的资源所有权被放进了视图树，且左侧列表的成员资格由生命周期副作用维护。**
> 在这个结构里，"宿主回收 tab 实例"（平台正常行为）必然传导为"销毁会话 + 改写列表归属"，
> 区别只是触发时机——所以它表现为间歇、难复现的 bug。ZCode 用三个结构性手段让同类问题
> **不可表达**：资源在视图树外（卸载只 detach）、销毁只认领域事件（用户 × / 父任务终态）、
> 行存在由持久索引正向拥有（运行态永远无权删行）。

## 6. 修复方向

1. **occurrence 释放 ≠ 销毁**：`signal.abort` 只清内存 runtime 与绑定提示，会话保留；重挂走
   `readBinding → reclaim`。
2. **销毁只认显式意图**：用户关闭（`registerCloseHandler` / 面板关闭按钮）→ dispose；
   可选追加主会话终态收割（需上游事件面）。
3. **残行与可见性**（平台约束为长期项）：dispose 保持 detach-LAST 之外，向上游诉求
   "列表行存在与运行态解耦 + 负向可见性（tombstone/事件）"。

## 7. 引用清单（ZCode @ aac4755）

- `docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`
- `docs/superpowers/specs/2026-07-20-sidebar-task-row-authority-design.md`（TSL23-A、tombstone、行存在权威）
- `docs/ui/task-grouped-view.md`（未分组=显式排序事实）
- `packages/ui/src/lib/workspaceSidePane.ts`（`closeSidePaneTab`:2173 纯函数；`openSelectionSideChatPane` 查重）
- `packages/ui/src/hooks/useAppPanels.ts`（`handleCloseSidePaneTab`:1428、父任务终态清理:1211、保活注释:1439）
- `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts` / `TerminalSession.tsx`（卸载≠销毁成文规则）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/task-list-session-membership.ts`（taskType 投影）
- `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`（`SESSION_TASK_TYPES` 含 `selection_side_chat`）
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:2645-2658`（closeTask=tombstone，不删 transcript）
