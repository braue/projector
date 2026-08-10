import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createFileFolder,
  deleteFileEntry,
  listFiles,
  moveFileEntry,
  openFileEntry,
  renameFileEntry,
  uploadFiles,
} from '../api'
import { errorMessage } from '../lib/errors'
import { formatSize } from '../lib/format'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type { FileNode } from '../types'
import { Button, InlineNameForm } from './ui'

// Files mode — generic project documents (PDFs, Word, Excel, anything) in a
// user-shaped folder tree. The tree is a REAL directory under the project's
// data folder, so every operation is a plain filesystem move and
// double-clicking a file hands the OS the real path to open with its
// default app (the backend runs on this machine).
//
// The rail is the tree: upload at the top (into the selected folder), a new
// folder button, then rows. Rows drag; folders (and the rail background =
// the root) take drops — both internal moves and files dragged in from the
// OS. Hover ✎ renames, ✕ deletes; single click selects, double click on a
// file opens it.

const ENTRY_MIME = 'application/purview-file-entry'

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.type === 'folder') {
      const hit = findNode(node.children, path)
      if (hit) return hit
    }
  }
  return null
}

export function FilesView({
  project,
  initialSelected = null,
}: {
  project: string
  /** Select this entry once the tree loads (a jump from Files › Search). */
  initialSelected?: string | null
}) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Starts on the jump target (the view remounts per sub-mode toggle, so a
  // mount-time initializer is enough); a path absent from the tree is inert.
  const [selected, setSelected] = useState<string | null>(initialSelected)
  // Which folder row (or '' = the rail root) is lit as a drop target.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Inline forms: a rename on one path, or a new folder under one dir.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const { width, startResize } = useSidebarWidth()
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setTree(await listFiles(project))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [project])

  useEffect(() => {
    setTree(null)
    load()
  }, [load])

  // Every mutation reloads the tree; failures surface in the rail.
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
    await load()
  }

  const selectedNode = tree && selected !== null ? findNode(tree, selected) : null
  // Uploads and new folders land in the selected folder (or the file's
  // parent folder, or the root).
  const targetDir = selectedNode
    ? selectedNode.type === 'folder'
      ? selectedNode.path
      : selectedNode.path.split('/').slice(0, -1).join('/')
    : ''

  const handleUpload = (files: File[], dir: string) => {
    if (files.length) act(() => uploadFiles(project, dir, files))
  }

  const handleDrop = (e: React.DragEvent, dir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const entry = e.dataTransfer.getData(ENTRY_MIME)
    if (entry) {
      // Internal move; moving into its own parent is a harmless no-op 409.
      if (entry !== dir) act(() => moveFileEntry(project, entry, dir))
      return
    }
    handleUpload([...e.dataTransfer.files], dir)
  }

  const dropProps = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(dir)
    },
    onDragLeave: (e: React.DragEvent) => {
      e.stopPropagation()
      setDropTarget((current) => (current === dir ? null : current))
    },
    onDrop: (e: React.DragEvent) => handleDrop(e, dir),
  })

  const rowActions = (node: FileNode) => (
    <>
      <span
        className="entry-delete entry-rename"
        title={`Rename ${node.name}`}
        onClick={(e) => {
          e.stopPropagation()
          setRenaming(node.path)
        }}
      >
        ✎
      </span>
      <span
        className="entry-delete"
        title={`Delete ${node.name}`}
        onClick={(e) => {
          e.stopPropagation()
          const what = node.type === 'folder' ? `folder "${node.name}" and everything in it` : `"${node.name}"`
          if (!window.confirm(`Delete ${what}?`)) return
          if (selected === node.path) setSelected(null)
          act(() => deleteFileEntry(project, node.path))
        }}
      >
        ✕
      </span>
    </>
  )

  const renderNode = (node: FileNode, depth: number) => {
    if (renaming === node.path) {
      return (
        <InlineNameForm
          key={node.path}
          initial={node.name}
          placeholder="New name — Enter to rename"
          onCommit={async (value) => {
            await renameFileEntry(project, node.path, value)
            setRenaming(null)
            await load()
          }}
          onCancel={() => setRenaming(null)}
        />
      )
    }

    const common = {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(ENTRY_MIME, node.path)
        e.dataTransfer.effectAllowed = 'move'
      },
      style: { paddingLeft: `${10 + depth * 14}px` },
    }

    if (node.type === 'folder') {
      return (
        <FolderRow
          key={node.path}
          node={node}
          depth={depth}
          selected={selected}
          dropTarget={dropTarget}
          common={common}
          dropProps={dropProps(node.path)}
          onSelect={() => setSelected(node.path)}
          actions={rowActions(node)}
          renderNode={renderNode}
          creatingIn={creatingIn}
          onCreate={async (value) => {
            await createFileFolder(project, node.path, value)
            setCreatingIn(null)
            await load()
          }}
          onCancelCreate={() => setCreatingIn(null)}
        />
      )
    }

    return (
      <button
        key={node.path}
        {...common}
        className={`tree-row file-row${selected === node.path ? ' selected' : ''}`}
        title={`${node.name} — double-click to open`}
        onClick={() => setSelected(node.path)}
        onDoubleClick={() => act(() => openFileEntry(project, node.path))}
      >
        <span className="file-glyph">▤</span>
        <span className="tree-name">{node.name}</span>
        {rowActions(node)}
      </button>
    )
  }

  return (
    <>
      <aside className="sources" style={{ width }}>
        <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
        <div
          className={`source-scroll files-root${dropTarget === '' ? ' file-drop' : ''}`}
          {...dropProps('')}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              handleUpload([...(e.target.files ?? [])], targetDir)
              e.target.value = ''
            }}
          />
          <button className="drop-zone as-button" onClick={() => fileInput.current?.click()}>
            <b>Drop files here</b>
            {targetDir ? `into ${targetDir}` : 'or click to browse'}
          </button>
          <div className="files-toolbar">
            <Button onClick={() => setCreatingIn(targetDir)}>New folder</Button>
          </div>
          {creatingIn === targetDir && (
            <InlineNameForm
              placeholder={`Folder name${targetDir ? ` in ${targetDir}` : ''} — Enter to create`}
              onCommit={async (value) => {
                await createFileFolder(project, targetDir, value)
                setCreatingIn(null)
                await load()
              }}
              onCancel={() => setCreatingIn(null)}
            />
          )}
          <div className="files-tree">
            {tree?.map((node) => renderNode(node, 0))}
            {tree && !tree.length && (
              <div className="pane-message">No files yet — drop anything above.</div>
            )}
          </div>
          {error && (
            <div className="list-error">
              <div className="list-error-text">{error}</div>
            </div>
          )}
        </div>
      </aside>

      <main className="preview">
        {selectedNode?.type === 'file' ? (
          <>
            <header className="preview-header">
              <div className="preview-title-row">
                <h2>{selectedNode.name}</h2>
              </div>
              <div className="preview-subtitle">
                <span className="mono">{selectedNode.path}</span>
              </div>
            </header>
            <div className="files-detail">
              <div>{formatSize(selectedNode.size)}</div>
              <div>Modified {new Date(selectedNode.modifiedAt).toLocaleString()}</div>
              <Button variant="primary" onClick={() => act(() => openFileEntry(project, selectedNode.path))}>
                Open
              </Button>
              <div className="dim">Opens with this file type's default app.</div>
            </div>
          </>
        ) : (
          <div className="pane-message">
            {tree === null
              ? 'Loading…'
              : 'Select a file to see its details — or double-click one to open it.'}
          </div>
        )}
      </main>
    </>
  )
}

function FolderRow({
  node,
  depth,
  selected,
  dropTarget,
  common,
  dropProps,
  onSelect,
  actions,
  renderNode,
  creatingIn,
  onCreate,
  onCancelCreate,
}: {
  node: Extract<FileNode, { type: 'folder' }>
  depth: number
  selected: string | null
  dropTarget: string | null
  common: object
  dropProps: object
  onSelect: () => void
  actions: React.ReactNode
  renderNode: (node: FileNode, depth: number) => React.ReactNode
  creatingIn: string | null
  onCreate: (value: string) => Promise<void>
  onCancelCreate: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button
        {...common}
        {...dropProps}
        className={[
          'tree-row', 'tree-folder', 'file-row',
          selected === node.path ? 'selected' : '',
          dropTarget === node.path ? 'file-drop' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => {
          onSelect()
          setOpen((current) => !current)
        }}
      >
        <span className="tree-caret">{open ? '▾' : '▸'}</span>
        <span className="tree-name">{node.name}</span>
        {actions}
      </button>
      {open && node.children.map((child) => renderNode(child, depth + 1))}
      {open && creatingIn === node.path && (
        <InlineNameForm
          placeholder={`Folder name in ${node.name} — Enter to create`}
          onCommit={onCreate}
          onCancel={onCancelCreate}
        />
      )}
    </>
  )
}
