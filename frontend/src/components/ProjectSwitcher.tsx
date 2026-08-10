import { useEffect, useRef, useState } from 'react'

import { errorMessage } from '../lib/errors'
import { TextInput } from './ui'

// Topbar dropdown for projects: pick one, or create a new
// one from the "+" row at the bottom, which turns into an inline name input.
// App-specific rows like the sidebar's — styled by LAYOUT css, not a ui.tsx
// primitive.
export function ProjectSwitcher({
  current,
  projects,
  onSelect,
  onCreate,
}: {
  current: string
  projects: string[]
  onSelect: (name: string) => void
  onCreate: (name: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setNaming(false)
      setName('')
      setError(null)
      return
    }
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    try {
      await onCreate(trimmed)
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="ws-switch" ref={wrap}>
      <button className="ws-trigger" onClick={() => setOpen(!open)} title="Switch project">
        <span>{current}</span>
        <span className="ws-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu">
          {projects.map((ws) => (
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
            </button>
          ))}
          <div className="ws-divider" />
          {naming ? (
            <div className="ws-new-form">
              <TextInput
                autoFocus
                value={name}
                placeholder="Project name — Enter to create"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create()
                  if (e.key === 'Escape') setOpen(false)
                }}
              />
              {error && <div className="ws-error">{error}</div>}
            </div>
          ) : (
            <button className="ws-item ws-new" onClick={() => setNaming(true)}>
              <span className="ws-plus">+</span> New project
            </button>
          )}
        </div>
      )}
    </div>
  )
}
