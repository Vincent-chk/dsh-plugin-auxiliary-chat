# DSH 上游议题草案（第三轮调研产出）

> 2026-10-16 · 依据：PLAN-ROUND3 根因调研（宿主包源码逐行读证，包版本以本机
> `~/.dsh/profiles/node_modules` 安装为准）。每份草案按「复现 / 根因证据 /
> 影响 / 建议修复 / 对本插件的意义」组织，可直接整理为 GitHub issue。

---

## 议题 U1：`sidebarRight` 硬注入导致禁用官方右栏后 10 个客户端包永不激活

### 复现
1. 在 profile 的 `cordis.patch.yml` 中将 `ui-sidebar-right` 置为 `disabled: true`
   （或任何不装载 `dsh-client-ui-sidebar-right` 的配置）。
2. 启动 `dsh web`，打开任意会话。
3. 观察：主会话聊天区、输入框、会话头部件全部不渲染；控制台可见相应
   entry 永久等待 `sidebarRight` 服务。

### 根因证据（本机安装包源码）
- `dsh-client-ui-chat/lib/client.js`（inject 声明，约 :12258）：
  `const inject = ["slots","sessions","uiWorkspace","uiSession","uiConversation","locale","configForms","remote","remote.session","sidebarRight"]`
- 同样硬声明 `"sidebarRight"` 的包（各包 `lib/client.js` 的 `const inject` 数组）：
  `dsh-client-ui-deliverables`、`dsh-client-ui-plan`、`dsh-client-ui-reference`、
  `dsh-client-ui-schedule`、`dsh-client-ui-sidebar-browser`、
  `dsh-client-ui-sidebar-files`、`dsh-client-ui-sidebar-terminal`、
  `dsh-client-ui-skill`、`dsh-client-ui-subagent`。
- 服务提供者只有 `dsh-client-ui-sidebar-right`（"the shipped right Sidebar"）。
- **关键反差**：`dsh-client-ui-chat` 对该服务的全部实际消费仅 3 处可选便利
  （client.js:12426–12436：`ctx.sidebarRight.openResource(url)`、带行号变体、
  `openTab("browser", …)`）+ 1 处 `scope.sidebarRightTabs` 读取 —— 会话 UI 本体
  渲染并不需要该服务。

### 影响
- 官方右栏一旦被禁用（用户选择精简 UI、第三方栏位插件想让位、无头/嵌入场景），
  聊天区与全部依赖包一起消失，表现为"整个应用坏了"，而非优雅降级。
- 生态位问题：任何想提供"自绘右栏"的插件都无法同时保住聊天区 —— 本插件的
  Path A（自有栏位）在 DSH 0.2.x 上因此不可达（见
  REVIEW-REFACTOR-2026-10-16 §5 AC-U-05 偏差记录）。

### 建议修复（按侵入性递增）
1. 最小：把 `sidebarRight` 从上述包的 `inject` 数组移除，调用点改为
   `const sidebarRight = ctx.get('sidebarRight')` 守卫式可选解析（ui-chat 的
   3 个调用点天然可选）。
2. 进阶：为"侧栏目标面"引入独立于具体实现的服务抽象（如 `navigationSurface`），
   让 chat 只依赖抽象，右栏/第三方栏位都能实现。

### 对本插件的意义
- 修复后 `conversation.session.header.utilities` 座位在无官方右栏时仍挂载，
  Path A（自有栏位 + 单栏模式）即可按规划启用，AC-U-05 偏差可关闭。

---

## 议题 U2：合法的 close-handler 否决被按 error 级日志呈现（S4）

### 复现
1. 任一插件用 `sidebarRight.registerCloseHandler(kind, handler)` 注册关闭钩子，
   并按官方文档语义（"Failure preserves the tab"）在 handler 中抛错以保留标签。
2. 用户点击该标签的关闭。
3. 控制台出现 `console.error("Sidebar tab close failed:", error)` —— 每一次
   **合法且预期**的否决都产生一条 error 级噪声。

### 根因证据（dsh-client-ui-sidebar-right/lib/client.js）
- 座位注入的关闭入口（:9175–9180）：
  `closeTab: (tabId) => { try { controller.closeIn(sessionId, tabId) } catch (error) { console.error("Sidebar tab close failed:", error) } }`
- `removeAfterCleanup`（:6439）：`this.closeHandlers.get(tab.kind)?.(sessionId, tab); commit()`
  ——同步调用、**返回值被忽略**；抛错 = 跳过 `commit()`（保留标签）并把错误上抛。
- 即：**抛错是唯一的保留通道**，而宿主 UI 又把一切抛错按 error 记录。两者叠加，
  "按契约使用否决"与"控制台干净"不可兼得。
- 附加隐患：`place()` 的 `replaceTab` 路径同样经过 `removeAfterCleanup`，但**没有**
  try/catch 包裹 —— 一个插件的合法否决会炸掉另一个插件 `openTab(replaceTab)`。

### 影响
- 遵守契约的插件被迫制造 error 级日志，污染用户控制台与错误监控。
- `replaceTab` 路径的未捕获抛错是跨插件的破坏面。

### 建议修复（按侵入性递增）
1. 最小：把 `console.error` 降级为可辨识的非错误输出（如 debug 级），或对
   `CloseVeto` 语义的错误（可约定 name/标记）静默。
2. 契约化：让 handler 的**返回值**表达意图（如返回 `false`/Promise 保留标签），
   抛错保留为兼容通道；同时给 `removeAfterCleanup` 的 replace 路径补 try/catch。

### 对本插件的意义
- 本插件已在第三轮改为 removal-first 协议（handler 永不抛错）绕开该噪声
  （PLAN-ROUND3 WP-A，visual 场景 silent-close-noise 断言零噪声）；
  但"先清理后移除"的强协议在契约层面仍然不可表达 —— 修复 2 可让强协议
  回归而不产生噪声。

---

## 议题 U3（引用，不在本轮展开）：隐藏且可运行的会话呈现（S1/S2）

`docs/SEAM-REQUEST.md` 的 S1（hide-but-runnable 元数据）与 S2（行隐藏座位）
仍是消除"回合中列表行闪现"（用户报告 G10/WP2.3）的根本途径；U1 的抽象层
若落地，S2 的行位亦可挂在同一抽象上。本插件当前以 archive-bridge + 中闪
断言（e2e G10）记录该缺口。
