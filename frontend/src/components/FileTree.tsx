import { useMemo, useState, type ReactNode } from 'react'
import { useTreePaneWidth } from '../lib/usePaneWidth'
import type { ItemCategory, ProjectTree, TreeNode } from '../types'
import { Checkbox } from './ui'

// Small colored glyph per item category so the tree reads at a glance.
const CATEGORY_GLYPH: Record<ItemCategory, { glyph: string; className: string }> = {
  connection: { glyph: '⇄', className: 'cat-connection' },
  tagList: { glyph: '☰', className: 'cat-taglist' },
  logic: { glyph: '{}', className: 'cat-logic' },
  system: { glyph: '⚙', className: 'cat-system' },
  hardware: { glyph: '▤', className: 'cat-hardware' },
  extension: { glyph: '✚', className: 'cat-extension' },
  meta: { glyph: 'ℹ', className: 'cat-meta' },
  other: { glyph: '?', className: 'cat-other' },
}

// Every item path under a node — what a folder checkbox toggles.
function itemPaths(node: TreeNode): string[] {
  if (node.type === 'item') return [node.path]
  return node.children.flatMap(itemPaths)
}

interface RowsProps {
  selected?: string | null
  onSelect?: (path: string) => void
  // aggregate mode: object-range checkboxes
  checked?: Set<string>
  onToggleCheck?: (paths: string[], value: boolean) => void
  /** Folders start closed when the folders ARE the index (whole-file compare). */
  defaultOpen?: boolean
}

function TreeEntry(props: RowsProps & { node: TreeNode; depth: number }) {
  const { node, depth, selected, onSelect, checked, onToggleCheck, defaultOpen = true } = props
  const [open, setOpen] = useState(defaultOpen)
  const indent = { paddingLeft: `${8 + depth * 14}px` }
  const checkable = checked !== undefined && onToggleCheck !== undefined
  // The subtree flatten is only needed to drive the folder checkbox.
  const paths = useMemo(
    () => (checkable && node.type === 'folder' ? itemPaths(node) : []),
    [checkable, node],
  )

  if (node.type === 'folder') {
    const allChecked = paths.length > 0 && paths.every((path) => checked?.has(path))
    const someChecked = !allChecked && paths.some((path) => checked?.has(path))
    const folderClasses = ['tree-row', 'tree-folder']
    if (node.status && node.status !== 'unchanged') folderClasses.push(`row-${node.status}`)
    return (
      <>
        <button
          className={folderClasses.join(' ')}
          style={indent}
          title={node.status && node.status !== 'unchanged' ? `${node.name} · ${node.status}` : node.name}
          onClick={() => setOpen(!open)}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          {checkable && (
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              stopClickPropagation
              onChange={(value) => onToggleCheck(paths, value)}
            />
          )}
          <span className="tree-name">{node.name}</span>
          {node.status && node.status !== 'unchanged' && (
            <span className={`status-dot status-${node.status}`}>
              {node.status === 'added' ? 'A' : node.status === 'removed' ? 'R' : 'M'}
            </span>
          )}
        </button>
        {open &&
          node.children.map((child) => (
            <TreeEntry {...props} key={child.path} node={child} depth={depth + 1} />
          ))}
      </>
    )
  }

  const { glyph, className } = CATEGORY_GLYPH[node.category] ?? CATEGORY_GLYPH.other
  const classes = ['tree-row', 'tree-item']
  if (node.path === selected) classes.push('selected')
  if (node.error) classes.push('tree-error')
  if (node.status && node.status !== 'unchanged') classes.push(`row-${node.status}`)

  return (
    <button
      className={classes.join(' ')}
      style={indent}
      title={
        node.error
          ? `${node.name}: ${node.error}`
          : `${node.kindLabel}${node.protocol ? ` · ${node.protocol}` : ''}${node.status && node.status !== 'unchanged' ? ` · ${node.status}` : ''}`
      }
      onClick={() => onSelect?.(node.path)}
    >
      {checkable && (
        <Checkbox
          checked={checked.has(node.path)}
          stopClickPropagation
          onChange={(value) => onToggleCheck([node.path], value)}
        />
      )}
      <span className={`tree-glyph ${className}`}>{glyph}</span>
      <span className="tree-name">{node.name}</span>
      {node.protocol && <span className="tree-tag">{node.protocol}</span>}
      {node.status && node.status !== 'unchanged' && (
        <span className={`status-dot status-${node.status}`}>
          {node.status === 'added' ? 'A' : node.status === 'removed' ? 'R' : 'M'}
        </span>
      )}
      {typeof node.pointCount === 'number' && node.pointCount > 0 && (
        <span className="tree-count">{node.pointCount}</span>
      )}
    </button>
  )
}

// The scrollable recursive rows, shared by browse, compare, and aggregate.
export function TreeRows({ nodes, ...props }: RowsProps & { nodes: TreeNode[] }) {
  return (
    <div className="tree-scroll">
      {nodes.map((node) => (
        <TreeEntry key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  )
}

// Generic middle-pane frame: header + rows + footer, resizable on its right
// edge (browse, compare, and aggregate share the width).
export function TreePane({
  header,
  footer,
  children,
}: {
  header: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const { width, startResize } = useTreePaneWidth()
  return (
    <aside className="file-tree" style={{ width }}>
      <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="pane-header">{header}</div>
      {children}
      {footer && <div className="pane-footer">{footer}</div>}
    </aside>
  )
}

export function FileTree({
  tree,
  selected,
  onSelect,
}: {
  tree: ProjectTree
  selected: string | null
  onSelect: (path: string) => void
}) {
  const { summary } = tree
  return (
    <TreePane
      header={
        <>
          <div className="tree-title">{tree.name}</div>
          <div className="tree-subtitle">
            {tree.deviceLabel ?? 'Unknown device'}
            {tree.schema && ` · schema ${tree.schema}`}
          </div>
        </>
      }
      footer={
        summary.connections !== undefined
          ? `${summary.connections} connections · ${summary.totalPoints} points · ${summary.files} files`
          : `${summary.files} sections`
      }
    >
      <TreeRows nodes={tree.tree} selected={selected} onSelect={onSelect} />
    </TreePane>
  )
}
