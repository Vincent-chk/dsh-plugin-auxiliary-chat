/**
 * Single source of truth for EVERY user-visible string of this plugin.
 *
 * Refactor plan v2 (decision revision), P0/WP0.1: before this module existed,
 * ~40 Chinese strings were hardcoded across components while the locale
 * dictionary held 8 keys — English users saw a half-translated panel and the
 * same risk concept was spelled four different ways. All copy now lives here;
 * `scripts/copy-check.mjs` fails the build when Han characters appear outside
 * this file (comments excluded), and `scripts/copy-truth-check.mjs` binds each
 * warning/state string to the test that proves the behaviour it describes.
 *
 * Decision 2026-10-16: close is SILENT. This dictionary therefore
 * contains NO pre-close risk warnings ("永久删除/无法恢复/销毁" clauses are gone);
 * the top bar reports inheritance FACTS only.
 *
 * @module client/locale
 */

/** Chinese (default) dictionary. Keys are stable; values are user-facing. */
export const zh: Record<string, string> = {
  // ── identity & entries ────────────────────────────────────────────────
  panel: '辅助会话',
  empty: '镜像当前主会话上下文，随用随关。',
  close: '关闭辅助会话',
  openNew: '新建辅助会话',
  handoff: '复制结论到主会话',
  creating: '正在创建辅助会话…',
  retry: '重试',

  // ── state cards ───────────────────────────────────────────────────────
  preparingTitle: '正在准备主会话上下文…',
  preparingBody: '用于临时提问，单向镜像当前主会话的上下文；收起可保留。',
  failedTitle: '无法创建辅助会话',
  closingTitle: '辅助会话正在关闭…',
  closingTitleLong: '仍在关闭辅助会话…',
  closingBody: '正在释放 {target}。完成后该标签会自动移除。',
  closingBodyLong: '清理时间已超过 10 秒，仍在处理 {target}。完成后该标签会自动移除。',
  closeFailedTitle: '关闭未完成：{target}',
  closeFailedBody: '{error} 内容暂时保留，清理责任仍在；重试将关闭同一条辅助会话。',
  closeFailedDefault: '主机侧清理失败。',
  retryClose: '重试关闭',
  endedTitle: '辅助会话已结束',
  endedDefault: '该会话已结束，临时会话不自动恢复。',
  unknownReason: '未知原因',

  // ── empty / unavailable surfaces ──────────────────────────────────────
  emptyMain: '还没有可镜像的主会话。',
  emptyMainHint: '打开一个主会话后重试。',
  emptyColumnHint: '点会话头部的辅助会话按钮打开第一条。',
  convUnavailable: '对话界面暂不可用',
  convUnavailableBody: 'ui-conversation 未装配或该会话尚未就绪。辅助会话本身仍可在主机侧运行，稍后重新打开本面板即可。',
  convUnavailableHintReopen: '重新打开该标签即可。',
  convUnavailableHintHost: 'ui-conversation 未装配，但辅助会话仍可在主机侧运行。',
  convUnavailableHintKeep: '辅助会话已保留，重新打开右列即可。',

  // ── narrow window: single-column mode (plan P2/WP2.1) ─────────────────
  narrowTitle: '单栏模式',
  narrowHint: '窗口较窄，辅助会话独占中栏。',
  backToMain: '返回主对话',

  // ── tab title semantics ───────────────────────────────────────────────
  srRunning: '，正在回复中',
  srUnread: '，有未读回复',
  liveDot: '有存活的辅助会话',

  // ── inheritance fact bar (facts only, no risk clauses) ────────────────
  inhPending: '临时会话 · 等待继承结果',
  inhPendingDetail: '尚未收到主机的继承结果。',
  inhOff: '临时会话 · 未继承主会话上下文',
  inhOffDetail: 'mirrorHistory 已关闭，本次没有把主会话内容交给本会话的模型。',
  inhEmpty: '临时会话 · 主会话当前没有可继承的已提交记录',
  inhEmptyDetail: '创建这一刻主会话的已提交转录为空（例如新会话、或首轮尚未提交），因此没有内容可继承。',
  inhSummary: '临时会话 · 已继承主会话摘要 {size} 字符（超长会话降级，非逐字历史）',
  inhSummaryDetail: '主会话过长，只有压缩摘要进入本会话的模型上下文（系统提示词 section），不是逐字转录。',
  inhWindow: '临时会话 · 已继承主会话最近 {entries} 条 · {size} 字符（较早 {omitted} 条超出预算）',
  inhWindowDetail: '完整的已提交转录超过 mirrorMaxChars 预算，只注入了最近的连续一段（隐藏消息，模型可见、聊天页不显示气泡）。',
  inhFull: '临时会话 · 已继承主会话上下文 {entries} 条 · {size} 字符',
  inhFullDetail: '创建瞬间的已提交转录整段注入为一条隐藏消息：模型可见，聊天页按设计不显示为气泡。',
  inhModel: ' · 模型/权限继承自创建时的主会话（{model}），可独立修改',
  mirrorWarnings: '镜像警告 {count} 条',
  mainArchived: '主会话已归档：参考历史已冻结，本辅助会话不会随归档停止。',

  // ── status line (controller events) ───────────────────────────────────
  statusClosing: '辅助会话仍在关闭（{target}）。',
  statusCloseFailed: '关闭未完成，内容暂时保留（{target}）：{error}',
  statusClosed: '辅助会话已关闭（{reason}）',
  statusReclaimFailed: '恢复辅助会话失败：{error}',
  statusReclaimBindFailed: '辅助会话已恢复，但本地绑定失败；请重试。',
  endedReasonGone: '辅助会话已结束（主机已重启或该会话已被回收）。临时会话不自动恢复。',
  statusNoMain: '没有可镜像的主会话：请先打开一个会话。',
  statusPreparing: '正在准备主会话上下文…',
  statusMirrorWarnings: '镜像警告：{warnings}',
  statusCreateFailed: '创建辅助会话失败：{error}',
  statusDisposeFailed: '标签已关闭；后台清理未完成，将在下次启动时补齐：{error}',
  statusGeometry: '面板宽度同步失败，布局可能不准；重试或刷新可恢复。',
  statusCopyFailed: '复制失败：{error}',

  // ── handoff ───────────────────────────────────────────────────────────
  handoffNoBinding: '无法回传：辅助会话当前没有本地绑定。',
  handoffNoConclusion: '无法回传：辅助会话还没有助手结论。',
  handoffDrafted: '结论已插入主会话输入框（草稿，需手动发送）。',
  handoffNotify: '辅助会话结论已作为草稿插入输入框。',
  handoffClipboard: '写入输入框被拒绝（{error}），已复制到剪贴板，请手动粘贴。',
  handoffClipboardNoCb: '写入输入框被拒绝（{error}），剪贴板也不可用。',
  handoffNoInputMachine: '输入机不可用，结论已复制到剪贴板，请手动粘贴到主会话。',
  handoffNothing: '输入机与剪贴板都不可用，无法回传结论。',

  // ── commands / shortcuts ──────────────────────────────────────────────
  sideNested: '辅助会话中无法再开启辅助会话，请先返回主会话。',
  sideAlias: '辅助会话',
  tabName: '辅助会话',
  tabNameN: '辅助会话 {n}',
  targetLabel: '{main} 的 {name}',
  closeTimeout: '关闭超过 {seconds} 秒未完成。已保留清理责任与原目标，可重试关闭。',
  cmdInitDesc: '内部指令：辅助会话初始化（请勿手动调用）',
  cmdEndDesc: '内部指令：销毁辅助会话（请勿手动调用）',
  errCommandNotRegistered: '辅助会话命令未注册：插件 host 半侧未加载或未生效',
  errPayloadUnparsable: '{label} 返回载荷无法解析：{text}',
  errForkUnavailable: '辅助会话服务不可用（sessions.fork 未装配）',
  errForkNoChild: 'sessions.fork 未返回子会话 id',
  errCommandsUnavailable: '辅助会话服务不可用（命令通道未装配）',
  errInitFailed: '{command} 报告初始化失败',
  errEndFailed: '{command} 报告销毁失败',
}

/** English dictionary; key set must match `zh` exactly (copy-check asserts). */
export const en: Record<string, string> = {
  panel: 'Side chat',
  empty: 'Mirrors the current main context; closes whenever you do.',
  close: 'Close side chat',
  openNew: 'New side chat',
  handoff: 'Copy conclusion to main chat',
  creating: 'Creating side chat…',
  retry: 'Retry',

  preparingTitle: 'Preparing main-session context…',
  preparingBody: 'For quick side questions; mirrors the main context one-way. Collapsing keeps it.',
  failedTitle: 'Could not create the side chat',
  closingTitle: 'Closing the side chat…',
  closingTitleLong: 'Still closing the side chat…',
  closingBody: 'Releasing {target}. The tab removes itself when done.',
  closingBodyLong: 'Cleanup passed 10 s and is still working on {target}. The tab removes itself when done.',
  closeFailedTitle: 'Close incomplete: {target}',
  closeFailedBody: '{error} Content is kept for now and cleanup responsibility remains; retry closes the same side chat.',
  closeFailedDefault: 'Host-side cleanup failed.',
  retryClose: 'Retry close',
  endedTitle: 'Side chat ended',
  endedDefault: 'This session ended; temporary sessions are not restored automatically.',
  unknownReason: 'unknown reason',

  emptyMain: 'No main session to mirror yet.',
  emptyMainHint: 'Open a main session and retry.',
  emptyColumnHint: 'Use the side-chat button in the conversation header to open the first one.',
  convUnavailable: 'Conversation UI unavailable',
  convUnavailableBody: 'ui-conversation is not assembled or the session is not ready yet. The side chat still runs host-side; reopen this panel later.',
  convUnavailableHintReopen: 'Reopen this tab.',
  convUnavailableHintHost: 'ui-conversation is not assembled; the side chat still runs host-side.',
  convUnavailableHintKeep: 'The side chat is kept; reopen the right column.',

  narrowTitle: 'Single-column mode',
  narrowHint: 'Narrow window: the side chat takes the middle column.',
  backToMain: 'Back to main chat',

  srRunning: ', replying',
  srUnread: ', unread replies',
  liveDot: 'live side chats',

  inhPending: 'Temporary · awaiting inheritance result',
  inhPendingDetail: 'The host has not reported the inheritance result yet.',
  inhOff: 'Temporary · main context not inherited',
  inhOffDetail: 'mirrorHistory is off; the main content was not given to this session’s model.',
  inhEmpty: 'Temporary · main session has no committed records to inherit',
  inhEmptyDetail: 'At creation the main session’s committed transcript was empty (new session, or first turn not committed), so there was nothing to inherit.',
  inhSummary: 'Temporary · inherited a {size}-char summary of the main session (long-session downgrade, not verbatim)',
  inhSummaryDetail: 'The main session is too long; only a compressed summary entered this session’s model context (system-prompt section), not a verbatim transcript.',
  inhWindow: 'Temporary · inherited the latest {entries} main messages · {size} chars (older {omitted} over budget)',
  inhWindowDetail: 'The full committed transcript exceeded the mirrorMaxChars budget; only the most recent contiguous window was injected (hidden message: model-visible, never drawn as bubbles).',
  inhFull: 'Temporary · inherited {entries} main messages · {size} chars',
  inhFullDetail: 'The committed transcript at creation was injected as one hidden message: model-visible, never drawn as bubbles by design.',
  inhModel: ' · model/permissions inherited from the main session at creation ({model}); adjustable here',
  mirrorWarnings: '{count} mirror warnings',
  mainArchived: 'Main session archived: the reference history is frozen; this side chat keeps running.',

  statusClosing: 'The side chat is still closing ({target}).',
  statusCloseFailed: 'Close incomplete; content kept for now ({target}): {error}',
  statusClosed: 'Side chat closed ({reason})',
  statusReclaimFailed: 'Restoring the side chat failed: {error}',
  statusReclaimBindFailed: 'The side chat restored but local binding failed; retry.',
  endedReasonGone: 'The side chat ended (host restarted or it was reclaimed). Temporary sessions are not restored automatically.',
  statusNoMain: 'No main session to mirror: open one first.',
  statusPreparing: 'Preparing main-session context…',
  statusMirrorWarnings: 'Mirror warnings: {warnings}',
  statusCreateFailed: 'Creating the side chat failed: {error}',
  statusDisposeFailed: 'Tab closed; background cleanup unfinished and will reconcile at next start: {error}',
  statusGeometry: 'Panel width sync failed; layout may be off. Retry or reload to recover.',
  statusCopyFailed: 'Copy failed: {error}',

  handoffNoBinding: 'Cannot hand off: the side chat has no local binding right now.',
  handoffNoConclusion: 'Cannot hand off: the side chat has no assistant conclusion yet.',
  handoffDrafted: 'Conclusion inserted into the main input as a draft (send manually).',
  handoffNotify: 'Side-chat conclusion inserted into the input as a draft.',
  handoffClipboard: 'Input write refused ({error}); copied to clipboard, paste manually.',
  handoffClipboardNoCb: 'Input write refused ({error}); clipboard unavailable too.',
  handoffNoInputMachine: 'Input machine unavailable; conclusion copied to clipboard, paste into the main session.',
  handoffNothing: 'Neither input machine nor clipboard is available; cannot hand off.',

  sideNested: 'Cannot open a side chat inside a side chat; return to the main session first.',
  sideAlias: 'side chat',
  tabName: 'Side chat',
  tabNameN: 'Side chat {n}',
  targetLabel: '{name} of {main}',
  closeTimeout: 'Close exceeded {seconds}s without finishing. Cleanup responsibility and the original target are kept; retry closes the same side chat.',
  cmdInitDesc: 'Internal command: side-chat initialization (do not invoke manually)',
  cmdEndDesc: 'Internal command: side-chat destruction (do not invoke manually)',
  errCommandNotRegistered: 'Side-chat command not registered: the plugin host half is not loaded or not active',
  errPayloadUnparsable: '{label} returned an unparsable payload: {text}',
  errForkUnavailable: 'Side-chat service unavailable (sessions.fork not assembled)',
  errForkNoChild: 'sessions.fork did not return a child session id',
  errCommandsUnavailable: 'Side-chat service unavailable (command channel not assembled)',
  errInitFailed: '{command} reported initialization failure',
  errEndFailed: '{command} reported destruction failure',
}

export type CopyLang = 'zh' | 'en'

function detectLang(): CopyLang {
  try {
    const nav = (globalThis as { navigator?: { language?: string } }).navigator
    const language = nav?.language ?? ''
    if (language === '') return 'zh'
    return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

let currentLang: CopyLang = detectLang()

/** Set the active language (index.tsx re-probes on `languagechange`). */
export function setCopyLang(lang: CopyLang): void {
  currentLang = lang
}

export function getCopyLang(): CopyLang {
  return currentLang
}

/** Resolve one key in zh (fallback for React `t`-less paths). */
export function copy(key: string): string {
  return zh[key] ?? key
}

/** Substitute `{vars}` into an already-translated string. */
export function substitute(raw: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Resolve one key in the active language and substitute `{vars}`.
 * Used by non-React modules (store/handoff) where framework `t` is absent.
 */
export function msg(key: string, vars?: Record<string, string | number>): string {
  const raw = (currentLang === 'en' ? en[key] : zh[key]) ?? zh[key] ?? key
  return substitute(raw, vars)
}
