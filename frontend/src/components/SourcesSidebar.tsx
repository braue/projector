import { useRef, useState } from 'react'

import { SOURCE_MIME, SOURCE_TABS, sourceKey } from '../lib/sources'
import { useSidebarWidth } from '../lib/useSidebarWidth'
import type {
  DeviceSource,
  ProjectEntry,
  SourceType,
  UploadSourceType,
  UploadedFile,
} from '../types'
import { Button, Spinner } from './ui'

// The left rail: three source tabs. RTAC carries the full AcRTAC flow
// (grey → double-click download → spinner → ready); RDB and SCD are
// upload-backed and share one pane (drop zone + file cards + profile rows).
// Ready items drag onto the canvas (an SCD profile can also drop ONTO a
// device to augment it) and click-select for Inspect.

const UPLOAD_META: Record<UploadSourceType, {
  accept: string
  dropLabel: string
  dropHint: string
  dragHint: string
}> = {
  rdb: {
    accept: '.rdb',
    dropLabel: 'Drop .rdb here',
    dropHint: 'QuickSet database, or click to browse',
    dragHint: 'drag to canvas, click to inspect',
  },
  scd: {
    accept: '.scd,.ssd,.sed,.cid,.icd',
    dropLabel: 'Drop .scd / .cid here',
    dropHint: 'SEL Architect · IEC 61850',
    dragHint: 'drag to canvas (onto a device to augment it), click to inspect',
  },
  sw: {
    accept: '.xml,.txt,.cfg,.bin',
    dropLabel: 'Drop switch settings here',
    dropHint: 'SEL-2730M settings export (XML)',
    dragHint: 'drag to canvas, click to inspect',
  },
}

function dragProps(source: DeviceSource) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(source))
      e.dataTransfer.effectAllowed = 'copy'
    },
  }
}

/** The RTAC/RDB/SCD tab strip — shared with the compare rail. */
export function SourceTabs({
  tab,
  onPick,
}: {
  tab: SourceType
  onPick: (tab: SourceType) => void
}) {
  return (
    <div className="source-tabs">
      {SOURCE_TABS.map(({ key, label }) => (
        <button
          key={key}
          className={tab === key ? 'source-tab on' : 'source-tab'}
          onClick={() => onPick(key)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function SourcesSidebar({
  projects,
  listError,
  onRetryList,
  uploads,
  onUpload,
  onDeleteUpload,
  selected,
  onSelect,
  onExport,
  placedRefs,
  footer,
}: {
  projects: ProjectEntry[]
  listError: string | null
  onRetryList: () => void
  uploads: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }>
  onUpload: (type: UploadSourceType, file: File) => void
  onDeleteUpload: (type: UploadSourceType, id: string) => void
  selected: DeviceSource | null
  onSelect: (source: DeviceSource) => void
  onExport: (name: string) => void
  /** sourceKey() values already on the canvas — shown with a dot. */
  placedRefs: Set<string>
  footer: string
}) {
  const [tab, setTab] = useState<SourceType>('rtac')
  const fileInput = useRef<HTMLInputElement>(null)
  const { width, startResize } = useSidebarWidth()

  const isSelected = (source: DeviceSource) =>
    selected?.type === source.type && selected?.ref === source.ref

  const uploadTab = tab === 'rtac' ? null : (tab as UploadSourceType)

  return (
    <aside className="sources" style={{ width }}>
      <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
      <SourceTabs tab={tab} onPick={setTab} />

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
                    {ready && placedRefs.has(sourceKey(source)) && <span className="on-canvas" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {uploadTab && (
        <div className="source-scroll">
          <input
            ref={fileInput}
            type="file"
            accept={UPLOAD_META[uploadTab].accept}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(uploadTab, file)
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
              if (file) onUpload(uploadTab, file)
            }}
          >
            <b>{UPLOAD_META[uploadTab].dropLabel}</b>
            {UPLOAD_META[uploadTab].dropHint}
          </button>
          {uploads[uploadTab].error && (
            <div className="list-error">
              <div className="list-error-text">{uploads[uploadTab].error}</div>
            </div>
          )}
          {uploads[uploadTab].files.map((file) => (
            <div key={file.id} className="rdb-file">
              <div className="rdb-file-name">
                <span className="mono">{file.fileName}</span>
                <button
                  className="rdb-delete"
                  title="Remove this file and its devices"
                  onClick={() => onDeleteUpload(uploadTab, file.id)}
                >
                  ✕
                </button>
              </div>
              {file.profiles.map((profile) => {
                const source: DeviceSource = { type: uploadTab, ref: profile.ref }
                const classes = ['project-entry', 'status-ready', 'profile-row']
                if (isSelected(source)) classes.push('selected')
                return (
                  <button
                    key={profile.ref}
                    className={classes.join(' ')}
                    {...dragProps(source)}
                    title={`${profile.name} — ${UPLOAD_META[uploadTab].dragHint}`}
                    onClick={() => onSelect(source)}
                  >
                    <span className="grip">⠿</span>
                    <span className="project-name">{profile.name}</span>
                    {profile.deviceType && <span className="relay-type">{profile.deviceType}</span>}
                    {placedRefs.has(sourceKey(source)) && <span className="on-canvas" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      <div className="pane-footer">{footer}</div>
    </aside>
  )
}
