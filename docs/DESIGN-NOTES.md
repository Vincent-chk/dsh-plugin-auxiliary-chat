# 设计与验证台账（Design & Verification Notes）

> 本文件是工程实现记录：DSH 平台约束分析、关键取舍、关闭协议、验证台账与残留边界，供二次开发者参考。产品功能介绍见 [README](../README.md)。（原为 README 主体，2026-10-15 移入。）

---

# @dsh-ext/dsh-plugin-auxiliary-chat

DeepSeek Harness 的**辅助会话**插件：在**当前会话窗口内**、会话头部的按钮打开一个右栏分栏面板（ChatGPT 式：主对话在左、辅助会话在右，同时可见、不覆盖整屏），里面是一组**临时辅助会话**。

## 它是什么

| 维度 | 行为 |
|---|---|
| 入口 | **会话头部右侧按钮**（`conversation.session.header.utilities`，order 20）。不在左栏、不切换主区 |
| 形态 | **框架的右列 `rightbar`**：中栏按轨道宽度自动让位，与主对话并排；收起即隐藏 |
| 会话身份 | 每次新建走 **`sessions.fork({atSeq:0})`**：服务端铸造子 id，**空继承**（无任何父事件，不画气泡），子会话 header 持久携带 `parentSession=主会话`（结构性归属，客户端无法谎报）；不是 subagent、不进会话列表（归档隐藏，见下） |
| 上下文继承 | **单向冻结快照，双通道**：①主会话的**全量已提交转录**经隐藏 `user/message`（`source.kind='aux-chat-mirror'`，压缩检查点同款）一次性注入——模型全量可见、UI 永不渲染；超预算（默认 100k 字符，`Config.mirrorMaxChars`）回退②系统提示词 section 里的摘要（12 条 / 每条 700 字）。操作边界指令、渲染后的主系统提示词、动态上下文、模型与权限预设、goal/todo/cwd 恒走 section。**刻意不 seed**——见下 |
| 聊天页 | **全新空白**：辅助会话从空会话开始，聊天记录里没有任何主会话内容（这是"不 seed"的直接结果） |
| 主会话可见性 | 主会话**完全看不到**辅助会话的任何痕迹：`fork` 只读父会话（父日志字节级不变，e2e 断言），`/aux-init` 发到**辅助会话自身**（命令行只落在辅助日志里，由空渲染器隐藏）。主转录零命令行、零创建日志（PRD R06） |
| 侧边栏可见性 | **默认隐藏**（归档集：默认过滤器与搜索都不显示；「仅看归档」下仍可见、回合运行期间行短暂可见）。`Config.hideFromSidebar:false` 可回到可见 |
| 配置 | 创建时快照主会话的模型与权限预设，之后可在辅助面板内**独立修改** |
| 能力 | 与主会话一致：完整工具能力，工作目录与主会话相同；产出的工作区文件**保留** |
| 打开方式 | 右栏 guide 胶囊 = 打开/聚焦已有辅助会话，没有则创建第一条；重复打开幂等（PRD R01/B06） |
| 多会话 | tab 菜单「新建辅助会话」再开一条；标签按 `辅助会话 2 / 3` 编号；收起、切标签、切主会话都只隐藏不销毁 |
| 关闭确认 | 关闭**有内容、正在回复或有待发队列**的标签时弹出内联确认条（空+闲置直接关）。确认文案**绑定捕获来源**：「关闭『主会话A 的 辅助会话』？」——切到 B 后再确认也不改写目标（PRD v2.0 T01/V10） |
| 未读 / 运行 | chip 显示运行 spinner；后台回复完成标记未读，实际可见并聚焦后清除（PRD R07/R18） |
| 快捷入口 | 桌面 `⌘⌥S`（Win/Linux `Ctrl+Alt+S`）；主输入框 `/side` 命令。辅助会话内 `/side` 被拒绝（不可嵌套，PRD R13/T41） |
| 回传 | 「复制结论到主会话」只把文本插入主会话输入框为草稿，用户确认后才发送（严格单向） |
| 生命周期 | 资源状态机 `creating / ready / closing / closeFailed / closed / ended`；只有**标签自身的关闭动作**会销毁；销毁 = 取消回合 → `dispose()` → 删会话日志目录 → 删投影缓存行 → 删标记文件。刷新重连见下（PRD v2.0 §7） |

## 四个平台约束（决定了本插件的关键取舍）

### 1. 继承不能有可见的历史 ⇒ 空 fork + 隐藏消息注入（v3 修订）

**seed 仍然刻意不用**：fork 出的继承段会进入子会话日志并发给浏览器，而 5 个客户端 UI 包对 `inheritedEventCount`/`ownEvents`/`isSeeded` **零引用**（2026-10-14 复核确认），没有任何截断视图的输入——用 seed 承载主会话历史必被画成气泡，这正是用户投诉的"内容重复显示"。

但"模型能看、transcript 不画"的通道其实有**两条**（此前文档只记了第一条，已修订）：

1. **系统提示词 section**——`isVisibleChatNode()` 排除 system-prompt 节点；
2. **`source.kind !== "user"` 的 `user/message` 事件**——chat 视图把它分类为 `context` 节点并隐藏（`isVisibleChatNode` 排除 context 类；分类逻辑 ui-chat L9277-9290），而 `deriveEventMessage`（dsh-session L214-226）对 user/message **无条件**放行到模型请求历史。官方自己就在用这条通道：压缩检查点（`source:{kind:"compact-checkpoint"}`）、time-context 注入、tool-goal 通知（`source:{kind:"tool-goal"}`）。

v3 因此把继承升级为：`fork(atSeq:0)`（**空前缀**，只取 header 里的 `parentSession` 结构身份，零可画事件）+ 通道 2 注入**全量已提交转录**（形态 A，压缩检查点同款；一次性写入、日志即证据、无每步重算）。边界=创建时刻的已提交前缀（进行中回合的流式片段结构性排除，其已提交的用户消息包含在内——根治旧缺陷 D1）；超预算回退通道 1 的摘要。聊天页保持 100% 干净。

原生角色级继承（ZCode 式）不可达，已核实为平台极限：`assistant/message` UI 恒画、`developer/message` 被 `withoutDeveloperMessages`（dsh-llm L755-758）从请求剥离、header `origin` 钉死仅 `"subagent"`（自定义值会被丢弃，且 subagent 身份会冻结 composer 寻址）。

创建链路：`fork` 只读父会话（父日志字节级不变），`/aux-init` 发到辅助会话自身（`command/run`+`command/done` 只落辅助日志、空渲染器隐藏）——R06"父转录零创建日志"在 fork 通道下继续完整达成（e2e 断言父日志不含任何辅助痕迹）。

**【2026-10-14 晚 修正：继承此前其实是"零内容"】** 操作者反馈"辅助会话里看不到主会话的内容"。取证（不是设计文档自证，而是读他那台宿主上正在打开的辅助会话）发现 `/aux-init` 的返回值自曝了两处真实缺陷：

```
"warnings": ["agent scope could not be minted (cannot get property \"systemPrompt\" without inject); the mirror section is not active"],
"downgrade": "summary"
```

1. **镜像 section 从未装上（致命）**：`create.ts` 用插件自己的 ctx 再 `createScope(ctx, agent)` 铸一个新作用域；而 `createScope` 的 fiber 是空插件（`dsh-scope` L286-299），可访问性继承自**插件自己**的 inject 声明——插件没声明 `systemPrompt`，于是 `agentCtx.systemPrompt` 抛 `cannot get property "systemPrompt" without inject`，整个 try 块被吞成一条 warning，section 从未注册（同时被铸出的 scope 也不会被 dispose，属泄漏）。**正确做法是用 agent 自己的作用域**：`dsh-agent-loop` 早就铸好了它（`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`，L778-779），其 static inject 含 `systemPrompt`/`tools`。改为经 `agent.ctx` 注册后，section 与工具守卫随 agent 一起回收，无额外 scope、无泄漏；服务属性读取也改成 try/catch 守卫并如实上报。
2. **超预算=全丢（设计缺陷）**：`buildFullTranscript` 是全有全无——第一条塞不进预算就 `return undefined` 回退摘要，而摘要 section 又因 (1) 没装上 → **主会话内容一点都没继承**。长会话（操作者的主会话 2.6 MB）必然踩中。现改为**最近连续尾窗**：从最新条目往回累积到预算为止，更早的一律排除（不夹杂空洞），并在注入文本头部写明"较早 N 条未包含"；只有"最新一条都放不下/父会话无可继承记录"才回退摘要。
3. **面板此前在撒谎**：状态条无条件写"已引用主会话上下文"。现在读主机实测结果 `inherited {form, entries, chars, truncated, omitted}`，如实显示三种状态并用 title 说明语义：
   - `已继承主会话最近 214 条 · 99.8k 字符（较早 353 条超出预算）`（实机原话）
   - `已继承主会话摘要 · X 字符（超长会话降级，非逐字历史）`
   - `主会话当前没有可继承的已提交记录` / `未继承主会话上下文（mirrorHistory 已关闭）`
   并在存在镜像警告时额外显示「镜像警告 N 条」（title 列出全文）——失败不再静默。

**边界（未变，如实）**：快照=**创建瞬间的已提交前缀**；进行中回合尚未提交的流式内容不在其中（与 ZCode"切到活跃 turn 的真实用户消息为止"的规则一致，e2e 用 inbox/committed 两种事件形态把这条边界钉住了）。已存在的辅助会话不会被修补——继承是创建时的一次性快照，需关闭重开。

### 2. 隐藏 = 归档（2026-10-14 第二轮重做：门禁桥接，能力零损失）

官方侧栏的行过滤器（`dsh-client-ui-workspace` 的 `sessionVisible`）只隐藏两类会话：`origin === "subagent"`（会让本面板复用的 composer 被 `session/agent-busy` 冻结，不可用）与 **workspace 归档集**（默认过滤器不显示、搜索同样排除）。因此隐藏走归档集。

第一轮实现（今日早些时候）因 `ArchivedSessionGate` 而翻车：归档会话的 `agent/pre-step` 被 `{kind:'reject'}` 拦截，回合直接 `blocked`；当时的绕法（自己应答 step、不调 `next()`）会**否决整条瀑布**，丢掉运行期上下文快照与另外 17 项注入，因此默认关闭。

**现行机制（`src/host/hide.ts`，默认开启）**：门禁每次 step **实时重读** `workspaceRegistry.archivedSessionIds`，且由更早的 bundle 注册——所以本插件用 `prepend:true` 抢在它前面：
1. `agent/pre-step` 上对本插件 `owned` 的会话先 `await unarchiveSession(id)` 再 `next()`；
2. 门禁在 `next()` 内读到集合已无该 id → 放行，**其余 17 个监听器与 base 决策（运行期上下文）全部照常贡献**；
3. `agent/status` 回 `idle` 时重新归档（行再次消失）。回合进行期间行可见是本通道的固有边界。

销毁路径维持"日志先删 + 台账下次启动反归档"，垂死行不闪现。启动时 marker 清扫改为在 `apply` 内**被等待**——客户端首个列表加载前必完成，杜绝"清扫晚于列表加载"造成的滞留行（2026-10-14 13:54 重启后操作者看到的残留行的机制）。

**残留边界（如实）**：「仅看归档」过滤器下仍可见；回合运行期间行短暂可见。若宿主未来开放行隐藏插槽，可切换为原生通道。

### 3. 内部命令在 "/" 菜单可见 ⇒ 三层兜底 + 降噪

Host 命令目录（`dsh-commands`）没有可见性字段：`normalizeDefinition` 只接受 `name/description/input/recordInput/handler`，`list(agent)` 返回"该会话可执行"的全集，而 slash 菜单直接渲染这个目录。插件注册的 `/aux-init`、`/aux-end` 因此会出现在**每个** composer 的 "/" 菜单（包括辅助面板自己的）。彻底隐藏需要框架级的 per-agent 命令挂载（把 command-injected 插件挂到该 agent 的 `agent.ctx` 下）。现有兜底保证误触无害：`recordInput:false`（载荷不落盘）、错误目标直接拒绝（`aux-chat/wrong-target`）、名称键空渲染器把命令行从转录中隐藏；两个命令的 description 已收敛为一句"内部指令：…（请勿手动调用）"。

### 4. 文件投放的隔离：文档级 drop 监听 vs 两个 composer（2026-10-14 修复）

**症状（操作者报告）**：往辅助会话里添加文件，文件同时出现在主会话里——"一并共享"。

**根因（实机复现）**：`ui-attachment` 的 `ComposerAttachments`（`conversation.input.attachments` 槽位占用者）为**每个已挂载的 composer** 安装**文档级** drag/drop 监听（`installDocumentDropEvents`，`$PKG/dsh-client-ui-attachment/lib/client.js:534-591`），`onDrop` 里 `if (canAcceptDrop) onAddFiles(files, …)`。官方组合的前提是"**文档内只有一个非 subagent composer**"：嵌入式 subagent 聊天被 `subagent !== null` 排除（`InputBar`: `canAcceptDrop = subagent === null && …`）。本插件挂载的第二个**普通**会话（辅助会话刻意不是 subagent 会话）打破了这个前提——一次投放被两个文档级监听各处理一次，实机抓到的正是两条上传：

```
POST /api/session/uploadFileBinary?sessionId=<main>  ← 主 composer 的文档级监听
POST /api/session/uploadFileBinary?sessionId=<aux>   ← 辅助 composer 的文档级监听
```

**这不是继承层的反流**：v3 的 fork 是单向一次性快照，引擎里没有"子会话回投父会话"的路径；漏的是**共享文档上的事件路由**。也**不是存储层**：DSH 附件是全局内容寻址存储（`<DSH_HOME>/attachments/v1/objects/<sha[0:2]>/<sha>`，本机实测 143 个对象），**没有 per-session 物理分桶**，隔离靠"引用随消息走 + 上传收据按 agent 作用域暂存"——`FileUploads.upload` 把 receipt 放进 `stagedFiles.get(agent.session)` 的 WeakMap，`resolve(agent, receiptId)` 只在接收 agent 作用域内可解析（`assertAgentScope`），跨会话使用会 `FILE_NOT_STAGED`（`$PKG/dsh-client-file-upload/lib/index.js:110-266`）。

**修复（`src/client/drop-router.ts`，零宿主补丁）**：只要挂载了辅助面板，插件就接管文档的**捕获阶段** drag/drop：

1. **目标会话由投放位置决定**——读框架自己的归属属性 `[data-conversation-session]`（`ui-conversation` 的停止快捷键用同一个 `closest()` 查找）；辅助面板 chrome 用 `[data-aux-chat]` + `[data-aux-session]`；落点在所有会话之外则回落主列；落点在 subagent 面板内则改投主列（与官方"文档级监听只喂普通 composer"的语义一致）。
2. 捕获阶段 `stopImmediatePropagation` 掐断后续全部传播 → 两个 composer 的文档级 intake 都不执行，**一次投放恰好一次处理**。
3. 用**原** `DataTransfer` 合成一次 `paste` 事件投给目标 composer 自己的 Lexical 编辑器 → 走它自己的 PASTE→`intakeFiles`：官方继续决定"上传 vs `@路径` chip"、图片限额与 toast，**没有复制任何 intake 策略**；`webkitGetAsEntry`（文件夹识别）与桌面 `__DSH_HOST_PATHS__.pathFor`（按 `File` 对象取真实路径）因为沿用同一批 `File` 对象而照常工作。
4. 拖入辅助面板时用面板自身的虚线高亮（`[data-aux-drag="active"]`）替代官方全屏遮罩：本地面板自己认领这次拖放。

未挂载辅助面板时路由器完全惰性（不 `preventDefault`、不拦截），官方单 composer 行为逐字节不变。

**实机复验（一次性实例 + 真实 bundle，playwright 驱动真实 GUI）**：

| 场景 | 结果 |
|---|---|
| 辅助面板内投放 | 仅辅助 composer 出现 chip；1 次上传 → 辅助会话 ✅ |
| 主列投放（面板挂载中） | 仅主 composer 出现 chip；1 次上传 → 主会话 ✅ |
| 辅助面板内走「添加文件」菜单 | 仅辅助 chip；1 次上传 → 辅助会话 ✅（回归） |
| 关闭辅助标签后主列投放 | 官方监听处理；仅主 chip；1 次上传 → 主会话 ✅（惰性） |
| 拖拽高亮 | 辅助面板内拖拽时 `data-aux-drag=active`，投放后清除 ✅ |

离线门：`npm run drop-check` **36 项**（含 D00 基线：不带路由器时一次投放同时进两个 composer，即本缺陷的离线复刻）；视觉门：`tools/visual/scenarios/drop-isolation.mjs` **12/12**（截图在 `tools/visual/evidence/`）。

**为什么此前 9 轮没抓到**：旧视觉场景 `attachment-isolation.mjs` 只用各 composer 的隐藏 `input[type=file]` 暂存文件（**文件对话框路径**），而这条路径从来不共享——缺陷只存在于**拖放**路径。本轮把拖放路径补成了独立场景。

**残留边界（如实登记）**：
- 拖拽经过窗口时官方全屏遮罩仍可能叠两层（`pointer-events:none` 的装饰层，不影响落点判定）；
- 合成 paste 的 `isTrusted=false`：未来若给 intake 加 `isTrusted` 门禁，需要改用真实事件通道（模块文档已登记）；
- 找不到目标编辑器（会话未就绪、composer 被 block）时不拦截，退回官方行为（可能重现双落点，属降级而非崩溃）。

## 为什么"临时"是这样实现的

DSH 0.2.0-rc.2 **没有**任何"不落盘会话"开关，也**没有**会话删除 API：

- `ctx.agents.create()` 只要组合里挂了 `sessionPersistence` 就无条件落盘（`dsh-agent-loop/lib/index.js:1818-1827`）；
- `SessionPersistence` 只有 `create/open/flush/stat/list`（`dsh-session-persistence/lib/types/index.d.ts:110-157`），`SessionController` 全方法表无 delete。

因此本插件用**四步手工销毁**（见 `src/host/dispose.ts`）逼近"永久删去"，并在启动时清扫崩溃残留的标记文件。会话存在的这段时间里磁盘上确实有一个 jsonl 文件——这是平台约束下能做到的最接近语义。

## 关闭协议与生命周期（PRD v2.0 结构修订）

本节是 2026-10-14 修订 PRD v2.0 的核心落地：**A 打开 a、切到 B 之后，a 仍属于 A；关闭永远作用于捕获的原资源与原标签实例，绝不误伤 b**。

**身份捕获（R01–R04）**：pane 挂载当帧把 `mainSessionId`、`tabKey`（tab 的 contentId）、`AbortSignal`（occurrence）一起冻结进 runtime；此后所有异步回调都要过"世代守卫"——`isCurrent(runtime, epoch)` 用对象身份 + 创建代次双重校验，tab 关闭后同 id 重开的新实例不会被旧回调污染（T05）。

**关闭准入（§6.3/§6.4）**：全部入口（标题 X、菜单、替换、快捷关闭）都过宿主 `registerCloseHandler`；需要确认时同步抛 `CloseVetoError` 保住标签（一次性 `bypassNextClose` 令牌只作用于原 occurrence）。确认文案读的是**按 id 绑定**的主会话标题，不是"当前屏幕上是谁"。

**关闭执行**：确认后同步翻 `closing`（<100ms 反馈）→ 以捕获的 `childSessionId + hostGeneration + operationId` 调 `/aux-end` → Host 完成后才 `closeIn(A, tabId)` 移除标签。30s 看门狗超时进 `closeFailed`（保留标签、记录确切目标、"重试关闭"**复用同一 operationId**）；`not-registered / stale-generation` 归类为已收敛。10 次连点只有一次逻辑清理（T14）。

**Host 代次（T12）**：host 每次 `apply()` 铸 `gen-<uuid>`，随创建结果下发；关闭请求回传，不匹配即 `aux-chat/stale-generation` 拒绝且什么都不动——越过 Host 重启的旧请求不能作用于同 id 下的任何新资源。

**刷新重连（§7.1 / E12 / T16）**：pane ready 时把 `tabKey → {sessionId, mirrorOf, hostGeneration}` 记入 localStorage，键含**窗口 owner**（sessionStorage，刷新保留、第二窗口隔离）。刷新后同 tab 重挂 → 先 `/aux-init mode:"reclaim"` 复接原 child（绝不二次 fork）；Host 侧凭 registry/marker 验证归属、拒绝改绑父会话与外来 id。复接被拒（Host 已重启回收）→ 面板显示"辅助会话已结束" + 显式「新建辅助会话」（新资源代次，不复活）。**未实现**：120s 失联宽限的自动到期回收——无日志污染的存活信号接缝（§15.3-4 已登记为开放项）；当前由 Host 重启清扫兜底。

**离线验证**：`npm run race-check`（43 项，驱动真实 controller：C01–C12 覆盖 R01/T01/T04/T05/T14/E06/E07/E12/T16/T12/§6.3 看门狗与幂等）；`scripts/e2e-isolated.mjs` **55 项**（真实栈：代次下发、reclaim 三分支、stale-generation 拒绝且资源未动、operationId 回显、归档隐藏+门禁桥+运行期上下文注入+空闲回补、**v3 fork 通道**：parentSession 结构绑定、空继承、parent-mismatch 拒绝、downgrade=full、D1 事实入模型上下文、父日志零痕迹）。

### 与 ZCode 侧边栏机制的对照登记（2026-10-14 审查结论）

| ZCode 机制 | 本插件等价物 | 状态 |
|---|---|---|
| 继承切点=活跃 turn 的真实用户消息 | 全量注入取**已提交事件前缀**（流式未提交片段结构性排除；进行中回合的已提交用户消息包含） | ✅ v3 对齐 |
| `parent_id` 归属 | header `parentSession`（fork 服务端写入；list/搜索暴露 `parentSessionId`） | ✅ v3 对齐 |
| `baseRevision` / 命令 ack | `hostGeneration` / `operationId`（关闭绑定与幂等重试） | ✅ v2 已对齐 |
| 输入队列 / 待发改道 | 平台 agent FIFO（inbox `next-turn`/`next-step`）+ `prompt(requestId)` 幂等；面板经 `pendingSubmissions` 观察队列并纳入关闭确认 | ✅ 等价（借用官方 composer，无需自建） |
| 原生角色级历史继承 | **平台不可达**（assistant 恒画 / developer 被剥离 / origin 钉死）——以隐藏 user/message 全量注入逼近 | ⚠️ 极限登记 |
| 附件存储分桶（ZCode: 会话 ID 内嵌 URI/物理路径） | **平台不同**：DSH 用全局内容寻址存储 + 引用随消息走 + 上传收据按 agent 作用域（`FILE_NOT_STAGED` 跨会话拒绝）——无需 per-session 目录即达成隔离 | ✅ 等价（非分桶实现） |
| 输入队列路由（命令信封携带 sessionId） | 上传/命令信封都带 `sessionId`（`uploadFileBinary?sessionId=…`、`commands.execute(agentId,…)`）；**拖放**由本插件的捕获路由器按投放位置补齐 | ✅ 本轮补齐 |
| E11 父归档联动 | 平台不级联非-subagent lineage；面板软提示「主会话已归档：参考历史已冻结」 | ✅ 软提示 |

## 安装（全局部署到 desktop profile）

```bash
node scripts/build.mjs                                  # 构建两个半侧
node scripts/smoke.mjs && node scripts/verify.mjs        # 契约与产物检查
node scripts/integration.mjs                             # 跨半侧一致性
node scripts/install-profile.mjs                         # 干跑，只打印不改动
node scripts/install-profile.mjs --apply --no-pnpm       # 备份 + 写 manifest + 目录链接
```

`--no-pnpm` 让安装器**只**建一个指向本仓库的目录链接（`profile/node_modules/@dsh-ext/…`），与你 profile 里
249 个 `@deepseek-ai` 链接完全同构，因此不需要跑 `pnpm install`、不改 lockfile、不会重解析其它依赖。
想走官方安装语义就去掉 `--no-pnpm`（安装器会打印 pnpm 命令，或用 `--pnpm` 直接执行）。

装好后**重启 DeepSeek Harness**（Loader 在组合期读取 `dsh.profile.bundles`），再刷新页面。

卸载：`node scripts/install-profile.mjs --uninstall --apply --no-pnpm`（会自动删掉那个链接）。

> desktop profile 无法用 `dsh plugin --profile desktop add` 安装（CLI 硬拒：profile 由 Electron 载体专属管理）。本脚本做的是同一件事：写 `dependencies` + `dsh.profile.bundles`。

## 开发循环

```bash
node scripts/build.mjs --half client   # 只打浏览器半侧
# → ≤500 ms 后浏览器自动热更（dsh-client-hmr 轮询 lib/client.js 的 mtime/ctime/size）
node scripts/build.mjs --half host     # 只打 Node 半侧（需重启 DSH 生效）
```

- 改 `dsh.client` 声明 / 包名 / `exports["./client"]` → **必须刷新页面**。
- 两个半侧可独立构建，因此可以并行开发（见下）。

## 已验证到什么程度

**当前门（v3 + 拖放隔离，2026-10-14）**：build / smoke / verify 19 / integration 32 / **race-check 43** / **drop-check 36** / **mirror-check 23** / **e2e-isolated 72** 全绿，另有视觉场景 `drop-isolation.mjs` 12/12 与 `mirror-live.mjs` 4/4（后者把隔离实例指向操作者的真实长会话，实机读出「最近 214 条 · 99.8k 字符，较早 353 条超出预算」）；spike（`scripts/spike-fork.mjs`，S1-S9）实证 fork(atSeq:0) 全链、形态 A append 形状（`{surfaceOp:'append'}`，agent-loop L1061 同款）、seed 事件派生 0 条模型消息、`blank=true` 孤儿不可见、selectModel 可用。下表为历史各轮验证明细（部分行属 v1/v2 时代口径）：

在一个**隔离的 DSH 实例**（独立 `DSH_HOME=/tmp/...`、独立端口，用 desktop profile 的组合复制而成，不触碰你正在运行的应用）上实测通过：

| 验证项 | 结果 |
|---|---|
| 插件 host 行进入 Loader 组合树 | `--dump-config` 末尾出现 `- id: aux-chat / name: '@dsh-ext/dsh-plugin-auxiliary-chat'` |
| host fiber 真实激活 | `pluginInventory/list` 返回 `{entryId:"include:aux-chat", enabled:true, fiberPhase:"active"}`，全实例 158 active / 0 failed |
| 浏览器启动图包含插件行 | 66 行中第 56 位，`rev=237bb5c0e7c8`，`inject` 的 3 个动态包均排在其之前 |
| bundle 路由 | `GET /plugins/??<pkg>/client.js&rev=…` → 200，与磁盘 `lib/client.js` 逐字节一致；错误 rev → 404 |
| `/aux-chat` 真实创建 | 成功，返回 `mirrorOf`/`cwd`/`provider=deepseek-official`/`model=deepseek-flash`/`permissionPreset=workspace-write`（模型与权限确实从主会话快照继承） |
| 落盘产物位置 | `<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd` + `session.lock`、`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`、`<DSH_HOME>/aux-chat/sessions/<id>.json` 三处齐全 |
| 四步销毁 | `/aux-end` 返回 `{logRemoved:true, cacheRemoved:true, markerRemoved:true}`，三处产物全部消失 |
| **主会话隔离** | 解压主会话日志：只有 header 一条记录，**不含**辅助会话 id、不含创建载荷（`recordInput:false` 生效）；主会话日志目录完好无损 |
| **附件会话隔离** | `tools/visual/scenarios/attachment-isolation.mjs` 9 项断言全绿：主会话 staged 的文件/草稿不出现在辅助面板（双向），面板根节点 `data-aux-session` 钉住辅助会话 id（`session-<uuid>`），截图在 `tools/visual/evidence/` |
| **面板几何（composer 在底部）** | `tools/visual/scenarios/pane-layout.mjs` 7 项断言全绿：composer 底边与面板底边 gap=0、上方留足转录空间、真实回合后仍成立 |
| 幂等性 | 重复销毁返回 `not-registered` 且**不触碰任何文件**；用外来 id（真实主会话）销毁同样被拒 |
| 拒绝路径 | `mirrorOf` 不存在 → `aux-chat/mirror-missing`；路径穿越 id → 被 `^session-[0-9A-Za-z][0-9A-Za-z-]{0,119}$` 拒绝；辅助会话嵌套 → `aux-chat/nested-aux` |
| 未知命令 | 返回 `undefined`（客户端降级为状态行提示，不崩） |
| 重构后的加载与生命周期 | `scripts/e2e-isolated.mjs` 20 项全绿：host fiber `active`、0 failed、bundle 逐字节一致、`/aux-chat` → `/aux-end` 全链路、标记清除 |
| 与官方右侧栏共存 | `scripts/e2e-isolated.mjs --with-official-rightbar` 22 项全绿：官方列在场时插件仍激活且不遮蔽它 |
| **聊天页干净** | `src/host/__selfcheck__/e2e-probe.mjs --prompt`：辅助会话可见载荷里**继承记录 = 0、可画气泡行 = 0**，整页只剩 4 条不画行的 log-only 记录（permission/preset、sandbox/mode、approval/policy、session/title） |
| **镜像确实到模型** | 同一探针：辅助会话自己的 `system/message` **携带 `aux-chat-mirror` section**，摘要块与"这是摘要不是原文"自述都在渲染后的提示词里（15309 字符，identity@0、mirror@114） |
| Path B 会话生命周期 | 自检 28 条断言（迷你 hook 运行时驱动真实组件）：挂载即创建、同一 tab 重挂复用、会话切换不重复创建、关 tab → `/aux-end` + release、创建失败显示原因与重试、多 tab 各自独立、无会话时说明而非空转 |
| 交付形态（e2e 断言） | 启动图含宿主右侧栏 → Path B 生效；产物注册 `sidebar.right.pane.tab` + `title`、读取 `useTabInfo`、且**不含**内层标签栏 |
| **归档+短路在开关打开时** | 探针 `--hide`：归档集合写入成功；我们自己的已归档辅助会话 `step/start = 1` 且走到真实 provider 边界；**对照组的"非本插件 + 已归档"会话仍 `blocked`、`step/start = 0`**（没有弄坏别人的归档会话） |

复现：`node scripts/e2e-isolated.mjs [--port 19520] [--with-official-rightbar]`（自建一次性 `DSH_HOME` 与私有端口，跑完自动清理，不碰你正在运行的应用）。

尚未端到端证实：**带真实模型回复**的完整回合。隔离实例没有 API key，回合停在 provider 边界（`MISSING_CREDENTIAL`），所以"归档+短路后能跑完一整轮"只有机制证据（`step/start`、`system/message`、`request/header` 都产生了）。默认路径（不隐藏）不受此影响。

尚未真机验证：**Path B 在真实浏览器里的表现**。离线 harness 用迷你 hook 运行时驱动真实组件，但"宿主是否真的把 `useTabInfo`/session 作用域交给这个 pane body"、"guide 胶囊点击是否真的开 tab"，只有官方源码契约交叉核对，没有真机点击。请在实机确认三点：①右栏 guide 里点「辅助会话」→ 直接进入可用对话（不再出现空面板）；②关掉该 tab → 会话被永久删除；③开两个 tab → 各自的会话独立、chip 标题可区分。

**教训记录**：本插件曾有连续几轮按 Path A 设计与验证，而实机一直是 Path B，导致"面板永远空状态、没有任何对话入口"。根因是我把"profile 的 `dsh.profile.bundles` 里没有 sidebar-right"误当成"它没被挂载"——实际上它来自 **bundle 的 patch 层**。现在 `scripts/e2e-isolated.mjs` 会断言启动图里存在该行并检查 Path B 的产物标记。
若顶部留白偏大，改 `src/client/styles.css` 里 `[data-platform='darwin'] .auxc-head` 一行即可。

## 架构

```
src/contract.ts          冻结的跨半侧接口（常量 + 载荷类型）
src/index.ts             host 入口：re-export ./host/apply
src/host/                会话登记表、上下文镜像、创建、四步销毁、启动清扫、命令通道
src/client/              会话内切换按钮、右栏分栏外壳、多标签、conversation.content 复用、回传、本地 store
src/client/drop-router.ts 文档级拖放按位置归会话（含合成 paste 重投递与拖拽高亮）
docs/VERIFIED-API.md     已实证的 DSH API 参考（每条带 文件:行 出处）
docs/REMOTE-CONTRACT.md  浏览器↔Host 的命令通道契约（Typert 命名空间是生成器产物，第三方插件用 commands 通道）
scripts/                 build / smoke / verify / integration / install-profile / e2e-isolated / gui-repro
src/host/__selfcheck__/mirror-window-check.mjs   尾窗预算自检（23 项）
```

**入口的分工**（`src/client/panel/Panel.tsx` + `src/client/store.ts`）：

| 路径 | 新建入口 | 销毁入口 |
|---|---|---|
| Path B（实机） | 宿主右栏 guide 页的「辅助会话」胶囊，或宿主 tab 栏的 `+`——**打开一个 tab 就自动创建它自己的辅助会话** | 关闭该宿主 tab |
| Path A（回退） | 会话头部切换按钮（打开并聚焦/自动创建） | 面板头部 `×` 结束会话 |

**面板内部没有任何新建控件**（用户明确要求："顶栏已有新建功能，面板内再加一个是重复的"）。Path B 里宿主 tab 本身就是"辅助会话窗口"，所以不再有内层标签栏；Path A 一次显示一个会话。两条路径的自检都有反向断言：面板内不得出现 `+`、无 `新建` 字样、无 `.auxc-tabs`。

**本机实际走 Path B（重要）**：`@deepseek-ai/dsh-client-ui-sidebar-right` 由 `dsh-web-app` 的 bundle patch **无条件挂载**（`$PKG/dsh-web-app/cordis.patch.yml:265-266`，无 disabled 门），desktop profile 包含 web-app —— 所以实机启动图里始终有它（`scripts/e2e-isolated.mjs` 现在会断言这一点，并把 Path B 的产物标记一并检查）。**Path A 只在有人显式禁用该 bundle 时才可能出现。**

| | Path B（实机形态） | Path A（回退） |
|---|---|---|
| 形态 | 宿主机右侧栏里的一个 tab 类型 | 占用框架 `rightbar` 右列 |
| 一个"辅助会话"= | **一个宿主 tab** | 当前主会话的那一个 |
| 新建入口 | guide 页的「辅助会话」胶囊 / 宿主 tab 栏的 `+` | 会话头部切换按钮 |
| 挂载即创建 | 是（`AuxPaneBody` 挂载时创建该 tab 的会话） | 是（toggle 打开时创建） |
| 关闭即销毁 | 关宿主 tab → `tab.signal` abort → 销毁 | `.auxc-head` 的 × → 销毁 |
| 面板内标签栏 | **无**（宿主 tab 就是标签） | **无** |

**与官方右侧栏共存**：
本插件启动时用 `ctx.get('sidebarRightTabs')` 探测：**不存在** → 占用 `rightbar` 并注册会话头按钮（Path A，本机形态）；
**存在** → 不占 `rightbar`（避免遮蔽官方列），改走官方两阶段 tab 注册（Path B），并因为官方列自带 corner 展开控件而不再重复注册按钮；
官方包若在本插件之后加载，`ctx.inject` 的 latch 会拆掉 Path A 并切换过去。两条时间线都已验证（见下）。

**UI 复用**：DSH 唯一的官方可复用会话 UI 通道是 `conversation.content` Component Factory（"Reusable Conversation content instantiated by presentation hosts"）。面板用 `ctx.sessions.retain(sessionId)` 拿到 `SessionReference`，再用 `<SessionProvider session={ref}>` 显式绑定**任意**会话，于是消息流、composer（发送/停止/排队/附件/`@`）、模型与权限选择器、审批与用户提问接管全部免费获得。

## 已知边界与风险

1. **删除依赖文件系统路径推断**：优先用 jsonl 后端的 `resolveCurrentLog(id)`，路径拼接仅兜底。DSH 若改变磁盘布局，销毁会降级为"只 dispose、不删文件"，并在日志留痕。
2. **`conversation.content` 是跨版本的耦合点**：DSH 升级若改 factory 输入形状会破。面板为其缺席准备了 fallback 占位（不白屏）。
3. **辅助会话在生命周期内可被 `session.search` 搜到**（磁盘上真实存在）。关闭后随删除消失。
4. **`@` 提及候选**：官方 `sessionReferenceResolver` 不按 `origin` 过滤，辅助会话带 `[辅助]` 标题前缀以便辨认。默认不拦截（需替换官方 Typert 服务，侵入性过高），后续可作为加固项开启。
5. **拖放路由依赖两个 DOM 契约**：归属属性 `[data-conversation-session]` 与本插件自己钉的 `[data-aux-chat]`/`[data-aux-session]`。DSH 若改名，路由器会解析不到目标而不拦截（退回官方双落点），不会崩；已在模块文档登记查询点。
6. **拖拽遮罩**：面板挂载期间，官方全屏遮罩在拖拽经过窗口时仍可能叠两层（装饰层，`pointer-events:none`），落点判定不受影响。
7. **文档级 drop 的其他消费者**：本路由器在辅助面板挂载期间独占文档级投放，因此同层的其他消费者收不到文件拖放——目前平台上只有一处：右侧栏用 pdf.js 打开**可编辑** PDF 时的批注粘贴监听（`dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js:3827-3836`，仅编辑态挂载）。此时文件会落到主会话 composer（"带上这个文件"的意图仍在），pdf.js 收不到。若将来该交互变得重要，可改为只拦截祖先带 `[data-conversation-session]`/`[data-aux-chat]` 的投放，代价是恢复主↔辅助反方向泄漏。
8. **自动标题**：~~辅助会话会触发一次首轮标题 LLM 调用~~ **v3 已根治**——fork 通道使子 header 携带 `parentSession`，标题插件的触发条件（`dsh-session-title/lib/index.js:386`）要求 `parentSession === undefined`，且注入消息 `source.kind !== 'user'` 也不满足触发条件（L381），双重抑制；`pinTitle` 仍固定 `[辅助]` 前缀标题供「仅看归档」辨认。

## License

MIT

---

# v4 改造台账（2026-10-16，对标 ZCode 改造规划 v2 执行记录）

## 决策（产品裁决，优先级高于历史 PRD）

1. **划词引用链路不做**；`/side` 维持裸命令（不带 prompt 直发）。ZCode 的该链路记录在
   v2 体验报告，作为未来可选项保留，不进入本插件迭代。
2. **关闭静默化（对标 ZCode）**：移除关闭确认条、"不再询问"偏好与全部关闭前风险提示句；
   关闭手势直接进关闭协议（abort→dispose→移标签）。**协议健壮性不降级**：operationId
   幂等、closeFailed 卡+重试、30s 看门狗、代次守卫全部保留（race-check C05–C16）。
   误触损失风险按决策接受；补偿仅 host 台账留痕（见改造规划风险 R3）。
3. 其余风险选型按规划推荐：HideChannel 接缝预备、窄屏单栏、镜像结构化、seams 需求文档。

## 文案治理（P0）

- 全量用户文案收敛到 `src/locale.ts`（zh/en 各 100+ 键，含状态卡/继承栏/回传/错误/命令描述）；
  `scripts/copy-check.mjs` 门禁：词典外汉字=0、zh/en 键集相等、零风险句（永久删除/无法恢复/
  永久销毁/将被丢弃）。
- `scripts/copy-truth-check.mjs`：六个状态面（creating/closing/closeFailed/ended/继承栏/handoff）
  的每条文案键绑定一个行为证明标记（测试文件内 `copy-truth:` 注释），文案与行为不再脱节。
- 顶部状态栏改为**纯继承事实播报**：条数/字符/降级说明 + 模型与权限继承来源（`inhModel`），
  不含任何风险子句。

## 静默关闭的实现边界

- `handleTabClose` 仍抛 `CloseVetoError`：这是宿主标签系统下"先销毁后移标签"的唯一通道，
  与"是否询问用户"无关；静默指无对话框、无警告文案。
- 队列/运行中回合随 abort 取消（ZCode 同语义）；`closeFailed` 时标签保留并可重试同一 operationId。
- destroy 路径新增归档集清理（`unarchiveIfArchived`），销毁后不再在归档集留残影（e2e E40a）。

## HideChannel（P2/WP2.2）

- `resolveHideChannel(deps)`：配置 `hideChannel`（auto/archive/native）× 宿主原生可见性面
  （`sessionVisibility` 服务，S1 接缝）解析通道；native 缺失或拒绝时回退 archive-bridge 并留
  warning/trace。idle 重归档在 native 通道下自门控跳过。
- 活门禁 `npm run hide-check`（H1–H7）：解析顺序、native 不归档、失败回退、强制配置。

## 窄屏单栏（P2/WP2.1）

- Path A 列在宽度不足时切单栏模式（`data-aux-single="1"` + 返回主对话按钮），死路卡片删除；
  Path B 窄屏仍由宿主右栏自决（autoFullscreen），文档化不越权。

## 镜像结构化（P3/WP3.1）

- form-A 注入本就带角色头（`## User/Assistant/Tool result (seq N)`）；本轮补两块缺失结构：
  reasoning 省略标记 `[reasoning omitted ×N]` 与多工具调用计数标记 `[tool calls ×N: names]`
  （mirror-check W08–W15）。digest 降级路径的角色前缀维持原状。

## 门禁计数（改造后）

verify 30 · race-check 51 · drop-check 36 · mirror-check 31 · hide-check 7 · integration 32 ·
e2e-isolated 80 · visual ≥50（场景：core-journey/real-roundtrip/multi-unread/copy-walkthrough
(zh+en)/drop-isolation/open-idempotent/pane-layout/mirror-live/attachment-isolation/
shipped-sidebar；narrow-single 因 DSH 0.2.x 禁用官方右栏后宿主 Web 无法启动而记为验证偏差，
见 docs/REVIEW-REFACTOR-2026-10-16.md §5）。

## v5 台账 · 第三轮（2026-10-16 下午）：静默关闭去噪 + 上游草案

- **触发**：二轮复核实锤两问题（sidebarRight 硬注入阻断 Path A；每次合法关闭一条
  error 级 "Sidebar tab close failed" 控制台噪声）。规划与验收标准：
  `docs/PLAN-ROUND3-SILENT-CLOSE-DENOISE.md`。
- **协议变更**：关闭处理器由 veto（抛错保留标签→后台销毁→程序化移除）改为
  **removal-first**（永不抛错→框架同步移除标签→后台销毁）。删除
  `CloseVetoError`/`bypassNextClose`；失败后台路径 = 同 operationId 重试一次 →
  console.warn → 宿主重启清扫兜底。防御面（标签未被宿主移除的非常规情形）
  维持 closing/closeFailed 卡片与文案，零字典改动。
- **附带修复（同一改动消除的隐患）**：`place()` 的 replaceTab 路径无 try/catch，
  旧协议下我们的否决可炸掉其他插件的 replaceTab 打开；新协议永不抛错，隐患归零
  （上游草案 U2 一并记录）。
- **根因补证**：10 包硬注入清单 + ui-chat 消费面（仅 3 处可选链接便利）→
  `docs/UPSTREAM-ISSUES.md` U1/U2/U3。
- **门禁**：race 62/62（新增 C17/C18/C19）；verify 30；drop 36；mirror 31；hide 7；
  integration 32；smoke；typecheck；visual silent-close-noise 7/7 ×2（即时消失
  204/219ms、零 veto 噪声、无卡片、无行残留）+ core-journey 10/10 + real-roundtrip
  9/9（新协议下真模型往返全程通过）；e2e 80/80 ×2（G10 观测面升级为实时 session/list，
  与落盘刷盘时序解耦）。
