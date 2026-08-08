import { useRef, useState } from 'react'

import type { DeviceSource, ProjectEntry, RdbFile, SourceType } from '../types'
import { Button, Spinner } from './ui'

// The left rail: three source tabs. RTAC carries the full AcRTAC flow
// (grey → double-click download → spinner → ready); RDB uploads QuickSet
// databases and lists their relay profiles; SCD lands in phase 3. Ready
// items drag onto the canvas and click-select for Inspect.
//
// Drag payload: JSON DeviceSource under application/gridlink-source.

export const SOURCE_MIME = 'application/gridlink-source'

const TABS: { key: SourceType; label: string }[] = [
  { key: 'rtac', label: 'RTAC' },
  { key: 'rdb', label: 'RDB' },
  { key: 'scd', label: 'SCD' },
]

function dragProps(source: DeviceSource) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(source))
      e.dataTransfer.effectAllowed = 'copy'
    },
  }
}

export function SourcesSidebar({
  projects,
  listError,
  onRetryList,
  rdbFiles,
  rdbError,
  onUploadRdb,
  onDeleteRdb,
  selected,
  onSelect,
  onExport,
  placedRefs,
  footer,
}: {
  projects: ProjectEntry[]
  listError: string | null
  onRetryList: () => void
  rdbFiles: RdbFile[]
  rdbError: string | null
  onUploadRdb: (file: File) => void
  onDeleteRdb: (id: string) => void
  selected: DeviceSource | null
  onSelect: (source: DeviceSource) => void
  onExport: (name: string) => void
  /** "type:ref" keys already on the canvas — shown with a dot. */
  placedRefs: Set<string>
  footer: string
}) {
  const [tab, setTab] = useState<SourceType>('rtac')
  const fileInput = useRef<HTMLInputElement>(null)

  const isSelected = (source: DeviceSource) =>
    selected?.type === source.type && selected?.ref === source.ref

  return (
    <aside className="sources">
      <div className="source-tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={tab === key ? 'source-tab on' : 'source-tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'rtac' && (
        <>
          {listError && (
            <div className="list-error">
              <div className="list-error-text">{listError}</div>
              <Button onClick={onRetryList}>Retry</Button>
            </div>
          )}
          <ul className="source-list">
            {projects.map((project) => {
              const { name, status, error } = project
              const ready = status === 'ready'
              const source: DeviceSource = { type: 'rtac', ref: name }
              const classes = ['project-entry', `status-${status}`]
              if (isSelected(source)) classes.push('selected')
              return (
                <li key={name}>
                  <button
                    className={classes.join(' ')}
                    {...(ready ? dragProps(source) : {})}
                    title={
                      ready
                        ? `${name} — drag to canvas, click to inspect`
                        : status === 'error'
                          ? `Export failed: ${error ?? 'unknown error'} — double-click to retry`
                          : `${name} — double-click to download`
                    }
                    onClick={() => ready && onSelect(source)}
                    onDoubleClick={() => (status === 'available' || status === 'error') && onExport(name)}
                  >
                    {ready && <span className="grip">⠿</span>}
                    <span className="project-name">{name}</span>
                    {status === 'exporting' && <Spinner />}
                    {status === 'error' && <span className="error-mark">!</span>}
                    {ready && placedRefs.has(`rtac:${name}`) && <span className="on-canvas" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {tab === 'rdb' && (
        <div className="source-scroll">
          <input
            ref={fileInput}
            type="file"
            accept=".rdb"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUploadRdb(file)
              e.target.value = ''
            }}
          />
          <button
            className="drop-zone as-button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const file = e.dataTransfer.files?.[0]
              if (file) onUploadRdb(file)
            }}
          >
            <b>Drop .rdb here</b>
            QuickSet database, or click to browse
          </button>
          {rdbError && (
            <div className="list-error">
              <div className="list-error-text">{rdbError}</div>
            </div>
          )}
          {rdbFiles.map((file) => (
            <div key={file.id} className="rdb-file">
              <div className="rdb-file-name">
                <span className="mono">{file.fileName}</span>
                <button
                  className="rdb-delete"
                  title="Remove this file and its devices"
                  onClick={() => onDeleteRdb(file.id)}
                >
                  ✕
                </button>
              </div>
              {file.profiles.map((profile) => {
                const source: DeviceSource = { type: 'rdb', ref: profile.ref }
                const classes = ['project-entry', 'status-ready', 'profile-row']
                if (isSelected(source)) classes.push('selected')
                return (
                  <button
                    key={profile.ref}
                    className={classes.join(' ')}
                    {...dragProps(source)}
                    title={`${profile.name} — drag to canvas, click to inspect`}
                    onClick={() => onSelect(source)}
                  >
                    <span className="grip">⠿</span>
                    <span className="project-name">{profile.name}</span>
                    {profile.relayType && <span className="relay-type">{profile.relayType}</span>}
                    {placedRefs.has(`rdb:${profile.ref}`) && <span className="on-canvas" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {tab === 'scd' && (
        <div className="source-placeholder">
          <div className="drop-zone">
            <b>Drop .scd / .cid here</b>
            SEL Architect · IEC 61850
          </div>
          <p className="phase-note">SCL support lands in phase 3, pending example exports.</p>
        </div>
      )}

      <div className="pane-footer">{footer}</div>
    </aside>
  )
}
