// The "or take it from the project" half of every tool's file intake: a
// select over the current project's Files store, filtered to the extensions
// the tool accepts. Sits beside the drop-zone (the OS-filesystem half).

import { useEffect, useState } from 'react'

import { listFiles } from '../api'
import { Select } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { FileNode } from '../types'

function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'folder') flattenFiles(node.children, out)
    else out.push(node.path)
  }
  return out
}

export function ProjectFilePick({
  project,
  extensions,
  onPick,
  disabled = false,
}: {
  project: string
  /** Lowercase extensions with dots, e.g. ['.xml']. */
  extensions: string[]
  onPick: (path: string) => void
  disabled?: boolean
}) {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    listFiles(project)
      .then((tree) => {
        setPaths(flattenFiles(tree).filter((p) =>
          extensions.some((ext) => p.toLowerCase().endsWith(ext)),
        ))
        setError(null)
      })
      .catch((err) => setError(errorMessage(err)))
  }

  // Load on mount and refresh whenever the control is focused, so files added
  // to the project while the (latched) tool pane sat hidden still show up.
  // extensions is a per-tool constant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [project])

  if (error) return <div className="tool-error">Project files unavailable: {error}</div>
  if (!paths || paths.length === 0) return null
  return (
    <div className="tool-row" onFocusCapture={load}>
      <Select
        label={`Or pick from ${project} › Files`}
        value=""
        placeholder={`${paths.length} matching file(s)…`}
        options={paths}
        onChange={(path) => {
          if (path && !disabled) onPick(path)
        }}
      />
    </div>
  )
}
