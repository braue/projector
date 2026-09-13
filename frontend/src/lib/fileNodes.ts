// Walks over a project's FileNode tree. The tools pick their inputs out of the
// tree rather than asking for an upload, so "flatten to the leaves I can use"
// is the shape they all want.

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
