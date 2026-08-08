import { useEffect, useState } from 'react'

import { fetchCompareItem, fetchCompareTree } from '../api'
import { useFetch } from '../lib/useFetch'
import type { ProjectEntry } from '../types'
import { DiffPreview } from './DiffPreview'
import { TreePane, TreeRows } from './FileTree'
import { Select } from './ui'

// Compare mode: pick an original and a new project (both must be downloaded),
// get the union file tree with added/removed/edited tints, click a row for
// the structured diff.

export function CompareView({ projects }: { projects: ProjectEntry[] }) {
  const ready = projects.filter((p) => p.status === 'ready').map((p) => p.name)
  const [original, setOriginal] = useState<string>('')
  const [updated, setUpdated] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)

  const bothPicked = Boolean(original && updated && original !== updated)

  useEffect(() => {
    setSelected(null)
  }, [original, updated])

  const { data: tree, error: treeError } = useFetch(
    bothPicked ? () => fetchCompareTree(original, updated) : null,
    [original, updated, bothPicked],
  )
  const { data: compareItem, error: itemError } = useFetch(
    bothPicked && selected ? () => fetchCompareItem(original, updated, selected) : null,
    [original, updated, selected, bothPicked],
    { keepStale: true },
  )

  return (
    <>
      <TreePane
        header={
          <div className="compare-header">
            <Select
              label="Original"
              value={original}
              onChange={setOriginal}
              options={ready}
              placeholder="— select —"
            />
            <Select
              label="New"
              value={updated}
              onChange={setUpdated}
              options={ready}
              placeholder="— select —"
            />
          </div>
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
          <TreeRows nodes={tree.tree} selected={selected} onSelect={setSelected} />
        ) : (
          <div className="pane-message">
            {treeError ??
              (bothPicked
                ? 'Comparing…'
                : original && updated
                  ? 'Pick two different projects.'
                  : 'Pick an original and a new project. Only downloaded projects can be compared.')}
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
                ? 'Select an object to see what changed.'
                : 'The union of both project trees will show here with added, removed, and modified objects tinted.')}
          </div>
        </main>
      )}
    </>
  )
}
