import { useState } from 'react'

import { Button, Spinner, TextInput } from './ui'

// The version-note dialog every intake path runs through: files dropped into
// the tree, an RTAC folder upload, a tool output — nothing lands without the
// one-line account of what it changes. One note covers the whole batch.

export interface PendingItem {
  name: string
  /** True when an entry with this name already exists at the destination —
   *  this upload becomes its next version. */
  isNewVersion: boolean
}

export function VersionNoteModal({
  title,
  destination,
  items,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  title: string
  /** Folder the batch lands in ('' = the project root). */
  destination: string
  items: PendingItem[]
  busy?: boolean
  error?: string | null
  onConfirm: (note: string) => void
  onCancel: () => void
}) {
  const [note, setNote] = useState('')
  const ready = note.trim().length > 0 && !busy
  const anyVersion = items.some((item) => item.isNewVersion)

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="t">{title}</span>
          <button className="x" onClick={onCancel} title="Cancel">✕</button>
        </div>
        <div className="modal-sub">
          Into <b>{destination || 'the project root'}</b>. Say what this version
          changes — the note shows beside it in the tree.
        </div>
        <div className="modal-list note-modal-list">
          {items.map((item) => (
            <div key={item.name} className="modal-row note-modal-row">
              <span className="modal-name mono">{item.name}</span>
              {item.isNewVersion && (
                <span className="modal-badge" title="An entry with this name is already there — it becomes the previous version, kept underneath">
                  new version
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="modal-filter">
          <TextInput
            autoFocus
            value={note}
            placeholder={anyVersion ? 'What changed in this version…' : 'Version note (e.g. "as-found from site")…'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) onConfirm(note.trim())
              if (e.key === 'Escape' && !busy) onCancel()
            }}
          />
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-foot">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => onConfirm(note.trim())}>
            {busy ? <Spinner /> : 'Add'}
          </Button>
        </div>
      </div>
    </div>
  )
}
