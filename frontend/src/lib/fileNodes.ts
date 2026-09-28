// Walks over and names things in a project's FileNode tree — shared by the
// sidebar, the panes that show a selection, and the tools, which pick their
// inputs out of the tree rather than asking for an upload.

import type { FileNode } from '../types'

/** A tree leaf — the file half of FileNode, with its artifact kind. */
export type FileLeafNode = Extract<FileNode, { type: 'file' }>

/** Every leaf in the tree, depth-first, optionally narrowed by `pick`. */
export function leaves(nodes: FileNode[], pick?: (node: FileLeafNode) => boolean): FileLeafNode[] {
  const out: FileLeafNode[] = []
  const walk = (level: FileNode[]) => {
    for (const node of level) {
      if (node.type === 'folder') walk(node.children)
      else if (!pick || pick(node)) out.push(node)
    }
  }
  walk(nodes)
  return out
}

/** Every RTAC export entry in a project tree — the DAC projects a tool can
 *  build onto, by tree path. */
export function rtacPaths(nodes: FileNode[]): string[] {
  return leaves(nodes, (node) => node.kind === 'rtac').map((node) => node.path)
}

/** The AcRTAC database project an `.rtac` entry mirrors: its recorded
 *  `database`, else the entry's name without `.rtac`. */
export function databaseName(entry: { database?: string | null; name: string }): string {
  return entry.database ?? entry.name.replace(/\.rtac$/i, '')
}

/** The sidebar's name for a leaf. */
export type FileLeaf = FileLeafNode

export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.type === 'folder') {
      const hit = findNode(node.children, path)
      if (hit) return hit
    }
  }
  return null
}

/** The live leaf a selected path belongs to — itself, or the entry whose
 *  version list contains it (selecting v2 still "belongs" to the entry). */
export function findLeafFor(nodes: FileNode[], path: string): FileLeaf | null {
  for (const node of nodes) {
    if (node.type === 'folder') {
      const hit = findLeafFor(node.children, path)
      if (hit) return hit
    } else {
      if (node.path === path) return node
      if (node.versions.some((version) => version.path === path)) return node
    }
  }
  return null
}

export function isTextFile(name: string): boolean {
  return /\.(txt|md)$/i.test(name)
}

/** Rendered in the preview pane by Chromium's built-in PDF viewer. */
export function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

/** The tree narrowed to what matches: a leaf by its own name, a folder by
 *  holding a match — or by its own name, which keeps its whole subtree, since
 *  naming a folder means asking for what is in it. */
export function filterTree(nodes: FileNode[], needle: string): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    const self = node.name.toLowerCase().includes(needle)
    if (node.type !== 'folder' || self) {
      if (self) out.push(node)
      continue
    }
    const children = filterTree(node.children, needle)
    if (children.length) out.push({ ...node, children })
  }
  return out
}

/** Display name for a ref/path — the entry name, with archive stamps shed. */
export function displayName(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/^\d{10,}-/, '')
}

/** What to call a path anywhere two versions could be confused: the entry
 *  name plus its version number — "feeder_1.rdb v2" for an archived
 *  version, "feeder_1.rdb v3" for the current one of a versioned entry. */
export function refLabel(tree: FileNode[] | null, path: string): string {
  const leaf = tree ? findLeafFor(tree, path) : null
  if (leaf && leaf.path !== path) {
    const index = leaf.versions.findIndex((version) => version.path === path)
    // An archived version answers to ITS name — the entry may have been
    // renamed by a later arrival.
    if (index >= 0) return `${leaf.versions[index].name} v${leaf.versions.length - index}`
  }
  if (leaf && leaf.path === path && leaf.versions.length) {
    return `${leaf.name} v${leaf.versions.length + 1}`
  }
  return displayName(path)
}

const extOf = (name: string) => (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase()

/** A file name's extension AS WRITTEN (case kept — it is going back into the
 *  name), or '' when it carries none. Only a short all-alphanumeric tail
 *  holding at least one letter counts, so "Feeder Rev 2.1" has no extension
 *  to protect and renames whole. The backend enforces the same rule. */
export function nameExtension(name: string): string {
  return /\.(?=[^.]*[A-Za-z])[A-Za-z0-9]{1,10}$/.exec(name)?.[0] ?? ''
}

/** The picked "Add new version…" file, its name normalized against the
 *  entry it supersedes — or the refusal message. A browser/Explorer
 *  duplicate suffix (" (1)", " - Copy") never renames the entry, and an
 *  extension change is refused as a mispick: the entry's artifact TYPE is
 *  its extension, and flipping it would strand Inspect/Compare. */
export function stageVersionFile(file: File, entryName: string): File | string {
  if (extOf(file.name) !== extOf(entryName)) {
    return `${file.name} is a different file type than ${entryName} — a new version keeps the `
      + `entry's type. Rename the entry first if the change is deliberate.`
  }
  const undup = file.name.replace(/(?: \(\d+\)| - Copy(?: \(\d+\))?)(\.[^.]+)?$/i, '$1')
  if (undup.toLowerCase() === entryName.toLowerCase() && file.name !== entryName) {
    return new File([file], entryName, { type: file.type })
  }
  return file
}

/** The folder a tree path sits in ('' for the root). */
export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
