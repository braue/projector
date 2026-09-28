import { useState } from 'react'

import { useAcrtacProjects } from '../lib/acrtacProjects'
import { Button, Checkbox, Spinner, TextInput } from './ui'

// The AcRTAC database's projects as a filterable list — the one picker every
// feature uses (the tree's download window, the RTAC Exporter, RTAC VLAN
// Deploy's project cell). The list itself is shared and cached
// (lib/acrtacProjects.ts), so it is instant after the first read anywhere,
// and Refresh here refreshes it everywhere.
//
//   single  clicking a row picks it (onPick) — the caller closes/moves on
//   multi   rows carry checkboxes; "Select shown" / "Clear shown" act on
//           what the filter leaves. Checked rows a filter hides STAY checked.

type Props = {
  /** Projects other rows/uses already have — badged, still pickable. */
  taken?: string[]
  autoFocus?: boolean
} & (
  | { mode: 'single'; current?: string | null; onPick: (name: string) => void }
  | { mode: 'multi'; checked: Set<string>; onChange: (next: Set<string>) => void }
)

export function AcrtacProjectList(props: Props) {
  const { projects, error, loading, refresh } = useAcrtacProjects()
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = (projects ?? []).filter((name) => name.toLowerCase().includes(needle))

  const multi = props.mode === 'multi' ? props : null
  const allShownChecked = multi !== null && shown.length > 0 && shown.every((name) => multi.checked.has(name))
  const toggle = (name: string, on: boolean) => {
    if (!multi) return
    const next = new Set(multi.checked)
    if (on) next.add(name)
    else next.delete(name)
    multi.onChange(next)
  }

  return (
    <div className="acrtac-list">
      <div className="acrtac-list-bar">
        <TextInput
          autoFocus={props.autoFocus}
          value={filter}
          placeholder="Filter projects…"
          disabled={projects === null}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && props.mode === 'single' && shown.length === 1) props.onPick(shown[0])
          }}
        />
        {multi && (
          <Button disabled={!shown.length}
            onClick={() => multi.onChange(allShownChecked
              ? new Set([...multi.checked].filter((name) => !shown.includes(name)))
              : new Set([...multi.checked, ...shown]))}>
            {allShownChecked ? 'Clear shown' : 'Select shown'}
          </Button>
        )}
        <Button onClick={refresh} disabled={loading} title="Read the AcRTAC database again">
          {loading && projects !== null ? <Spinner /> : 'Refresh'}
        </Button>
      </div>
      {error && <div className="acrtac-list-error">{error}</div>}
      {projects === null ? (
        <div className="acrtac-list-empty"><Spinner /> Reading the AcRTAC database…</div>
      ) : (
        <div className="acrtac-list-rows">
          {shown.map((name) => {
            const badge = props.taken?.includes(name) && <span className="modal-badge">in use</span>
            return props.mode === 'single' ? (
              <button key={name} className={`acrtac-list-row pick${name === props.current ? ' is-current' : ''}`}
                onClick={() => props.onPick(name)}>
                <span className="acrtac-list-name">{name}</span>
                {badge}
              </button>
            ) : (
              <label key={name} className="acrtac-list-row">
                <Checkbox checked={props.checked.has(name)} onChange={(on) => toggle(name, on)} />
                <span className="acrtac-list-name">{name}</span>
                {badge}
              </label>
            )
          })}
          {!projects.length && !error && <div className="acrtac-list-empty">The database lists no projects.</div>}
          {projects.length > 0 && !shown.length && (
            <div className="acrtac-list-empty">No projects match “{filter.trim()}”.</div>
          )}
        </div>
      )}
    </div>
  )
}
