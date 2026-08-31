import { useEffect, useState } from 'react'

import { appVersion } from '../api'
import { useDismiss } from '../lib/useDismiss'

import { InlineNameForm, RowAction } from './ui'

// Topbar dropdown for projects: pick one, rename or delete from the hover
// actions on each row, or create a new one from the "+" row at the bottom,
// which turns into an inline name input. App-specific rows like the
// sidebar's — styled by LAYOUT css, not a ui.tsx primitive.
export function ProjectSwitcher({
  current,
  projects,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  current: string
  projects: string[]
  onSelect: (name: string) => void
  onCreate: (name: string) => Promise<void>
  onRename: (name: string, nextName: string) => Promise<void>
  onDelete: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  // The InlineNameForm owns the value and any commit error; these just mark
  // which form is showing.
  const [naming, setNaming] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
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
    }
  }, [open])

  return (
    <div className="ws-switch" ref={wrap}>
      <button className="topbar-button ws-trigger" onClick={() => setOpen(!open)} title="Switch project">
        <span>{current}</span>
        <span className="ws-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu">
          {projects.map((ws) =>
            renaming === ws ? (
              <InlineNameForm
                key={ws}
                initial={ws}
                placeholder="New name — Enter to rename"
                onCommit={async (value) => {
                  await onRename(ws, value)
                  setOpen(false)
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <button
                key={ws}
                className={ws === current ? 'ws-item active' : 'ws-item'}
                onClick={() => {
                  onSelect(ws)
                  setOpen(false)
                }}
              >
                {ws}
                {ws === current && <span className="ws-check">✓</span>}
                <RowAction kind="rename" title={`Rename project ${ws}`} onClick={() => setRenaming(ws)} />
                <RowAction
                  kind="delete"
                  title={`Delete project ${ws}`}
                  onClick={() => {
                    setOpen(false)
                    onDelete(ws)
                  }}
                />
              </button>
            ),
          )}
          <div className="ws-divider" />
          {naming ? (
            <InlineNameForm
              placeholder="Project name — Enter to create"
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
