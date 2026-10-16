# 代码审查记录 · v4 改造（体验改造规划 v2）

> 审查人：实施代理自审 + 门禁复核 · 日期：2026-10-16
> 范围：branch `refactor/ux-polish-v2` 全部改动（23 个修改文件 + 7 个新增文件，+722/−395 行）
> 决策依据：《DSH 辅助会话插件体验改造规划 v2》决策记录三条（划词不做//side 维持/关闭静默）

## 1 · 改动清单与意图

| 文件 | 意图 |
|---|---|
| `src/locale.ts`（新） | 全量用户文案单一事实源（zh/en 各 86 键）；`msg/substitute/setCopyLang` |
| `src/client/store.ts` | 静默关闭协议（`startClose` 取代 `confirmClose` 族）、`indicators()` 单源、model 回显落 runtime、状态文案走词典 |
| `src/client/panel/Panel.tsx` | 移除 ConfirmInline 与风险句；状态卡/继承栏/单栏模式全部词典化；顶栏纯事实+模型继承 |
| `src/client/panel/ChatView.tsx`、`handoff.ts`、`remote.ts`、`index.tsx` | 文案迁移；`/side` 嵌套拒绝文案词典化；语言探针（languagechange） |
| `src/client/styles.css` | 删除确认条样式；新增单栏模式样式 |
| `src/host/hide.ts` | HideChannel 抽象（resolve/probe/hideThroughChannel）；native 通道 idle 不自归档 |
| `src/host/create.ts` / `apply.ts` / `types.ts` | 隐藏走通道解析；配置 `hideChannel`（读取时校验，不用 schema enum——schemastery 窄 cast 不保证 enum） |
| `src/host/dispose.ts` | 销毁后清理归档集残影（E40a 根因修复）；exactOptionalPropertyTypes 修复 |
| `src/host/mirror.ts` | form-A 结构化标记：`[reasoning omitted ×N]`、`[tool calls ×N: names]`；标题前缀常量化 |
| `src/contract.ts` | 新增 `TITLE_UNNAMED` 常量 |
| `scripts/lib/copy-gates.mjs` + `copy-check.mjs` + `copy-truth-check.mjs`（新） | 文案门禁（G1/G2/G3）与文案-行为一致性门禁（G4），并折进 verify |
| `src/host/__selfcheck__/hide-channel-check.mjs`（新） | HideChannel 活门禁 H1–H7 |
| `race-check.mjs` | 确认制用例改写为静默语义 + 新增 C13–C16（43→51） |
| `mirror-window-check.mjs` | W08–W15 结构化断言（23→31） |
| `e2e-isolated.mjs` | E36–E41 真栈断言（35→79 含条件分支） |
| `tools/visual/scenarios/*`（工作区工具，不在本仓库） | real-roundtrip 确认流→静默断言；multi-unread +AC-U-04；新增 copy-walkthrough（zh/en）、narrow-single |
| `tsconfig.json` | `types: ["node"]`（main 上 typecheck 原本即红：host 用 node:fs 而 types 为空） |

## 2 · 自审发现并修复的问题

1. **remote.ts 括号缺失**（替换字符串漏右括号）→ 语法错，构建即发现并修。
2. **locale 导入路径三级错位**（client/panel 层应为 `../../locale.ts`）→ typecheck 发现并修。
3. **Node ≥21 自带 `navigator.language=en-US`**：自检进程里词典被翻成英文，zh 断言全红 → race-check 顶部显式 `setCopyLang('zh')` 钉住；浏览器侧由 index 的语言探针跟随宿主。
4. **归档集残影**（e2e E40a 失败暴露）：destroy 不清归档集 → 销毁后 id 留在 `archivedSessionIds`，"仅看归档"过滤器见残影 → dispose 增加 `unarchiveIfArchived`（含 repeat-converged 路径）。
5. **watchdog 秒数取整为 0**（closeTimeoutMs=60 的自检场景）→ `Math.max(1, round)`。
6. **schemastery 窄 cast 无 enum**：配置 schema 加 enum 会运行期炸 → 改读取时校验（`archive|native` 之外一律 auto）。
7. **STALE 自检误加用例**：H1–H7 先加进了已标注 STALE 的 selfcheck.mjs（跑不到）→ 移至新活门禁 hide-channel-check.mjs，STALE 文件还原。

### 复核补遗（2026-10-16 二轮调研，针对收官汇报四个遗留断言）

8. **`sidebarRight` 硬依赖已代码实锤**：`dsh-client-ui-chat` 的 `inject` 数组显式含
   `"sidebarRight"`（lib/client.js Chat target inject 声明），该服务仅由
   `dsh-client-ui-sidebar-right` 提供——禁用官方右栏则会话 UI 永不激活，Path A 在
   DSH 0.2.x 上不可达。AC-U-05 偏差记录的根因链闭合，结论不变。
9. **CloseVeto 噪声根因已实锤**：`removeAfterCleanup` 同步调用处理器并立即 `commit()`，
   返回值被忽略；"Failure preserves the tab"（抛错=保留）是宿主文档化且唯一的否决通道。
   错误日志来自宿主 UI 自己的 `closeTab` 包装（`console.error("Sidebar tab close failed:")`），
   插件侧无法消除 → 已列 `docs/SEAM-REQUEST.md` S4。
10. **旧截影"还没有辅助会话"句式无法溯源（修正原判断）**：该句在插件全部 git 历史
   （`git log -S`）、当前代码、当前宿主包中均不存在；当前真页捕获证明宿主引导卡是
   "标题+描述"原样拼接（无宿主自拼模板）。§3 原第三条"宿主 EntryBox 自拼句式"的说法
   证据不足，予以撤回；矛盾风险由本插件单源 indicators + 现行文案关闭。
11. **WP2.3 闪烁断言补全**：原 e2e 只钉了"创建即归档/空闲重归档"两半，缺"回合进行中
    解档（行可见）"半——已补显式断言（`G10/WP2.3: mid-turn the archive bridge lifted
    the hide…`），每回合 1+1 闪烁的度量现在两端都有真栈证据。

## 3 · 已知残留（记录，不阻塞）

- **宿主控制台噪声（根因已实锤，见补遗 9）**：每次静默关闭宿主 UI 路径打印一条
  `Sidebar tab close failed: AuxChatCloseVeto…`（error 级、界面不可见）。抛错否决是宿主
  文档化的唯一通道，插件侧无法消除；已提 `SEAM-REQUEST` S4（降噪或显式否决返回值）。
- ~~宿主引导气泡模板~~（撤回，见补遗 10）：当前真页证明宿主按"标题+描述"原样渲染，
  无自拼模板；旧矛盾句式无法在当前宿主复现，不再作为宿主侧残留记录。
- **列表闪烁**：等 S1 接缝（docs/SEAM-REQUEST.md）；HideChannel 已备切换位。
- **render-check.mjs / selfcheck.mjs 为 STALE 参考件**（2026-10-14 标注），不在活门禁内；活门禁清单见下。

## 4 · 门禁结果（改造后）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 全绿（含 main 存量修复） |
| `npm run verify`（含 copy-check 3 + copy-truth 8） | 30 通过 |
| `npm run race-check` | 51/51 |
| `npm run drop-check` | 36 通过 |
| `npm run mirror-check` | 31 通过 |
| `npm run hide-check` | 7/7 |
| `node scripts/integration.mjs` | 32 通过 |
| `node scripts/e2e-isolated.mjs` | 80 通过（含 E36–E41 与 G10/WP2.3 闪烁断言；加固了两处日志读取竞态后连续两轮全绿） |
| visual 场景（真页+截图） | 见验收记录（本文件 §5，跑毕回填） |

## 5 · 用户视角验收（visual 真页 + 截图存证 tools/visual/evidence/）

- 已通过：real-roundtrip 9/9（含 AC-U-01 静默关闭两条：无对话框、标签移除；事实栏断言）、
  multi-unread 10/10（含 AC-U-04 两条）、copy-walkthrough en 5/5（EN 全英表面实证：
  "Temporary · inherited the latest 293 main messages · 99.9k chars (older 235 over budget)"）、
  drop-isolation 15/15、open-idempotent 2/2、pane-layout 7/7、mirror-live 4/4（顶栏事实+模型继承
  实证："…· 模型/权限继承自创建时的主会话（deepseek-flash），可独立修改"）、attachment-isolation 9/9、
  shipped-sidebar 5/5、core-journey 10/10、copy-walkthrough zh 5/5。
  **visual 合计 81 断言全绿（目标 ≥50）**；证据截图在 tools/visual/evidence/（r6-silent-closed、
  r7-fact-bar、c1-fact-bar、c2-silent-closed、m3-unread 等）。
- **验证偏差（记录在案）**：AC-U-05 窄屏单栏无法在 DSH 0.2.x 真机验证——`--no-panel` 禁用官方右栏后
  宿主 Web 启动即失败（`dsh-client-ui-chat` 等 10 个 entry 永久 pending 于 `sidebarRight` 服务，
  探针控制台证据见 probe-pathA2）。Path A 整体不可启动，属平台约束而非插件缺陷；单栏代码路径
  由 copy 门禁 + 代码审查覆盖，narrow-single.mjs 保留待宿主解耦后启用。
- 环境性波动处理：宿主欢迎遮罩偶发拦截点击 → 场景加 clearMask/clickThrough 重试守卫（非产品逻辑）。

## 6 · 第三轮：静默关闭去噪（removal-first）+ 上游议题草案

> 2026-10-16 下午 · 输入：§复核补遗实锤的 ①② 两问题 · 规划：`docs/PLAN-ROUND3-SILENT-CLOSE-DENOISE.md`

### 6.1 根因补证（在二轮基础上再钉死一层）

1. **①（sidebarRight 硬注入）**：全宿主 **10 个**客户端包在 `const inject` 数组中硬声明
   `"sidebarRight"`（ui-chat / deliverables / plan / reference / schedule / sidebar-browser /
   sidebar-files / sidebar-terminal / skill / subagent）。关键反差：ui-chat 对该服务的全部
   实际消费只有 3 处**可选**链接打开便利（client.js:12426–12436）+ 1 处 `sidebarRightTabs`
   读取——会话 UI 本体并不需要它。→ 草案 `docs/UPSTREAM-ISSUES.md` U1。
2. **②（close-veto 噪声）**：机制逐行钉死——座位 `closeTab` 包装（sidebar-right
   client.js:9175–9180）`console.error("Sidebar tab close failed")` ← `closeIn` ←
   `removeAfterCleanup`（:6439，同步调用、返回值忽略、抛错=跳过 commit）。**附加实锤**：
   `place()` 的 `replaceTab` 路径同样经过 `removeAfterCleanup` 但无 try/catch —— 我们的
   否决本可能炸掉其他插件的 replaceTab 打开。→ 草案 U2。

### 6.2 改动（WP-A，全部通过门禁）

- `src/client/store.ts`：`handleTabClose` **永不抛错**（removal-first：ready/closeFailed
  也是"启动后台清理 + 放行"）；删除 `CloseVetoError` 与 `bypassNextClose`（协议尾部的
  程序化 closeIn 由 `closed` 相位守卫放行）。`startClose` 增加两条后台路径：runtime 已随
  标签移除时的失败 → **同 operationId 自动重试一次**（宿主对部分拆除的第二调用会经
  not-registered 收敛）→ 仍失败 `console.warn`；看门狗对已消失 runtime 只 warn。
  防御面（非标准宿主保留标签时）维持 closeFailed 卡片 + 重试不动。
- `src/client/index.tsx` / `Panel.tsx`：注册处与卡片注释更新为新协议语义（文案零改动，
  copy-gates 不动）。
- 测试：`race-check.mjs` 语义翻转（veto 断言→无抛错断言）+ 新增 C17（移除先行时序：
  手势返回即 abort，后台 dispose 恰好一次、binding 清除）、C18（后台失败自动重试同
  operationId 且静默收敛）、C19（持续失败恰好一条 warn、无未处理 rejection）。
- 新 visual 场景（工作区 `tools/visual/scenarios/silent-close-noise.mjs`）：真浏览器
  关闭 → 标签**同一手势内消失**（实测 204/219ms）、closing 卡片**从不渲染**、控制台
  **零** "Sidebar tab close failed" 与零 aux 相关 error/pageerror、关闭的会话**不新增**
  列表行、reload-binding 清除。连续两轮 7/7。

### 6.3 验收记录（AC 对照）

| AC | 结果 |
| --- | --- |
| AC-A1（全相位无抛错 + 并发一次 dispose） | race C05/C09/C14/C17 ✓ |
| AC-A2（真实时序后台收尾） | race C17 ✓ |
| AC-A3（重试收敛 / 看门狗 warn） | race C18/C19 ✓ |
| AC-A4（既有不变量） | race C01–C04/C08/C10–C13/C15/C16 ✓（62/62） |
| AC-A5（快速门禁） | verify 30 · drop 36 · mirror 31 · hide 7 · integration 32 · smoke · typecheck ✓ |
| AC-B1（visual） | silent-close-noise 7/7 ×2 · core-journey 10/10 · real-roundtrip 见下 |
| AC-C1（上游草案） | docs/UPSTREAM-ISSUES.md U1/U2/U3 ✓ |
| AC-D1（全量） | e2e-isolated ×2 全绿（见 §6.4） |
| AC-D2（审查+推送） | 本节即审查记录；推送 refactor/ux-polish-v2 |

### 6.4 e2e（第三轮后 ×2）

80/80 × 2 连续全绿（/tmp 证据日志 e2e-r3-a4 / e2e-r3-b）。本轮顺带把 G10/WP2.3 的观测面
从**落盘文件**升级为**实时 session/list**：落盘的 workspace.json 会把"短回合的解档+重档"
合并成一次刷盘（门禁通过证明实时集合确实抬起过），文件观测在快回合上天然闪烁；实时列表
正是侧栏读取的用户可见面，断言从此与刷盘时序解耦（探测时验证 args 形状为 `{_request:{}}`）。
另：G10 的时间盒从 8s 放宽到 60s（回合启动落后于 prompt-accept 的队列去抖+供应商延迟）。

### 6.5 设计取舍记录

- **放弃"先销毁后移标签"的强时序**：veto 是唯一保留通道且必然产生 error 级噪声（②实锤），
  而标签消失时 会话已处于归档隐藏态，后台销毁对用户不可见 —— 时序弱化的用户可见代价为零，
  换来零噪声 + 即时消失 + replaceTab 隐患消除。失败兜底：同 opId 重试一次 → warn →
  宿主重启代际清扫（sweep）。
- **closing/closeFailed 卡片保留为防御面**：生产路径标签同手势消失、卡片永不渲染
  （visual 断言）；非标准宿主（或 race-check 直驱）下仍如实展示。文案与 copy-gates 零改动。

## 7 · 界面精简：移除顶栏继承说明条（2026-10-16 晚）

> 用户决定："删去顶部的'临时会话 · 已继承主会话最近 N 条 · …k 字符（较早 M 条超出预算） ·
> 模型/权限继承自创建时的主会话（…），可独立修改'这一类的说明性文字，保持页面简洁。"

### 7.1 改了什么

- **删除可见文字**：顶栏（`.auxc-bar`）不再渲染继承说明句的**任何**形态
  （pending / off / empty / summary / window / full 六种文案 + `inhModel` 模型后缀），
  连同它们的长按/悬停详情（`title`）与 `auxc-bar-context`/`auxc-bar-warn` 的降级着色。
  页面顶栏现在只剩：**真实镜像警告**（`mirrorWarnings`，仅有宿主报告问题时出现）、
  **主会话已归档提示**（仅在归档态出现）、以及「复制结论到主会话」动作。
- **保留不可见事实**：交付继承结果降级为顶栏上的机器可读属性
  `data-aux-inherited`（form）、`data-aux-model`、`data-aux-inherited-chars`（字符数），
  使"如实告知"这一自检属性继续可验证（mirror-live / drop-isolation / core-journey）。
- **字典收缩**：`src/locale.ts` 删除 13 个键 × 2 语言（86 → 73），zh/en 键位仍对齐。
- **门禁同步**：`copy-gates.mjs` 的 `inheritance-bar` 面替换为 `pane-bar` 面
  （只约束剩下两句告警文案：`mirrorWarnings` / `mainArchived`），行为证明标记移到
  `tools/visual/scenarios/core-journey.mjs`；`mirror-window-check.mjs` 中的旧
  `copy-truth:` 标记随之删除（其 31 项预算行为检查不变）。

### 7.2 取舍记录（诚实性如何保持）

被删除的说明条原本承担"面板必须如实说明继承了什么"的职责（2026-10-14 的实锤缺陷：
会话没有继承内容而面板宣称"已引用主会话上下文"）。移除文字后，诚实性由三处承接：

1. **数据属性**：form / chars / model 仍可从 DOM 读取，真机场景继续断言
   （含"降级可检测"：form ≠ full 时 chars 仍非空）；
2. **告警只在真实异常时出现**：镜像失败会进入 `runtime.warnings` 并渲染为警告条，
   因此"静默成功、静默失败"不会发生——失败态可见，正常态不打扰；
3. **文案字典仍是单源**：删除后不存在"面板措辞与实际交付不符"的可漂移文本。

用户可见代价（已确认接受）：正常继承过程不再可见，用户无法从界面判断本次继承是
全量、尾窗还是摘要；需要该信息时看 `data-aux-inherited*` 属性或宿主日志。
