// The "or take it from a project" half of every tool's file intake: a
// project selector plus a select over that project's Files store, filtered
// to the extensions the tool accepts. Tools are GLOBAL utilities — the
// project open in the sidebar is only the dropdown's starting value, never
// an assumption. Sits beside the drop-zone (the OS-filesystem half).

import { useEffect, useState } from 'react'

import { listFiles, listProjects } from '../api'
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
  /** Starting value for the project dropdown (usually the open project). */
  project: string
  /** Lowercase extensions with dots, e.g. ['.xml']. */
  extensions: string[]
  onPick: (path: string, project: string) => void
  disabled?: boolean
}) {
  const [projects, setProjects] = useState<string[]>([])
  const [selected, setSelected] = useState(project)
  const [paths, setPaths] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    listProjects().then(setProjects).catch(() => {})
    if (!selected) return
    listFiles(selected)
      .then((tree) => {
        setPaths(flattenFiles(tree).filter((p) =>
          extensions.some((ext) => p.toLowerCase().endsWith(ext)),
        ))
        setError(null)
      })
      .catch((err) => setError(errorMessage(err)))
  }

  // Load on mount and whenever the chosen project changes; refresh whenever
  // the control is focused, so files added while the (latched) tool pane sat
  // hidden still show up. extensions is a per-tool constant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [selected])

  if (error) return <div className="tool-error">Project files unavailable: {error}</div>
  if (!projects.length && !selected) return null
  return (
    <div className="tool-row" onFocusCapture={load}>
      <Select
        label="From project"
        value={selected}
        options={projects.length ? projects : [selected].filter(Boolean)}
        onChange={(name) => {
          if (name && name !== selected) {
            setPaths(null)
            setSelected(name)
          }
        }}
      />
      <Select
        label="Pick a file"
        value=""
        placeholder={paths === null
          ? 'loading…'
          : paths.length
            ? `${paths.length} matching file(s)…`
            : 'no matching files'}
        options={paths ?? []}
        onChange={(path) => {
          if (path && !disabled) onPick(path, selected)
        }}
      />
    </div>
  )
}
