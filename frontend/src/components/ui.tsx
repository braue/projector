// UI PRIMITIVES — the single seam for adopting an internal design system.
//
// Every generic control and display element the app uses is defined here and
// ONLY here: views (App, ProjectSidebar, FileTree, Preview, DiffPreview,
// CompareView, AggregateView) never render a raw <button>, <select>, <table>,
// <input>, or <textarea> for anything generic — they compose these.
//
// To restyle the app with a component library: reimplement each export below
// on top of the library, keep the props contracts, and delete the matching
// "PRIMITIVES" section of index.css. Nothing outside this file (and that CSS
// section) needs to change.
//
// The two deliberate exceptions — see FRONTEND.md:
//   - tree rows (FileTree) and project rows (ProjectSidebar) are app-specific
//     list rows, styled by the LAYOUT css, though they use Checkbox/Spinner
//     from here for their embedded controls.
//   - pane scaffolding (headers/footers/three-pane flex) is layout, not a
//     control.

import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { errorMessage } from '../lib/errors'
import { useDismiss } from '../lib/useDismiss'

// --- buttons -----------------------------------------------------------------

/** Push button. `variant="primary"` is the filled call-to-action. */
export function Button({
  variant = 'default',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary'
}) {
  return (
    <button className={`ui-button ui-button-${variant}`} {...rest}>
      {children}
    </button>
  )
}

/** A navigation link styled as a Button — downloads and external hrefs. */
export function LinkButton({
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className="ui-button ui-button-default ui-link-button" {...rest}>
      {children}
    </a>
  )
}

/** Exclusive choice rendered as a joined button strip (topbar mode switch,
 *  sidebar source tabs). `fill` splits the width evenly between segments
 *  instead of sizing each to its label. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fill = false,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  fill?: boolean
}) {
  return (
    <nav className={fill ? 'ui-segmented fill' : 'ui-segmented'}>
      {options.map((option) => (
        <button
          key={option.value}
          className={
            option.value === value ? 'ui-segment active' : 'ui-segment'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  )
}

// --- form controls -----------------------------------------------------------

/** Shared label layout for form controls; a bare control when `label` is unset. */
function withLabel(label: string | undefined, control: ReactElement) {
  if (!label) return control
  return (
    <label className="ui-labeled">
      <span className="ui-label">{label}</span>
      {control}
    </label>
  )
}

/**
 * Labeled dropdown. `onChange` receives the selected value directly. Options
 * are plain strings, or { value, label } pairs when the two differ.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder,
  variant = 'default',
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  options: (string | { value: string; label: string })[]
  placeholder?: string
  /** 'action' sizes the select to its text, for use as a pick-to-act button. */
  variant?: 'default' | 'action'
}) {
  return withLabel(label, (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={variant === 'action' ? 'ui-select ui-select-action' : 'ui-select'}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((raw) => {
        const { value, label } = typeof raw === 'string' ? { value: raw, label: raw } : raw
        return (
          <option key={value} value={value}>
            {label}
          </option>
        )
      })}
    </select>
  ))
}

/** Single-line text input (settings search); `label` wraps it like Select's.
 *  Accepts `ref` (React 19 ref-as-prop) for callers that manage focus. */
export function TextInput({
  label,
  ...rest
}: React.ComponentProps<'input'> & { label?: string }) {
  return withLabel(label, <input type="text" className="ui-input" {...rest} />)
}

/**
 * Inline name form for list rows (create / rename): autofocused input, Enter
 * commits the trimmed value, Escape cancels. Owns its value and shows the
 * error a rejected onCommit throws — callers keep only an "editing" marker.
 */
export function InlineNameForm({
  initial = '',
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string
  placeholder: string
  onCommit: (value: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  // Commits mutate identity (renames, creates) — a repeat Enter during the
  // await must not fire a second one.
  const [pending, setPending] = useState(false)
  // Set once the form is finished (Escape, or a successful commit) so the
  // trailing blur cannot fire a second action.
  const done = useRef(false)

  const commit = async () => {
    const trimmed = value.trim()
    if (!trimmed || pending || done.current) return
    setPending(true)
    try {
      await onCommit(trimmed)
      done.current = true
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  // Clicking away saves a rename — Enter must not be required. An unchanged
  // or emptied name, or a create form (no initial), just closes: abandoning
  // a create by clicking away must not silently create something.
  const blur = () => {
    if (done.current || pending) return
    const trimmed = value.trim()
    if (initial && trimmed && trimmed !== initial) commit()
    else onCancel()
  }

  return (
    <div className="side-form">
      <TextInput
        autoFocus
        value={value}
        placeholder={placeholder}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={blur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            done.current = true
            onCancel()
          }
        }}
      />
      {error && <div className="side-form-error">{error}</div>}
    </div>
  )
}

/** Multi-line text input (aggregate term list). */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="ui-textarea" spellCheck={false} {...props} />
}

/** Checkbox supporting the indeterminate (partially-checked) state. */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  stopClickPropagation = false,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  /** For checkboxes embedded in clickable rows. */
  stopClickPropagation?: boolean
}) {
  return (
    <input
      type="checkbox"
      className="ui-checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate
      }}
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

// --- indicators --------------------------------------------------------------

/** Small inline busy indicator. */
export function Spinner() {
  return <span className="ui-spinner" aria-label="loading" />
}

/**
 * Short status/kind label. Tones: default (purple, item kind), added /
 * removed / edited (diff statuses).
 */
export function Tag({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'added' | 'removed' | 'edited'
  children: ReactNode
}) {
  return <span className={`ui-tag ui-tag-${tone}`}>{children}</span>
}

/** Inline chip for a single listed value (added/removed points). */
export function Chip({
  tone,
  children,
}: {
  tone: 'added' | 'removed'
  children: ReactNode
}) {
  return <span className={`ui-chip ui-chip-${tone}`}>{children}</span>
}

// --- structure ---------------------------------------------------------------

/**
 * Uppercase strip heading a block of content. With `onClick` it renders as a
 * button (the collapse toggle); without, a non-interactive label strip.
 */
export function SectionHeader({
  title,
  count,
  caret,
  onClick,
}: {
  title: ReactNode
  count?: ReactNode
  caret?: 'open' | 'closed'
  onClick?: () => void
}) {
  const Element = onClick ? 'button' : 'div'
  return (
    <Element className="ui-section-header" onClick={onClick}>
      {title}
      {count !== undefined && <span className="ui-count">{count}</span>}
      {caret && <span className="ui-section-caret">{caret === 'open' ? '▾' : '▸'}</span>}
    </Element>
  )
}

/** Collapsible titled block (preview sections). Starts open. */
export function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string
  count?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="ui-section">
      <SectionHeader
        title={title}
        count={count}
        caret={open ? 'open' : 'closed'}
        onClick={() => setOpen(!open)}
      />
      {open && children}
    </div>
  )
}

/** Horizontal tab strip with per-tab counts (setting-page sheets). */
export function TabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: { key: string; label: string; count?: number }[]
  activeKey: string
  onSelect: (key: string) => void
}) {
  return (
    <div className="ui-tabbar">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={tab.key === activeKey ? 'ui-tab active' : 'ui-tab'}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ui-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

// --- data table --------------------------------------------------------------

export interface TableColumn {
  key: string
  label: string
}

export interface TableRow {
  /** Stable identity for React. */
  id: string
  /** Cell content by column key; missing keys render empty. */
  cells: Record<string, ReactNode>
  /** Hover titles by column key (for truncated text). */
  titles?: Record<string, string>
  /** Row tone for diff coloring. */
  tone?: 'added' | 'removed' | 'edited'
}

/**
 * The one table used everywhere: sticky uppercase header, dense mono body,
 * scrolls inside its own viewport. All app tables (setting-page sheets, diff
 * tables, aggregation results, EtherCAT topology) flatten their data into
 * columns + rows before rendering — no rowSpan, no nested tables.
 */
export function DataTable({
  columns,
  rows,
  maxHeight,
}: {
  columns: TableColumn[]
  rows: TableRow[]
  /** CSS length capping the viewport; omit to fill the parent. */
  maxHeight?: string
}) {
  return (
    <div className="ui-table-viewport" style={maxHeight ? { maxHeight } : undefined}>
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.tone ? `tone-${row.tone}` : undefined}>
              {columns.map((column) => (
                <td key={column.key} title={row.titles?.[column.key]}>
                  {row.cells[column.key] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- context menu ------------------------------------------------------------

export interface ContextMenuItem {
  /** A separator row when true; every other field is ignored. */
  separator?: boolean
  label?: ReactNode
  /** Destructive action — tinted like the delete row actions. */
  danger?: boolean
  onClick?: () => void
}

/**
 * Right-click menu at a fixed point. The caller owns the open state (render
 * it only while open) and the items; picking an item runs it and closes.
 * Clicks outside and Escape dismiss. Position clamps to the viewport so a
 * right-click near an edge never spills the menu off screen.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const wrap = useDismiss<HTMLDivElement>(true, onClose, { escape: true })

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const box = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`
  }, [x, y, wrap])

  return (
    <div
      ref={wrap}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="ctx-sep" />
        ) : (
          <button
            key={index}
            className={item.danger ? 'ctx-item danger' : 'ctx-item'}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

/**
 * The hover rename/delete icon on list rows (projects, sources, notes,
 * files). A span, not a button - rows are already buttons; the click stops
 * propagating so the row click survives underneath.
 */
export function RowAction({
  kind,
  title,
  onClick,
}: {
  kind: 'rename' | 'delete'
  title: string
  onClick: () => void
}) {
  return (
    <span
      className={kind === 'rename' ? 'entry-delete entry-rename' : 'entry-delete'}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {kind === 'rename' ? '\u270E' : '\u2715'}
    </span>
  )
}
