import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import {
  createProject,
  deleteProject,
  deleteRtacExport,
  deleteUpload,
  fetchSourceItem,
  fetchSourceTree,
  listProjects,
  listRtacProjects,
  listUploads,
  renameProject,
  renameRtacExport,
  renameUpload,
  rtacExportNames,
  startExport,
  uploadRtacFolder,
  uploadSourceFile,
} from './api'
import { AggregateView } from './components/AggregateView'
import { CanvasView } from './components/CanvasView'
import { CompareView, EMPTY_COMPARE } from './components/CompareView'
import type { CompareState } from './components/CompareView'
import { FilesSearchView } from './components/FilesSearchView'
import { FilesView } from './components/FilesView'
import { NotesSearchView } from './components/NotesSearchView'
import { NotesView } from './components/NotesView'
import { SearchView } from './components/SearchView'
import { FileTree } from './components/FileTree'
import { Preview } from './components/Preview'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { SourcesSidebar } from './components/SourcesSidebar'
import { TodoList } from './components/TodoList'
// The atlas embeds the whole field-knowledge library — 82 documents inlined as
// raw text — so it is its own chunk, fetched the first time it is opened
// rather than parsed on every cold start of a canvas session.
const AtlasView = lazy(() =>
  import('./components/AtlasView').then((m) => ({ default: m.AtlasView })),
)
import { Button, SegmentedControl, TextInput } from './components/ui'
import { ToolsView } from './tools/ToolsView'
import type { ToolSeek } from './tools/registry'
import { confirmOverwrite } from './lib/confirm'
import { errorMessage } from './lib/errors'
import { count } from './lib/format'
import { replaceRefFile, sourceKey } from './lib/sources'
import { useFetch } from './lib/useFetch'
import { REF_SEPARATOR } from './types'
import type {
  DeviceSource,
  ProjectEntry,
  UploadSourceType,
  UploadedFile,
  WorkspaceGraph,
} from './types'

const POLL_MS = 1200
const PROJECT_KEY = 'projector-project'

type Mode = 'canvas' | 'inspect' | 'compare' | 'notes' | 'files'
type InspectSub = 'browse' | 'aggregate' | 'search'

// A mode's working-view/search split (Notes, Files). One state object keeps
// the coupling structural: entering search drops any pending jump target,
// and opening a hit carries the target back into the working view.
function useSubSearch<Jump>() {
  const [state, setState] = useState<{ searching: boolean; jump: Jump | null }>({
    searching: false,
    jump: null,
  })
  const setSearching = useCallback((searching: boolean) => setState({ searching, jump: null }), [])
  const openAt = useCallback((jump: Jump) => setState({ searching: false, jump }), [])
  return { searching: state.searching, jump: state.jump, setSearching, openAt }
}

type SubSearch = ReturnType<typeof useSubSearch<string>>

/** The working-view/search toggle a sub-search mode puts in the topbar. */
function SubSearchTabs({ search, browseLabel }: { search: SubSearch; browseLabel: string }) {
  return (
    <SegmentedControl
      options={[
        { value: 'browse', label: browseLabel },
        { value: 'search', label: 'Search' },
      ]}
      value={search.searching ? 'search' : 'browse'}
      onChange={(sub) => search.setSearching(sub === 'search')}
    />
  )
}

const MODES: { value: Mode; label: string }[] = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'inspect', label: 'Inspect' },
  { value: 'compare', label: 'Compare' },
  { value: 'notes', label: 'Notes' },
  { value: 'files', label: 'Files' },
]

/** Modes that bring their own left rail instead of the sources sidebar. */
const OWN_RAIL: Mode[] = ['compare', 'notes', 'files']

const EMPTY_UPLOADS: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }> = {
  rdb: { files: [], error: null },
  scd: { files: [], error: null },
  sw: { files: [], error: null },
}
const UPLOAD_TYPES = Object.keys(EMPTY_UPLOADS) as UploadSourceType[]

export default function App() {
  const [mode, setMode] = useState<Mode>('canvas')
  // The atlas is reference material, not project data: it sits beside every
  // mode rather than inside the mode row, and keeps its place while you dip
  // back into the project.
  const [atlasOpen, setAtlasOpen] = useState(false)
  // Latched on the first open: the atlas chunk is fetched then, and the pane
  // stays mounted from that point so the reading position survives a detour.
  const [atlasEverOpened, setAtlasEverOpened] = useState(false)
  // The tools are global utilities, so like the atlas they live beside the
  // mode row — and latch for the same reason: an open terminal session or a
  // half-configured extraction survives dipping back into the project.
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsEverOpened, setToolsEverOpened] = useState(false)
  // Reference jumps out of a canvas device popup: the seek says what to show
  // over there, and its `n` bumps per request so a repeat still lands.
  const [toolsSeek, setToolsSeek] = useState<ToolSeek | null>(null)
  const [inspectSub, setInspectSub] = useState<InspectSub>('browse')
  // Notes and Files each split into their working view and a full-pane search.
  const notesSearch = useSubSearch<string>()
  const filesSearch = useSubSearch<string>()
  // Destructured so effects can depend on the stable callbacks, not the
  // per-render hook object.
  const { setSearching: setNotesSearching } = notesSearch
  const { setSearching: setFilesSearching } = filesSearch
  // The current project scopes every source, canvas, and compare below.
  // null projects = still loading the list; null project + loaded list =
  // nothing exists yet, so the user names their first project before work.
  const [project, setProject] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[] | null>(null)
  const [rtacProjects, setRtacProjects] = useState<ProjectEntry[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [uploads, setUploads] = useState(EMPTY_UPLOADS)
  const [selectedSource, setSelectedSource] = useState<DeviceSource | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  // Compare picks live here, not in CompareView: that view unmounts on every
  // mode switch, and a comparison mid-review must survive a detour through
  // Inspect or the canvas.
  const [compare, setCompare] = useState<CompareState>(EMPTY_COMPARE)
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [showFindings, setShowFindings] = useState(false)

  const refreshRtac = useCallback(async () => {
    if (!project) return
    try {
      const list = await listRtacProjects(project)
      setRtacProjects(list.projects)
      setListError(null)
    } catch (err) {
      setListError(`Cannot reach the backend: ${errorMessage(err)}`)
    }
  }, [project])

  const refreshUploads = useCallback(async (type: UploadSourceType) => {
    if (!project) return
    try {
      const files = await listUploads(project, type)
      setUploads((current) => ({ ...current, [type]: { ...current[type], files } }))
    } catch (err) {
      setUploads((current) => ({
        ...current,
        [type]: { ...current[type], error: errorMessage(err) },
      }))
    }
  }, [project])

  const refreshProjects = useCallback(async () => {
    try {
      const names = await listProjects()
      setProjects(names)
      return names
    } catch {
      // Backend unreachable: the sidebar already surfaces it; keep the list.
      return null
    }
  }, [])

  // Startup: restore the last-used project if it still exists, otherwise the
  // first one; none at all leaves `project` null and gates on naming one.
  useEffect(() => {
    refreshProjects().then((names) => {
      if (!names) return
      const remembered = localStorage.getItem(PROJECT_KEY)
      setProject(remembered && names.includes(remembered) ? remembered : names[0] ?? null)
    })
  }, [refreshProjects])

  useEffect(() => {
    if (project) localStorage.setItem(PROJECT_KEY, project)
  }, [project])

  // Switching projects swaps every source list and clears per-project state.
  useEffect(() => {
    setRtacProjects([])
    setUploads(EMPTY_UPLOADS)
    setSelectedSource(null)
    setSelectedItem(null)
    setCompare(EMPTY_COMPARE)
    setGraph(null)
    setShowFindings(false)
    setNotesSearching(false)
    setFilesSearching(false)
    if (!project) return
    refreshRtac()
    for (const type of UPLOAD_TYPES) refreshUploads(type)
  }, [project, refreshRtac, refreshUploads, setNotesSearching, setFilesSearching])

  const handleCreateProject = useCallback(
    async (name: string) => {
      await createProject(name)
      await refreshProjects()
      setProject(name)
    },
    [refreshProjects],
  )

  const handleRenameProject = useCallback(
    async (name: string, nextName: string) => {
      const renamed = await renameProject(name, nextName)
      await refreshProjects()
      setProject((current) => (current === name ? renamed.name : current))
    },
    [refreshProjects],
  )

  const handleDeleteProject = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete project "${name}" and all of its sources? This cannot be undone.`)) {
        return
      }
      try {
        await deleteProject(name)
      } catch (err) {
        setListError(errorMessage(err))
        return
      }
      const names = (await refreshProjects()) ?? []
      setProject((current) =>
        current === name ? names[0] ?? null : current,
      )
    },
    [refreshProjects],
  )

  // Poll while any export is in flight so spinners resolve on their own —
  // each refresh replaces `rtacProjects`, which re-arms the timer.
  const exporting = rtacProjects.some((p) => p.status === 'exporting')
  useEffect(() => {
    if (!exporting) return
    const timer = window.setTimeout(refreshRtac, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [exporting, rtacProjects, refreshRtac])

  const handleExport = useCallback(
    async (name: string) => {
      if (!project) return
      try {
        await startExport(project, name)
      } catch (err) {
        setListError(`Could not start the export of ${name}: ${errorMessage(err)}`)
        return
      }
      setSelectedSource((current) => (current?.type === 'rtac' && current.ref === name ? null : current))
      await refreshRtac()
    },
    [project, refreshRtac],
  )

  // RTAC sources beyond the database double-click: folder upload + removal.
  const [rtacBusy, setRtacBusy] = useState(false)
  const handleUploadRtacFolder = useCallback(
    async (files: File[]) => {
      if (!project) return
      const overwriting = rtacExportNames(files)
        .filter((name) => rtacProjects.some((entry) => entry.name === name))
      if (!confirmOverwrite(overwriting, 'this upload')) return
      setRtacBusy(true)
      setListError(null)
      try {
        await uploadRtacFolder(project, files)
        await refreshRtac()
        setGraphVersion((v) => v + 1)
      } catch (err) {
        setListError(errorMessage(err))
      } finally {
        setRtacBusy(false)
      }
    },
    [project, rtacProjects, refreshRtac],
  )

  const handleDeleteRtac = useCallback(
    async (name: string) => {
      if (!project) return
      try {
        await deleteRtacExport(project, name)
      } catch (err) {
        setListError(errorMessage(err))
      }
      setSelectedSource((current) =>
        current?.type === 'rtac' && current.ref === name ? null : current,
      )
      await refreshRtac()
      setGraphVersion((v) => v + 1)
    },
    [project, refreshRtac],
  )

  const handleRtacChanged = useCallback(async () => {
    await refreshRtac()
    setGraphVersion((v) => v + 1)
  }, [refreshRtac])

  // Renames are identity changes — the backend rewrites canvas refs, and the
  // local selection follows the new ref. Failures throw so the sidebar's
  // inline form can show them.
  const handleRenameRtac = useCallback(
    async (name: string, nextName: string) => {
      if (!project) return
      const renamed = await renameRtacExport(project, name, nextName)
      setSelectedSource((current) =>
        current?.type === 'rtac' && current.ref === name ? { type: 'rtac', ref: renamed.name } : current,
      )
      await refreshRtac()
      setGraphVersion((v) => v + 1)
    },
    [project, refreshRtac],
  )

  const handleRenameUpload = useCallback(
    async (type: UploadSourceType, id: string, name: string) => {
      if (!project) return
      const renamed = await renameUpload(project, type, id, name)
      setSelectedSource((current) => {
        if (current?.type !== type) return current
        const ref = replaceRefFile(current.ref, id, renamed.id)
        return ref === current.ref ? current : { type, ref }
      })
      await refreshUploads(type)
      setGraphVersion((v) => v + 1)
    },
    [project, refreshUploads],
  )

  const setUploadError = useCallback((type: UploadSourceType, error: string | null) => {
    setUploads((current) => ({ ...current, [type]: { ...current[type], error } }))
  }, [])

  const handleUpload = useCallback(
    async (type: UploadSourceType, file: File) => {
      if (!project) return
      setUploadError(type, null)
      try {
        await uploadSourceFile(project, type, file)
        await refreshUploads(type)
        // New profiles may resolve existing ghosts (or re-resolve a deleted
        // file's attachments after a re-upload) — recompute the canvas.
        setGraphVersion((v) => v + 1)
      } catch (err) {
        setUploadError(type, errorMessage(err))
      }
    },
    [project, refreshUploads, setUploadError],
  )

  const handleDeleteUpload = useCallback(
    async (type: UploadSourceType, id: string) => {
      if (!project) return
      try {
        await deleteUpload(project, type, id)
      } catch (err) {
        setUploadError(type, errorMessage(err))
      }
      setSelectedSource((current) =>
        current?.type === type && current.ref.startsWith(`${id}${REF_SEPARATOR}`) ? null : current,
      )
      await refreshUploads(type)
      setGraphVersion((v) => v + 1)
    },
    [project, refreshUploads, setUploadError],
  )

  // Entering a mode always lands on its working view, not a stale search.
  const changeMode = useCallback((next: Mode) => {
    setMode(next)
    setNotesSearching(false)
    setFilesSearching(false)
  }, [setNotesSearching, setFilesSearching])

  // Selecting a source (sidebar click, or canvas node double-click via onInspect).
  const handleSelectSource = useCallback((source: DeviceSource) => {
    setSelectedSource(source)
    setSelectedItem(null)
    setInspectSub('browse')
  }, [])

  const inspectFromCanvas = useCallback(
    (source: DeviceSource) => {
      handleSelectSource(source)
      setMode('inspect')
    },
    [handleSelectSource],
  )

  // A device popup's "Connection drawing": the Drawing Generator opens seeded
  // with the device's part number and corpus model, and runs at once when the
  // part number is known.
  const openDrawingTool = useCallback((dwgen: { partNumber: string | null; model: string | null }) => {
    setToolsSeek((prev) => ({ tool: 'dwgen', dwgen, n: (prev?.n ?? 0) + 1 }))
    setToolsOpen(true)
    setToolsEverOpened(true)
    setAtlasOpen(false)
  }, [])

  const { data: tree, error: treeError } = useFetch(
    project && selectedSource ? () => fetchSourceTree(project, selectedSource) : null,
    [project, selectedSource],
  )
  const { data: item, error: itemError } = useFetch(
    project && selectedSource && selectedItem
      ? () => fetchSourceItem(project, selectedSource, selectedItem)
      : null,
    [project, selectedSource, selectedItem],
    { keepStale: true },
  )

  const placedRefs = useMemo(
    () => new Set((graph?.devices ?? []).map((device) => sourceKey(device.source))),
    [graph],
  )

  const canAggregate = selectedSource?.type === 'rtac'

  const topbarInfo =
    mode === 'canvas' && graph
      ? `${graph.links.length} connections · ${count(graph.summary.conflicts, 'conflict')}`
        + (graph.summary.waived ? ` · ${graph.summary.waived} acknowledged` : '')
      : ''

  // Still loading the project list: just the shell, no flash of onboarding.
  if (projects === null) {
    return (
      <header className="topbar">
      </header>
    )
  }

  // Nothing exists yet (first run, or everything deleted): name a project
  // before any work starts.
  if (project === null) {
    return <FirstProject onCreate={handleCreateProject} />
  }

  return (
    <>
      <header className="topbar">
        {/* Everything up to the tools/atlas toggles is scoped to the current
            project, so one guard covers the lot — the way the body below
            does it. Those two panes span every project, hold the corner so
            their toggles never move, and the project switcher goes away with
            the rest: nothing on screen is scoped to a project while either
            is up. */}
        {!atlasOpen && !toolsOpen && (
          <>
            <SegmentedControl options={MODES} value={mode} onChange={changeMode} />
            {mode === 'inspect' && selectedSource && (
              <SegmentedControl
                options={[
                  { value: 'browse' as InspectSub, label: 'Browse' },
                  ...(canAggregate
                    ? [{ value: 'aggregate' as InspectSub, label: 'Aggregate' }]
                    : []),
                  { value: 'search' as InspectSub, label: 'Search' },
                ]}
                value={inspectSub}
                onChange={setInspectSub}
              />
            )}
            {mode === 'notes' && <SubSearchTabs search={notesSearch} browseLabel="Create" />}
            {mode === 'files' && <SubSearchTabs search={filesSearch} browseLabel="Navigate" />}
            <span className="topbar-info">{topbarInfo}</span>
            {mode === 'canvas' && graph && graph.diagnostics.length > 0 && (
              <button
                className={showFindings ? 'findings-chip on' : 'findings-chip'}
                onClick={() => setShowFindings((current) => !current)}
              >
                ⚠ {count(graph.diagnostics.length, 'network finding')}
              </button>
            )}
            <ProjectSwitcher
              current={project}
              projects={projects}
              onSelect={setProject}
              onCreate={handleCreateProject}
              onRename={handleRenameProject}
              onDelete={handleDeleteProject}
            />
          </>
        )}
        {/* Beside the two takeover panes, and like them outside the project
            guard: the list spans every project, so it stays reachable with
            the tools or the atlas up. */}
        <TodoList />
        <button
          className={toolsOpen ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
          onClick={() => {
            setToolsOpen((open) => !open)
            setToolsEverOpened(true)
            setAtlasOpen(false)
          }}
          title={toolsOpen ? 'Back to the project' : 'Open the tools'}
        >
          <span className="topbar-toggle-mark">⚒</span>
          <span>Tools</span>
        </button>
        <button
          className={atlasOpen ? 'topbar-button topbar-toggle on' : 'topbar-button topbar-toggle'}
          onClick={() => {
            setAtlasOpen((open) => !open)
            setAtlasEverOpened(true)
            setToolsOpen(false)
          }}
          title={atlasOpen ? 'Back to the project' : 'Open the atlas reference'}
        >
          <span className="topbar-toggle-mark">◆</span>
          <span>Atlas</span>
        </button>
      </header>

      <div className="app">
        {!atlasOpen && !toolsOpen && (
          <>
          {!OWN_RAIL.includes(mode) && (
            <SourcesSidebar
              project={project}
              projects={rtacProjects}
              listError={listError}
              onRetryList={refreshRtac}
              uploads={uploads}
              onUpload={handleUpload}
              onDeleteUpload={handleDeleteUpload}
              onRenameRtac={handleRenameRtac}
              onRenameUpload={handleRenameUpload}
              rtacBusy={rtacBusy}
              onUploadRtacFolder={handleUploadRtacFolder}
              onDeleteRtac={handleDeleteRtac}
              onRtacChanged={handleRtacChanged}
              selected={mode === 'inspect' ? selectedSource : null}
              onSelect={handleSelectSource}
              onExport={handleExport}
              placedRefs={placedRefs}
            />
          )}

          {mode === 'canvas' && (
            <div className="canvas-column">
              <CanvasView
                project={project}
                reloadKey={graphVersion}
                onInspect={inspectFromCanvas}
                onGraph={setGraph}
                onOpenDrawing={openDrawingTool}
              />
              {showFindings && graph && graph.diagnostics.length > 0 && (
                <div className="findings-panel">
                  <div className="findings-head">
                    <span>Network review — {count(graph.diagnostics.length, 'finding')}</span>
                    <button className="x" onClick={() => setShowFindings(false)} title="Close">✕</button>
                  </div>
                  {graph.diagnostics.map((finding, i) => (
                    <div key={i} className={`finding ${finding.severity === 'error' ? 'bad' : 'warnc'}`}>
                      {finding.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === 'inspect' &&
            (selectedSource && inspectSub === 'search' ? (
              <SearchView
                key={`${project}:${sourceKey(selectedSource)}`}
                project={project}
                source={selectedSource}
                onOpen={(path) => {
                  setSelectedItem(path)
                  setInspectSub('browse')
                }}
              />
            ) : selectedSource && tree && inspectSub === 'aggregate' && canAggregate ? (
              <AggregateView
                key={`${project}:${selectedSource.ref}`}
                project={project}
                name={selectedSource.ref}
                tree={tree}
              />
            ) : (
              <>
                {selectedSource && tree && (
                  <FileTree tree={tree} selected={selectedItem} onSelect={setSelectedItem} />
                )}
                {selectedSource && !tree && (
                  <aside className="file-tree">
                    <div className="pane-message">{treeError ?? 'Loading…'}</div>
                  </aside>
                )}
                {item ? (
                  <Preview item={item} />
                ) : (
                  <main className="preview">
                    <div className="pane-message">
                      {itemError ??
                        (selectedSource
                          ? 'Select an item to view its settings.'
                          : 'Pick a source from the sidebar — or click a device on the canvas.')}
                    </div>
                  </main>
                )}
              </>
            ))}

          {mode === 'compare' && (
            <CompareView
              key={project}
              project={project}
              projects={rtacProjects}
              uploads={uploads}
              state={compare}
              onState={setCompare}
              listError={listError}
              onRetryList={refreshRtac}
              onUpload={handleUpload}
              rtacBusy={rtacBusy}
              onUploadRtacFolder={handleUploadRtacFolder}
              onRtacChanged={handleRtacChanged}
            />
          )}

          {mode === 'notes' &&
            (notesSearch.searching ? (
              <NotesSearchView key={project} project={project} onOpen={notesSearch.openAt} />
            ) : (
              <NotesView key={project} project={project} initialSelectedId={notesSearch.jump} />
            ))}

          {mode === 'files' &&
            (filesSearch.searching ? (
              <FilesSearchView key={project} project={project} onOpen={filesSearch.openAt} />
            ) : (
              <FilesView key={project} project={project} initialSelected={filesSearch.jump} />
            ))}
          </>
        )}

        {/* Same latch as the atlas: an open terminal session or half-filled
            tool form survives a detour back into the project. */}
        {toolsEverOpened && (
          <div className="tools-pane" hidden={!toolsOpen}>
            <ToolsView project={project} seek={toolsSeek} />
          </div>
        )}

        {/* Mounted from the first open onwards — never before, so the library
            is not in the startup path, and never unmounted after, so a
            half-read page is still there when you come back from the project. */}
        {atlasEverOpened && (
          <div className="atlas-pane" hidden={!atlasOpen}>
            <Suspense fallback={null}>
              <AtlasView active={atlasOpen} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  )
}

// The first-run gate: nothing exists until the user names a project.
function FirstProject({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      <header className="topbar">
      </header>
      <div className="app onboard">
        <div className="modal-card onboard-card">
          <div className="modal-head">
            <span className="t">Name your first project</span>
          </div>
          <div className="modal-sub">
            A project holds its own RTAC exports, settings uploads, and canvas —
            everything scoped to one job.
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
