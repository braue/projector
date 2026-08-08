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

import { useState, type ReactNode } from 'react'

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

/** Exclusive choice rendered as a joined button strip (topbar mode switch). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <nav className="ui-segmented">
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

/** Labeled dropdown. `onChange` receives the selected value directly. */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
}) {
  const select = (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="ui-select">
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
  if (!label) return select
  return (
    <label className="ui-labeled">
      <span className="ui-label">{label}</span>
      {select}
    </label>
  )
}

/** Single-line text input (settings search). */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className="ui-input" {...props} />
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
 * Uppercase strip heading a block of content. With `onToggle` semantics
 * (default) it collapses; `static` renders a non-interactive label strip.
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
