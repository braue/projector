import { useMemo } from 'react'

import { fetchCompareItem, fetchCompareTree } from '../api'
import { useFetch } from '../lib/useFetch'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type {
  DeviceSource,
  ProjectEntry,
  SourceType,
  UploadSourceType,
  UploadedFile,
} from '../types'
import { DiffPreview } from './DiffPreview'
import { TreePane, TreeRows } from './FileTree'
import { SourceTabs } from './SourcesSidebar'
import { Select } from './ui'

// Compare mode: the left rail looks like every other page — the RTAC/RDB/SCD
// source tabs — but instead of a list it carries the Original/New pickers for
// that type (two RTAC projects, two relay profiles, two whole SCDs; the tab
// IS the same-type constraint). The union item tree shows added/removed/
// edited tints; click a row for the structured diff.
//
// The state lives in App, not here: this view unmounts whenever the user
// leaves Compare mode, and a comparison mid-review must survive a detour
// through Inspect. Picks are kept PER TYPE so switching source tabs flips
// between comparisons instead of discarding them.

/** One source tab's comparison: the picked pair and the item under review. */
export type ComparePicks = { original: string; updated: string; selected: string | null }

export type CompareState = { tab: SourceType; picks: Record<SourceType, ComparePicks> }

const NO_PICKS: ComparePicks = { original: '', updated: '', selected: null }

export const EMPTY_COMPARE: CompareState = {
  tab: 'rtac',
  picks: { rtac: NO_PICKS, rdb: NO_PICKS, scd: NO_PICKS, sw: NO_PICKS },
}

export function CompareView({
  project,
  projects,
  uploads,
  state,
  onState,
}: {
  /** The projector project every ref below lives in. */
  project: string
  projects: ProjectEntry[]
  uploads: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }>
  state: CompareState
  onState: (state: CompareState) => void
}) {
  const { tab } = state
  const picks = state.picks[tab]

  // What a pick MEANS per type: an RTAC project and an SCD are compared whole
  // (an .scd's IEDs are one substation — reading them apart loses the point),
  // while an RDB or a switch export is compared one profile at a time, which
  // is how two revisions of the same relay get held up against each other.
  const options = useMemo(() => {
    if (tab === 'rtac') {
      return projects
        .filter((project) => project.status === 'ready')
        .map((project) => ({ value: project.name, label: project.name }))
    }
    if (tab === 'scd') {
      return uploads.scd.files.map((file) => ({ value: file.id, label: file.fileName }))
    }
    return uploads[tab].files.flatMap((file) =>
      file.profiles.map((profile) => ({
        value: profile.ref,
        label: `${file.fileName} · ${profile.name}`,
      })),
    )
  }, [tab, projects, uploads])

  // A tab switch only changes which comparison is showing — the tab left
  // behind keeps its picks. Changing a picker resets the item selection (it
  // belongs to the old pair); a remembered ref whose source has since been
  // deleted stays stored but stops acting until it's offered again.
  const pickTab = (next: SourceType) => onState({ ...state, tab: next })
  const patch = (change: Partial<ComparePicks>) =>
    onState({ ...state, picks: { ...state.picks, [tab]: { ...picks, ...change } } })
  const offered = (ref: string) => options.some((option) => option.value === ref)

  const original = offered(picks.original) ? picks.original : ''
  const updated = offered(picks.updated) ? picks.updated : ''
  const selected = picks.selected

  const bothPicked = Boolean(original && updated && original !== updated)
  const a: DeviceSource = { type: tab, ref: original }
  const b: DeviceSource = { type: tab, ref: updated }

  const { data: tree, error: treeError } = useFetch(
    bothPicked ? () => fetchCompareTree(project, a, b) : null,
    [project, tab, original, updated, bothPicked],
  )
  const { data: compareItem, error: itemError } = useFetch(
    bothPicked && selected ? () => fetchCompareItem(project, a, b, selected) : null,
    [project, tab, original, updated, selected, bothPicked],
    { keepStale: true },
  )

  const { width, startResize } = useSidebarWidth()

  return (
    <>
      <aside className="sources" style={{ width }}>
        <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
        <SourceTabs tab={tab} onPick={pickTab} />

        <div className="compare-picker">
          <Select
            label="Original"
            value={original}
            onChange={(value) => patch({ original: value, selected: null })}
            options={options}
            placeholder="— select —"
          />
          <Select
            label="New"
            value={updated}
            onChange={(value) => patch({ updated: value, selected: null })}
            options={options}
            placeholder="— select —"
          />
        </div>
      </aside>

      <TreePane
        header={
          tree ? (
            <>
              <div className="tree-title">{tree.updated.name}</div>
              <div className="tree-subtitle">vs {tree.original.name} (original)</div>
            </>
          ) : (
            <>
              <div className="tree-title">Compare</div>
              <div className="tree-subtitle">added · removed · modified</div>
            </>
          )
        }
        footer={
          tree ? (
            <span className="compare-legend">
              <span className="legend legend-added">{tree.summary.added} added</span>
              <span className="legend legend-removed">{tree.summary.removed} removed</span>
              <span className="legend legend-edited">{tree.summary.edited} modified</span>
              <span className="legend">{tree.summary.unchanged} unchanged</span>
            </span>
          ) : undefined
        }
      >
        {tree ? (
          // A whole-SCD tree is a folder per IED and dozens of them; opening
          // every one by default buries the changed IEDs it exists to show.
          <TreeRows
            nodes={tree.tree}
            selected={selected}
            onSelect={(path) => patch({ selected: path })}
            defaultOpen={tab !== 'scd'}
          />
        ) : (
          <div className="pane-message">
            {treeError ??
              (bothPicked
                ? 'Comparing…'
                : original && updated
                  ? 'Pick two different sources.'
                  : 'Pick an original and a new source in the sidebar.')}
          </div>
        )}
      </TreePane>

      {compareItem ? (
        <DiffPreview compare={compareItem} />
      ) : (
        <main className="preview">
          <div className="pane-message">
            {itemError ??
              (tree
                ? 'Select an item to see what changed.'
                : 'The union of both sources will show here with added, removed, and modified items tinted.')}
          </div>
        </main>
      )}
    </>
  )
}
