# Round 4 计划与验收：occurrence 回收 ≠ 用户关闭（Issue #2）

- 关联：[#2](https://github.com/Vincent-chk/dsh-plugin-auxiliary-chat/issues/2)
- 分支：`fix/issue-2-occurrence-detach`（改善版本独立分支，未经确认不并 main）

## 1. 问题与根因（一段版）

宿主回收 tab occurrence（座位切换/布局重算）会 abort `tab.signal`；插件曾把每次
abort 当成用户关闭并销毁辅助会话，销毁流程的 `detachSession` 让左侧列表出现
「未分组」残行，主会话的辅助会话随之失效。根因是把资源生命周期绑在了 UI 实例上
。

## 2. 设计（落地形态）

```text
signal.abort（occurrence 被宿主回收）
  ├─ tabsIn(mainSessionId) 仍含该 tab 记录（按 id 或 contentId===tabKey）
  │    → detachTabRuntime：删 runtime、退订快照；
  │      保留 会话 / sessions.retain 引用 / tabKey 绑定 —— 静默，无文案
  └─ 记录已从已提交布局除名（罕见：布局压缩等，用户关闭已由 close handler 承接）
       → closeTabSession（原 removal-first 销毁路径，行为不变）

在飞竞态（create / reclaim 未返回时 occurrence 释放）
  ├─ 记录活 → bindDetached / retainDetached：child 落地后写绑定、持引用，等重挂 reclaim
  └─ 记录亡 → 维持 E06/T04/R09 回滚销毁

重挂（新 occurrence、同 contentId）
  → ensureTabSession → readBinding → reclaim 同一 child → bindReference 幂等复用引用
```

分流刻意**偏向保留**：错保留由 close handler / boot sweep 兜底（可逆），错销毁不可逆
（即本 bug）。安全边际：`sidebarRight` 缺席或 `tabsIn` 抛错一律读作"记录仍活"。

## 3. 变更清单

| 位置 | 变更 |
| --- | --- |
| `src/client/store.ts` | `onOccurrenceReleased`/`tabRecordAlive`/`detachTabRuntime`/`bindDetached`/`retainDetached`；abort 监听分流；create/reclaim 在飞分支按记录存活分流；`bindReference` 引用幂等；`ensureTabSession` 同 id 新 signal 替换守卫；过期 occurrence 的迟到 abort 被忽略 |
| `src/client/__selfcheck__/race-check.mjs` | fake `tabsIn` 改为可编程的已提交布局记录；C20–C23（detach+重挂 reclaim 同一 child、迟到 create 保留、同 id 超越、reclaim 在飞释放） |
| `scripts/e2e-isolated.mjs` | E42/E43：仅卸载（未 `/aux-end`）的 child 保留 marker/transcript/workspace 成员资格，且同一 child 可再次 reclaim（重挂契约，不 fork） |
| `tools/visual/scenarios/visit-aux-session.mjs`（工作区） | 6→9：第二轮切换往返后绑定不变、草稿保留 |
| `README.md` | 已知限制补充"不跨宿主重启保留" |
| 不变 | `contract.ts`、locale 词条（零新增 UI 文案）、宿主、归档桥、用户关闭协议（round-3 全语义） |

## 4. 验收结果

| 门禁 | 结果 |
| --- | --- |
| typecheck | ✓ |
| verify（含 copy gates） | 30/30 ✓ |
| race-check | 78/78 ✓（62 旧全绿 + 16 新） |
| drop-router / mirror-window / hide-channel | 36 / 31 / 7 ✓ |
| integration | 32/32 ✓ |
| smoke | ✓ |
| e2e-isolated | 84/84 ✓（80 + E42×3 + E43） |
| visual：visit-aux-session | 9/9 ✓（含二轮往返：绑定不变、草稿保留、回合续跑） |
| visual：其余场景回归 | silent-close-noise 7/7 · core-journey 12/12 · copy-walkthrough zh 6/6 + en 6/6 · mirror-live 4/4 · drop-isolation 15/15 · real-roundtrip 13/13 ✓ |

关键证据（visit-aux-session 运行日志）：访问 `[辅助]` 行再返回、以及**再次**访问返回，
pane 始终绑定同一 `data-aux-session`，composer 可输入、未提交草稿原样保留、回合持续
输出、控制台零错误——"看一眼 = 关掉并销毁"的缺陷不复存在。

场景工具随批加固（工作区 `tools/visual/`，非产品代码）：欢迎/公告模态的关闭改为
语言无关（继续/Continue/Got it/知道了/… + Escape 兜底），real-roundtrip 的引导点击
改为清遮罩重试、收尾重开步骤改为聚焦重试——en-US 与 real-roundtrip 此前的崩溃均
为该脚本脆弱性，与插件改动无关（加固后 6/6、13/13 全绿）。

## 5. 残余风险与后续

- detached 期间 `indicators()` 不计入该 child（用户不可见窗口，代码注释已述）；P2 可做宿主半推送。
- 记录存活判定依赖 `tabsIn` 读已提交布局：宿主未来若把"挂载态"混入该读数，需复核。
- 上游四项（行存在权威/tombstone、未分组一等公民、taskType 投影、父删除 live 收割）
  维持 Seam 诉求，不在本轮。
