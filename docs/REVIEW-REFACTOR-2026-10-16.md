# 代码审查记录 · v4 改造（对标 ZCode 改造规划 v2）

> 审查人：实施代理自审 + 门禁复核 · 日期：2026-10-16
> 范围：branch `refactor/zcode-benchmark-v2` 全部改动（23 个修改文件 + 7 个新增文件，+722/−395 行）
> 决策依据：《DSH 辅助会话插件对标 ZCode 改造规划 v2》决策记录三条（划词不做//side 维持/关闭静默）

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

## 3 · 已知残留（记录，不阻塞）

- **宿主控制台噪声**：每次静默关闭宿主会打印 `Sidebar tab close failed: AuxChatCloseVeto…`。这是宿主对"handler 抛错=保留标签"契约的日志口径，非用户可见界面；若宿主未来提供"异步接管关闭"的契约应切换。
- **宿主引导气泡模板**：EntryBox 自拼"X还没有X。新建一个，<desc>"句式不受插件控制；新 desc 已无风险句，矛盾断言（AC-U-04）覆盖"未读×引导"组合。
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
| `node scripts/e2e-isolated.mjs` | 79 通过（含 E36–E41） |
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
