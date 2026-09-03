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
import { Button, Modal, Select, Spinner, TextInput } from './ui'

/** The hardware types selacrtac's importxml accepts, per the SEL acrtac
 *  submodule docs (bare model numbers, doc order). */
const DEVICE_TYPES = ['3530', '2241', '3505', '3532', '3354', '3351', '3332', '1102', '3555']

/** Firmware is the revision label: R + number ("R151"), per the same docs. */
const FIRMWARE = /^R\d+$/i

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

  const firmwareOk = FIRMWARE.test(firmware.trim())
  const ready = Boolean(name.trim() && deviceType && firmwareOk)
    && !running && imported === null

  const begin = async () => {
    setError(null)
    try {
      const { job: id } = await startAcrtacImport(project, {
        path,
        name: name.trim(),
        deviceType,
        firmware: firmware.trim().toUpperCase(),
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
      <div className="modal-filter">
        <Select
          label="Device type"
          value={deviceType}
          placeholder="RTAC model…"
          disabled={running || imported !== null}
          options={DEVICE_TYPES}
          onChange={setDeviceType}
        />
      </div>
      {field('Firmware', firmware, setFirmware, 'R151')}
      {firmware.trim() !== '' && !firmwareOk && (
        <div className="modal-error">
          Firmware is the revision label — an R followed by the number, e.g. R151.
        </div>
      )}
      {job && job.log.length > 0 && imported === null && (
        <div className="tool-joblog">
          {job.log.slice(-6).map((line, i) => (
            <div key={i} className="tool-joblog-line">{line}</div>
          ))}
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
      {imported !== null && (
        <div className="modal-status">✓ Imported into AcRTAC as <b>{imported}</b>.</div>
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
