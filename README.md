# DSH 辅助会话 · Auxiliary Chat

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在当前会话窗口右侧开一列临时"草稿会话"。主对话在左，辅助会话在右——随手问、随手删，主会话分毫不动。

## 为什么需要它

调试到一半，想问一句"这段代码为什么这么写"；或者让模型先润色一版文案，满意了再放进主对话——这类不值得进入主对话历史的小问题，现在有了去处：开一个辅助会话，它带着主会话的上下文开工，问完关掉就永久消失，主会话干干净净。

## 核心特性

### 并排分栏，不打断主对话

- ChatGPT 式布局：主对话在左、辅助会话在右，同时可见；收起即隐藏，不切换页面
- 多种入口：右侧栏「辅助会话」入口或 tab 栏 `+`、桌面快捷键 `⌘⌥S`（Win/Linux `Ctrl+Alt+S`）、主输入框 `/side` 命令
- 可以开多条辅助会话，各自独立标签、编号区分；收起、切换都只是隐藏，不会误删

### 上下文单向继承，聊天页保持干净

- 辅助会话"知道"主会话聊了什么：创建瞬间把主会话已提交的对话一次性快照给模型
- 但聊天页面是全空白的——没有重复的历史气泡，只有你接下来问的内容
- 主会话完全无感：日志字节级不变，看不到任何辅助会话的痕迹
- 超长会话自动截取最近的记录（默认 100k 字符预算）；面板顶部**不显示**继承说明文字（2026-10-16 晚决策，保持页面简洁），继承结果以不可见的数据属性记录在顶栏上，便于自检与排障

### 完整能力，独立配置

- 与主会话相同的完整工具能力，共享同一工作目录，产出的文件保留在工作区
- 模型与权限预设创建时继承主会话，之后可在面板内独立修改
- 回复在后台运行时标签显示 spinner，完成标记未读，实际看到后清除

### 关闭即永久删除（静默）

- 关闭标签 = 会话日志、缓存、标记文件全部清除，不留痕迹；**不弹确认、不问风险**（2026-10-16 决策，对标 ZCode 的静默关闭）
- 标签**立即消失**（removal-first，2026-10-16 第三轮），清理在后台完成：失败以同一操作号自动重试一次，仍失败则记录警告、由宿主重启的代际清扫兜底——不会静默失败而无人知晓
- 工作区里由辅助会话产出的文件**保留**（删除只针对会话自身痕迹）
- 默认不出现在左侧会话列表与搜索中；回合运行期间列表行短暂可见（平台接缝限制，见 docs/SEAM-REQUEST.md）

### 严格单向，绝不串门

- 「复制结论到主会话」只把文本作为草稿插入主输入框，由你确认后才发送
- 拖文件进辅助面板只进辅助会话，拖到主列只进主会话——按投放位置路由
- 页面刷新后自动重连原会话；若宿主已回收，面板会明确告知并提供一键新建

## 安装

需要 Node ≥ 22。

```bash
git clone https://github.com/Vincent-chk/dsh-plugin-auxiliary-chat.git
cd dsh-plugin-auxiliary-chat
npm install --no-audit --no-fund

node scripts/build.mjs                              # 构建 host + client 两侧
node scripts/smoke.mjs                              # 契约自检
node scripts/install-profile.mjs                    # 干跑：只打印将做的改动
node scripts/install-profile.mjs --apply --no-pnpm  # 写入 desktop profile（先备份，目录链接，不动 lockfile）
```

装好后**重启 DeepSeek Harness** 并刷新页面。卸载：`node scripts/install-profile.mjs --uninstall --apply --no-pnpm`。

> desktop profile 由 Electron 载体专属管理，`dsh plugin --profile desktop add` 会被 CLI 硬拒；安装脚本做的是同一件事（写 `dependencies` + `dsh.profile.bundles`）。

## 配置

Cordis 插件配置，共三项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `hideFromSidebar` | `true` | 辅助会话创建后立即归档，不出现在会话列表与搜索中 |
| `mirrorHistory` | `true` | 是否镜像主会话内容（对话记录、系统提示词、动态上下文）；`false` 则只保留 cwd、模型路由、权限预设等事实信息 |
| `mirrorMaxChars` | `100000` | 全量镜像的字符预算；超出取最近记录，最新一条都放不下时回退摘要 |
| `hideChannel` | `auto` | 隐藏通道：`auto` 优先用宿主原生可见性接缝（若存在），否则归档桥接；`archive`/`native` 强制单侧 |

## 已知边界

- 「仅看归档」过滤器下仍能看到辅助会话；回复运行期间列表行短暂可见（根因与需求见 docs/SEAM-REQUEST.md S1）
- `/aux-init`、`/aux-end` 是内部命令，可能出现在 "/" 菜单里（平台限制），误触无害
- 上下文继承是创建时的一次性快照；主会话后续新增内容，需关闭重开才会带上
- 删除依赖当前 DSH 磁盘布局；若未来版本改变布局，关闭会退化为"停止会话但不删文件"并留日志

## 开发

```bash
node scripts/build.mjs --half client    # 只打浏览器侧，保存后 ~500ms 热更
node scripts/build.mjs --half host      # 只打 Node 侧，需重启 DSH 生效

npm run verify                          # 产物与 manifest 硬条件
npm run race-check                      # 关闭协议竞态自检
npm run drop-check                      # 拖放隔离自检
npm run mirror-check                    # 上下文尾窗预算自检
node scripts/e2e-isolated.mjs           # 隔离实例端到端（自建一次性 DSH_HOME，不碰运行中的应用）
```

代码结构：`src/host/`（会话登记、上下文镜像、创建与销毁、命令通道）、`src/client/`（分栏面板、多标签、拖放路由、本地状态）、`src/contract.ts`（两侧共享的冻结契约）。

> 平台约束分析、设计取舍与完整验证台账见 [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)；已实证的 DSH API 参考见 [docs/VERIFIED-API.md](docs/VERIFIED-API.md)，浏览器↔Host 命令契约见 [docs/REMOTE-CONTRACT.md](docs/REMOTE-CONTRACT.md)。

## License

[MIT](LICENSE)
