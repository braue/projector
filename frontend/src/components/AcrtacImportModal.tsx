// Import to AcRTAC — the dialog behind the tree's right-click action on an
// RTAC entry. Asks what the database project should be called and which
// device type + firmware the import targets, then runs the import as a job,
// streaming the bridge's narration until it settles. Needs the machine with
// the RTAC database (Python + selacrtac) — elsewhere the job fails with a
// clear message.

import { useState } from 'react'

import { startAcrtacImport } from '../api'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import { Button, Modal, Spinner, TextInput } from './ui'

export function AcrtacImportModal({
  project,
  path,
  entryName,
  database = null,
  onClose,
}: {
  project: string
  /** Tree path of the .rtac entry to import. */
  path: string
  /** The entry's display name — the name fallback. */
  entryName: string
  /** The database project the entry mirrors, when known — the name seed. */
  database?: string | null
  onClose: () => void
}) {
  const [name, setName] = useState(database ?? entryName.replace(/\.rtac$/i, ''))
  const [deviceType, setDeviceType] = useState('')
  const [firmware, setFirmware] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)

  const { job, running, start } = useToolJob(
    (result) => setImported((result as { name: string }).name),
    setError,
  )

  const ready = Boolean(name.trim() && deviceType.trim() && firmware.trim())
    && !running && imported === null

  const begin = async () => {
    setError(null)
    try {
      const { job: id } = await startAcrtacImport(project, {
        path,
        name: name.trim(),
        deviceType: deviceType.trim(),
        firmware: firmware.trim(),
      })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const field = (
    label: string,
    value: string,
    set: (value: string) => void,
    placeholder: string,
  ) => (
    <div className="modal-filter">
      <TextInput
        label={label}
        value={value}
        placeholder={placeholder}
        disabled={running || imported !== null}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ready) begin()
        }}
      />
    </div>
  )

  return (
    <Modal title={`Import to AcRTAC — ${entryName}`} onClose={onClose} locked={running}>
      <div className="modal-sub">
        Import this RTAC export into the AcRTAC database as a new project.
      </div>
      {field('Name in AcRTAC', name, setName, 'Database project name')}
      {field('Device type', deviceType, setDeviceType, '3555')}
      {field('Firmware', firmware, setFirmware, 'R151')}
      {job && job.log.length > 0 && imported === null && (
        <div className="tool-joblog">
          {job.log.slice(-6).map((line, i) => (
            <div key={i} className="tool-joblog-line">{line}</div>
          ))}
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
      {imported !== null && (
        <div className="modal-sub">✓ Imported into AcRTAC as <b>{imported}</b>.</div>
      )}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={running}>
          {imported !== null ? 'Close' : 'Cancel'}
        </Button>
        {imported === null && (
          <Button variant="primary" disabled={!ready} onClick={begin}>
            {running ? <Spinner /> : 'Import'}
          </Button>
        )}
      </div>
    </Modal>
  )
}
