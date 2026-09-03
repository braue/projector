import { useCallback, useEffect, useState } from 'react'

import { fetchRtacAvailable, refreshRtacAvailable, startRtacExport } from '../api'
import { errorMessage } from '../lib/errors'
import type { RtacAvailableEntry } from '../types'
import { Button, Checkbox, Modal, Spinner, TextInput } from './ui'

// The AcRTAC database browser: a window over the app listing every project
// in the machine's database. Check the ones to download; they land in the
// tree at the DESTINATION folder as <name>.rtac — a new version when the
// export is already there, with the previous one kept underneath. Every
// download carries the mandatory version note. Listing the database itself
// goes through the Python bridge (slow), so the list has its own loading
// state and an explicit refresh.

export function RtacDatabaseModal({
  project,
  destination,
  versionOf = null,
  onClose,
  onStarted,
}: {
  project: string
  /** Tree folder the downloads land in ('' = the project root). */
  destination: string
  /** "New version from AcRTAC": the ONE picked database project exports
   *  onto this existing .rtac entry (in `destination`), whatever the entry
   *  is named. Selection is single in this mode. */
  versionOf?: string | null
  onClose: () => void
  /** Called after exports kick off, so the sidebar starts polling. */
  onStarted: () => void
}) {
  const [entries, setEntries] = useState<RtacAvailableEntry[] | null>(null)
  // The database's own list error, or a fetch failure — shown the same way.
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState('')
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
      // Versioning one entry takes exactly one source project.
      if (versionOf) return value ? new Set([name]) : new Set()
      const next = new Set(current)
      if (value) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const download = async () => {
    // Nothing to confirm: an export already in the tree becomes the previous
    // VERSION of the new one — a download can never cost you what you have.
    const trimmed = note.trim()
    if (!trimmed) return
    setStarting(true)
    try {
      for (const name of checked) {
        await startRtacExport(project, destination, name, trimmed, versionOf ?? undefined)
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
    <Modal title="AcRTAC database" onClose={onClose}>
        <div className="modal-sub">
          {versionOf ? (
            <>
              Select the database project to pull as the <b>next version of{' '}
              {versionOf}</b> — the copy you have is kept underneath, and the
              entry takes the database project's name.
            </>
          ) : (
            <>
              Select the RTAC projects to download into{' '}
              <b>{destination || 'the project root'}</b>. One already there
              becomes its next version.
            </>
          )}
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
                <label key={entry.name} className="modal-row">
                  <Checkbox
                    checked={checked.has(entry.name)}
                    onChange={(value) => toggle(entry.name, value)}
                  />
                  <span className="modal-name">{entry.name}</span>
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

        <div className="modal-filter">
          <TextInput
            value={note}
            placeholder="Version note — what is this download? (required)"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="modal-foot">
          <Button onClick={() => load(true)} disabled={entries === null}>
            Refresh list
          </Button>
          <Button
            variant="primary"
            disabled={!checked.size || !note.trim() || starting}
            onClick={download}
          >
            {starting ? <Spinner /> : `Download ${checked.size || ''}`.trim()}
          </Button>
        </div>
    </Modal>
  )
}
