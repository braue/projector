import { useCallback, useEffect, useState } from 'react'

import { fetchRtacAvailable, refreshRtacAvailable, startExport } from '../api'
import { errorMessage } from '../lib/errors'
import type { RtacAvailableEntry } from '../types'
import { Button, Checkbox, Spinner } from './ui'

// The AcRTAC database browser: a window over the app listing every project
// in the machine's database. Check the ones to download; they export into
// the CURRENT purview project and appear in the sidebar with per-item
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
  const [dbError, setDbError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setEntries(null)
    setFetchError(null)
    try {
      const list = refresh ? await refreshRtacAvailable(project) : await fetchRtacAvailable(project)
      setEntries(list.projects)
      setDbError(list.error)
    } catch (err) {
      setEntries([])
      setFetchError(errorMessage(err))
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
    setStarting(true)
    try {
      for (const name of checked) {
        await startExport(project, name)
      }
      onStarted()
      onClose()
    } catch (err) {
      setFetchError(errorMessage(err))
      setStarting(false)
    }
  }

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
            {(dbError ?? fetchError) && (
              <div className="modal-error">{dbError ?? fetchError}</div>
            )}
            <div className="modal-list">
              {entries.map((entry) => (
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
              {!entries.length && !(dbError ?? fetchError) && (
                <div className="modal-empty">The database lists no projects.</div>
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
