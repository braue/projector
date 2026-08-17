import { useEffect, useMemo, useState } from 'react'

import { compareReportUrl, fetchCompareItem, fetchCompareTree } from '../api'
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

export function CompareView({
  project,
  projects,
  uploads,
}: {
  /** The projector project every ref below lives in. */
  project: string
  projects: ProjectEntry[]
  uploads: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }>
}) {
  const [tab, setTab] = useState<SourceType>('rtac')
  const [original, setOriginal] = useState<string>('')
  const [updated, setUpdated] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)

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

  const pickTab = (next: SourceType) => {
    setTab(next)
    setOriginal('')
    setUpdated('')
  }

  const bothPicked = Boolean(original && updated && original !== updated)
  const a: DeviceSource = { type: tab, ref: original }
  const b: DeviceSource = { type: tab, ref: updated }

  useEffect(() => {
    setSelected(null)
  }, [original, updated])

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
            onChange={setOriginal}
            options={options}
            placeholder="— select —"
          />
          <Select
            label="New"
            value={updated}
            onChange={setUpdated}
            options={options}
            placeholder="— select —"
          />
          <button
            className="ui-button"
            disabled={!bothPicked}
            onClick={() => window.open(compareReportUrl(project, a, b), '_blank')}
            title="Download a PDF report of the differences"
          >
            Export report (PDF)
          </button>
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
            onSelect={setSelected}
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
