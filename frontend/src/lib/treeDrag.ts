// What travels on a drag between the project tree and the tools. The tree
// is the one place files are picked from: its rows carry their project and
// paths, and a tool's drop area takes them. The other way, a tool's output
// row carries its run file, and a tree folder takes it as a new entry.

import type { DragEvent } from 'react'

/** Tree rows: { project, paths }. */
export const TREE_ENTRY_MIME = 'application/projector-file-entry'
/** Tool output rows: { tool, run, path, name }. */
export const TOOL_OUTPUT_MIME = 'application/projector-tool-output'

export interface TreeDrag {
  project: string
  paths: string[]
}

export interface ToolOutputDrag {
  tool: string
  run: string
  path: string
  name: string
}

export function setTreeDrag(e: DragEvent, drag: TreeDrag) {
  e.dataTransfer.setData(TREE_ENTRY_MIME, JSON.stringify(drag))
  // Moved within the tree; copied into a tool.
  e.dataTransfer.effectAllowed = 'copyMove'
}

/** The tree entries on a drop, or null when the drag is something else. */
export function readTreeDrag(e: DragEvent): TreeDrag | null {
  const raw = e.dataTransfer.getData(TREE_ENTRY_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (typeof value?.project === 'string' && Array.isArray(value.paths)) {
      return { project: value.project, paths: value.paths.filter((p: unknown) => typeof p === 'string') }
    }
  } catch {
    // not ours
  }
  return null
}

export function setToolOutputDrag(e: DragEvent, drag: ToolOutputDrag) {
  e.dataTransfer.setData(TOOL_OUTPUT_MIME, JSON.stringify(drag))
  e.dataTransfer.effectAllowed = 'copy'
}

export function readToolOutputDrag(e: DragEvent): ToolOutputDrag | null {
  const raw = e.dataTransfer.getData(TOOL_OUTPUT_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return typeof value?.tool === 'string' && typeof value.run === 'string' && typeof value.path === 'string'
      ? { tool: value.tool, run: value.run, path: value.path, name: String(value.name ?? '') }
      : null
  } catch {
    return null
  }
}

/** Whether a drag in progress carries `mime` (the data itself is only
 *  readable on drop). */
export function dragHas(e: DragEvent, mime: string): boolean {
  return [...e.dataTransfer.types].includes(mime)
}

/** Whether `path` ends in one of `extensions` (lowercase, with dots). */
export function hasExtension(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext))
}
