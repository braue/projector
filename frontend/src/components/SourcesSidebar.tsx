import { useRef, useState } from 'react'

import { SOURCE_MIME, SOURCE_TABS, sourceKey } from '../lib/sources'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type {
  DeviceSource,
  ProjectEntry,
  SourceType,
  UploadSourceType,
  UploadedFile,
} from '../types'
import { RtacDatabaseModal } from './RtacDatabaseModal'
import { Button, InlineNameForm, RowAction, Spinner } from './ui'

// The left rail: four source tabs. Every source belongs to the CURRENT
// projector project. RTAC exports arrive two ways — browse the machine's
// AcRTAC database in a window and download selections, or upload an
// exported XML folder straight from disk. RDB/SCD/SW are upload-backed and
// share one pane — a drop zone over file cards that fold like folders, each
// holding its own profiles (an RDB's relays, an SCD's IEDs). Ready items
// drag onto the canvas (an SCD profile can also drop ONTO a device to
// augment it) and click-select for Inspect.

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

/** The RTAC/RDB/SCD/SW tab strip — shared with the compare rail. */
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
  project,
  projects,
  listError,
  onRetryList,
  uploads,
  onUpload,
  onDeleteUpload,
  onRenameRtac,
  onRenameUpload,
  rtacBusy,
  onUploadRtacFolder,
  onDeleteRtac,
  onRtacChanged,
  selected,
  onSelect,
  onExport,
  placedRefs,
}: {
  /** The current projector project every source below belongs to. */
  project: string
  projects: ProjectEntry[]
  listError: string | null
  onRetryList: () => void
  uploads: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }>
  onUpload: (type: UploadSourceType, file: File) => void
  onDeleteUpload: (type: UploadSourceType, id: string) => void
  /** Identity renames — reject to surface an inline error in the form. */
  onRenameRtac: (name: string, nextName: string) => Promise<void>
  onRenameUpload: (type: UploadSourceType, id: string, name: string) => Promise<void>
  /** An XML-folder upload is in flight. */
  rtacBusy: boolean
  onUploadRtacFolder: (files: File[]) => void
  onDeleteRtac: (name: string) => void
  /** Database exports were kicked off — refresh the list and start polling. */
  onRtacChanged: () => void
  selected: DeviceSource | null
  onSelect: (source: DeviceSource) => void
  onExport: (name: string) => void
  /** sourceKey() values already on the canvas — shown with a dot. */
  placedRefs: Set<string>
}) {
  const [tab, setTab] = useState<SourceType>('rtac')
  const [dbOpen, setDbOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const { width, startResize } = useSidebarWidth()

  // One rename form at a time, keyed by what it renames; the form owns the
  // input value and any commit error.
  const [renaming, setRenaming] = useState<
    { kind: 'rtac'; name: string } | { kind: 'upload'; type: UploadSourceType; id: string } | null
  >(null)

  // Upload cards are folders: one file holds many profiles (an RDB's relays,
  // an SCD's IEDs), so each card collapses. Open is the default; the set
  // holds only what the reader has folded away, keyed by type + file id.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

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
          <div className="source-scroll">
            <button className="drop-zone as-button" onClick={() => setDbOpen(true)}>
              <b>Browse AcRTAC database…</b>
              select projects to download
            </button>
            <input
              ref={(el) => {
                folderInput.current = el
                el?.setAttribute('webkitdirectory', '')
              }}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                if (files.length) onUploadRtacFolder(files)
                e.target.value = ''
              }}
            />
            <button
              className="drop-zone as-button"
              onClick={() => folderInput.current?.click()}
              disabled={rtacBusy}
            >
              <b>{rtacBusy ? 'Uploading folder…' : 'Upload exported XML folder'}</b>
              {rtacBusy ? <Spinner /> : 'folder-of-XML from AcSELerator RTAC'}
            </button>

            <ul className="source-list">
              {projects.map((entry) => {
                const { name, status, error } = entry
                const ready = status === 'ready'
                const source: DeviceSource = { type: 'rtac', ref: name }
                const classes = ['project-entry', `status-${status}`]
                if (isSelected(source)) classes.push('selected')
                if (renaming?.kind === 'rtac' && renaming.name === name) {
                  return (
                    <li key={name}>
                      <InlineNameForm
                        initial={name}
                        placeholder="New name — Enter to rename"
                        onCommit={async (value) => {
                          await onRenameRtac(name, value)
                          setRenaming(null)
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    </li>
                  )
                }
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
                            : `${name} — downloading…`
                      }
                      onClick={() => ready && onSelect(source)}
                      onDoubleClick={() => status === 'error' && onExport(name)}
                    >
                      {ready && <span className="grip">⠿</span>}
                      <span className="project-name">{name}</span>
                      {status === 'exporting' && <Spinner />}
                      {status === 'error' && <span className="error-mark">!</span>}
                      {ready && placedRefs.has(sourceKey(source)) && <span className="on-canvas" />}
                      {ready && (
                        <RowAction
                          kind="rename"
                          title={`Rename ${name}`}
                          onClick={() => setRenaming({ kind: 'rtac', name })}
                        />
                      )}
                      {status !== 'exporting' && (
                        <RowAction
                          kind="delete"
                          title="Remove this export from the project"
                          onClick={() => onDeleteRtac(name)}
                        />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          {dbOpen && (
            <RtacDatabaseModal
              project={project}
              onClose={() => setDbOpen(false)}
              onStarted={onRtacChanged}
            />
          )}
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
          {uploads[uploadTab].files.map((file) => {
            const folderKey = `${uploadTab}:${file.id}`
            const open = !collapsed.has(folderKey)
            return (
              <div key={file.id} className="rdb-file">
                {renaming?.kind === 'upload' && renaming.type === uploadTab && renaming.id === file.id ? (
                  <InlineNameForm
                    initial={file.fileName}
                    placeholder="New name — Enter to rename"
                    onCommit={async (value) => {
                      await onRenameUpload(uploadTab, file.id, value)
                      setRenaming(null)
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <div className="rdb-file-name">
                    <button
                      className="rdb-file-toggle"
                      title={`${file.fileName} — click to ${open ? 'collapse' : 'expand'}`}
                      onClick={() => toggleCollapsed(folderKey)}
                    >
                      <span className="tree-caret">{open ? '▾' : '▸'}</span>
                      <span className="mono">{file.fileName}</span>
                      <span className="rdb-file-count">{file.profiles.length}</span>
                    </button>
                    <button
                      className="rdb-delete"
                      title="Rename this file"
                      onClick={() => setRenaming({ kind: 'upload', type: uploadTab, id: file.id })}
                    >
                      ✎
                    </button>
                    <button
                      className="rdb-delete"
                      title="Remove this file and its devices"
                      onClick={() => onDeleteUpload(uploadTab, file.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
                {open &&
                  file.profiles.map((profile) => {
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
            )
          })}
        </div>
      )}
    </aside>
  )
}
