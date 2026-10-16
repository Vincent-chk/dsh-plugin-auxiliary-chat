# 不改宿主前提下按 ZCode 模式改造的可行性评估

- 关联：[#2](https://github.com/Vincent-chk/dsh-plugin-auxiliary-chat/issues/2)、
  [BUG2-ROOTCAUSE-ZCODE-COMPARISON.md](./BUG2-ROOTCAUSE-ZCODE-COMPARISON.md)
- 前提约束：宿主 DSH 0.2.0-rc.2 冻结面不动——座位语义（`scope:'session'`）、
  `TabDomain` 的 occurrence 回收（`signal.abort`）、`registerCloseHandler` 唯一用户关闭权威、
  左侧列表的 workspace 分组与「未分组」桶、archived=不可运行耦合。
- 对照源码：ZCode @ `aac4755`。

## TL;DR

**可行，且成本是小型外科手术。** ZCode 防 bug 的四个结构性手段里，修复本 bug 需要的
三个（资源在视图树外、卸载≠销毁、销毁只认显式意图、重挂按稳定 id 复用——第 4 个与
第 3 个互为表里）**全部可以在插件内实现**，因为其中大部分机器已经存在，只是被
`signal.abort → dispose` 这一根接线短路了。做不到的两个（行存在权威/tombstone、
taskType 投影排除）都属于「列表外观」层，受宿主约束，已有缓解并列入上游诉求，
**不影响 bug 的修复**。

## 1. ZCode 模式 → 插件现状映射：大部分机器已在

| ZCode 概念 | ZCode 实现 | 插件已有对应物 | 状态 |
| --- | --- | --- | --- |
| 持久资源索引（tasks-index） | SQLite 正向权威 | host 半 marker + registry；`sweepAuxSessions` 按 marker 判活（`dispose.ts:281`，活 agent 跳过） | ✅ 已有 |
| 资源在视图树外 | CLI session service / 模块级 registry | 辅助会话本来就是宿主侧真会话；客户端只持引用（`sessions.retain`） | ✅ 已有 |
| 稳定内容身份 + 重挂复用 | tab 持 `childSessionId`，重挂按 id 重绑 | `tabKey = contentId`（跨 occurrence 稳定，`Panel.tsx:229-233`，PRD v2.0 §4.2）+ sessionStorage binding + `readBinding → reclaim`（`store.ts:373-409`，§7.1 为 reload 而建，同样覆盖 occurrence 回收） | ✅ 已有 |
| 关闭=用户意图显式附加 | × 按钮处理器显式 `closeSession` | `registerCloseHandler(AUX_TAB_KIND) → handleTabClose → startClose`（`index.tsx:382`，与 abort 通道**本来就分离**） | ✅ 已有 |
| 卸载≠销毁 | 成文规则（registry 注释） | ❌ **唯一缺失**：abort 监听直接 `closeTabSession → dispose` | 🔧 本改造 |
| 实时状态 enrich（sessions-index） | 字段级覆盖列表行 | 每 runtime 的 snapshot 订阅 | ✅ 够用（见 §3 陈旧窗口分析） |
| 父任务终态收割 | `subscribeTaskLifecycle` | ❌ 无对应事件面（宿主只暴露 `agent/pre-step`/`agent/status`，`hide.ts:188/260`）；现状靠 boot sweep 收割孤儿 | ⚪ 可选/P2 |

结论：改造不是"引入新架构"，而是**把已有的 reload-reclaim 机器升级为常规生命周期**，
并拆掉 abort 上的销毁接线。

## 2. 目标设计（代码级）

### 2.1 abort 分支改为「释放实例」，按记录存活分流

```text
signal.abort
  ├─ sidebar.tabsIn(mainSessionId) 仍含该 tab（按 id/tabKey）
  │    → occurrence 回收（视图切换/布局重算）：detachTabRuntime()
  │       删 runtime、退订 snapshot；【保留】host 引用与 binding hint；不 dispose
  └─ 记录已从布局除名且未经 close handler（罕见：布局压缩/replaceTab 边角）
       → 维持现 closeTabSession()（孤儿无法被回收，销毁是对的）
```

取向说明：abort 与布局提交之间存在竞态，规则必须**偏向保留**——错保留（其实该删）
由 boot sweep 与 close handler 兜底，可逆；错销毁不可逆，正是本 bug。

### 2.2 用户关闭路径不动

`handleTabClose → startClose`（watchdog、operationId、后台重试、`clearBinding`+
`releaseReference`+`closeIn` bound removal）保持现状。

### 2.3 在建竞态（late-success rollback）条件细化

创建在飞时 abort：回滚条件从 `signal.aborted` 收紧为 `signal.aborted && 记录已除名`。
记录仍在 → child 落地后写 binding、保留引用，等重挂 reclaim；记录已除名 → 维持现有
回滚销毁（E12/T16 语义不变）。

### 2.4 引用与幂等

- `detachTabRuntime` **不** `releaseReference`：detached 期间引用由 client store 持有，
  宿主侧 agent 得以续跑（ZCode 的后台继续）。
- `bindReference` 重挂会再次 `retain` 同一 sessionId——需幂等：`this.references` 已持有时复用。

### 2.5 重挂零改动

`Panel.tsx:242-253` 的 effect 键含 `tab?.signal`；宿主重挂 occurrence（新 signal、同
contentId）→ `ensureTabSession` 新建 runtime → `startTabSession` → `readBinding(tabKey)`
命中 → `reclaim` 同一 sessionId → 续跑。这正是 reload 路径，已被既有用例覆盖。

## 3. 边界与风险

1. **同 tabId 新 signal**：`ensureTabSession` 守卫 `has(tabId)` 直接返回。宿主
   `TabDomain.sync` 对同 tabId 复用同一 occurrence，正常不会出现；作为 P1 加固。
2. **指标陈旧窗口**：detached 期间 `indicators()` 少算该会话。分析：detach 只发生在
   主会话非激活时（座位被其他会话占用），而主会话激活 ⇒ pane 挂载 ⇒ runtime 在；
   右栏收起是 keepMounted，不触发。残余风险记录于代码注释。
3. **资源积累**：用户不关 ⇒ 辅助会话与主会话同寿命；主会话删除后由 boot sweep 收割。
4. **跨宿主重启不保留**：boot sweep 会清掉无活 agent 的 aux（现状语义）。与 ZCode
   存在产品级差异：维持现状，README 已知限制表述。
5. **回归面**：不新增词条（copy gates 零变更预期）；silent-close 行为不变。

## 4. 不改宿主做不到的（诚实清单）

| ZCode 手段 | 受阻点 | 现状缓解 | 上游诉求 |
| --- | --- | --- | --- |
| 行存在正向权威（summary 缺失不删行，TSL23-A） | 左列表归宿主 | dispose detach-LAST 已把窗口压到最小 | Seam S1/S2；Discussion #9842 |
| 显式 tombstone 负向可见性 | 同上 | 无；靠"删得够快" | Seam S2 |
| 「未分组」一等公民（显式排序） | 同上 | N/A | 同上 |
| taskType 投影排除辅助会话 | 宿主无会话类型 | 归档桥（hide.ts 的权衡已文档化） | Seam S3/S4 |
| 父会话删除 live 收割 | 无 session-delete 事件面 | boot sweep | Seam（新增候选） |

## 5. 验收标准草案

1. **模拟回收**：对 pane 的 signal 直接 `abort()`（`tabsIn` 记录仍在）→ 会话不销毁；
   重挂同 tabKey → reclaim 同一 sessionId，可继续对话。
2. **用户关闭**：close handler 路径行为与 round-3 验收完全一致。
3. **布局除名**：abort 且 `tabsIn` 无记录 → 孤儿销毁（现有回滚语义）。
4. **资源不泄漏**：往返访问 N 次，辅助会话数量不变。
5. **门禁全绿**：typecheck、verify、race、drop、mirror、hide、integration、
   e2e-isolated、visual 全套；copy gates 零新增。

## 6. 实施切分

- **P0（修 bug）**：`detachTabRuntime` + 分流规则 + rollback 条件 + `bindReference`
  幂等 + 模拟 abort 的单测与 e2e 断言。
- **P1（加固）**：同 tabId 新 signal 替换守卫；`visit-aux-session` 场景复活断言；
  指标陈旧窗口注释。
- **P2（可选对齐）**：宿主半 detached 状态推送；live 父删除收割（依赖上游事件面）；
  跨重启保留（产品决策，默认不做）。
