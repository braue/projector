import { TextInput } from './ui'

// The scaffold every search pane shares (Inspect, Notes, Files): the query
// bar, an optional subtitle count line, and a scrollable body that shows a
// pane message until there are results. Views keep only their data
// acquisition and row rendering (query state for the live panes lives in
// lib/useSearchQuery.ts).

export function SearchPane({
  placeholder,
  query,
  onQuery,
  onEnter,
  action,
  subtitle,
  message,
  children,
}: {
  placeholder: string
  query: string
  onQuery: (value: string) => void
  /** Run on Enter (button-run panes); live panes omit it. */
  onEnter?: () => void
  /** Extra control beside the input (e.g. the Search button). */
  action?: React.ReactNode
  subtitle?: React.ReactNode
  /** When set, the body shows this message instead of children. */
  message?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <main className="preview search-view">
      <header className="preview-header">
        <div className="search-bar">
          <TextInput
            autoFocus
            value={query}
            placeholder={placeholder}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onEnter && ((e) => {
              if (e.key === 'Enter') onEnter()
            })}
          />
          {action}
        </div>
        {subtitle && <div className="preview-subtitle">{subtitle}</div>}
      </header>
      <div className="preview-scroll no-sheets">
        {message ? <div className="pane-message">{message}</div> : children}
      </div>
    </main>
  )
}

/** One result group: a clickable header (object, note), then match rows. */
export function SearchHit({
  name,
  meta,
  count,
  title,
  onOpen,
  children,
}: {
  name: string
  meta?: string | null
  count: React.ReactNode
  title: string
  onOpen: () => void
  children: React.ReactNode
}) {
  return (
    <section className="search-hit">
      <button className="search-hit-head" onClick={onOpen} title={title}>
        <span className="search-hit-name">{name}</span>
        {meta && <span className="search-hit-kind">{meta}</span>}
        <span className="ui-count">{count}</span>
      </button>
      {children}
    </section>
  )
}

/** One location + text match line; clickable when onClick is given. */
export function MatchRow({
  location,
  onClick,
  title,
  children,
}: {
  location: string
  onClick?: () => void
  title?: string
  children: React.ReactNode
}) {
  const content = (
    <>
      <span className="search-where">{location}</span>
      <span className="search-text">{children}</span>
    </>
  )
  return onClick ? (
    <button className="search-match as-row" onClick={onClick} title={title}>
      {content}
    </button>
  ) : (
    <div className="search-match">{content}</div>
  )
}
