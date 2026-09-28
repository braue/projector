import { useState } from 'react'

import { startRtacExport } from '../api'
import { useAction } from '../lib/useAction'
import { AcrtacProjectList } from './AcrtacProjectList'
import { Button, Modal, Spinner, TextInput } from './ui'

// Download from the AcRTAC database into the tree: check the projects to pull
// (the shared AcrtacProjectList); they land at the DESTINATION folder as
// <name>.rtac — a new version when the export is already there, with the
// previous one kept underneath. Every download carries the mandatory version
// note. Each download runs as a job in the tasks popover (retried from there
// if it fails); the tree shows the entry once it has landed.

export function RtacDatabaseModal({
  project,
  destination,
  versionOf = null,
  onClose,
}: {
  project: string
  /** Tree folder the downloads land in ('' = the project root). */
  destination: string
  /** "New version from AcRTAC": the ONE picked database project exports
   *  onto this existing .rtac entry (in `destination`), whatever the entry
   *  is named. Selection is single in this mode. */
  versionOf?: string | null
  onClose: () => void
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const { run, busy: starting, error } = useAction()

  const download = async () => {
    // Nothing to confirm: an export already in the tree becomes the previous
    // VERSION of the new one — a download can never cost you what you have.
    const trimmed = note.trim()
    if (!trimmed) return
    const started = await run(async () => {
      for (const name of checked) {
        await startRtacExport(project, destination, name, trimmed, versionOf ?? undefined)
      }
    })
    if (started) onClose()
  }

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
      {versionOf ? (
        <AcrtacProjectList mode="single" autoFocus current={[...checked][0] ?? null}
          onPick={(name) => setChecked(new Set([name]))} />
      ) : (
        <AcrtacProjectList mode="multi" autoFocus checked={checked} onChange={setChecked} />
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-filter">
        <TextInput
          value={note}
          placeholder="Version note — what is this download? (required)"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="modal-foot">
        <Button onClick={onClose}>Cancel</Button>
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
