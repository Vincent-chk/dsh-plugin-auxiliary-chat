/**
 * Inline SVG glyphs for this plugin.
 *
 * Drawn here rather than imported from `@deepseek-ai/dsh-client-ui-primitives`
 * on purpose: the client half then requires only `react` /
 * `react/jsx-runtime`, so a renamed or missing icon export in a future DSH
 * release can never break the bundle. Stroke geometry follows the shipped icon
 * set (16px viewBox, 1px regular / 1.3px active stroke, `currentColor`).
 * @module client/panel/icons
 */
import type { ReactNode } from 'react'

/** Props every glyph shares. */
export interface IconProps {
  /** Square edge in pixels. */
  size: number
  /** Whether the surrounding control is engaged (picks the heavier stroke). */
  active?: boolean | undefined
}

/** Shared wrapper: one 16-unit viewBox rendered at `size`. */
function Glyph(props: {
  size: number
  strokeWidth: number
  className?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={props.className}
    >
      {props.children}
    </svg>
  )
}

/**
 * Conversation-header toggle: a frame whose right column is filled.
 * @param props.size - square edge.
 * @param props.active - true while the auxiliary column is expanded.
 * @returns the glyph.
 */
export function IconPanelRight(props: IconProps): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={props.active === true ? 1.3 : 1}>
      <rect x="2.1" y="3.1" width="11.8" height="9.8" rx="1.2" />
      <path d="M9.7 3.1v9.8" />
      <path d="M11.3 6.2h1.5M11.3 8.7h1.5" />
    </Glyph>
  )
}

/** Tab glyph marking one auxiliary session row. */
export function AuxTabGlyph(props: IconProps): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={props.active === true ? 1.3 : 1}>
      <path d="M2.6 8a5.4 5.4 0 1 1 2.2 4.32L2.6 13.1l.62-2.1A5.36 5.36 0 0 1 2.6 8Z" />
    </Glyph>
  )
}

/** `+` used by the new-tab action. */
export function IconPlus(props: IconProps): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={1.3}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Glyph>
  )
}

/** `×` used by the close actions. */
export function IconClose(props: IconProps): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={1.3}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </Glyph>
  )
}

/** Arrow-into-sheet used by the "send conclusion to the main chat" action. */
export function IconHandoff(props: IconProps): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={1.3}>
      <path d="M2.4 8h6.9M6.5 5.1L9.4 8l-2.9 2.9" />
      <path d="M11.6 2.9v10.2" />
    </Glyph>
  )
}

/** Wide empty-state mark: an outline bubble with a mirror arrow. */
export function EmptyGlyph(props: { size: number }): ReactNode {
  return (
    <Glyph size={props.size} strokeWidth={1}>
      <path d="M2.6 7.4a4.8 4.8 0 1 1 1.96 3.84L2.6 12.2l.56-1.9A4.77 4.77 0 0 1 2.6 7.4Z" />
      <path d="M11.4 4.6h2.2M12.5 3.5v2.2" />
    </Glyph>
  )
}
