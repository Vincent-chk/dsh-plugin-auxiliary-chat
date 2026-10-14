# 已实证 API 参考（不要再自行调研，除非本文件标注「未确认」）

证据根：`/Users/a1-6/.dsh/profiles/node_modules/@deepseek-ai/`（下称 `$PKG`），版本 0.2.0-rc.2。
本文件每条都来自源码/类型定义/实测，出处已标 `文件:行`。**不要凭直觉改这些结论。**

---

## A. 工程约束（硬性）

| 约束 | 说明 |
|---|---|
| 包名一行 Loader 条目 | client-modules 按**包名**建浏览器 row，读 `dsh.client` + `exports["./client"]`；同一包两行会硬失败。**行里只写裸包名，绝不写 `/client`。** |
| client 产物 4 条硬条件 | ①经典脚本首语句 `window.__ModuleLoader__.load({id, factory})`；②`id` === 包名；③factory **必须 `return module.exports`**；④导出 `apply` 与 `inject`。`scripts/build.mjs` 已自动满足。 |
| 平台 seed 表恰好 9 项 | `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。seed 匹配是**整串精确匹配**（`require("react/")` 会挂）。 |
| `dsh.client.external` | 非 seed 的 DSH client 包**必须**写进这里，用 `<pkg>/client` 子路径形式（`stripClientSuffix` 会归一）。 |
| host 半侧禁止 import | `react`、`react-dom`、`@deepseek-ai/dsh-client-*` —— 在 Host 的 Node 侧**无法解析**。 |
| 不要写 `@deepseek-ai/dsh-*` 的 peerDependencies | 会被安装器语义化版本校验拒绝并回滚。只有 `@deepseek-ai/cordis` 可写。 |
| HMR | 改 `lib/client.js` 后 ≤500 ms 浏览器自动热更（client-hmr stat 轮询 mtime/ctime/size），**无需刷新**。改 `dsh.client` 声明或包名需刷新页面。 |
| desktop profile | `dsh plugin --profile desktop` 被 CLI 硬拒（Electron 专属）。只能手改 profile 的 `package.json` + `pnpm install`。**安装由 Lead 统一执行，实现者不要碰 `~/.dsh/**`。** |

---

## B. Host 侧（teammate `aux-host` 用）

### B1. 创建辅助会话（不经过 `ctx.subagents`，避免父日志污染）

```ts
import type { Context } from '@deepseek-ai/cordis'

const handle = await ctx.agents.create({
  sessionId,                       // SessionId（branded string）
  seed,                            // readonly SessionEvent[]，必须从 seq 0 连续
  inheritedEventCount,             // SessionLogOffset = seed.length
  meta: { cwd, isSeeded: seed.length > 0 },   // 注意：不要写 origin，不要写 parentSession
  agentOptions: { provider, model, reasoningEffort, maxTokens? },
  setup: (agentCtx, agent) => { /* 见 B4 */ },
})
```

- `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>` —— `$PKG/dsh-agent/lib/types/index.d.ts:278`
- `AgentHandle = { agent: Agent; dispose(): Promise<void> }`；`dispose()` 契约："stops the loop, awaits its exit, unregisters the agent, **removes its session from the store**, and finally unwinds its scoped world" —— `$PKG/dsh-agent/lib/types/index.d.ts:136-146`
- `CreateAgentOptions` 字段 —— `$PKG/dsh-agent/lib/types/index.d.ts:48-104`：`sessionId`（必填）、`parentAgent?`、`meta?{cwd?,parentSession?,isSeeded?,origin?:'subagent',delegationDepth?,agentPreset?}`、`inheritedEventCount?`、`seed?`、`agentOptions?`、`signal?`、`setup?`
- **关键**：`origin:'subagent'` 或（`parentSession` 指向的父 agent 仍 live）会让 `remote.session.prompt/cancel/rename` 全部返回 `session/agent-busy`（`$PKG/dsh-api-session-controller/lib/types/agent.js:106-122`），且客户端 composer 变只读。**所以辅助会话必须不设 `origin`、不设 `parentSession`。**
- **落盘无法阻止**：`ctx.agents.create` 只要挂了 `sessionPersistence` 就无条件落盘（`$PKG/dsh-agent-loop/lib/index.js:1818-1827`）。靠 B5 的手工删除解决。

### B1b. 只读上下文继承（seed）

```ts
import { buildForkSeed } from '@deepseek-ai/dsh-session'   // $PKG/dsh-session/lib/types/index.d.ts:16

const events = mainAgent.session.snapshotEvents()          // Session.snapshotEvents(fromSeq?, toSeqExclusive?)
const boundary = [...events].reverse().find((e) => e.type === 'turn/end')?.seq
const seed = boundary === undefined ? [] : buildForkSeed(events, boundary)
const inheritedEventCount = seed.length
```

- `Session.snapshotEvents` —— `$PKG/dsh-session/lib/types/index.d.ts:193`
- `buildForkSeed(events, boundary): SessionEvent[]` —— `$PKG/dsh-session/lib/types/fork.d.ts:17`；复制**含**切点的前缀 + 继承标记 + 为开放尾部补 closer
- `seed` 契约："contiguous from seq 0 with lossless-JSON data" —— `$PKG/dsh-agent/lib/types/index.d.ts:74-80`
- 若 `boundary` 未定义（主会话还没有完成的回合），seed 用 `[]`，改为把镜像说明经 `agent.followup()` 投递（见 B2）。
- **镜像锚点消息**：主会话系统提示词 / AGENTS.md / goal / todo / cwd 摘要建议作为一条 `user/message` 事件追加到 `seed` 末尾（这样 `inheritedEventCount` 一并覆盖）。**先读 `$PKG/dsh-session/lib/types/types.d.ts` 里 `SessionEventMap` 的 `user/message` 精确形状再构造**；若形状过于复杂，退化路径 = 创建后立刻 `agent.followup(createUserMessage(...))`。以「能真跑起来」为准，两条路都可以。

### B2. 给辅助会话发消息（host 侧内部）

辅助会话虽可用官方 Remote，但 host 内部直接投递更简单：
- `agent.followup(message: UserMessage): void` —— 排队一个普通回合并唤醒驱动（`$PKG/dsh-agent/lib/types/runtime-types.d.ts:192`）
- `agent.steer(message: UserMessage)` —— `$PKG/dsh-agent/lib/types/runtime-types.d.ts:199`
- `agent.cancel(cause, options?)` —— `$PKG/dsh-agent/lib/types/runtime-types.d.ts:157`
- `agent.whenIdle(): Promise<void>` —— `:164`
- `createUserMessage` 的构造方式请**从已发布实现反推**（grep `createUserMessage` 于 `$PKG/*/lib/*.js`），不要臆造。

### B3. 读主会话的系统提示词 / goal / todo / cwd

- 系统提示词：`ctx.systemPrompt.assemble({ scope })` → `PromptAssembly`；渲染文本用 `renderPrompt(assembly)` / `renderContextSnapshot(assembly)` —— `$PKG/dsh-system-prompt/lib/types/index.d.ts:199, 205, 292`。`AssembleContext = { scope?: ScopeKey; signal?: AbortSignal }` —— `:37-45`。取 scope 的方式：`ctx.agents.get(mainSessionId)?.ctx` 上读（**未确认**具体 key，需实测；若拿不到就跳过该项并在 `warnings` 里报告）。
- goal 投影：`ctx.sessionProjections.stateOf(session, 'goal')` —— key 为 `"goal"`（`$PKG/dsh-goal/lib/types/index.d.ts:34`）
- todo 投影：`stateOf(session, 'todos')` → `TodoItem[] | null`（`$PKG/dsh-tool-todo/lib/types/types.d.ts:33-47`）
- cwd：`mainAgent.session.header.cwd`（`$PKG/dsh-session/lib/types/types.d.ts` 的 `SessionHeader`）
- **所有投影读取都必须包在 try/catch 里**，失败只进 `warnings`，绝不阻断创建。

### B4. 每会话模型与权限（在 `setup(agentCtx, agent)` 里）

- 模型：`installModelSelection(agentCtx, selection): () => void` —— `$PKG/dsh-agent/lib/types/model-selection.d.ts:49`（运行期改模型的官方机制）
- 权限预设：`ctx.permissionPresets.set(session, name): void` —— `$PKG/dsh-permission-presets/lib/types/index.d.ts:186`；读当前值 `current(session): string` —— `:162`；目录 `catalog(): PermissionCatalog` —— `:138`；`names` / `defaultPreset` —— `:133, :151`
- 底层旋钮（`set()` 内部也是走这两个）：`setSandboxMode(session, mode)` —— `$PKG/dsh-sandbox-policy/lib/types/session-mode.d.ts:49`；`setApprovalPolicy(session, policy)` —— `$PKG/dsh-user-approval/lib/types/index.d.ts:63`
- **快照来源**：创建时读主会话的 `permissionPresets.current(mainSession)` 与主 agent 的 `options.provider/model/reasoningEffort`（`$PKG/dsh-agent/lib/types/runtime-types.d.ts:141`），写进 `AuxSessionInfo`。
- `setup` 是发布前唯一窗口，返回值是 `AgentSetupCommit | void` —— `$PKG/dsh-agent/lib/types/index.d.ts:85-103`

### B5. 永久删除（DSH 没有删除 API，必须四步手工）

1. `await handle.dispose()`
2. 删日志目录：解析路径优先用 jsonl 后端 `resolveCurrentLog(id, signal?): Promise<string|undefined>` —— `$PKG/dsh-session-persistence-jsonl/lib/types/index.d.ts:151`；拿到文件路径后删除其**父目录**（含 `session.lock`）。路径推断（`<root>/<projectKey(cwd)>/<encodeSegment(id)>/`）仅作兜底 —— 构造函数 `$PKG/dsh-session-persistence-jsonl/lib/index.js:903-928`
3. 删投影缓存行：`<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` —— `$PKG/dsh-session-projection-cache/lib/types/index.d.ts:33-53`
4. 删插件自己的标记文件（见 B6）
- **必须在 dispose 之后删**，否则写句柄 close 会补写。
- 文件系统操作用 `node:fs/promises` 的 `rm(..., {recursive:true, force:true})`；**不要**走 `ctx.fs`（它没有删除方法，`$PKG/dsh-fs/lib/types/index.d.ts:94-235`）。

### B6. 崩溃残留清扫

- 标记目录：`<DSH_HOME>/aux-chat/sessions/<sessionId>.json`，内容 = `{ sessionId, cwd, createdAt }`
- 创建成功后写标记；销毁时最后删标记。
- `apply()` 里启动时读标记目录，对每个残留执行 B5 的第 2/3/4 步（此时没有 handle，跳过 dispose），返回 `AuxSweepResult`。
- `DSH_HOME` 从 `process.env.DSH_HOME` 读，缺省 `~/.dsh`。

### B7. 传输层已冻结（命令通道 RPC）

浏览器↔Host 的通道用官方 `remote.commands`（Typert 命名空间是 build-time 生成的，第三方插件无法新增）。**完整线格式见 `docs/REMOTE-CONTRACT.md`，这是冻结契约。**

你需要在 `src/host/apply.ts` 里：
1. `const disposeCreate = ctx.commands.register({ name: 'aux-chat', description: '...', recordInput: false, handler })`
2. `const disposeEnd = ctx.commands.register({ name: 'aux-end', description: '...', recordInput: false, handler })`
3. 两个 handler 都把结果包成 `{ kind: 'success', text: JSON.stringify({...}) }` 或 `{ kind: 'error', text }`
4. `CommandDefinition` 形状见 `$PKG/dsh-commands/lib/types/index.d.ts:38-55`；`CommandInvocation` 提供 `agent`（被寻址的 agent）与 `rawInput`
5. 注册必须包在 `ctx.effect(() => ctx.commands.register(...), 'aux-chat: commands')` 里

**注意**：`recordInput: false` 是硬要求——否则 JSON 载荷会进会话日志，主会话就能看到辅助会话的 id 与创建参数。

---

## C. Client 侧（teammate `aux-client` 用）

### C1. 侧边栏入口 + 主区面板（`id` 必须等于 `key`）

```tsx
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 100, locale: LOCALE_NS, label: () => t('panel') },
    AuxPanelIcon,
  ),
)
ctx.slots.inject('main', () =>
  ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: LOCALE_NS, children: { [SLOT_AUX_CHAT]: { kind: 'single', scope: 'session' } } },
    AuxPanel,
  ),
)
```

- `sidebar.panellist` = `{kind:'list', scope:'root'}`，注册字段 `{id, order?, label?}` + 图标组件；图标 props `{size: number; active: boolean}`（宽栏 size=16，收起栏 18）—— `$PKG/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:42-50, 94-99`
- `main` = `{kind:'keyed', scope:'root'}`，注册字段 `{key}` —— `$PKG/dsh-client-ui-layout/lib/types/client/index.d.ts:49-56`
- 点击 → `selectPanel(id)`，未注册的 key 会抛错（所以两个注册必须同 id 同时在场）—— `$PKG/dsh-client-ui-layout/lib/client.js:462-465`
- **每个注册都必须包在 `ctx.slots.inject(key, () => ctx.slots.register(...))` 里**（声明即认领）——先例 `$PKG/dsh-client-ui-schedule/lib/client.js:6788-6820`
- 声明 session 作用域子 slot 后，组件 props 会**自动**获得 `SessionProvider`（类型见 `$PKG/dsh-client-ui-slots/lib/types/index.d.ts:335-337`；注入点 `$PKG/dsh-client-ui-renderer/lib/client.js:732-740`）

### C2. 为任意会话挂载完整对话界面（核心机制）

```tsx
const ref = ctx.sessions.retain(auxSessionId, { source: RETAIN_SOURCE })   // 立即返回
await ref.ready                                                          // 首次历史打开结算
<SessionProvider session={ref}>{renderSlot(SLOT_AUX_CHAT, {})}</SessionProvider>
// 子组件里：
renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero })
```

- `ctx.sessions.retain(target, { source, signal? }): SessionReference` —— `$PKG/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:52`
- `SessionReference = { sessionId, binding, ready: Promise<SessionBinding>, release() }` —— 同上 `:22-30`
- `SessionBinding = { sessionId, session: SessionFace, eventSource, ctx }` —— `$PKG/dsh-api-session-controller/lib/types/client/sessions/service.d.ts:76-83`
- `<SessionProvider session={ref}>` 显式绑定任意会话：`SlotScopeTargetMap['session'] = SessionReference` —— `$PKG/dsh-client-ui-session/lib/types/client/index.d.ts:67-70`；实现 `$PKG/dsh-client-ui-renderer/lib/client.js:684-701`
- **`conversation.content` factory 是官方唯一可复用会话 UI 通道**：注释 "Reusable Conversation content instantiated by presentation hosts" —— `$PKG/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:280-327`；输入 props `{variant:'main'|'embedded', phase:'settling'|'hero'|'active', hero:boolean}` —— `:509-513`
- **出货先例（照抄它）**：`$PKG/dsh-client-ui-subagent/lib/client.js:744-829`（retain → SessionProvider → renderFactorySlot）
  - `:751-754` retain（source `sidebarChat`）+ finally release
  - `:789-800` body 组件签名 `({useResource, useTabInfo, SessionProvider, renderSlot})` + `<SessionProvider session={ref}>{renderSlot(...)}</SessionProvider>`
  - `:775-787` 子组件 `renderFactorySlot('conversation.content', {variant:'embedded',phase,hero}, {slots:{views: FixedChatConversationView}})`
- **白拿**：消息流、composer（发送/停止/排队/投递模式/附件/`@` 引用）、模型选择座、权限预设座、计划座、**审批与用户提问接管**、queue/todo dock。
- **拿不到**：`conversation.header`（属 `main.conversation` 声明者）与宽度拖拽条 ⇒ 自绘顶栏。
- **`phase`/`hero` 自己推导**（照 `$PKG/dsh-client-ui-subagent/lib/client.js:776-781`），`useSession`/`useConversation` 从 SessionProvider 作用域拿到。
- **降级**：`renderFactorySlot` 在 ui-conversation 缺席时返回 `fallback ?? null`（`$PKG/dsh-client-ui-renderer/lib/client.js:1040-1048`）⇒ 必须给 fallback 占位，绝不能白屏。

### C3. 面板容器与样式

- 中栏是裸 flex 容器，面板自己 `height:100%` + 滚动。
- darwin 顶部下沉：`padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px))`，官方参考 `$PKG/dsh-client-ui-plugin-manager/lib/client.js:1701`
- 主题 token 只读 `--dsw-*`（如 `--dsw-alias-label-primary/-secondary/-tertiary`、`--dsw-alias-bg-base/-layer-1..3`、`--dsw-alias-border-l1..l4`、`--dsw-alias-interactive-bg-hover`、`--dsw-radius-sm/md/lg/xl`）
- 控件用 `@deepseek-ai/dsh-client-ui-primitives`（**唯一可直接 import 组件的包**，在 seed 表里）：Button/Switch/SegmentedControl/Menu/Modal/Tooltip/Toast/MarkdownText/StateDot/PathLabel/icons…
- CSS 注入约定（HMR 回收靠这两个 data 属性）：`style.dataset.plugin = <包名>`，`style.dataset.pluginCss = <包名>/<文件>.css`；先查重再插入 —— `$PKG/dsh-client-ui-sidebar/lib/client.js:14-21`
- `src/client/styles.css` 用 `import css from './styles.css?inline'`（build.mjs 有 inlineCss 插件）

### C4. 多标签外壳（本插件自己的状态）

- **辅助会话注册表挂 root context，不能放面板组件里**：切面板会真卸载面板（keyed slot 只渲染选中的 entry）—— `$PKG/dsh-client-ui-renderer/lib/client.js:1153-1156`。切走/切回必须保留标签，所以用 root 级 store + `ctx.effect`。
- 标签数据（`AuxSessionInfo`）由 host 的 `list()` 远程调用恢复；面板首次挂载时 `list()` 一次即可实现"切走再回来标签还在"。
- 当前主会话 id 的取法（root scope 拿不到 `sessionId`）：遍历 `useSessions(s => s).ids`，取 `useSessionRetainInfo(id, r => (r?.retainedBy?.mainView ?? 0) > 0)` 为真的那个；或用 `useSessions` 自己算。`retainedBy.mainView` 是 ui-session 判定"主视图"的官方依据 —— `$PKG/dsh-client-ui-session/lib/client.js:283, 340`
- 新建标签 → 调 remote `create({ mirrorOf: 当前主会话 id })`；关闭标签 → 调 remote `dispose({ sessionId })`，并 `ref.release()`
- 应用关闭/刷新：`window.addEventListener('beforeunload', ...)` 里对每个标签发 `dispose`（尽力而为，host 启动清扫兜底）

### C5. 结论回传主会话输入框

- 目标：把辅助会话结论作为**草稿**插入主会话输入框，用户确认后才发送。
- 输入机：`ctx.conversation`（`IConversation`，Agent-scoped）—— `ctx.conversation` 的 `inputActions.setDraft` / `insertText` —— `$PKG/dsh-client-ui-conversation/lib/types/client/contract/input.ts`（`input.ts` 中 `setDraft`/`insertText` 见 `contract/input.d.ts`；具体签名**由你按类型定义确认**）
- 由于是 Agent-scoped，需要主会话的 binding：`ctx.sessions.binding(mainSessionId)?.ctx` 或先 retain 主会话拿 `binding.ctx`。
- 若拿不到公开入口，退化方案：把结论复制到剪贴板并在主会话输入框旁给提示（**必须在最终报告里说明采用了哪条**）。

### C6. 客户端 Remote 调用

四个方法（`docs/REMOTE-CONTRACT.md` 冻结）：`create` / `dispose` / `list` / `sweep`。
调用形态见 REMOTE-CONTRACT.md；**由 host 半侧提供传输，client 只调用**。

---

## D. 统一禁忌

1. 不要改 `src/contract.ts` 的导出名（改了就两边一起改，并在报告里声明）。
2. 不要碰对方的文件（host 只写 `src/index.ts`、`src/host/**`、`src/types/**`；client 只写 `src/client/**`）。
3. 不要碰 `~/.dsh/**`、不要改 `package.json` / `scripts/**` / `docs/**`（Lead 负责）。
4. 不要引入 npm 运行时依赖（client 侧只能 require 9 个 seed 词与已声明的 external）。
5. 每个实现都要能通过 `node scripts/build.mjs --half host|client`。
6. 不确定的 API：**先 grep 已发布实现反推真实调用**，再动手；拿不准就在报告里标「未确认」，不要猜。
