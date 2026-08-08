import { useEffect, useState } from 'react'

import { fetchCompareItem, fetchCompareTree } from '../api'
import type { CompareItem, CompareTree, ProjectEntry } from '../types'
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
  const [tree, setTree] = useState<CompareTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [compareItem, setCompareItem] = useState<CompareItem | null>(null)
  const [itemError, setItemError] = useState<string | null>(null)

  const bothPicked = original && updated && original !== updated

  useEffect(() => {
    if (!bothPicked) {
      setTree(null)
      setSelected(null)
      return
    }
    let cancelled = false
    setTree(null)
    setTreeError(null)
    setSelected(null)
    fetchCompareTree(original, updated)
      .then((t) => !cancelled && setTree(t))
      .catch((err) => !cancelled && setTreeError(err.message))
    return () => {
      cancelled = true
    }
  }, [original, updated, bothPicked])

  useEffect(() => {
    if (!bothPicked || !selected) {
      setCompareItem(null)
      return
    }
    let cancelled = false
    setItemError(null)
    fetchCompareItem(original, updated, selected)
      .then((d) => !cancelled && setCompareItem(d))
      .catch((err) => !cancelled && setItemError(err.message))
    return () => {
      cancelled = true
    }
  }, [original, updated, selected, bothPicked])

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
