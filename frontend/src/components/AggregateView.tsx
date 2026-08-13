import { useCallback, useMemo, useState } from 'react'

import { aggregateSettings } from '../api'
import { errorMessage } from '../lib/errors'
import type { AggregateResult, ProjectTree } from '../types'
import { TreePane, TreeRows } from './FileTree'
import { Button, DataTable, SectionHeader, TextArea, type TableRow } from './ui'

// Aggregate mode: check a range of objects in the tree (none checked = whole
// project), list the setting names to pull, and get objects × settings as one
// table. Matching is case-insensitive substring, so "baud" finds "Baud Rate"
// and "Failover Serial Port Baud Rate" — each cell says which setting it
// matched when that isn't obvious.

function resultRows(result: AggregateResult): TableRow[] {
  return result.rows.map((row) => ({
    id: row.file,
    titles: { object: row.file },
    cells: {
      object: <span className="agg-object">{row.name}</span>,
      kind: <span className="agg-kind">{row.protocol ?? row.kindLabel}</span>,
      ...Object.fromEntries(
        result.terms.map((term) => {
          const matches = row.values[term] ?? []
          return [
            term,
            matches.length === 0
              ? '—'
              : matches.map((match) => (
                  <div key={match.name} className="agg-match">
                    {match.name.toLowerCase() !== term.toLowerCase() && (
                      <span className="agg-match-name">{match.name}: </span>
                    )}
                    {match.value || '""'}
                  </div>
                )),
          ]
        }),
      ),
    },
  }))
}

export function AggregateView({
  project,
  name,
  tree,
}: {
  /** The projector project scope. */
  project: string
  /** The RTAC project whose settings are pivoted. */
  name: string
  tree: ProjectTree
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [termsText, setTermsText] = useState('')
  const [result, setResult] = useState<AggregateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const onToggleCheck = useCallback((paths: string[], value: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      for (const path of paths) {
        if (value) next.add(path)
        else next.delete(path)
      }
      return next
    })
  }, [])

  const run = useCallback(async () => {
    const terms = termsText
      .split(/[\n,]/)
      .map((term) => term.trim())
      .filter(Boolean)
    if (!terms.length) {
      setError('Enter at least one setting name.')
      return
    }
    setRunning(true)
    setError(null)
    try {
      setResult(await aggregateSettings(project, name, terms, [...checked]))
    } catch (err) {
      setResult(null)
      setError(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }, [project, name, termsText, checked])

  // The tree pane and result table don't depend on the terms text — keep
  // them referentially stable so typing re-renders only the controls.
  const treePane = useMemo(
    () => (
      <TreePane
        header={
          <>
            <div className="tree-title">{tree.name}</div>
            <div className="tree-subtitle">check objects to scope · none = all</div>
          </>
        }
        footer={checked.size ? `${checked.size} objects in scope` : 'whole project in scope'}
      >
        <TreeRows nodes={tree.tree} checked={checked} onToggleCheck={onToggleCheck} />
      </TreePane>
    ),
    [tree, checked, onToggleCheck],
  )
  const rows = useMemo(() => (result ? resultRows(result) : []), [result])

  return (
    <>
      {treePane}

      <main className="preview aggregate">
        <div className="aggregate-controls">
          <div className="aggregate-input">
            <label className="aggregate-label" htmlFor="agg-terms">
              Setting names — one per line or comma-separated
            </label>
            <TextArea
              id="agg-terms"
              value={termsText}
              onChange={(e) => setTermsText(e.target.value)}
              placeholder={'Baud Rate\nServer IP Port\nMap Name'}
              rows={4}
            />
          </div>
          <Button variant="primary" onClick={run} disabled={running}>
            {running ? 'Aggregating…' : 'Aggregate'}
          </Button>
        </div>

        {error && <p className="section-note error-note">{error}</p>}

        {result && (
          <>
            <SectionHeader
              title="Results"
              count={`${result.rows.length} objects${result.scoped ? ' · scoped' : ''}`}
            />
            {result.rows.length === 0 ? (
              <p className="section-note">No object in scope carries a matching setting.</p>
            ) : (
              <DataTable
                columns={[
                  { key: 'object', label: 'Object' },
                  { key: 'kind', label: 'Kind' },
                  ...result.terms.map((term) => ({ key: term, label: term })),
                ]}
                rows={rows}
              />
            )}
          </>
        )}
      </main>
    </>
  )
}
