import { useCallback, useEffect, useState } from 'react'

import { fetchRtacAvailable, refreshRtacAvailable, startExport } from '../api'
import { confirmOverwrite } from '../lib/confirm'
import { errorMessage } from '../lib/errors'
import type { RtacAvailableEntry } from '../types'
import { Button, Checkbox, Spinner, TextInput } from './ui'

// The AcRTAC database browser: a window over the app listing every project
// in the machine's database. Check the ones to download; they export into
// the CURRENT projector project and appear in the sidebar with per-item
// spinners while the CLI works. Listing the database itself goes through the
// Python bridge (slow), so the list has its own loading state and an
// explicit refresh.

export function RtacDatabaseModal({
  project,
  onClose,
  onStarted,
}: {
  project: string
  onClose: () => void
  /** Called after exports kick off, so the sidebar starts polling. */
  onStarted: () => void
}) {
  const [entries, setEntries] = useState<RtacAvailableEntry[] | null>(null)
  // The database's own list error, or a fetch failure — shown the same way.
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)
  // Name filter over the (often long) database list. Checked projects a
  // narrower filter hides STAY checked — the Download count is the truth.
  const [filter, setFilter] = useState('')

  const load = useCallback(async (refresh: boolean) => {
    setEntries(null)
    try {
      const list = refresh ? await refreshRtacAvailable(project) : await fetchRtacAvailable(project)
      setEntries(list.projects)
      setError(list.error)
    } catch (err) {
      setEntries([])
      setError(errorMessage(err))
    }
  }, [project])

  useEffect(() => {
    load(false)
  }, [load])

  const toggle = (name: string, value: boolean) => {
    setChecked((current) => {
      const next = new Set(current)
      if (value) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const download = async () => {
    // Same-name selections replace the project's existing export — never
    // silently. Cancel aborts the whole download.
    const overwriting = (entries ?? [])
      .filter((entry) => checked.has(entry.name) && entry.inProject)
      .map((entry) => entry.name)
    if (!confirmOverwrite(overwriting, 'a fresh download')) return
    setStarting(true)
    try {
      for (const name of checked) {
        await startExport(project, name)
      }
      onStarted()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setStarting(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = (entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="t">AcRTAC database</span>
          <button className="x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="modal-sub">
          Select the RTAC projects to download into <b>{project}</b>.
        </div>

        {entries === null ? (
          <div className="modal-loading">
            <Spinner /> Reading the AcRTAC database…
          </div>
        ) : (
          <>
            {error && <div className="modal-error">{error}</div>}
            {entries.length > 0 && (
              <div className="modal-filter">
                <TextInput
                  autoFocus
                  value={filter}
                  placeholder="Filter projects…"
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}
            <div className="modal-list">
              {shown.map((entry) => (
                <label
                  key={entry.name}
                  className={entry.inProject ? 'modal-row in-project' : 'modal-row'}
                >
                  <Checkbox
                    checked={checked.has(entry.name)}
                    onChange={(value) => toggle(entry.name, value)}
                  />
                  <span className="modal-name">{entry.name}</span>
                  {entry.inProject && <span className="modal-badge">in project</span>}
                </label>
              ))}
              {!entries.length && !error && (
                <div className="modal-empty">The database lists no projects.</div>
              )}
              {entries.length > 0 && !shown.length && (
                <div className="modal-empty">No projects match “{filter.trim()}”.</div>
              )}
            </div>
          </>
        )}

        <div className="modal-foot">
          <Button onClick={() => load(true)} disabled={entries === null}>
            Refresh list
          </Button>
          <Button variant="primary" disabled={!checked.size || starting} onClick={download}>
            {starting ? <Spinner /> : `Download ${checked.size || ''}`.trim()}
          </Button>
        </div>
      </div>
    </div>
  )
}
