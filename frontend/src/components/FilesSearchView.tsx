import { useEffect, useMemo, useRef, useState } from 'react'

import { listFiles, openFileEntry } from '../api'
import { errorMessage } from '../lib/errors'
import { formatSize } from '../lib/format'
import { useDebounced } from '../lib/useDebounced'
import type { FileNode } from '../types'
import { Highlight } from './Highlight'
import { TextInput } from './ui'

// Files › Search: live case-insensitive substring over every file and folder
// NAME (and path) in the project tree — document contents are out of scope.
// Single click jumps to the entry in Navigate; double-clicking a file opens
// it with the OS default app, same as the tree. The single click is delayed
// a beat so a double-click doesn't tear the row out from under itself.

const DOUBLE_CLICK_GRACE_MS = 250

interface FlatEntry {
  type: 'folder' | 'file'
  name: string
  path: string
  size?: number
}

function flatten(nodes: FileNode[], out: FlatEntry[] = []): FlatEntry[] {
  for (const node of nodes) {
    out.push({
      type: node.type,
      name: node.name,
      path: node.path,
      size: node.type === 'file' ? node.size : undefined,
    })
    if (node.type === 'folder') flatten(node.children, out)
  }
  return out
}

export function FilesSearchView({
  project,
  onOpen,
}: {
  project: string
  /** Jump to the entry in Navigate. */
  onOpen: (path: string) => void
}) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const needle = useDebounced(query, 200).trim().toLowerCase()
  const clickTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    listFiles(project).then(setTree, (err) => setError(errorMessage(err)))
    return () => window.clearTimeout(clickTimer.current)
  }, [project])

  const entries = useMemo(() => (tree ? flatten(tree) : []), [tree])
  const hits = useMemo(
    () =>
      needle
        ? entries.filter(
            (entry) =>
              entry.name.toLowerCase().includes(needle) ||
              entry.path.toLowerCase().includes(needle),
          )
        : [],
    [entries, needle],
  )

  const reveal = (entry: FlatEntry) => {
    window.clearTimeout(clickTimer.current)
    if (entry.type === 'folder') {
      onOpen(entry.path)
      return
    }
    clickTimer.current = window.setTimeout(() => onOpen(entry.path), DOUBLE_CLICK_GRACE_MS)
  }

  const open = (entry: FlatEntry) => {
    window.clearTimeout(clickTimer.current)
    openFileEntry(project, entry.path).catch((err) => setError(errorMessage(err)))
  }

  return (
    <main className="preview search-view">
      <header className="preview-header">
        <div className="search-bar">
          <TextInput
            autoFocus
            value={query}
            placeholder="Find a file or folder by name…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {needle && (
          <div className="preview-subtitle">
            {hits.length} entr{hits.length === 1 ? 'y' : 'ies'} · click to reveal in Navigate,
            double-click a file to open it
          </div>
        )}
      </header>
      <div className="preview-scroll no-sheets">
        {error && <div className="pane-message">{error}</div>}
        {!error && tree && !needle && (
          <div className="pane-message">
            {entries.length
              ? 'Searches every file and folder name in the project as you type.'
              : 'No files yet — switch to Navigate to drop some in.'}
          </div>
        )}
        {!error && needle && tree && hits.length === 0 && (
          <div className="pane-message">No matches for "{query.trim()}".</div>
        )}
        {hits.map((entry) => (
          <button
            key={entry.path}
            className="search-match as-row file-hit"
            title={entry.type === 'file' ? `${entry.name} — double-click to open` : entry.name}
            onClick={() => reveal(entry)}
            onDoubleClick={entry.type === 'file' ? () => open(entry) : undefined}
          >
            <span className="file-glyph">{entry.type === 'folder' ? '▸' : '▤'}</span>
            <span className="search-text">
              <Highlight text={entry.name} query={needle} />
            </span>
            <span className="search-path">{entry.path}</span>
            {entry.size !== undefined && <span className="search-size">{formatSize(entry.size)}</span>}
          </button>
        ))}
      </div>
    </main>
  )
}
