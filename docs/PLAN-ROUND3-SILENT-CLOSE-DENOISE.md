# 第三轮改造规划：静默关闭去噪（removal-first 协议）+ sidebarRight 解耦上游议题

> 2026-10-16 · 依据二轮复核实锤的两个问题（REVIEW-REFACTOR-2026-10-16 §复核补遗 ①②）
> 本文档先给根因（带宿主源码证据），再给任务拆分与逐项验收标准（AC），最后执行。

## 一、根因（已在宿主包源码中钉死）

### 问题①：禁用官方右栏后一切右栏座位消失（AC-U-05 平台偏差）

- **证据**：`dsh-client-ui-chat/lib/client.js` 的 `const inject = [...]` 硬声明 `"sidebarRight"`；
  全宿主共 **10 个客户端包**同样硬注入：ui-chat、deliverables、plan、reference、schedule、
  sidebar-browser、sidebar-files、sidebar-terminal、skill、subagent（服务提供者只有
  `dsh-client-ui-sidebar-right`）。
- **消费面实锤（本轮新增）**：ui-chat 对 `ctx.sidebarRight` 的全部消费只有 3 处
  **可选的链接打开便利**（`openResource(url)`、`openTab("browser")`，client.js:12426–12436）
  外加一处 `scope.sidebarRightTabs` 读取——会话 UI 本体并不需要该服务即可渲染。
  硬注入导致：官方右栏 bundle 一禁用 → 服务永不注册 → 10 个 entry 永久 pending →
  会话 UI、`conversation.session.header.utilities` 座位（Path A 开关所在地）全部不挂载。
- **结论**：插件侧无法修复（inject 声明在宿主包内）。处置 = WP-B 上游议题草案
  （建议：将 `sidebarRight` 改为可选解析 `ctx.get('sidebarRight')` 守卫调用），
  插件侧维持文档化偏差记录。

### 问题②：每次合法关闭都产生一条 error 级控制台噪声

- **机制（宿主源码逐行钉死）**：
  1. 用户点标签 X → 座位注入的 `closeTab(tabId)`（sidebar-right client.js:9175–9180）
     → `try { controller.closeIn(sessionId, tabId) } catch { console.error("Sidebar tab close failed:", …) }`；
  2. `closeIn` → `removeAfterCleanup`（:6439）：`closeHandlers.get(kind)?.(sessionId, tab); commit()`
     ——**同步调用、返回值被忽略**；handler 抛错 = `commit()`（真正移除标签）被跳过，错误上抛；
  3. 我们按官方契约（"Failure preserves the tab"）用 `throw CloseVetoError` 保留标签，
     于是**每一次合法否决都被宿主按 error 级记录**。插件侧无法在 veto 协议内消除。
- **修复思路（插件侧可落地，WP-A）**：改用 **removal-first 协议**——关闭处理器
  **永不抛错**：同步启动后台 dispose 并正常返回 → 宿主在同一 tick 内 `commit()` 移除
  标签（与官方自带标签的关闭体感一致）→ dispose 在后台
  完成（销毁 + 归档清理）。veto 通道从此不再使用 → 噪声归零。
- **附带收益**：
  - 换路径修复另一个隐患：`place()` 的 `replaceTab` 路径同样调用我们的 close handler
    且**没有 try/catch 包裹**——旧协议下其他插件以 replaceTab 替换辅助标签时我们的
    veto 会炸掉对方的 openTab；新协议永不抛错，该隐患一并消除。
- **代价与决策**：
  - dispose 从"先于移除"变为"后台收尾"。失败时标签已消失，无法再原地展示
    closeFailed 卡片 → 生产路径失败改为**同 operationId 自动重试一次 + console.warn**
    （宿主侧 `/aux-end` 对部分失败的第二调用会经 not-registered/marker 收敛）；
    卡片保留为非标准宿主下的防御性 UI（copy 不变，copy-gates 不动）。

## 二、任务拆分与验收标准

### WP-A 关闭协议改造（store.ts / index.tsx）

- A1 `handleTabClose` 永不抛错：closing/closed 相位放行；无 sessionId（creating/
  failed/ended）放行；ready/closeFailed → `void startClose()` 后放行。删除
  `CloseVetoError` 与 `bypassNextClose`（协议尾部 closeIn 由 closed 相位守卫放行）。
- A2 `startClose` 失败路径分支：runtime 已不存活（生产路径，标签先走）→ 以同一
  operationId 延迟重试一次；仍失败 → `console.warn('[aux-chat] …')` 终态记录。
  runtime 仍存活（防御路径）→ 维持现有 closeFailed 卡片行为不变。
- A3 看门狗：runtime 已不存活时补一条 warn（后台关闭仍挂起的可观测性）。
- **AC-A1** race-check：`handleTabClose` 在 ready/creating/closing 全相位下同步正常
  返回（无抛错断言）；并发 10 次手势仍恰好一次 dispose（C05/C14 不回归）。
- **AC-A2** race-check 新增 C17（真实时序仿真）：手势返回后立即 abort（模拟宿主同
  tick 移除标签触发的 unmount）→ dispose 仍在后台完成、binding 清除、无重复 dispose、
  无抛错。
- **AC-A3** race-check C06 更新：dispose 一次失败后，生产时序（runtime 已走）自动重试
  同一 operationId 且收敛；C07 看门狗在 runtime 已走时 warn 而非崩溃。
- **AC-A4** 既有不变量全部保持：C01–C04、C08、C10–C13、C15、C16 原语义通过。
- **AC-A5** typecheck 通过；`scripts/verify.mjs` 快速门禁全绿。

### WP-B visual 真浏览器验收：零噪声 + 即时消失

- 新场景 `silent-close-noise.mjs`：真实标签 X 关闭 → 断言
  1. 标签在交互后即时消失（不再出现 closing 卡片 DOM）；
  2. puppeteer 捕获的控制台**无** `Sidebar tab close failed` 且无任何 error 级 aux 行；
  3. 会话行不残留（归档清理照旧）。
- **AC-B1** 新场景全绿；core-journey / real-roundtrip / multi-unread 不回归。

### WP-C 上游议题草案（docs/UPSTREAM-ISSUES.md）

- C1 `sidebarRight` 硬注入解耦（含 10 包清单、ui-chat 消费面证据、建议修复）。
- C2 close-veto 契约降噪（S4 引用：合法否决不应呈现为 error 日志；建议返回值语义）。
- **AC-C1** 每份草案含：复现步骤 / 根因证据（包+行号）/ 影响面 / 建议修复 / 对本插件
  的意义；与 SEAM-REQUEST 交叉引用。

### WP-D 文档与提交

- REVIEW-REFACTOR 增补 §6（第三轮）；DESIGN-NOTES 台账 v5；SEAM-REQUEST S4 标注
  "插件侧已绕开，上游仍建议修复"；README 如有需要同步。
- **AC-D1** 全量门禁：verify（含 copy/copy-truth）、race、drop、mirror、hide-channel、
  integration、e2e-isolated ×2 连续全绿、visual 受影响场景全绿。
- **AC-D2** 自我代码审查（diff 全读 + 逐 AC 核对）后提交推送 `refactor/ux-polish-v2`。

## 三、风险与对策

| 风险 | 对策 |
| --- | --- |
| removal-first 后 dispose 永久失败 → 会话归档残留 | 同 opId 自动重试 + warn；宿主重启代际清扫兜底（已有 sweep） |
| 关闭瞬间 closing 卡片闪一帧 | 同一 React 事件内宿主移除与我们 phase 翻转合并提交，理论无帧；visual 场景显式断言卡片不出现 |
| 旧测试语义（veto）失效 | race-check 同步改造，不变量编号保持 |
