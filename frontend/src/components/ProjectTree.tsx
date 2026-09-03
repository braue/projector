import { useMemo, useRef, useState } from 'react'

import {
  createFileFolder,
  deleteFileEntry,
  discardFileEdit,
  dismissRtacError,
  moveFileEntry,
  openFileEntry,
  recordFileEdit,
  renameFileEntry,
  revealFileEntry,
  saveTextFile,
  startRtacExport,
  uploadFiles,
  uploadRtacFolder,
} from '../api'
import { errorMessage } from '../lib/errors'
import { formatDay, formatStamp, formatWhen } from '../lib/format'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type { ArtifactKindName, FileNode, FileVersion, RtacExportStatus } from '../types'
import { RtacDatabaseModal } from './RtacDatabaseModal'
import { ContextMenu, InlineNameForm, Spinner, type ContextMenuItem } from './ui'
import { VersionNoteModal, type PendingItem } from './VersionNoteModal'

// THE sidebar — one folder tree holding everything a project is: settings
// artifacts (RTAC exports, RDB/SCD/switch files), documents, and .txt notes,
// organized however the engineer likes. Git-style versions ride each entry:
// the row is the newest version (its note and time in plain sight), and the
// vN badge accordions out the versions underneath — every one selectable,
// comparable, openable.
//
// No toolbar: the tree is clean rows over empty space, and everything else
// is the RIGHT-CLICK menu — on the background or a folder for intake (add
// files, RTAC export, AcRTAC download, new note/folder), on an entry for
// open/rename/delete/compare, on a version for its compare/open.
//
// Interactions:
//   click            select (artifact → Inspect, .txt → editor, else info)
//   ctrl/cmd+click   hold a SECOND selection (versions count as files here);
//                    right-click either held row for the Compare option
//   double-click     open with the OS default app (files)
//   right-click      the context menu for whatever is under the cursor
//   drag row         move into a folder (or the root background)
//   drop OS files    upload into that folder — the version-note dialog runs

const ENTRY_MIME = 'application/projector-file-entry'

// Stroke icons for the tree rows (lucide outlines), sized and colored by the
// .tree-icon / .tree-chevron CSS. App-specific row decoration, not a ui.tsx
// primitive — the tree rows are LAYOUT, like FileTree's category glyphs.
function icon(path: React.ReactNode, className = 'tree-icon') {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  )
}

const Chevron = ({ open }: { open: boolean }) =>
  icon(<path d="m9 18 6-6-6-6" />, open ? 'tree-chevron open' : 'tree-chevron')

const FolderIcon = ({ open }: { open: boolean }) =>
  open
    ? icon(
        <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />,
        'tree-icon folder',
      )
    : icon(
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
        'tree-icon folder',
      )

const FileIcon = () =>
  icon(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>,
  )

const NoteIcon = () =>
  icon(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>,
  )

const KIND_LABEL: Record<ArtifactKindName, string> = {
  rtac: 'RTAC',
  rdb: 'RDB',
  scd: 'SCD',
  sw: 'SW',
}

export type FileLeaf = Extract<FileNode, { type: 'file' }>

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
    if (index >= 0) return `${leaf.name} v${leaf.versions.length - index}`
  }
  if (leaf && leaf.path === path && leaf.versions.length) {
    return `${leaf.name} v${leaf.versions.length + 1}`
  }
  return displayName(path)
}

type PendingBatch =
  | { kind: 'files'; dir: string; files: File[] }
  | { kind: 'rtac-folder'; dir: string; files: File[]; names: string[] }
  /** "Add new version…": the picked file lands under the ENTRY's name,
   *  whatever the picked file happens to be called on disk. */
  | { kind: 'version'; dir: string; entryName: string; file: File }
  /** "Record edits as new version…": commit a working copy's in-place
   *  edits (the bytes are already there — only the note travels). */
  | { kind: 'edit'; dir: string; path: string; name: string }

/** What was under the cursor when the menu opened. */
type MenuTarget =
  | { type: 'dir'; dir: string; node: Extract<FileNode, { type: 'folder' }> | null }
  | { type: 'leaf'; node: FileLeaf }
  | { type: 'version'; leaf: FileLeaf; version: FileVersion }

export function ProjectTree({
  project,
  tree,
  treeError,
  exports,
  selected,
  secondary,
  onSelect,
  onToggleSecondary,
  onComparePair,
  onReload,
  onExportsChanged,
}: {
  project: string
  tree: FileNode[] | null
  treeError: string | null
  exports: RtacExportStatus[]
  selected: string | null
  /** The second concurrently-selected path (ctrl/cmd-click). */
  secondary: string | null
  onSelect: (path: string | null) => void
  /** Ctrl/cmd-click: pick (or unpick) the second selection. */
  onToggleSecondary: (path: string) => void
  /** The context menu's compare over the two held selections. */
  onComparePair: (original: string, updated: string) => void
  onReload: () => void
  onExportsChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [notingIn, setNotingIn] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [openVersions, setOpenVersions] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingBatch | null>(null)
  const [noteBusy, setNoteBusy] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  // The AcRTAC browser, opened at a destination folder — optionally aimed
  // at an existing entry as its next version (null = closed).
  const [dbState, setDbState] = useState<{ dir: string; versionOf?: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const { width, startResize } = useSidebarWidth()
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const versionInput = useRef<HTMLInputElement>(null)
  // Where the hidden pickers deliver to — set by the menu item that opened
  // them (the input change event no longer knows the folder on its own).
  const intakeDir = useRef('')
  const versionTarget = useRef<{ dir: string; entryName: string } | null>(null)

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
    onReload()
  }

  const toggleSet = (set: Set<string>, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  // --- intake ----------------------------------------------------------------

  const stageUpload = (files: File[], dir: string) => {
    if (!files.length) return
    setNoteError(null)
    setPending({ kind: 'files', dir, files })
  }

  const stageRtacFolder = (files: File[], dir: string) => {
    if (!files.length) return
    const names = [...new Set(files
      .map((file) => (file.webkitRelativePath || file.name).split('/')[0])
      .filter(Boolean))]
    setNoteError(null)
    setPending({ kind: 'rtac-folder', dir, files, names })
  }

  const confirmNote = async (note: string) => {
    if (!pending) return
    setNoteBusy(true)
    try {
      if (pending.kind === 'files') {
        await uploadFiles(project, pending.dir, pending.files, note)
      } else if (pending.kind === 'version') {
        await uploadFiles(project, pending.dir, [
          new File([pending.file], pending.entryName, { type: pending.file.type }),
        ], note)
      } else if (pending.kind === 'edit') {
        await recordFileEdit(project, pending.path, note)
      } else {
        await uploadRtacFolder(project, pending.dir, pending.files, note)
      }
      setPending(null)
      setNoteError(null)
      onReload()
    } catch (err) {
      setNoteError(errorMessage(err))
    } finally {
      setNoteBusy(false)
    }
  }

  const pendingItems: PendingItem[] = useMemo(() => {
    if (!pending || !tree) return []
    const dirNode = pending.dir ? findNode(tree, pending.dir) : null
    const siblings = new Set(
      (dirNode?.type === 'folder' ? dirNode.children : pending.dir ? [] : tree)
        .map((node) => node.name),
    )
    if (pending.kind === 'files') {
      return pending.files.map((file) => ({
        name: file.name,
        isNewVersion: siblings.has(file.name),
      }))
    }
    if (pending.kind === 'version') {
      return [{ name: pending.entryName, isNewVersion: true }]
    }
    if (pending.kind === 'edit') {
      return [{ name: pending.name, isNewVersion: true }]
    }
    return pending.names.map((name) => ({
      name: `${name}.rtac`,
      isNewVersion: siblings.has(`${name}.rtac`),
    }))
  }, [pending, tree])

  const createNote = async (dir: string, name: string) => {
    const file = /\.(txt|md)$/i.test(name) ? name : `${name}.txt`
    const path = dir ? `${dir}/${file}` : file
    await saveTextFile(project, path, '')
    setNotingIn(null)
    onReload()
    onSelect(path)
  }

  // --- the context menu --------------------------------------------------------

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const deleteEntry = (node: FileNode) => {
    const what =
      node.type === 'folder'
        ? `folder "${node.name}" and everything in it`
        : node.versions.length
          ? `"${node.name}" and its ${node.versions.length + 1} versions`
          : `"${node.name}"`
    if (!window.confirm(`Delete ${what}?`)) return
    if (selected === node.path || selected?.startsWith(`${node.path}/`)) onSelect(null)
    act(() => deleteFileEntry(project, node.path))
  }

  /** Intake + creation items for a folder ('' = the root). */
  const dirItems = (dir: string): ContextMenuItem[] => [
    {
      label: 'Add files…',
      onClick: () => {
        intakeDir.current = dir
        fileInput.current?.click()
      },
    },
    {
      label: 'Add RTAC export folder…',
      onClick: () => {
        intakeDir.current = dir
        folderInput.current?.click()
      },
    },
    { label: 'Download from AcRTAC…', onClick: () => setDbState({ dir }) },
    { separator: true },
    { label: 'New note', onClick: () => setNotingIn(dir) },
    { label: 'New folder', onClick: () => setCreatingIn(dir) },
    { separator: true },
    {
      label: 'Show in file explorer',
      onClick: () => act(() => revealFileEntry(project, dir)),
    },
  ]

  /** The kind a path inspects as (versions inherit their entry's kind). */
  const kindOfPath = (p: string) =>
    tree ? findLeafFor(tree, p)?.kind ?? null : null

  /** When two rows are held and `path` is one of them (and kinds agree),
   *  the menu offers comparing them: the right-clicked row is the "new"
   *  side, the other the original — Swap lives in the compare pane. */
  const comparePairItems = (path: string): ContextMenuItem[] => {
    if (!selected || !secondary) return []
    if (path !== selected && path !== secondary) return []
    const other = path === selected ? secondary : selected
    const kind = kindOfPath(path)
    if (!kind || kind !== kindOfPath(other)) return []
    return [{
      label: `Compare with ${refLabel(tree, other)}`,
      onClick: () => onComparePair(other, path),
    }]
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    if (target.type === 'dir') {
      const items = dirItems(target.dir)
      if (target.node) {
        const node = target.node
        items.push(
          { separator: true },
          { label: 'Rename', onClick: () => setRenaming(node.path) },
          { label: 'Delete', danger: true, onClick: () => deleteEntry(node) },
        )
      }
      return items
    }

    if (target.type === 'version') {
      const { version } = target
      return [
        ...comparePairItems(version.path),
        // An archived version of a directory artifact (size null) is a
        // FOLDER — the OS-open endpoint serves files only, so it gets
        // "show in explorer" alone.
        ...(version.size !== null
          ? [{
              label: 'Open with default app',
              onClick: () => act(() => openFileEntry(project, version.path)),
            }]
          : []),
        {
          label: 'Show in file explorer',
          onClick: () => act(() => revealFileEntry(project, version.path)),
        },
      ]
    }

    const node = target.node
    const nodeDir = node.path.split('/').slice(0, -1).join('/')
    return [
      ...(node.kind
        ? [{ label: 'Inspect', onClick: () => onSelect(node.path) }]
        : isTextFile(node.name)
          ? [{ label: 'Edit', onClick: () => onSelect(node.path) }]
          : []),
      { label: 'Open with default app', onClick: () => act(() => openFileEntry(project, node.path)) },
      {
        label: 'Show in file explorer',
        onClick: () => act(() => revealFileEntry(project, node.path)),
      },
      // A working copy edited in place (Excel over the live file) commits
      // as a new version — the pre-edit snapshot archives — or restores.
      ...(node.edited
        ? [
            {
              label: 'Record edits as new version…',
              onClick: () => {
                setNoteError(null)
                setPending({ kind: 'edit', dir: nodeDir, path: node.path, name: node.name })
              },
            },
            {
              label: 'Discard on-disk edits',
              danger: true,
              onClick: () => {
                if (!window.confirm(`Discard the on-disk edits to "${node.name}" and restore the recorded version?`)) return
                act(() => discardFileEdit(project, node.path))
              },
            },
          ]
        : []),
      // Versioning an RTAC export means pulling it from the database again
      // (or re-uploading the folder); single-file entries get a direct
      // file-picker path.
      ...(node.kind === 'rtac'
        ? [{
            label: 'New version from AcRTAC…',
            onClick: () => setDbState({ dir: nodeDir, versionOf: node.name }),
          }]
        : [{
            label: 'Add new version…',
            onClick: () => {
              versionTarget.current = { dir: nodeDir, entryName: node.name }
              versionInput.current?.click()
            },
          }]),
      ...comparePairItems(node.path),
      { separator: true },
      { label: 'Rename', onClick: () => setRenaming(node.path) },
      { label: 'Delete', danger: true, onClick: () => deleteEntry(node) },
    ]
  }

  // --- drag/drop ---------------------------------------------------------------

  const handleDrop = (e: React.DragEvent, dir: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const entry = e.dataTransfer.getData(ENTRY_MIME)
    if (entry) {
      if (entry !== dir) act(() => moveFileEntry(project, entry, dir))
      return
    }
    stageUpload([...e.dataTransfer.files], dir)
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

  // --- rows --------------------------------------------------------------------

  const select = (e: React.MouseEvent, path: string) => {
    if (e.ctrlKey || e.metaKey) {
      if (path !== selected) onToggleSecondary(path)
    } else onSelect(path)
  }

  const rowClasses = (path: string, extra: string[] = []) => {
    const classes = ['tree-row', 'file-row', ...extra]
    if (selected === path) classes.push('selected')
    if (secondary === path) classes.push('compare-mark')
    return classes.filter(Boolean).join(' ')
  }

  const renderVersion = (leaf: FileLeaf, version: FileVersion, index: number, depth: number) => {
    const label = `v${leaf.versions.length - index}`
    return (
      <button
        key={version.path}
        className={rowClasses(version.path, ['version-row'])}
        style={{ paddingLeft: `${10 + (depth + 1) * 14}px` }}
        title={`${leaf.name} ${label}${version.at ? ` — ${formatWhen(version.at)}` : ''}${version.note ? `\n${version.note}` : ''}`}
        onClick={(e) => select(e, version.path)}
        onDoubleClick={version.size !== null
          ? () => act(() => openFileEntry(project, version.path))
          : undefined}
        onContextMenu={(e) => openMenu(e, { type: 'version', leaf, version })}
      >
        <span className="version-badge">{label}</span>
        {version.at !== null && <span className="row-stamp">{formatStamp(version.at)}</span>}
        <span className="row-note">{version.note ?? '—'}</span>
      </button>
    )
  }

  const renderLeaf = (node: FileLeaf, depth: number) => {
    const versionsOpen = openVersions.has(node.path)
    const currentVersion = node.versions.length + 1
    const indent = { paddingLeft: `${10 + depth * 14}px` }
    const stamp = node.uploadedAt !== null ? formatDay(node.uploadedAt) : ''
    return (
      <div key={node.path} className="tree-entry">
        {renaming === node.path ? (
          <InlineNameForm
            initial={node.name}
            placeholder="New name — Enter to rename"
            onCommit={async (value) => {
              await renameFileEntry(project, node.path, value)
              setRenaming(null)
              onReload()
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <button
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ENTRY_MIME, node.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            className={rowClasses(node.path, node.kind ? ['artifact-row'] : [])}
            style={indent}
            title={[
              `${node.name}${node.uploadedAt ? ` — ${formatWhen(node.uploadedAt)}` : ''}`,
              node.note ?? undefined,
            ].filter(Boolean).join('\n')}
            onClick={(e) => select(e, node.path)}
            onDoubleClick={node.kind === null
              ? () => act(() => openFileEntry(project, node.path))
              : undefined}
            onContextMenu={(e) => openMenu(e, { type: 'leaf', node })}
          >
            {node.kind ? (
              <span className={`kind-badge kind-${node.kind}`}>{KIND_LABEL[node.kind]}</span>
            ) : isTextFile(node.name) ? (
              <NoteIcon />
            ) : (
              <FileIcon />
            )}
            <span className="tree-name">{node.name}</span>
            {node.edited && (
              <span
                className="edited-badge"
                title="Edited on disk since its recorded version — right-click to record or discard"
              >
                edited
              </span>
            )}
            {node.versions.length > 0 && (
              <span
                className={versionsOpen ? 'version-count on' : 'version-count'}
                title={`${currentVersion} versions`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenVersions((current) => toggleSet(current, node.path))
                }}
                // Rapid expand/collapse clicks must never read as the row's
                // own double-click (which opens the file).
                onDoubleClick={(e) => e.stopPropagation()}
              >
                v{currentVersion}
              </span>
            )}
            {stamp && <span className="row-stamp">{stamp}</span>}
          </button>
        )}
        {versionsOpen && (
          <>
            {/* The current version leads its own history — same row shape as
                the archived ones, so its note and time read in the same
                columns, only here when the accordion is open. */}
            <button
              className={rowClasses(node.path, ['version-row'])}
              style={{ paddingLeft: `${10 + (depth + 1) * 14}px` }}
              title={[
                `${node.name} v${currentVersion} (current)${node.uploadedAt ? ` — ${formatWhen(node.uploadedAt)}` : ''}`,
                node.note ?? undefined,
              ].filter(Boolean).join('\n')}
              onClick={(e) => select(e, node.path)}
              onDoubleClick={node.kind === null
                ? () => act(() => openFileEntry(project, node.path))
                : undefined}
              onContextMenu={(e) => openMenu(e, { type: 'leaf', node })}
            >
              <span className="version-badge current">v{currentVersion}</span>
              {node.uploadedAt !== null && <span className="row-stamp">{formatStamp(node.uploadedAt)}</span>}
              <span className="row-note">{node.note ?? '—'}</span>
            </button>
            {node.versions.map((version, index) => renderVersion(node, version, index, depth))}
          </>
        )}
      </div>
    )
  }

  const renderNode = (node: FileNode, depth: number): React.ReactNode => {
    if (node.type !== 'folder') return renderLeaf(node, depth)

    const open = !collapsed.has(node.path)
    return (
      <div key={node.path} className="tree-entry">
        {renaming === node.path ? (
          <InlineNameForm
            initial={node.name}
            placeholder="New name — Enter to rename"
            onCommit={async (value) => {
              await renameFileEntry(project, node.path, value)
              setRenaming(null)
              onReload()
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <button
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ENTRY_MIME, node.path)
              e.dataTransfer.effectAllowed = 'move'
            }}
            {...dropProps(node.path)}
            className={[
              rowClasses(node.path, ['tree-folder']),
              dropTarget === node.path ? 'file-drop' : '',
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            title={node.name}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey) return
              onSelect(node.path)
              setCollapsed((current) => toggleSet(current, node.path))
            }}
            onContextMenu={(e) => openMenu(e, { type: 'dir', dir: node.path, node })}
          >
            <Chevron open={open} />
            <FolderIcon open={open} />
            <span className="tree-name">{node.name}</span>
          </button>
        )}
        {open && node.children.map((child) => renderNode(child, depth + 1))}
        {open && creatingIn === node.path && (
          <InlineNameForm
            placeholder={`Folder name in ${node.name} — Enter to create`}
            onCommit={async (value) => {
              await createFileFolder(project, node.path, value)
              setCreatingIn(null)
              onReload()
            }}
            onCancel={() => setCreatingIn(null)}
          />
        )}
        {open && notingIn === node.path && (
          <InlineNameForm
            placeholder="Note name — Enter to create"
            onCommit={(value) => createNote(node.path, value)}
            onCancel={() => setNotingIn(null)}
          />
        )}
      </div>
    )
  }

  // --- in-flight RTAC exports --------------------------------------------------

  const exportRows = exports.map((entry) => (
    <div
      key={entry.path}
      className={`tree-row file-row export-row${entry.status === 'error' ? ' export-error' : ''}`}
      title={entry.status === 'error'
        ? `${entry.path}: ${entry.error}`
        : `Downloading ${entry.path} from the AcRTAC database…`}
    >
      {entry.status === 'exporting' ? <Spinner /> : <span className="kind-badge kind-rtac">RTAC</span>}
      <span className="tree-name">{entry.path}</span>
      {entry.status === 'error' && (
        <>
          <span className="row-note">{entry.error}</span>
          <span
            className="entry-delete"
            title="Retry this download"
            onClick={() => {
              const dir = entry.path.split('/').slice(0, -1).join('/')
              const entryName = entry.path.split('/').pop() ?? entry.path
              // The status row carries the real database name; the path is
              // only a fallback (a renamed/sanitized entry cannot reproduce
              // it). `into` keeps the retry landing on the SAME entry.
              const database = entry.database ?? displayName(entry.path).replace(/\.rtac$/i, '')
              act(async () => {
                await dismissRtacError(project, entry.path)
                await startRtacExport(project, dir, database, entry.note, entryName)
                onExportsChanged()
              })
            }}
          >
            ↻
          </span>
          <span
            className="entry-delete"
            title="Dismiss"
            onClick={() => act(async () => {
              await dismissRtacError(project, entry.path)
              onExportsChanged()
            })}
          >
            ✕
          </span>
        </>
      )}
    </div>
  ))

  return (
    <aside className="sources" style={{ width }}>
      <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
      <div
        className={`source-scroll files-root${dropTarget === '' ? ' file-drop' : ''}`}
        {...dropProps('')}
        onContextMenu={(e) => openMenu(e, { type: 'dir', dir: '', node: null })}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            stageUpload([...(e.target.files ?? [])], intakeDir.current)
            e.target.value = ''
          }}
        />
        <input
          ref={versionInput}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            const target = versionTarget.current
            if (file && target) {
              setNoteError(null)
              setPending({ kind: 'version', dir: target.dir, entryName: target.entryName, file })
            }
            e.target.value = ''
          }}
        />
        {/* webkitdirectory input for the exported-RTAC-folder path. */}
        <input
          ref={folderInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          // @ts-expect-error non-standard folder-picker attribute
          webkitdirectory=""
          onChange={(e) => {
            stageRtacFolder([...(e.target.files ?? [])], intakeDir.current)
            e.target.value = ''
          }}
        />
        {creatingIn === '' && (
          <InlineNameForm
            placeholder="Folder name — Enter to create"
            onCommit={async (value) => {
              await createFileFolder(project, '', value)
              setCreatingIn(null)
              onReload()
            }}
            onCancel={() => setCreatingIn(null)}
          />
        )}
        {notingIn === '' && (
          <InlineNameForm
            placeholder="Note name — Enter to create"
            onCommit={(value) => createNote('', value)}
            onCancel={() => setNotingIn(null)}
          />
        )}
        <div className="files-tree">
          {exportRows}
          {tree?.map((node) => renderNode(node, 0))}
        </div>
        {(error ?? treeError) && (
          <div className="list-error">
            <div className="list-error-text">{error ?? treeError}</div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
      {pending && (
        <VersionNoteModal
          title={pending.kind === 'files' ? 'Add files'
            : pending.kind === 'version' ? `New version of ${pending.entryName}`
            : pending.kind === 'edit' ? `Record edits to ${pending.name}`
            : 'Add RTAC export'}
          destination={pending.dir}
          items={pendingItems}
          busy={noteBusy}
          error={noteError}
          onConfirm={confirmNote}
          onCancel={() => setPending(null)}
        />
      )}
      {dbState !== null && (
        <RtacDatabaseModal
          project={project}
          destination={dbState.dir}
          versionOf={dbState.versionOf ?? null}
          onClose={() => setDbState(null)}
          onStarted={onExportsChanged}
        />
      )}
    </aside>
  )
}
