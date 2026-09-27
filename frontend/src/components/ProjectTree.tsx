import { useEffect, useMemo, useRef, useState } from 'react'

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
  startAcrtacOpen,
  startRtacExport,
  uploadFiles,
  uploadRtacFolder,
} from '../api'
import { errorMessage } from '../lib/errors'
import { databaseName } from '../lib/fileNodes'
import { formatDay, formatStamp, formatWhen } from '../lib/format'
import { useSidebarWidth } from '../lib/usePaneWidth'
import { useToolJob } from '../lib/useToolJob'
import type { ArtifactKindName, FileNode, FileVersion, RtacExportStatus } from '../types'
import { AcrtacImportModal, AcrtacImportRow, type AcrtacImportTarget } from './AcrtacImportModal'
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
//   ctrl/cmd+click   hold one more row alongside the selection (versions
//                    count as files here) — or let go of a held one
//   shift+click      hold every visible entry between the selection and here
//   right-click      the context menu for whatever is under the cursor; on a
//                    held row with others held, the BULK menu (delete,
//                    import to AcRTAC, new versions from AcRTAC — and
//                    Compare when exactly two of one kind are held)
//   Delete / Escape  delete what is held / let go of all but the selection
//   double-click     open with the OS default app (files); an RTAC entry
//                    opens its database project in the AcSELerator RTAC GUI
//   drag row         move into a folder (or the root background) — dragging
//                    a held row moves everything held
//   drop OS files    upload into that folder — the version-note dialog runs;
//                    dropped FOLDERS come in as RTAC exports

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

/** Rendered in the preview pane by Chromium's built-in PDF viewer. */
export function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

/** The tree narrowed to what matches: a leaf by its own name, a folder by
 *  holding a match — or by its own name, which keeps its whole subtree, since
 *  naming a folder means asking for what is in it. */
function filterTree(nodes: FileNode[], needle: string): FileNode[] {
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

// Which folders are open rides sessionStorage per project: switching panes
// or projects doesn't re-collapse an exploration mid-session — only a fresh
// app start does (folders start collapsed at launch).
const expandedKey = (project: string) => `projector.tree-expanded:${project}`

function loadExpanded(project: string): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(expandedKey(project)) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
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
function stageVersionFile(file: File, entryName: string): File | string {
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

/** A file from a picked or dropped folder, with its folder-relative path. */
type FolderFile = { file: File; path: string }

/** Split folder files into the RTAC exports they hold. An export's root is
 *  the folder holding SEL_RTAC/ (or ExportSource.xml), so picking or
 *  dropping a PARENT of several exports brings each in as its own entry.
 *  Files come back re-rooted at their export's folder name — the first path
 *  segment is what the backend names the entry after. Without any marker
 *  the old rule stands: each top-level folder is one export. Returns the
 *  refusal message when two exports would land under one name. */
function splitRtacExports(files: FolderFile[]): { files: FolderFile[]; names: string[] } | string {
  const roots = new Set<string>()
  for (const { path } of files) {
    const parts = path.split('/')
    const marker = parts.findIndex((part, i) => i > 0 && (i < parts.length - 1
      ? part.toUpperCase() === 'SEL_RTAC'
      : /^ExportSource\.xml$/i.test(part)))
    if (marker > 0) roots.add(parts.slice(0, marker).join('/'))
  }
  if (!roots.size) {
    return { files, names: [...new Set(files.map((entry) => entry.path.split('/')[0]).filter(Boolean))] }
  }
  // Longest first: a file belongs to the innermost export holding it.
  const ordered = [...roots].sort((a, b) => b.length - a.length)
  const byName = new Map<string, string>()
  const out: FolderFile[] = []
  for (const entry of files) {
    const root = ordered.find((candidate) => entry.path.startsWith(`${candidate}/`))
    if (!root) continue
    const name = root.split('/').pop() ?? root
    const other = byName.get(name.toLowerCase())
    if (other !== undefined && other !== root) {
      return `Two exports are both named ${name} (${other} and ${root}) — bring them in separately.`
    }
    byName.set(name.toLowerCase(), root)
    out.push({ file: entry.file, path: `${name}${entry.path.slice(root.length)}` })
  }
  return { files: out, names: [...byName.values()].map((root) => root.split('/').pop() ?? root) }
}

/** Everything under dropped OS entries: folders walked into FolderFiles,
 *  top-level files kept loose. */
async function readDropped(entries: FileSystemEntry[]): Promise<{ folders: FolderFile[]; loose: File[] }> {
  const fileOf = (entry: FileSystemEntry) =>
    new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
  const childrenOf = async (entry: FileSystemEntry) => {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const out: FileSystemEntry[] = []
    // readEntries hands a directory over in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) return out
      out.push(...batch)
    }
  }
  // Siblings are read concurrently; each path is fixed, so order doesn't matter.
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<FolderFile[]> => {
    const path = `${prefix}${entry.name}`
    if (entry.isFile) return [{ file: await fileOf(entry), path }]
    const nested = await Promise.all((await childrenOf(entry)).map((child) => walk(child, `${path}/`)))
    return nested.flat()
  }
  const [folders, loose] = await Promise.all([
    Promise.all(entries.filter((e) => e.isDirectory).map((e) => walk(e, ''))).then((nested) => nested.flat()),
    Promise.all(entries.filter((e) => !e.isDirectory).map(fileOf)),
  ])
  return { folders, loose }
}

/** Run `fn` over every path, carrying on past failures; throws one error
 *  naming each path that failed. */
async function each(paths: string[], fn: (path: string) => Promise<unknown>) {
  const failed: string[] = []
  for (const path of paths) {
    try {
      await fn(path)
    } catch (err) {
      failed.push(`${displayName(path)}: ${errorMessage(err)}`)
    }
  }
  if (failed.length) throw new Error(failed.join('\n'))
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')

type PendingBatch =
  | { kind: 'files'; dir: string; files: File[] }
  /** One or more RTAC export folders — plus any loose files dropped with
   *  them, landing under the same note. */
  | { kind: 'rtac-folder'; dir: string; files: FolderFile[]; names: string[]; loose: File[] }
  /** "New versions from AcRTAC": re-pull each held RTAC entry from the
   *  database it mirrors, superseding it in place. */
  | { kind: 'refresh'; entries: { dir: string; name: string; database: string }[] }
  /** "Add new version…": the picked file supersedes the entry named
   *  `entryName` — and the entry takes the PICKED FILE's name (versions
   *  follow what their newest arrival is called). */
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
  filter,
  treeError,
  exports,
  selected,
  held,
  onSelect,
  onToggleHeld,
  onHoldRange,
  onComparePair,
  onReload,
  onExportsChanged,
}: {
  project: string
  tree: FileNode[] | null
  /** The topbar's filter box. Narrows what the tree SHOWS; every other use
   *  of the tree (upload collisions, compare labels) still sees all of it. */
  filter: string
  treeError: string | null
  exports: RtacExportStatus[]
  selected: string | null
  /** Further rows held alongside the selection (ctrl/shift-click). */
  held: string[]
  onSelect: (path: string | null) => void
  /** Ctrl/cmd-click: hold (or let go of) one more row. */
  onToggleHeld: (path: string) => void
  /** Shift-click: hold exactly these rows alongside the selection. */
  onHoldRange: (paths: string[]) => void
  /** The context menu's compare over the two held rows. */
  onComparePair: (original: string, updated: string) => void
  onReload: () => void
  onExportsChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [notingIn, setNotingIn] = useState<string | null>(null)
  // Folders start collapsed at launch; see loadExpanded for the lifetime.
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(project))
  const expandedFor = useRef(project)
  if (expandedFor.current !== project) {
    // Project switched without a remount: swap in that project's set.
    expandedFor.current = project
    setExpanded(loadExpanded(project))
  }
  useEffect(() => {
    try {
      sessionStorage.setItem(expandedKey(project), JSON.stringify([...expanded]))
    } catch {
      // Persistence is best-effort; expansion still works for this render.
    }
  }, [project, expanded])
  const [openVersions, setOpenVersions] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<PendingBatch | null>(null)
  const [noteBusy, setNoteBusy] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  // The AcRTAC browser, opened at a destination folder — optionally aimed
  // at an existing entry as its next version (null = closed).
  const [dbState, setDbState] = useState<{ dir: string; versionOf?: string } | null>(null)
  const [importTargets, setImportTargets] = useState<AcrtacImportTarget[] | null>(null)
  // Imports under way, oldest first — the dialog hands each job over and
  // closes, and the row below the tree carries it the rest of the way. The
  // project rides along so switching projects hides (never cancels) them.
  const [imports, setImports] = useState<{
    id: string
    label: string
    project: string
  }[]>([])
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

  // Anything that PUTS something into a folder opens the path to it, so the
  // result is on screen. Called on SUCCESS (an upload that lands, an export
  // that completes, a move) — not on intent, so a cancelled dialog doesn't
  // leave folders open. The inline create forms are the exception: they
  // render inside the folder, which must be open for them to show at all.
  const revealDir = (dir: string) => {
    if (!dir) return
    setExpanded((current) => {
      const next = new Set(current)
      let acc = ''
      for (const part of dir.split('/')) {
        acc = acc ? `${acc}/${part}` : part
        next.add(acc)
      }
      return next
    })
  }

  // A finished AcRTAC download leaves the pending list having landed its
  // entry in a possibly-collapsed folder — reveal where it went, and when
  // the download superseded (renamed) an entry the selection pointed at,
  // follow the rename instead of blanking on the stale path. Only rows last
  // seen 'exporting' landed; an 'error' row leaves by being dismissed.
  const knownExports = useRef<Map<string, { status: string; into: string | null }>>(new Map())
  useEffect(() => {
    const current = new Map(exports.map((entry) => [
      entry.path,
      { status: entry.status, into: entry.into ?? null },
    ]))
    for (const [exportPath, known] of knownExports.current) {
      if (current.has(exportPath) || known.status !== 'exporting') continue
      const dir = parentOf(exportPath)
      revealDir(dir)
      if (known.into) {
        const oldPath = dir ? `${dir}/${known.into}` : known.into
        if (selected === oldPath) onSelect(exportPath)
      }
    }
    knownExports.current = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exports])

  // --- open in AcRTAC ----------------------------------------------------------

  // Double-click an RTAC entry: open its database project in the AcSELerator
  // RTAC GUI — the recorded database name when the entry has one (set by
  // downloads and imports), the entry's own name as the fallback. Needs the
  // machine with the database — elsewhere the job fails with a clear
  // message, shown in the tree's error strip.
  const [acrtacOpening, setAcrtacOpening] = useState<string | null>(null)
  const acrtacOpenJob = useToolJob(
    () => setAcrtacOpening(null),
    (message) => {
      setAcrtacOpening(null)
      setError(message)
    },
  )
  const openInAcrtac = async (node: FileLeaf) => {
    if (acrtacOpening !== null) return
    const name = databaseName(node)
    setError(null)
    setAcrtacOpening(name)
    try {
      const { job } = await startAcrtacOpen(name)
      acrtacOpenJob.start(job)
    } catch (err) {
      setAcrtacOpening(null)
      setError(errorMessage(err))
    }
  }

  /** Drop a settled import's row; the job itself is already over. */
  const finishImport = (id: string) =>
    setImports((current) => current.filter((entry) => entry.id !== id))

  // --- intake ----------------------------------------------------------------

  const stageUpload = (files: File[], dir: string) => {
    if (!files.length) return
    setNoteError(null)
    setPending({ kind: 'files', dir, files })
  }

  const stageRtacFolder = (files: FolderFile[], dir: string, loose: File[] = []) => {
    const split = splitRtacExports(files)
    if (typeof split === 'string') {
      setError(split)
      return
    }
    if (!split.files.length && !loose.length) return
    setError(null)
    setNoteError(null)
    setPending({ kind: 'rtac-folder', dir, files: split.files, names: split.names, loose })
  }

  const confirmNote = async (note: string) => {
    if (!pending) return
    setNoteBusy(true)
    try {
      if (pending.kind === 'files') {
        await uploadFiles(project, pending.dir, pending.files, note)
      } else if (pending.kind === 'version') {
        // The entry FOLLOWS the new version's name: the picked file lands
        // under its own name, superseding (and renaming) the entry.
        const { added } = await uploadFiles(project, pending.dir, [pending.file], note, pending.entryName)
        const oldPath = pending.dir ? `${pending.dir}/${pending.entryName}` : pending.entryName
        if (added[0] && added[0] !== oldPath) {
          // Selection and the open-versions accordion follow the rename —
          // otherwise the right pane silently blanks on a stale path.
          if (selected === oldPath) onSelect(added[0])
          setOpenVersions((current) => (current.has(oldPath)
            ? new Set([...current].map((p) => (p === oldPath ? added[0] : p)))
            : current))
        }
      } else if (pending.kind === 'edit') {
        await recordFileEdit(project, pending.path, note)
      } else if (pending.kind === 'refresh') {
        // Each pull supersedes its entry in place when it lands; the export
        // rows under the tree carry them from here.
        for (const entry of pending.entries) {
          await startRtacExport(project, entry.dir, entry.database, note, entry.name)
        }
        onExportsChanged()
      } else {
        if (pending.files.length) await uploadRtacFolder(project, pending.dir, pending.files, note)
        if (pending.loose.length) await uploadFiles(project, pending.dir, pending.loose, note)
      }
      if (pending.kind !== 'refresh') revealDir(pending.dir)
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
    if (pending.kind === 'refresh') {
      return pending.entries.map((entry) => ({
        name: entry.dir ? `${entry.dir}/${entry.name}` : entry.name,
        isNewVersion: true,
      }))
    }
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
      return [{ name: pending.file.name, isNewVersion: true }]
    }
    if (pending.kind === 'edit') {
      return [{ name: pending.name, isNewVersion: true }]
    }
    return [
      ...pending.names.map((name) => ({
        name: `${name}.rtac`,
        isNewVersion: siblings.has(`${name}.rtac`),
      })),
      ...pending.loose.map((file) => ({
        name: file.name,
        isNewVersion: siblings.has(file.name),
      })),
    ]
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

  // --- the held set -------------------------------------------------------------

  /** Every held row — the selection first. */
  const heldPaths = useMemo(
    () => (selected === null ? [] : [selected, ...held.filter((p) => p !== selected)]),
    [selected, held],
  )

  const heldSet = useMemo(() => new Set(heldPaths), [heldPaths])

  /** The held rows that are tree ENTRIES (files, artifacts, folders — not
   *  archived versions), minus any inside a held folder: what delete and
   *  move act on. */
  const heldEntries = useMemo(() => {
    if (!tree) return []
    const live = heldPaths.filter((p) => findNode(tree, p) !== null)
    return live.filter((p) => !live.some((other) => other !== p && p.startsWith(`${other}/`)))
  }, [heldPaths, tree])

  /** The held rows that import to AcRTAC: RTAC entries and archived RTAC
   *  versions, each under its own identity. */
  const importTargetsOf = (paths: string[]): AcrtacImportTarget[] => {
    if (!tree) return []
    const out: AcrtacImportTarget[] = []
    for (const p of paths) {
      const leaf = findLeafFor(tree, p)
      if (!leaf) continue
      if (leaf.path === p) {
        if (leaf.kind === 'rtac') out.push({ path: p, name: leaf.name, database: leaf.database })
        continue
      }
      const version = leaf.versions.find((v) => v.path === p)
      if (version?.kind === 'rtac') out.push({ path: p, name: version.name, database: version.database })
    }
    return out
  }

  const deleteEntries = (paths: string[]) => {
    if (!tree || !paths.length) return
    if (paths.length === 1) {
      const node = findNode(tree, paths[0])
      if (node) deleteEntry(node)
      return
    }
    const names = paths.map((p) => `  • ${displayName(p)}`)
    const listed = names.length > 12
      ? [...names.slice(0, 12), `  …and ${names.length - 12} more`]
      : names
    if (!window.confirm(`Delete these ${paths.length} entries — with their versions, and everything inside any folder?\n\n${listed.join('\n')}`)) return
    onSelect(null)
    act(() => each(paths, (p) => deleteFileEntry(project, p)))
  }

  /** The bulk menu: what a right-click on one of several held rows acts on. */
  const bulkItems = (path: string): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [...comparePairItems(path)]
    const imports = importTargetsOf(heldPaths)
    if (imports.length) {
      items.push({
        label: imports.length === 1 ? 'Import to AcRTAC…' : `Import ${imports.length} to AcRTAC…`,
        onClick: () => setImportTargets(imports),
      })
    }
    const rtacLeaves = heldEntries
      .map((p) => (tree ? findNode(tree, p) : null))
      .filter((node): node is FileLeaf => node?.type === 'file' && node.kind === 'rtac')
    if (rtacLeaves.length) {
      items.push({
        label: `New versions from AcRTAC (${rtacLeaves.length})…`,
        onClick: () => {
          setNoteError(null)
          setPending({
            kind: 'refresh',
            entries: rtacLeaves.map((leaf) => ({
              dir: parentOf(leaf.path),
              name: leaf.name,
              database: databaseName(leaf),
            })),
          })
        },
      })
    }
    const entries = heldEntries
    if (entries.length) {
      if (items.length) items.push({ separator: true })
      items.push({
        label: entries.length === 1 ? 'Delete' : `Delete ${entries.length} entries`,
        danger: true,
        onClick: () => deleteEntries(entries),
      })
    }
    return items
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
      // Picking a folder that HOLDS several exports brings each one in.
      label: 'Add RTAC export folders…',
      onClick: () => {
        intakeDir.current = dir
        folderInput.current?.click()
      },
    },
    { label: 'Download from AcRTAC…', onClick: () => setDbState({ dir }) },
    { separator: true },
    {
      label: 'New note',
      onClick: () => {
        revealDir(dir)
        setNotingIn(dir)
      },
    },
    {
      label: 'New folder',
      onClick: () => {
        revealDir(dir)
        setCreatingIn(dir)
      },
    },
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
    if (heldPaths.length !== 2 || !heldPaths.includes(path)) return []
    const other = heldPaths[0] === path ? heldPaths[1] : heldPaths[0]
    const kind = kindOfPath(path)
    if (!kind || kind !== kindOfPath(other)) return []
    return [{
      label: `Compare with ${refLabel(tree, other)}`,
      onClick: () => onComparePair(other, path),
    }]
  }

  /** The Import-to-AcRTAC item — the live entry and its archived versions
   *  share it, each importing under its own identity. */
  const importItem = (path: string, name: string, database: string | null): ContextMenuItem => ({
    label: 'Import to AcRTAC…',
    onClick: () => setImportTargets([{ path, name, database }]),
  })

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    const targetPath = target.type === 'leaf' ? target.node.path
      : target.type === 'version' ? target.version.path
      : target.node ? target.dir : null
    if (targetPath !== null && heldPaths.length > 1 && heldPaths.includes(targetPath)) {
      return bulkItems(targetPath)
    }
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
        // An archived RTAC version imports too — under the identity IT
        // carried, not whatever the entry is called today.
        ...(version.kind === 'rtac'
          ? [importItem(version.path, version.name, version.database)]
          : []),
        {
          label: 'Show in file explorer',
          onClick: () => act(() => revealFileEntry(project, version.path)),
        },
      ]
    }

    const node = target.node
    const nodeDir = parentOf(node.path)
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
      // file-picker path. RTAC entries also go the other way: import this
      // copy into the AcRTAC database.
      ...(node.kind === 'rtac'
        ? [{
            label: 'Open in AcRTAC',
            onClick: () => openInAcrtac(node),
          }, {
            label: 'New version from AcRTAC…',
            onClick: () => setDbState({ dir: nodeDir, versionOf: node.name }),
          },
          importItem(node.path, node.name, node.database)]
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
    const raw = e.dataTransfer.getData(ENTRY_MIME)
    if (raw) {
      let paths: string[]
      try {
        paths = JSON.parse(raw)
      } catch {
        paths = [raw]
      }
      // Skip what is already there, and a folder dropped into itself.
      const moving = paths.filter((p) => p !== dir && parentOf(p) !== dir && !dir.startsWith(`${p}/`))
      if (moving.length) {
        // The held paths die with the move; the selection follows its row.
        const moved = selected !== null && moving.includes(selected)
          ? [dir, selected.split('/').pop()].filter(Boolean).join('/')
          : selected
        act(async () => {
          try {
            await each(moving, (p) => moveFileEntry(project, p, dir))
          } finally {
            revealDir(dir)
            if (moving.length > 1 || moved !== selected) onSelect(moved)
          }
        })
      }
      return
    }
    // Folders only survive the drop event as ENTRIES — read them now, walk
    // them after. Any folder in the drop makes it an RTAC-export intake.
    const entries = [...e.dataTransfer.items]
      .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
      .filter((entry): entry is FileSystemEntry => entry !== null)
    if (entries.some((entry) => entry.isDirectory)) {
      readDropped(entries)
        .then(({ folders, loose }) => stageRtacFolder(folders, dir, loose))
        .catch((err) => setError(errorMessage(err)))
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
    if (e.shiftKey && selected !== null) {
      // The range runs over visible entry rows; a selected archived version
      // anchors at its entry.
      const anchor = visibleOrder.includes(selected)
        ? selected
        : (tree ? findLeafFor(tree, selected)?.path : null) ?? null
      const from = anchor === null ? -1 : visibleOrder.indexOf(anchor)
      const to = visibleOrder.indexOf(path)
      if (from >= 0 && to >= 0) {
        onHoldRange(visibleOrder.slice(Math.min(from, to), Math.max(from, to) + 1))
        return
      }
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) onToggleHeld(path)
    else onSelect(path)
  }

  const rowClasses = (path: string, extra: string[] = []) => {
    const classes = ['tree-row', 'file-row', ...extra]
    if (selected === path) classes.push('selected')
    else if (heldSet.has(path)) classes.push('held')
    return classes.filter(Boolean).join(' ')
  }

  // Dragging a held row carries everything held (entries only — an archived
  // version cannot move on its own).
  const dragStart = (e: React.DragEvent, path: string) => {
    const group = heldPaths.length > 1 && heldSet.has(path) ? heldEntries : []
    e.dataTransfer.setData(ENTRY_MIME, JSON.stringify(group.length ? group : [path]))
    e.dataTransfer.effectAllowed = 'move'
  }

  // One version-history row — the archived versions and the current-version
  // head row share this chrome, differing only in badge, title and handlers.
  const versionRow = (opts: {
    path: string
    label: string
    current?: boolean
    at: number | null
    note: string | null
    title: string
    depth: number
    onDoubleClick?: () => void
    onContextMenu: (e: React.MouseEvent) => void
  }) => (
    <button
      key={`${opts.path}${opts.current ? ':current' : ''}`}
      className={rowClasses(opts.path, ['version-row'])}
      style={{ paddingLeft: `${10 + (opts.depth + 1) * 14}px` }}
      title={opts.title}
      onClick={(e) => select(e, opts.path)}
      onDoubleClick={opts.onDoubleClick}
      onContextMenu={opts.onContextMenu}
    >
      <span className={opts.current ? 'version-badge current' : 'version-badge'}>{opts.label}</span>
      {opts.at !== null && <span className="row-stamp">{formatStamp(opts.at)}</span>}
      <span className="row-note">{opts.note ?? '—'}</span>
    </button>
  )

  const renderVersion = (leaf: FileLeaf, version: FileVersion, index: number, depth: number) => {
    const label = `v${leaf.versions.length - index}`
    // A version renamed by a later arrival keeps its identity off-row: the
    // hover title names it, and Import to AcRTAC uses it.
    const renamed = version.name !== leaf.name
    return versionRow({
      path: version.path,
      label,
      at: version.at,
      note: version.note,
      depth,
      title: [
        `${leaf.name} ${label}${version.at ? ` — ${formatWhen(version.at)}` : ''}`,
        renamed ? `was named ${version.name}` : undefined,
        version.note ?? undefined,
      ].filter(Boolean).join('\n'),
      onDoubleClick: version.size !== null
        ? () => act(() => openFileEntry(project, version.path))
        : undefined,
      onContextMenu: (e) => openMenu(e, { type: 'version', leaf, version }),
    })
  }

  // The rename form both entry shapes (leaf and folder) swap in for their row.
  // A file's extension is its TYPE — Inspect and Compare choose their parser
  // from it, and a new version is refused outright when it differs — so the
  // field holds the name alone and the extension rides along beside it,
  // untypable. Folders (and extensionless files) edit whole.
  const renameForm = (node: { path: string; name: string }, isFile: boolean) => {
    const ext = isFile ? nameExtension(node.name) : ''
    return (
      <InlineNameForm
        initial={ext ? node.name.slice(0, -ext.length) : node.name}
        suffix={ext}
        placeholder="New name — Enter to rename"
        onCommit={async (value) => {
          await renameFileEntry(project, node.path, value)
          setRenaming(null)
          onReload()
        }}
        onCancel={() => setRenaming(null)}
      />
    )
  }

  // The create-folder / create-note forms rendered under whichever dir the
  // context menu opened them for — the root and every folder share these.
  const intakeForms = (dir: string, dirName: string | null) => (
    <>
      {creatingIn === dir && (
        <InlineNameForm
          placeholder={dirName
            ? `Folder name in ${dirName} — Enter to create`
            : 'Folder name — Enter to create'}
          onCommit={async (value) => {
            await createFileFolder(project, dir, value)
            setCreatingIn(null)
            onReload()
          }}
          onCancel={() => setCreatingIn(null)}
        />
      )}
      {notingIn === dir && (
        <InlineNameForm
          placeholder="Note name — Enter to create"
          onCommit={(value) => createNote(dir, value)}
          onCancel={() => setNotingIn(null)}
        />
      )}
    </>
  )

  // Double-click on an entry row: plain files open with the OS default app;
  // an RTAC entry opens its database project in the AcSELerator RTAC GUI.
  const leafDoubleClick = (node: FileLeaf) =>
    node.kind === null ? () => act(() => openFileEntry(project, node.path))
    : node.kind === 'rtac' ? () => openInAcrtac(node)
    : undefined

  const filterTerm = filter.trim().toLowerCase()
  const filtering = filterTerm !== ''
  const shown = useMemo(
    () => (filtering && tree ? filterTree(tree, filterTerm) : tree),
    [tree, filterTerm, filtering],
  )

  // The entry rows on screen, top to bottom — what a shift-click range
  // spans (version rows stay out: ranges are for bulk entry actions).
  const visibleOrder = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: FileNode[]) => {
      for (const node of nodes) {
        out.push(node.path)
        if (node.type === 'folder' && (filtering || expanded.has(node.path))) walk(node.children)
      }
    }
    walk(shown ?? [])
    return out
  }, [shown, filtering, expanded])

  const renderLeaf = (node: FileLeaf, depth: number) => {
    const versionsOpen = openVersions.has(node.path)
    const currentVersion = node.versions.length + 1
    const indent = { paddingLeft: `${10 + depth * 14}px` }
    const stamp = node.uploadedAt !== null ? formatDay(node.uploadedAt) : ''
    return (
      <div key={node.path} className="tree-entry">
        {renaming === node.path ? renameForm(node, true) : (
          <button
            draggable
            onDragStart={(e) => dragStart(e, node.path)}
            className={rowClasses(node.path, node.kind ? ['artifact-row'] : [])}
            style={indent}
            title={[
              `${node.name}${node.uploadedAt ? ` — ${formatWhen(node.uploadedAt)}` : ''}`,
              node.note ?? undefined,
            ].filter(Boolean).join('\n')}
            onClick={(e) => select(e, node.path)}
            onDoubleClick={leafDoubleClick(node)}
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
            {versionRow({
              path: node.path,
              label: `v${currentVersion}`,
              current: true,
              at: node.uploadedAt,
              note: node.note,
              depth,
              title: [
                `${node.name} v${currentVersion} (current)${node.uploadedAt ? ` — ${formatWhen(node.uploadedAt)}` : ''}`,
                node.note ?? undefined,
              ].filter(Boolean).join('\n'),
              onDoubleClick: leafDoubleClick(node),
              onContextMenu: (e) => openMenu(e, { type: 'leaf', node }),
            })}
            {node.versions.map((version, index) => renderVersion(node, version, index, depth))}
          </>
        )}
      </div>
    )
  }

  const renderNode = (node: FileNode, depth: number): React.ReactNode => {
    if (node.type !== 'folder') return renderLeaf(node, depth)

    // Filtering opens everything it kept: a hit three folders down is no
    // use behind a closed chevron. The remembered open set is untouched, so
    // clearing the filter restores the tree the way it was left.
    const open = filtering || expanded.has(node.path)
    return (
      <div key={node.path} className="tree-entry">
        {renaming === node.path ? renameForm(node, false) : (
          <button
            draggable
            onDragStart={(e) => dragStart(e, node.path)}
            {...dropProps(node.path)}
            className={[
              rowClasses(node.path, ['tree-folder']),
              dropTarget === node.path ? 'file-drop' : '',
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            title={node.name}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey) {
                select(e, node.path)
                return
              }
              onSelect(node.path)
              setExpanded((current) => toggleSet(current, node.path))
            }}
            onContextMenu={(e) => openMenu(e, { type: 'dir', dir: node.path, node })}
          >
            <Chevron open={open} />
            <FolderIcon open={open} />
            <span className="tree-name">{node.name}</span>
          </button>
        )}
        {open && node.children.map((child) => renderNode(child, depth + 1))}
        {open && intakeForms(node.path, node.name)}
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
              const dir = parentOf(entry.path)
              // The status row carries the real database name; the path is
              // only a fallback (a renamed/sanitized entry cannot reproduce
              // it). `into` keeps the retry superseding the SAME entry.
              const database = databaseName({ database: entry.database, name: displayName(entry.path) })
              act(async () => {
                await dismissRtacError(project, entry.path)
                await startRtacExport(project, dir, database, entry.note, entry.into ?? undefined)
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
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest('input, textarea')) return
          if (e.key === 'Delete') {
            if (heldEntries.length) {
              e.preventDefault()
              deleteEntries(heldEntries)
            }
          } else if (e.key === 'Escape' && held.length) {
            onSelect(selected)
          }
        }}
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
              const staged = stageVersionFile(file, target.entryName)
              if (typeof staged === 'string') {
                setError(staged)
              } else {
                setError(null)
                setNoteError(null)
                setPending({ kind: 'version', dir: target.dir, entryName: target.entryName, file: staged })
              }
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
            stageRtacFolder(
              [...(e.target.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })),
              intakeDir.current,
            )
            e.target.value = ''
          }}
        />
        {intakeForms('', null)}
        <div className="files-tree">
          {shown?.map((node) => renderNode(node, 0))}
          {filtering && shown?.length === 0 && (
            <div className="tree-empty">No entries match “{filter.trim()}”</div>
          )}
          {/* AcRTAC status rows sit BELOW the tree: appearing at the top
              shifted every entry down a row the moment a job started. */}
          {exportRows}
          {acrtacOpening !== null && (
            <div
              className="tree-row file-row export-row"
              title={acrtacOpenJob.job?.log.at(-1) ?? `Opening ${acrtacOpening} in AcSELerator RTAC…`}
            >
              <Spinner />
              <span className="tree-name">Opening {acrtacOpening} in AcRTAC…</span>
            </div>
          )}
          {imports.filter((entry) => entry.project === project).map((entry) => (
            <AcrtacImportRow
              key={entry.id}
              job={entry.id}
              name={entry.label}
              onDone={() => {
                finishImport(entry.id)
                // The entry now records the database project it mirrors —
                // reload so "Open in AcRTAC" and the row agree with it.
                onReload()
              }}
              onError={(message) => {
                finishImport(entry.id)
                setError(message)
              }}
            />
          ))}
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
            : pending.kind === 'refresh' ? `New versions from AcRTAC (${pending.entries.length})`
            : pending.names.length > 1 ? `Add ${pending.names.length} RTAC exports`
            : 'Add RTAC export'}
          destination={pending.kind === 'refresh' ? null : pending.dir}
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
      {importTargets !== null && (
        <AcrtacImportModal
          project={project}
          targets={importTargets}
          onStarted={(id, label) => {
            setError(null)
            setImports((current) => [...current, { id, label, project }])
          }}
          onClose={() => setImportTargets(null)}
        />
      )}
    </aside>
  )
}
