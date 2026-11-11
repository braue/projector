import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createProject,
  deleteProject,
  listFiles,
  openFileEntry,
  renameProject,
  setProjectArchived,
} from './api'
import { CompareView } from './components/CompareView'
import { FileView, hasFileView, type FindSeed } from './components/FileView'
import { HoursPanel } from './components/HoursPanel'
import { InspectView } from './components/InspectView'
import { PdfView } from './components/PdfView'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { ProjectTree } from './components/ProjectTree'
import { TasksPopover } from './components/TasksPopover'
import { TestNetworkView } from './components/TestNetworkView'
import { TextFileView } from './components/TextFileView'
import { TodoBoard } from './components/TodoBoard'
// The atlas embeds the whole field-knowledge library — 82 documents inlined as
// raw text — so it is its own chunk, fetched the first time it is opened
// rather than parsed on every cold start.
const AtlasView = lazy(() =>
  import('./components/AtlasView').then((m) => ({ default: m.AtlasView })),
)
import { Button, TextInput } from './components/ui'
import { ToolsView } from './tools/ToolsView'
import { errorMessage } from './lib/errors'
import { onEvent, useConnected } from './lib/events'
import { toggleTheme, useTheme } from './lib/theme'
import { useContentSearch } from './lib/contentSearch'
import { findLeafFor, isPdfFile, isTextFile, refLabel, type FileLeaf } from './lib/fileNodes'
import { formatSize, formatStamp, formatWhen } from './lib/format'
import { useJobs } from './lib/jobs'
import { reloadProjects, useProjectList } from './lib/projectList'
import { useTodos } from './lib/todos'
import { useAction } from './lib/useAction'
import { useTreeSelection } from './lib/useTreeSelection'
import type { FileNode, LandedDownload, ToolJob } from './types'

/** What fills the window beside the margin: the project, or one of the
 *  machine-global takeover panes. */
type Pane = 'project' | 'todo' | 'test' | 'tools' | 'atlas'

export default function App() {
  // Reference material and global utilities sit beside the project, hold the
  // top-right corner, and latch once opened so an open terminal session or a
  // half-read page survives a detour back into the project.
  const [pane, setPane] = useState<Pane>('project')
  const [opened, setOpened] = useState<ReadonlySet<Pane>>(() => new Set())
  const togglePane = (next: Pane) => {
    setPane((current) => (current === next ? 'project' : next))
    setOpened((seen) => (seen.has(next) ? seen : new Set(seen).add(next)))
  }
  const openTodos = (useTodos() ?? []).filter((c) => c.status !== 'done').length
  // The current project scopes everything below. The window opens with none —
  // the user picks one from the switcher; null list = still loading it.
  const [project, setProject] = useState<string | null>(null)
  const projectList = useProjectList()
  // THE tree — the one sidebar everything lives in.
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const selection = useTreeSelection()
  const { selected, held, comparePair } = selection
  const connected = useConnected()
  // Work in progress lives only in the tasks popover; the tree just hears
  // which of this project's AcRTAC downloads have landed, to open the folder.
  const jobs = useJobs()
  const landed = useMemo<LandedDownload[]>(() => jobs
    .filter((job) => job.meta?.type === 'rtac-export' && job.meta.project === project
      && job.status === 'done')
    .map((job) => ({
      job: job.id,
      path: String(job.meta!.path),
      into: (job.meta!.into as string | null) ?? null,
    })), [jobs, project])
  // The file-tree filter: always on show in the margin, under the project it
  // filters, so a narrowed tree always has its box beside it. Ctrl+Shift+F
  // (and Ctrl+F when the pane on the right has no find of its own) jumps to
  // it; Esc clears it.
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)
  // The filter also looks INSIDE files: the index's hits sit under their
  // rows, and clicking one opens the file with find already on the term.
  const content = useContentSearch(project, filter)
  const indexing = (content.status?.reading ?? 0) + (content.status?.ocr ?? 0)
  const [seed, setSeed] = useState<(FindSeed & { path: string; nonce: number }) | null>(null)

  const loadTree = useCallback(async () => {
    if (!project) return
    try {
      setTree(await listFiles(project))
      setTreeError(null)
    } catch (err) {
      setTreeError(`Cannot reach the backend: ${errorMessage(err)}`)
    }
  }, [project])


  // Switching projects swaps the tree and clears per-project state.
  const { select } = selection
  useEffect(() => {
    setTree(null)
    setTreeError(null)
    select(null)
    if (!project) return
    loadTree()
  }, [project, loadTree, select])

  // The tree follows the disk: the backend watches the project folder and
  // says when anything in it changed — an upload, a tool saving a result,
  // Excel saving over a working copy. A finished download reloads too (in
  // case the watcher is down), and so does coming back from a dropped
  // connection, since changes in the gap were never announced.
  useEffect(() => {
    if (!project) return
    const offs = [
      onEvent('tree', (data: { project: string }) => {
        if (data.project === project) loadTree()
      }),
      onEvent('job', (job: ToolJob) => {
        if (job.meta?.type === 'rtac-export' && job.meta.project === project && job.status === 'done') {
          loadTree()
        }
      }),
      onEvent('reconnected', loadTree),
    ]
    return () => offs.forEach((off) => off())
  }, [project, loadTree])

  const projectMode = pane === 'project'
  const closeFilter = useCallback(() => {
    setFilter('')
    filterInput.current?.blur()
  }, [])

  // What the main pane shows for the current selection.
  const selectedLeaf: FileLeaf | null =
    tree && selected !== null ? findLeafFor(tree, selected) : null

  // Who owns Ctrl+F. A pane you can READ — a settings inspection, a
  // comparison, a PDF — takes it for find-in-page, the way every other
  // reader binds that key; the tree filter keeps it the rest of the time,
  // and answers to Ctrl+Shift+F always, so the muscle memory still lands
  // somewhere. The atlas is outside project mode and owns its own.
  const paneOwnsFind = Boolean(
    projectMode &&
      (comparePair ||
        (selectedLeaf &&
          (selectedLeaf.kind || isPdfFile(selectedLeaf.name) || hasFileView(selectedLeaf.name)))),
  )

  // The cursor goes into the box with the term selected, to type over.
  const openFilter = useCallback(() => {
    filterInput.current?.focus()
    filterInput.current?.select()
  }, [])

  useEffect(() => {
    if (!projectMode) return
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        // The pane's own bar binds the plain chord (and ignores the shifted
        // one), so the two listeners never both fire.
        if (!e.shiftKey && paneOwnsFind) return
        e.preventDefault()
        openFilter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectMode, paneOwnsFind, openFilter])

  // Picking something in the tree always lands in the project, whichever
  // takeover pane was up.
  const selectInTree = useCallback((path: string | null, options?: { keepPane?: boolean }) => {
    select(path)
    setSeed(null)
    if (!options?.keepPane) setPane('project')
  }, [select])
  const openHit = useCallback((path: string, where: string) => {
    select(path)
    setSeed((current) => ({ path, term: content.term, where, nonce: (current?.nonce ?? 0) + 1 }))
    setPane('project')
  }, [select, content.term])
  // A seed belongs to the file it was clicked under.
  const activeSeed = seed && seed.path === selected ? seed : null
  const { compare } = selection
  const compareInTree = useCallback((original: string, updated: string) => {
    compare(original, updated)
    setPane('project')
  }, [compare])

  const handleCreateProject = useCallback(
    async (name: string) => {
      await createProject(name)
      await reloadProjects()
      setProject(name)
    },
    [],
  )

  const handleRenameProject = useCallback(
    async (name: string, nextName: string) => {
      const renamed = await renameProject(name, nextName)
      await reloadProjects()
      setProject((current) => (current === name ? renamed.name : current))
    },
    [],
  )

  const handleDeleteProject = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete project "${name}" and everything in it? This cannot be undone.`)) {
        return
      }
      try {
        await deleteProject(name)
      } catch (err) {
        setTreeError(errorMessage(err))
        return
      }
      await reloadProjects()
      // Deleting the open project leaves nothing open, like a fresh start.
      setProject((current) => (current === name ? null : current))
    },
    [],
  )

  // Archiving only refiles the project in the switcher; whatever is open
  // stays open.
  const handleArchiveProject = useCallback(
    async (name: string, archive: boolean) => {
      try {
        await setProjectArchived(name, archive)
      } catch (err) {
        setTreeError(errorMessage(err))
        return
      }
      await reloadProjects()
    },
    [],
  )

  // Still loading the project list: just the shell, no flash of onboarding.
  if (projectList === null) {
    return <div className="app"><aside className="sources" /></div>
  }

  // Nothing exists yet: the user names their first project.
  if (projectList.projects.length === 0) {
    return <FirstProject onCreate={handleCreateProject} />
  }

  return (
    <>
      {!connected && <div className="reconnect-bar">Reconnecting to the backend…</div>}
      <TasksPopover />
      <div className="app">
        {(() => {
          // The margin: the project, its filter box, the tree, and the
          // machine-global panes along the foot. One column, always up, so
          // the files are never more than a click away from any pane.
          const head = (
            <div className="margin-head">
              <ProjectSwitcher
                current={project}
                projects={projectList.projects}
                archived={projectList.archived}
                onSelect={setProject}
                onCreate={handleCreateProject}
                onRename={handleRenameProject}
                onDelete={handleDeleteProject}
                onArchive={handleArchiveProject}
              />
              {project !== null && (
                <div className="tree-filter">
                  <svg className="tree-filter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20l-4-4" />
                  </svg>
                  <TextInput
                    ref={filterInput}
                    className="ui-input tree-filter-input"
                    placeholder="Filter files"
                    aria-label="Filter files"
                    value={filter}
                    spellCheck={false}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        closeFilter()
                      }
                    }}
                  />
                  {indexing > 0 && (
                    <span
                      className="tree-filter-busy"
                      title={`Reading ${content.status?.reading ?? 0} · OCR ${content.status?.ocr ?? 0}`}
                    >
                      {indexing}
                    </span>
                  )}
                  {filter ? (
                    <button className="tree-filter-clear" title="Clear filter (Esc)" onClick={closeFilter}>
                      ✕
                    </button>
                  ) : (
                    <span className="tree-filter-key">Ctrl ⇧ F</span>
                  )}
                </div>
              )}
            </div>
          )
          const foot = (
            <nav className="margin-nav" aria-label="Panes">
              <PaneToggle
                label="Todo"
                count={openTodos}
                on={pane === 'todo'}
                title={pane === 'todo' ? 'Back to the project' : 'Open the todo board'}
                onClick={() => togglePane('todo')}
              />
              <HoursPanel />
              <PaneToggle
                label="Test"
                on={pane === 'test'}
                title={pane === 'test' ? 'Back to the project' : 'Open the test network'}
                onClick={() => togglePane('test')}
              />
              <PaneToggle
                label="Tools"
                on={pane === 'tools'}
                title={pane === 'tools' ? 'Back to the project' : 'Open the tools'}
                onClick={() => togglePane('tools')}
              />
              <PaneToggle
                label="Atlas"
                on={pane === 'atlas'}
                title={pane === 'atlas' ? 'Back to the project' : 'Open the atlas reference'}
                onClick={() => togglePane('atlas')}
              />
              <ThemeToggle />
            </nav>
          )
          return project === null ? (
            <aside className="sources">
              {head}
              <div className="source-scroll" />
              {foot}
            </aside>
          ) : (
            <ProjectTree
              project={project}
              tree={tree}
              filter={filter}
              contentHits={content.hits}
              onOpenHit={openHit}
              treeError={treeError}
              landed={landed}
              selected={selected}
              held={held}
              head={head}
              foot={foot}
              onSelect={selectInTree}
              onToggleHeld={selection.toggleHeld}
              onHoldRange={selection.holdRange}
              onComparePair={compareInTree}
              onReload={loadTree}
            />
          )
        })()}

        {projectMode && (
          <>
            {project === null ? (
              <main className="preview" />
            ) : comparePair ? (
              <CompareView
                project={project}
                original={{ ref: comparePair.original, label: refLabel(tree, comparePair.original) }}
                updated={{ ref: comparePair.updated, label: refLabel(tree, comparePair.updated) }}
                onSwap={selection.swapCompare}
                onClear={selection.clearCompare}
              />
            ) : selected && selectedLeaf?.kind ? (
              <InspectView
                key={`${project}:${selected}`}
                project={project}
                path={selected}
                kind={selectedLeaf.kind}
                title={refLabel(tree, selected)}
                // Not every .xml is a switch export: one that does not parse
                // as one is shown as the text it is.
                fallback={hasFileView(selectedLeaf.name) ? (
                  <FileView project={project} path={selected} name={refLabel(tree, selected)} />
                ) : undefined}
              />
            ) : selected && selectedLeaf && isPdfFile(selectedLeaf.name) ? (
              <PdfView
                key={`${project}:${selected}:${activeSeed?.nonce ?? 0}`}
                project={project}
                path={selected}
                name={refLabel(tree, selected)}
                seed={activeSeed?.term}
              />
            ) : selected && selectedLeaf && hasFileView(selectedLeaf.name) ? (
              <FileView
                key={`${project}:${selected}:${activeSeed?.nonce ?? 0}`}
                project={project}
                path={selected}
                name={refLabel(tree, selected)}
                seed={activeSeed}
              />
            ) : selected && selectedLeaf && isTextFile(selectedLeaf.name) ? (
              <TextFileView
                key={`${project}:${selected}`}
                project={project}
                path={selected}
                name={refLabel(tree, selected)}
                readOnly={selected !== selectedLeaf.path}
              />
            ) : selected && selectedLeaf ? (
              <FileInfo project={project} path={selected} leaf={selectedLeaf} />
            ) : (
              <main className="preview">
                {tree === null && treeError && (
                  <div className="pane-message">{treeError}</div>
                )}
              </main>
            )}
          </>
        )}

        {opened.has('todo') && (
          <div className="todo-pane" hidden={pane !== 'todo'}>
            <TodoBoard project={project} />
          </div>
        )}

        {opened.has('test') && (
          <div className="test-pane" hidden={pane !== 'test'}>
            <TestNetworkView active={pane === 'test'} />
          </div>
        )}

        {/* Same latch as the atlas: an open terminal session or half-filled
            tool form survives a detour back into the project. */}
        {opened.has('tools') && (
          <div className="tools-pane" hidden={pane !== 'tools'}>
            <ToolsView project={project ?? ''} />
          </div>
        )}

        {/* Mounted from the first open onwards — never before, so the library
            is not in the startup path, and never unmounted after. */}
        {opened.has('atlas') && (
          <div className="atlas-pane" hidden={pane !== 'atlas'}>
            <Suspense fallback={null}>
              <AtlasView active={pane === 'atlas'} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  )
}

/** The margin's last word: light / dark. */
function ThemeToggle() {
  const dark = useTheme() === 'dark'
  return (
    <button className="nav-link theme-toggle" onClick={toggleTheme} title={dark ? 'Light mode' : 'Dark mode'}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        {dark ? (
          <>
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
          </>
        ) : (
          <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  )
}

/** A margin link that swaps the main area for a takeover pane. */
function PaneToggle({
  label,
  count = 0,
  on,
  title,
  onClick,
}: {
  label: string
  /** A chip after the label (open todo cards); hidden at 0. */
  count?: number
  on: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button className={on ? 'nav-link on' : 'nav-link'} onClick={onClick} title={title} aria-pressed={on}>
      <span>{label}</span>
      {count > 0 && <span className="todo-count">{count}</span>}
    </button>
  )
}

/** Details for a plain (non-artifact, non-text) file — or an archived
 *  version of one: size, times, note, and the OS-default-app open. */
function FileInfo({
  project,
  path,
  leaf,
}: {
  project: string
  path: string
  leaf: FileLeaf
}) {
  const [error, setError] = useState<string | null>(null)
  const isVersion = path !== leaf.path
  const version = isVersion ? leaf.versions.find((v) => v.path === path) : null
  const at = isVersion ? version?.at ?? null : leaf.uploadedAt
  const note = isVersion ? version?.note ?? null : leaf.note
  const size = isVersion ? version?.size ?? null : leaf.size

  return (
    <main className="preview">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{leaf.name}</h2>
          {isVersion && version && (
            <span className="note-count">
              v{leaf.versions.length - leaf.versions.indexOf(version)}
            </span>
          )}
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
        </div>
      </header>
      <div className="files-detail">
        {size !== null && <div>{formatSize(size)}</div>}
        {at !== null && <div title={formatWhen(at)}>Added {formatStamp(at)}</div>}
        {note && <div className="file-note">“{note}”</div>}
        <Button
          variant="primary"
          onClick={() => openFileEntry(project, path).catch((err) => setError(errorMessage(err)))}
        >
          Open
        </Button>
        {error && <div className="list-error-text">{error}</div>}
      </div>
    </main>
  )
}

// The first-run gate: nothing exists until the user names a project.
function FirstProject({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const { run, busy, error } = useAction()

  const create = () => {
    const trimmed = name.trim()
    if (trimmed && !busy) run(() => onCreate(trimmed))
  }

  return (
    <>
      <div className="app onboard">
        <div className="modal-card onboard-card">
          <div className="modal-head">
            <span className="t">Name your first project</span>
          </div>
          <div className="onboard-form">
            <TextInput
              autoFocus
              value={name}
              placeholder="e.g. Substation 12 upgrade"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
            />
            <Button variant="primary" disabled={!name.trim() || busy} onClick={create}>
              Create project
            </Button>
          </div>
          {error && <div className="modal-error onboard-error">{error}</div>}
        </div>
      </div>
    </>
  )
}
