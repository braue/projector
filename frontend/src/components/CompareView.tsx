import { useEffect, useState } from 'react'

import { fetchCompareItem, fetchCompareTree } from '../api'
import { useFetch } from '../lib/useFetch'
import { DiffPreview } from './DiffPreview'
import { TreePane, TreeRows } from './FileTree'
import { Button } from './ui'

// Compare — two same-kind artifacts (or two versions of one), entered from
// the tree: ⇆ on a version row compares it against the current version, and
// ctrl+click picks any second artifact. The union item tree shows added/
// removed/edited tints; click a row for the structured diff.

export function CompareView({
  project,
  original,
  updated,
  onSwap,
  onClear,
}: {
  project: string
  original: { ref: string; label: string }
  updated: { ref: string; label: string }
  onSwap: () => void
  /** Back to inspecting just the selected artifact. */
  onClear: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)

  // A new pair means the old item selection belongs to a diff that no longer
  // exists.
  useEffect(() => {
    setSelected(null)
  }, [original.ref, updated.ref])

  const { data: tree, error: treeError } = useFetch(
    () => fetchCompareTree(project, original.ref, updated.ref),
    [project, original.ref, updated.ref],
  )
  const { data: compareItem, error: itemError } = useFetch(
    selected ? () => fetchCompareItem(project, original.ref, updated.ref, selected) : null,
    [project, original.ref, updated.ref, selected],
    { keepStale: true },
  )

  // Whole-file compares of many-profile artifacts fold a folder per profile;
  // opening every folder buries the changed ones the compare exists to show.
  const manyFolders = (tree?.tree ?? []).filter((node) => node.type === 'folder').length > 3

  return (
    <>
      <TreePane
        header={
          <>
            <div className="tree-title">{tree?.updated.name ?? updated.label}</div>
            <div className="tree-subtitle">vs {tree?.original.name ?? original.label} (original)</div>
            <div className="compare-actions">
              <Button onClick={onSwap} title="Swap which side counts as original">⇆ Swap</Button>
              <Button onClick={onClear} title="Stop comparing">Done</Button>
            </div>
          </>
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
          <TreeRows
            nodes={tree.tree}
            selected={selected}
            onSelect={setSelected}
            defaultOpen={!manyFolders}
          />
        ) : (
          <div className="pane-message">{treeError ?? 'Comparing…'}</div>
        )}
      </TreePane>

      {compareItem ? (
        <DiffPreview compare={compareItem} />
      ) : (
        <main className="preview">
          {itemError && <div className="pane-message">{itemError}</div>}
        </main>
      )}
    </>
  )
}
