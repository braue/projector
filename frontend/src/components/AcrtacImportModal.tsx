// Import to AcRTAC — the dialog behind the tree's right-click action on an
// RTAC entry. Asks what the database project should be called and which
// device type + firmware the import targets, then hands the job to the tree
// and closes: the import runs in the background like an AcRTAC download,
// narrating into a status row under the tree. Needs the machine with the
// RTAC database (Python + selacrtac) — elsewhere the job fails with a clear
// message, shown in the tree's error strip.

import { useEffect, useState } from 'react'

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
  onStarted,
  onClose,
}: {
  project: string
  /** Tree path of the .rtac entry to import. */
  path: string
  /** The entry's display name — the name fallback. */
  entryName: string
  /** The database project the entry mirrors, when known — the name seed. */
  database?: string | null
  /** Called with the started job once the import is under way; the tree
   *  watches it from here on. */
  onStarted: (job: string, name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(database ?? entryName.replace(/\.rtac$/i, ''))
  const [deviceType, setDeviceType] = useState('')
  const [firmware, setFirmware] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Only the START of the import is awaited here — a quick POST. The import
  // itself outlives this dialog.
  const [starting, setStarting] = useState(false)

  const firmwareOk = FIRMWARE.test(firmware.trim())
  const ready = Boolean(name.trim() && deviceType && firmwareOk) && !starting

  const begin = async () => {
    setError(null)
    setStarting(true)
    try {
      const { job } = await startAcrtacImport(project, {
        path,
        name: name.trim(),
        deviceType,
        firmware: firmware.trim().toUpperCase(),
      })
      onStarted(job, name.trim())
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setStarting(false)
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
        disabled={starting}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ready) begin()
        }}
      />
    </div>
  )

  return (
    <Modal title={`Import to AcRTAC — ${entryName}`} onClose={onClose}>
      <div className="modal-sub">
        Import this RTAC export into the AcRTAC database as a new project. The
        import runs in the background — you can keep working while it does.
      </div>
      {field('Name in AcRTAC', name, setName, 'Database project name')}
      <div className="modal-filter">
        <Select
          label="Device type"
          value={deviceType}
          placeholder="RTAC model…"
          disabled={starting}
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
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={starting}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={begin}>
          {starting ? <Spinner /> : 'Import'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * One in-flight import, as a status row under the tree — the import half of
 * the download's export rows. Owns the job poll: the row is here for as long
 * as the job runs, and its settling is the parent's (onDone / onError).
 */
export function AcrtacImportRow({
  name,
  job,
  onDone,
  onError,
}: {
  /** The database project name the import is creating. */
  name: string
  /** Job id from startAcrtacImport. */
  job: string
  onDone: () => void
  onError: (message: string) => void
}) {
  const watched = useToolJob(onDone, onError)
  const { start } = watched
  useEffect(() => {
    start(job)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job])
  return (
    <div
      className="tree-row file-row export-row"
      title={watched.job?.log.at(-1) ?? `Importing ${name} into AcRTAC…`}
    >
      <Spinner />
      <span className="tree-name">Importing {name} into AcRTAC…</span>
    </div>
  )
}
