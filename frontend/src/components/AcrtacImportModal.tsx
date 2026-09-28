// Import to AcRTAC — the dialog behind the tree's right-click action on one
// RTAC entry or a multi-selection of them. Asks what each database project
// should be called and which device type + firmware the batch targets, then
// starts the job and closes: the import runs in the background and shows in
// the tasks popover like every other job. A batch is ONE job — the bridge
// imports in order through a single AcRTAC session. Needs the machine with
// the RTAC database (Python + selacrtac) — elsewhere the job fails with a
// clear message.

import { useState } from 'react'

import { startAcrtacImport } from '../api'
import { useAction } from '../lib/useAction'
import { Button, Modal, Select, Spinner, TextInput } from './ui'
import { databaseName } from '../lib/fileNodes'

/** The hardware types selacrtac's importxml accepts, per the SEL acrtac
 *  submodule docs (bare model numbers, doc order). */
const DEVICE_TYPES = ['3530', '2241', '3505', '3532', '3354', '3351', '3332', '1102', '3555']

/** Firmware is the revision label: R + number ("R151"), per the same docs. */
const FIRMWARE = /^R\d+$/i

/** One entry to import. */
export interface AcrtacImportTarget {
  /** Tree path of the .rtac entry (or an archived version of one). */
  path: string
  /** The entry's display name — the name fallback. */
  name: string
  /** The database project the entry mirrors, when known — the name seed. */
  database: string | null
}

export function AcrtacImportModal({
  project,
  targets,
  onClose,
}: {
  project: string
  targets: AcrtacImportTarget[]
  onClose: () => void
}) {
  const [names, setNames] = useState(() => targets.map(databaseName))
  const [deviceType, setDeviceType] = useState('')
  const [firmware, setFirmware] = useState('')
  // Only the START of the import is awaited here — a quick POST. The import
  // itself outlives this dialog.
  const { run, busy: starting, error } = useAction()

  const single = targets.length === 1
  const trimmed = names.map((name) => name.trim())
  const lowered = trimmed.map((name) => name.toLowerCase())
  const duplicate = trimmed.find((name, index) => name && lowered.indexOf(name.toLowerCase()) !== index)
  const firmwareOk = FIRMWARE.test(firmware.trim())
  const ready = trimmed.every(Boolean) && !duplicate && Boolean(deviceType && firmwareOk) && !starting

  const begin = async () => {
    const started = await run(() => startAcrtacImport(project, {
      items: targets.map((target, index) => ({ path: target.path, name: trimmed[index] })),
      deviceType,
      firmware: firmware.trim().toUpperCase(),
    }))
    if (started) onClose()
  }

  const setName = (index: number, value: string) =>
    setNames((current) => current.map((name, i) => (i === index ? value : name)))

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
    <Modal
      title={single ? `Import to AcRTAC — ${targets[0].name}` : `Import ${targets.length} to AcRTAC`}
      onClose={onClose}
    >
      <div className="modal-sub">
        {single
          ? 'Import this RTAC export into the AcRTAC database as a new project.'
          : 'Import these RTAC exports into the AcRTAC database, one new project each, all on the same hardware.'}
        {' '}The import runs in the background — you can keep working while it does.
      </div>
      {single ? field('Name in AcRTAC', names[0], (value) => setName(0, value), 'Database project name') : (
        <div className="modal-list">
          {targets.map((target, index) => (
            <div key={target.path} className="modal-row acrtac-import-row">
              <span className="modal-name mono" title={target.path}>{target.name}</span>
              <TextInput
                value={names[index]}
                placeholder="Name in AcRTAC"
                disabled={starting}
                onChange={(e) => setName(index, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}
      {duplicate && (
        <div className="modal-error">Two imports are both named {duplicate} — each needs its own AcRTAC name.</div>
      )}
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
          {starting ? <Spinner /> : single ? 'Import' : `Import ${targets.length}`}
        </Button>
      </div>
    </Modal>
  )
}
