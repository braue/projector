import { useEffect, useState } from 'react'

import { appVersion } from '../api'
import { useDismiss } from '../lib/useDismiss'

import { InlineNameForm, RowAction, Tag } from './ui'

// Topbar dropdown for projects: pick one, rename, archive or delete from the
// hover actions on each row, or create a new one from the "+" row at the
// bottom, which turns into an inline name input. Archived projects (no longer
// in active development) sit in a collapsed "Archive" section below the
// active ones and open the same way. App-specific rows like the
// sidebar's — styled by LAYOUT css, not a ui.tsx primitive.
export function ProjectSwitcher({
  current,
  projects,
  archived,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onArchive,
}: {
  /** The open project, or null — the window starts with none. */
  current: string | null
  projects: string[]
  archived: string[]
  onSelect: (name: string) => void
  onCreate: (name: string) => Promise<void>
  onRename: (name: string, nextName: string) => Promise<void>
  onDelete: (name: string) => void
  onArchive: (name: string, archive: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  // The InlineNameForm owns the value and any commit error; these just mark
  // which form is showing.
  const [naming, setNaming] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const active = projects.filter((ws) => !archived.includes(ws))
  const shelved = projects.filter((ws) => archived.includes(ws))
  // Which build is this? Asked of every bug report, and the way you confirm an
  // upgrade actually took. It cannot change while the process runs, so it is
  // fetched once rather than tied to the menu.
  const [version, setVersion] = useState<string | null>(null)
  const wrap = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  useEffect(() => {
    appVersion().then(setVersion, () => {})
  }, [])

  // A closed menu has no half-finished form to come back to.
  useEffect(() => {
    if (!open) {
      setNaming(false)
      setRenaming(null)
    } else {
      // Opening onto an archived project shows where it is.
      setArchiveOpen(current !== null && archived.includes(current))
    }
    // Only on open/close — a refile while open must not snap the section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const row = (ws: string, isArchived: boolean) =>
    renaming === ws ? (
      <InlineNameForm
        key={ws}
        initial={ws}
        placeholder="New name"
        onCommit={async (value) => {
          await onRename(ws, value)
          setOpen(false)
        }}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <button
        key={ws}
        className={`ws-item${ws === current ? ' active' : ''}${isArchived ? ' ws-archived' : ''}`}
        onClick={() => {
          onSelect(ws)
          setOpen(false)
        }}
      >
        <span className="ws-item-name">{ws}</span>
        {ws === current && <span className="ws-check">✓</span>}
        <RowAction kind="rename" title={`Rename project ${ws}`} onClick={() => setRenaming(ws)} />
        <RowAction
          kind={isArchived ? 'unarchive' : 'archive'}
          title={isArchived ? `Move ${ws} back to active projects` : `Archive project ${ws}`}
          onClick={() => onArchive(ws, !isArchived)}
        />
        <RowAction
          kind="delete"
          title={`Delete project ${ws}`}
          onClick={() => {
            setOpen(false)
            onDelete(ws)
          }}
        />
      </button>
    )

  return (
    <div className="ws-switch" ref={wrap}>
      <button
        className="topbar-button ws-trigger"
        onClick={() => setOpen(!open)}
        title={current === null ? 'Choose a project'
          : archived.includes(current) ? `${current} (archived)` : current}
      >
        {current === null
          ? <span className="ws-current ws-none">Choose a project</span>
          : <span className="ws-current">{current}</span>}
        {current !== null && archived.includes(current) && <Tag>Archived</Tag>}
        <span className="ws-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu">
          {active.map((ws) => row(ws, false))}
          {shelved.length > 0 && (
            <>
              <div className="ws-divider" />
              <button className="ws-item ws-archive-toggle" onClick={() => setArchiveOpen(!archiveOpen)}>
                <span className="ws-archive-caret">{archiveOpen ? '▾' : '▸'}</span>
                <span className="ws-item-name">Archive</span>
                <span className="ws-archive-count">{shelved.length}</span>
              </button>
              {archiveOpen && shelved.map((ws) => row(ws, true))}
            </>
          )}
          <div className="ws-divider" />
          {naming ? (
            <InlineNameForm
              placeholder="Project name"
              onCommit={async (value) => {
                await onCreate(value)
                setOpen(false)
              }}
              onCancel={() => setOpen(false)}
            />
          ) : (
            <button className="ws-item ws-new" onClick={() => setNaming(true)}>
              <span className="ws-plus">+</span> New project
            </button>
          )}
          {version && <div className="ws-version">Projector {version}</div>}
        </div>
      )}
    </div>
  )
}
