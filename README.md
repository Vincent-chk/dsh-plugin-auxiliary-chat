# DSH 辅助会话 · Auxiliary Chat

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在主对话旁边开一列"草稿会话"。随手问、随手关，主对话分毫不动。

## 它解决什么问题

有些问题值得问模型，但不值得写进主对话的历史：这段代码为什么这么写、帮我把这版文案润色一下、这个报错到底什么意思……问完就过去了，不需要在主对话里留下痕迹。

开一个辅助会话就行。它带着主会话的上下文开工，回答只留在自己那一列；用完了关掉，它连同会话记录一起消失——主对话从头到尾干干净净。

## 怎么用

### 打开

四种方式，任选一种：

| 方式 | 操作 |
| --- | --- |
| 右侧栏入口 | 打开右侧边栏，点「辅助会话」 |
| 标签栏 | 右侧栏标签行的 `+`，选择「辅助会话」 |
| 快捷键 | `⌘⌥S`（Windows / Linux 为 `Ctrl+Alt+S`） |
| 命令 | 在主输入框输入 `/side` |

### 提问

辅助会话有自己的输入框，直接问就好。它已经继承了主会话的内容、工作目录、模型与权限预设；你还可以在面板里单独给它换模型、换权限，怎么改都不会影响主会话。

### 把结论带回主对话

点顶部的「复制结论到主会话」，内容会作为**草稿**填进主输入框，由你确认之后再发送。插件不会替你在主会话里发任何消息。

### 拖文件

拖进辅助面板，文件只进辅助会话；拖到主对话，只进主会话。按你放手的位置决定，不会两头都进。

### 开多条

每条辅助会话是独立标签，自动编号区分。收起右栏、切换标签都只是隐藏，不会误删。

### 关闭

点标签上的关闭，它立刻消失：不弹确认框，也不问风险提示。会话日志、缓存与登记信息一并清除，不留痕迹。

## 特性

- **并排分栏**——主对话在左、辅助会话在右，同时可见，不用来回切页面。
- **继承上下文，页面保持干净**——创建那一刻，把主会话已提交的内容一次性交给辅助会话的模型；辅助会话自己的聊天页从空白开始，没有重复的历史气泡。内容过长时自动取最近的部分（默认 10 万字符预算）。顶栏保持简洁，只有真出现镜像异常或主会话已归档时才提示。
- **能力完整**——与主会话相同的工具能力，共享同一工作目录，产出的文件留在工作区。
- **状态一眼可见**——后台回复时标签显示运行指示；回复完成而你没在看时标记未读，看到即清除。
- **严格单向，绝不串门**——不会主动往主会话发消息，也不会把辅助会话的内容混进主对话。
- **关闭即清除**——辅助会话自身的痕迹（日志、缓存、登记）全部删除；工作区里由它产出的**文件保留**。
- **刷新不丢**——页面刷新后自动重连原来的会话；如果宿主已经回收了它，面板会明确告诉你，并提供一键新建。

## 安装

需要 Node ≥ 22，以及已安装的 DeepSeek Harness。

```bash
git clone https://github.com/Vincent-chk/dsh-plugin-auxiliary-chat.git
cd dsh-plugin-auxiliary-chat
npm install --no-audit --no-fund

node scripts/build.mjs                              # 构建 host + client 两侧
node scripts/smoke.mjs                              # 契约自检
node scripts/install-profile.mjs                    # 干跑：只打印将要做的改动
node scripts/install-profile.mjs --apply --no-pnpm  # 写入 desktop profile（先备份）
```

装好后重启 DeepSeek Harness 并刷新页面。

卸载：`node scripts/install-profile.mjs --uninstall --apply --no-pnpm`

> desktop profile 由 Electron 载体专属管理，`dsh plugin --profile desktop add` 会被 CLI 拒绝；安装脚本做的是同一件事（写 `dependencies` 与 `dsh.profile.bundles`），并会先备份、使用目录链接、不改动 lockfile。

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `hideFromSidebar` | `true` | 辅助会话创建后不出现在左侧会话列表与搜索中 |
| `mirrorHistory` | `true` | 是否把主会话内容交给辅助会话（对话记录、系统提示词、动态上下文）；关掉则只继承工作目录、模型路由、权限预设 |
| `mirrorMaxChars` | `100000` | 继承内容的字符预算；超出时取最近的记录，连最新一条都放不下时回退为摘要 |
| `hideChannel` | `auto` | 隐藏方式：优先使用宿主提供的原生可见性接口，没有则回退到归档方式；也可强制 `archive` / `native` |

## 已知限制

- 回合运行期间，辅助会话可能短暂出现在左侧会话列表里；在「仅看归档」过滤器下也能看到——这是平台目前还没有"隐藏但可运行"接口所致。
- `/aux-init`、`/aux-end` 是插件内部命令，可能出现在 `/` 命令菜单中，误触无害。
- 上下文继承是**创建那一刻的快照**：主会话之后新增的内容不会自动补进来，关掉重开即可带上。
- 删除依赖当前 DSH 的磁盘布局；若未来版本改动布局，关闭会退化为"停止会话但不删文件"，并在日志中记录。

## 开发者

代码分两半：`src/host/`（会话登记、上下文镜像、创建与销毁、命令通道）与 `src/client/`（分栏面板、多标签、拖放路由、界面状态）；两侧共享的冻结契约在 `src/contract.ts`。

- DSH API 实证记录：[docs/VERIFIED-API.md](docs/VERIFIED-API.md)
- 浏览器 ↔ Host 命令契约：[docs/REMOTE-CONTRACT.md](docs/REMOTE-CONTRACT.md)
- 平台约束、设计取舍与验证记录：[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)
- 希望上游补齐的平台能力：[docs/SEAM-REQUEST.md](docs/SEAM-REQUEST.md)

构建与自检脚本都在 `scripts/`：`npm run verify`、`npm run race-check`、`npm run drop-check`、`npm run mirror-check`、`node scripts/e2e-isolated.mjs`。

## License

[MIT](LICENSE)
