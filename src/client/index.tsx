/**
 * Client half: right-Sidebar auxiliary chat tab type (Path B, the live path)
 * with an owned-column fallback (Path A) when the shipped Sidebar is absent.
 *
 * PRD-aligned behaviours this seats:
 * - the guide capsule is idempotent 打开 (focus existing); 新建 is a tab-menu row;
 * - internal `/aux-init` and `/aux-end` command rows render to nothing;
 * - closing a non-empty tab asks for confirmation (the panel owns the dialog);
 * - ⌘⌥S / Ctrl+Alt+S and the `/side` composer command open the side chat, and
 *   `/side` is refused inside an auxiliary session.
 * @module client/index
 */
import type { Context } from '@deepseek-ai/cordis'
import css from './styles.css?inline'
import { LOCALE_NS, PACKAGE_NAME, PANEL_ID, RETAIN_SOURCE } from '../contract.ts'
import { AuxChatBody } from './panel/ChatView.tsx'
import {
  AuxHeaderToggle,
  AuxNewMenu,
  AuxPaneBody,
  AuxPaneTabTitle,
  AuxRightbarPanel,
  setController,
} from './panel/Panel.tsx'
import { EmptyGlyph } from './panel/icons.tsx'
import { AuxChatController, newSessionId } from './store.ts'
import { createPlainSession, endAuxSession, initAuxSession, reclaimAuxSession } from './remote.ts'
import { handoffToMain } from './panel/handoff.ts'
import type {
  ClientContextLike,
  Disposable,
  ShortcutDefinitionLike,
  SidebarRightLike,
  SidebarRightTabDefinitionLike,
  SidebarRightTabsLike,
} from './types.ts'

/**
 * Cordis services this client half waits for.
 *
 * `remote.commands` is the frozen transport both halves ride (the gateway
 * mounts every Remote namespace as its own service, so it must be declared
 * rather than probed). The optional faces (`sidebarRight`, `shortcuts`,
 * `commandUi`) are probed lazily inside effects instead, so their absence
 * degrades to a warning instead of failing activation.
 */
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.commands']

/** Tab type discriminator registered through the official right Sidebar. */
const AUX_TAB_KIND = 'aux-chat'

/** Shipped right Sidebar package, as listed in the page boot manifest. */
const OFFICIAL_RIGHT_SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar-right'

/** Grace period before the fallback claims the seat on a failed shipped row. */
const OFFICIAL_SEAT_GRACE_MS = 3_000

/**
 * Locale dictionary (key set asserted by `scripts/smoke.mjs` — extend both).
 */
const zh: Record<string, string> = {
  panel: '辅助会话',
  empty: '镜像当前主会话的上下文，关闭后永久删除。',
  close: '结束并销毁辅助会话',
  handoff: '复制结论到主会话',
  creating: '正在创建辅助会话…',
  retry: '重试',
  openNew: '新建辅助会话',
  contextHint: '临时会话 · 已引用主会话上下文 · 关闭后无法恢复',
}
const en: Record<string, string> = {
  panel: 'Side chat',
  empty: 'Mirrors the main conversation; deleted permanently when closed.',
  close: 'End and destroy the side chat',
  handoff: 'Copy conclusion to the main chat',
  creating: 'Creating side chat…',
  retry: 'Retry',
  openNew: 'New side chat',
  contextHint: 'Temporary · references the main context · gone when closed',
}

/** Inject the plugin stylesheet once per document. */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  const head = document.head
  if (head === undefined || head === null) return
  // Every DOM call is feature-detected because the offline smoke harness
  // installs only a minimal `document`.
  const query = typeof document.querySelector === 'function' ? document.querySelector(`style[data-plugin-css="${PACKAGE_NAME}/client/styles.css"]`) : null
  if (query !== null && query !== undefined) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PACKAGE_NAME
  tag.dataset.pluginCss = `${PACKAGE_NAME}/client/styles.css`
  tag.textContent = css
  head.appendChild(tag)
}

function probeOfficialTabs(client: ClientContextLike): SidebarRightTabsLike | undefined {
  let face: unknown
  try {
    face = client.get('sidebarRightTabs')
  } catch {
    return undefined
  }
  const candidate = face as SidebarRightTabsLike | undefined
  return candidate !== undefined && typeof candidate.register === 'function' ? candidate : undefined
}

/** Whether the page boot manifest contains the shipped right Sidebar. */
function manifestHasOfficialRightSidebar(): boolean {
  try {
    const manifest = (globalThis as { __DSH_BOOT__?: { entries?: readonly { readonly id?: unknown }[] } }).__DSH_BOOT__
    return Array.isArray(manifest?.entries) && manifest.entries.some((entry) => entry?.id === OFFICIAL_RIGHT_SIDEBAR)
  } catch {
    return false
  }
}

/** Null renderer for the internal command rows (clean panel transcript). */
function HiddenCommandRow(): null {
  return null
}

/**
 * Install the plugin's seats, choosing the shipped-tab path or the owned-column
 * path without ever blocking the shipped right Sidebar's own activation.
 */
function installSeats(ctx: Context, client: ClientContextLike, controller: AuxChatController): Disposable {
  const slots = client.slots
  let seatParts: Disposable[] = []
  let mode: 'none' | 'rightbar' | 'official' = 'none'

  const disposeSeats = (): void => {
    const parts = seatParts
    seatParts = []
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      try {
        parts[i]?.()
      } catch {
        /* a failing disposer must not block the rest */
      }
    }
  }

  // ── Path B: ride the shipped two-stage tab system ─────────────────────
  const startOfficialPath = (): void => {
    if (mode === 'official') return
    const tabs = probeOfficialTabs(client)
    if (tabs === undefined) return
    disposeSeats()
    const definition: SidebarRightTabDefinitionLike = {
      id: PANEL_ID,
      kind: AUX_TAB_KIND,
      priority: 'extension',
      multiple: true,
      keepMounted: true,
      title: () => t('panel'),
      guide: [
        {
          id: 'aux-chat.open',
          order: 40,
          title: () => t('panel'),
          description: () => t('empty'),
          // Shipped EntryBox renders the icon/card; EmptyGlyph = mirror bubble.
          icon: EmptyGlyph,
        },
      ],
    }
    seatParts = [
      tabs.register(definition),
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register(
          { name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: LOCALE_NS, children: { [SLOT_AUX_CHAT]: { kind: 'single', scope: 'session' } } },
          AuxPaneBody,
        ),
      ),
      slots.inject('sidebar.right.pane.tab.title', () =>
        slots.register({ name: 'sidebar.right.pane.tab.title', key: PANEL_ID, locale: LOCALE_NS }, AuxPaneTabTitle),
      ),
      // No custom "sidebar.right.tab.guide.entry" occupant: the shipped EntryBox
      // already renders the card (same design as 工作区文件/新建终端/浏览器); a
      // custom button had no stylesheet and appeared as a plain bar.
      // Explicit 新建 action on every right-Sidebar tab menu.
      slots.inject('sidebar.right.tab.menu.item', () =>
        slots.register({ name: 'sidebar.right.tab.menu.item', id: 'aux-chat-new', locale: LOCALE_NS }, AuxNewMenu),
      ),
    ]
    mode = 'official'
    onPathChange?.()
  }

  // ── Path A: own the frame column ──────────────────────────────────────
  const startRightbarPath = (): void => {
    if (mode !== 'none') return
    seatParts = [
      slots.inject('conversation.session.header.utilities', () =>
        slots.register({ name: 'conversation.session.header.utilities', id: PANEL_ID, order: 20, locale: LOCALE_NS }, AuxHeaderToggle),
      ),
      slots.inject('rightbar', () =>
        slots.register(
          {
            name: 'rightbar',
            children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
          },
          AuxRightbarPanel,
        ),
      ),
    ]
    mode = 'rightbar'
    onPathChange?.()
  }

  let onPathChange: (() => void) | undefined

  if (probeOfficialTabs(client) !== undefined) startOfficialPath()
  else if (!manifestHasOfficialRightSidebar()) startRightbarPath()

  // Registry arriving later moves us onto path B and tears the column down.
  let latch: Disposable | undefined
  if (typeof ctx.inject === 'function') {
    try {
      const fiber = ctx.inject(['sidebarRightTabs'], () => {
        startOfficialPath()
      })
      latch = () => {
        try {
          void (fiber as unknown as { dispose?: () => unknown }).dispose?.()
        } catch {
          /* best effort */
        }
      }
    } catch {
      latch = undefined
    }
  } else if (probeOfficialTabs(client) !== undefined) {
    startOfficialPath()
  }

  // Bounded fallback: shipped row listed but never activated.
  let fallback: ReturnType<typeof setTimeout> | undefined
  if (mode === 'none' && manifestHasOfficialRightSidebar()) {
    fallback = setTimeout(() => {
      if (mode === 'none' && probeOfficialTabs(client) === undefined) startRightbarPath()
    }, OFFICIAL_SEAT_GRACE_MS)
  }

  return () => {
    if (fallback !== undefined) clearTimeout(fallback)
    latch?.()
    disposeSeats()
  }
}

function t(key: string): string {
  return zh[key] ?? key
}

/** Root slot id for the conversation hole (shared by both panel bodies). */
const SLOT_AUX_CHAT = 'aux-chat.conversation'

/**
 * Wire the plugin into one client root.
 */
export function apply(ctx: Context): void {
  const client = ctx as unknown as ClientContextLike
  injectStyles()

  let translate: ((key: string) => string) | undefined

  ctx.effect(() => {
    try {
      translate = client.locale.bind?.(LOCALE_NS)
    } catch {
      translate = undefined
    }
    const disposeLocale = client.locale.register(LOCALE_NS, { zh, en })
    return [disposeLocale]
  }, 'aux-chat: registry + dictionaries')

  /**
   * The composer session context carries `sessionId` (verified against
   * ui-commands' own `warm(session)`); accept both spellings defensively.
   */
  const sessionIdOf = (session: unknown): string | undefined => {
    if (typeof session === 'string') return session
    if (session !== null && typeof session === 'object') {
      const record = session as { sessionId?: unknown; id?: unknown }
      if (typeof record.sessionId === 'string') return record.sessionId
      if (typeof record.id === 'string') return record.id
    }
    return undefined
  }

  const officialSeat = (): SidebarRightLike | undefined => {
    try {
      const face = client.get('sidebarRight') as SidebarRightLike | undefined
      return face !== undefined && typeof face.openTab === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }

  const controller = new AuxChatController({
    sessions: client.sessions,
    retainSource: RETAIN_SOURCE,
    create: async (auxSessionId, cwd, mainSessionId) => {
      // Two-phase creation keeps the main session log untouched (R06).
      await createPlainSession(client, auxSessionId, cwd)
      return initAuxSession(client, auxSessionId, mainSessionId, { requestId: auxSessionId })
    },
    reclaim: (auxSessionId, mainSessionId) => reclaimAuxSession(client, auxSessionId, mainSessionId),
    dispose: (auxSessionId, options) => endAuxSession(client, auxSessionId, options),
    handoff: (auxSessionId, mainSessionId) => handoffToMain(client, auxSessionId, mainSessionId),
    present: (shown) => {
      // Path B owns geometry itself; only Path A reports to the frame.
      const layout = (() => {
        try {
          return client.get('layout') as { openRightbar?(track: boolean, fullscreen: boolean): void; closeRightbar?(): void } | undefined
        } catch {
          return undefined
        }
      })()
      if (shown) layout?.openRightbar?.(true, false)
      else layout?.closeRightbar?.()
    },
    client,
  })
  ctx.effect(() => {
    setController(controller)
    return () => setController(undefined)
  }, 'aux-chat: controller')

  const disposers: Disposable[] = []

  // Seats + the internal-command hidden rows (transcript stays clean).
  ctx.effect(() => {
    const disposeSeats = installSeats(ctx, client, controller)
    const disposeConversationHole = client.slots.inject(SLOT_AUX_CHAT, () =>
      client.slots.register({ name: SLOT_AUX_CHAT, locale: LOCALE_NS }, AuxChatBody),
    )
    const hiddenRows = ['aux-init', 'aux-end'].map((name) =>
      client.slots.inject('conversation.chat.commandview', () =>
        client.slots.register({ name: 'conversation.chat.commandview', key: name, locale: LOCALE_NS }, HiddenCommandRow),
      ),
    )
    return [disposeSeats, disposeConversationHole, ...hiddenRows]
  }, 'aux-chat: seats')

  // Close confirmation: veto the framework removal for non-empty tabs.
  ctx.effect(() => {
    let dispose: Disposable | undefined
    const install = (): void => {
      const sidebar = officialSeat()
      if (sidebar?.registerCloseHandler === undefined || dispose !== undefined) return
      try {
        dispose = sidebar.registerCloseHandler(AUX_TAB_KIND, (_sessionId, tab) => {
          controller.handleTabClose(tab)
        })
      } catch {
        dispose = undefined
      }
    }
    install()
    if (typeof ctx.inject === 'function') {
      try {
        const fiber = ctx.inject(['sidebarRight'], () => install())
        return () => {
          dispose?.()
          void (fiber as unknown as { dispose?: () => unknown }).dispose?.()
        }
      } catch {
        /* the latch is a convenience */
      }
    }
    return () => dispose?.()
  }, 'aux-chat: close handler')

  // ⌘⌥S / Ctrl+Alt+S (desktop only; never claimed on Web). The shortcuts
  // service is not in the inject list, so it is installed through a latch:
  // reading it as a context property on an undeclared path throws, and a
  // one-shot probe can run before the owning package has activated.
  const installShortcut = (): Disposable => {
    const shortcuts = (() => {
      try {
        const face = client.get('shortcuts') as { register?: unknown } | undefined | null
        return face !== undefined && face !== null && typeof face.register === 'function' ? face : undefined
      } catch {
        return undefined
      }
    })() as { register(definition: ShortcutDefinitionLike): Disposable } | undefined
    if (shortcuts === undefined) return () => undefined
    const mountedMain = (): string | undefined => {
      try {
        return officialSeat()?.mounted?.getSnapshot() ?? controller.mainSessionId
      } catch {
        return controller.mainSessionId
      }
    }
    const definition: ShortcutDefinitionLike = {
      id: 'aux-chat.toggle',
      label: () => t('panel'),
      aliases: ['side chat', '辅助会话'],
      defaults: {
        'desktop:macos': { code: 'KeyS', modifiers: ['meta', 'alt'] },
        'desktop:windows': { code: 'KeyS', modifiers: ['control', 'alt'] },
        'desktop:linux': { code: 'KeyS', modifiers: ['control', 'alt'] },
      },
      regions: ['page', 'editable'],
      modals: [],
      resolve: () => ({ status: 'handled', run: () => controller.openOrFocus(mountedMain()) }),
    }
    try {
      return shortcuts.register(definition)
    } catch (error) {
      // Wrong platform, duplicate id, or an older registry: degrade, never fail boot.
      console.warn('aux-chat: shortcut not registered', error)
      return () => undefined
    }
  }
  ctx.effect(() => {
    let dispose: Disposable = installShortcut()
    let latchDispose: Disposable | undefined
    if (typeof ctx.inject === 'function') {
      try {
        const fiber = ctx.inject(['shortcuts'], () => {
          dispose?.()
          dispose = installShortcut()
        })
        latchDispose = () => {
          try {
            void (fiber as unknown as { dispose?: () => unknown }).dispose?.()
          } catch {
            /* best effort */
          }
        }
      } catch {
        latchDispose = undefined
      }
    }
    return () => {
      dispose?.()
      latchDispose?.()
    }
  }, 'aux-chat: shortcut')

  // `/side` composer command (and nested refusal). Same latch pattern as the
  // shortcut: the commandUi service may activate after this plugin.
  const installSideCommand = (): Disposable => {
    const commandUi = (() => {
      try {
        const face = client.get('commandUi') as { register?: unknown } | undefined | null
        return face !== undefined && face !== null && typeof face.register === 'function' ? face : undefined
      } catch {
        return undefined
      }
    })() as { register(contribution: unknown): Disposable } | undefined
    if (commandUi === undefined) return () => undefined
    try {
      return commandUi.register({
        name: 'side',
        label: () => t('panel'),
        description: () => t('empty'),
        available: (session?: unknown) => {
          return !controller.isAuxSession(sessionIdOf(session))
        },
        ui: {
          kind: 'action',
          run: (session?: unknown) => {
            const id = sessionIdOf(session)
            const target = id ?? officialSeat()?.mounted?.getSnapshot() ?? controller.mainSessionId
            if (controller.isAuxSession(target)) {
              // PRD copy: nesting is refused; nothing is sent.
              throw new Error('辅助会话中无法再开启辅助会话，请先返回主会话。')
            }
            controller.openOrFocus(target)
          },
        },
      })
    } catch (error) {
      console.warn('aux-chat: /side command not registered', error)
      return () => undefined
    }
  }
  ctx.effect(() => {
    let dispose: Disposable = installSideCommand()
    let latchDispose: Disposable | undefined
    if (typeof ctx.inject === 'function') {
      try {
        const fiber = ctx.inject(['commandUi'], () => {
          dispose?.()
          dispose = installSideCommand()
        })
        latchDispose = () => {
          try {
            void (fiber as unknown as { dispose?: () => unknown }).dispose?.()
          } catch {
            /* best effort */
          }
        }
      } catch {
        latchDispose = undefined
      }
    }
    return () => {
      dispose?.()
      latchDispose?.()
    }
  }, 'aux-chat: /side command')

  // Desktop semantics: on reload the process-session aux chats are swept by
  // the host; do not actively destroy on unload (the tab record disappearing
  // already drives teardown, and PRD distinguishes hide from destroy).

  void disposers
  void translate
  void newSessionId
}
