import { useState } from 'react'

import type { ProjectEntry, SourceType } from '../types'
import { Button, Spinner } from './ui'

// The left rail: three source tabs. RTAC carries the full AcRTAC flow
// (grey → double-click download → spinner → ready); ready items drag onto the
// canvas and click-select for Inspect. RDB and SCD land in later phases and
// say so.
//
// Drag payload: JSON { type, ref } under application/gridlink-source.

export const SOURCE_MIME = 'application/gridlink-source'

const TABS: { key: SourceType; label: string }[] = [
  { key: 'rtac', label: 'RTAC' },
  { key: 'rdb', label: 'RDB' },
  { key: 'scd', label: 'SCD' },
]

export function SourcesSidebar({
  projects,
  listError,
  onRetryList,
  selected,
  onSelect,
  onExport,
  placedRefs,
  footer,
}: {
  projects: ProjectEntry[]
  listError: string | null
  onRetryList: () => void
  selected: string | null
  onSelect: (name: string) => void
  onExport: (name: string) => void
  /** rtac refs already on the canvas — shown with a dot. */
  placedRefs: Set<string>
  footer: string
}) {
  const [tab, setTab] = useState<SourceType>('rtac')

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
              const classes = ['project-entry', `status-${status}`]
              if (name === selected) classes.push('selected')
              return (
                <li key={name}>
                  <button
                    className={classes.join(' ')}
                    draggable={ready}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SOURCE_MIME, JSON.stringify({ type: 'rtac', ref: name }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    title={
                      ready
                        ? `${name} — drag to canvas, click to inspect`
                        : status === 'error'
                          ? `Export failed: ${error ?? 'unknown error'} — double-click to retry`
                          : `${name} — double-click to download`
                    }
                    onClick={() => ready && onSelect(name)}
                    onDoubleClick={() => (status === 'available' || status === 'error') && onExport(name)}
                  >
                    {ready && <span className="grip">⠿</span>}
                    <span className="project-name">{name}</span>
                    {status === 'exporting' && <Spinner />}
                    {status === 'error' && <span className="error-mark">!</span>}
                    {ready && placedRefs.has(name) && <span className="on-canvas" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {tab === 'rdb' && (
        <div className="source-placeholder">
          <div className="drop-zone">
            <b>Drop .rdb here</b>
            QuickSet database, or click to browse
          </div>
          <p className="phase-note">RDB profiles land in phase 2.</p>
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
