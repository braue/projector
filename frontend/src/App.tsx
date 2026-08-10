import { useCallback, useEffect, useMemo, useState } from 'react'

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
  startExport,
  uploadRtacFolder,
  uploadSourceFile,
} from './api'
import { AggregateView } from './components/AggregateView'
import { CanvasView } from './components/CanvasView'
import { CompareView } from './components/CompareView'
import { FileTree } from './components/FileTree'
import { Preview } from './components/Preview'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { SourcesSidebar } from './components/SourcesSidebar'
import { Button, SegmentedControl, TextInput } from './components/ui'
import { errorMessage } from './lib/errors'
import { sourceKey } from './lib/sources'
import { TIER_COLOR } from './lib/tiers'
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
const PROJECT_KEY = 'purview-project'

type Mode = 'canvas' | 'inspect' | 'compare'
type InspectSub = 'browse' | 'aggregate'

const MODES: { value: Mode; label: string }[] = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'inspect', label: 'Inspect' },
  { value: 'compare', label: 'Compare' },
]

const EMPTY_UPLOADS: Record<UploadSourceType, { files: UploadedFile[]; error: string | null }> = {
  rdb: { files: [], error: null },
  scd: { files: [], error: null },
  sw: { files: [], error: null },
}

export default function App() {
  const [mode, setMode] = useState<Mode>('canvas')
  const [inspectSub, setInspectSub] = useState<InspectSub>('browse')
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

  // Database-list errors live in the browser modal now; the sidebar banner
  // only reports the backend being unreachable, and Retry refetches.
  const retryList = refreshRtac

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
    setGraph(null)
    setShowFindings(false)
    if (!project) return
    refreshRtac()
    refreshUploads('rdb')
    refreshUploads('scd')
    refreshUploads('sw')
  }, [project, refreshRtac, refreshUploads])

  const handleCreateProject = useCallback(
    async (name: string) => {
      await createProject(name)
      await refreshProjects()
      setProject(name)
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
    [project, refreshRtac],
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
      ? `${graph.links?.length ?? 0} connections · ${graph.summary.conflicts} conflict${graph.summary.conflicts === 1 ? '' : 's'}`
      : mode === 'inspect' && selectedSource
        ? `${selectedSource.type === 'rdb' ? selectedSource.ref.replace(REF_SEPARATOR, ' · ') : selectedSource.ref} · read-only`
        : ''

  // Still loading the project list: just the shell, no flash of onboarding.
  if (projects === null) {
    return (
      <header className="topbar">
        <span className="brand">Purview</span>
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
        <span className="brand">Purview</span>
        <SegmentedControl options={MODES} value={mode} onChange={setMode} />
        <ProjectSwitcher
          current={project}
          projects={projects}
          onSelect={setProject}
          onCreate={handleCreateProject}
          onDelete={handleDeleteProject}
        />
        {mode === 'inspect' && canAggregate && (
          <SegmentedControl
            options={[
              { value: 'browse' as InspectSub, label: 'Browse' },
              { value: 'aggregate' as InspectSub, label: 'Aggregate' },
            ]}
            value={inspectSub}
            onChange={setInspectSub}
          />
        )}
        <span className="topbar-info">{topbarInfo}</span>
      </header>

      <div className="app">
        {mode !== 'compare' && (
          <SourcesSidebar
            project={project}
            projects={rtacProjects}
            listError={listError}
            onRetryList={retryList}
            uploads={uploads}
            onUpload={handleUpload}
            onDeleteUpload={handleDeleteUpload}
            rtacBusy={rtacBusy}
            onUploadRtacFolder={handleUploadRtacFolder}
            onDeleteRtac={handleDeleteRtac}
            onRtacChanged={handleRtacChanged}
            selected={mode === 'inspect' ? selectedSource : null}
            onSelect={handleSelectSource}
            onExport={handleExport}
            placedRefs={placedRefs}
            footer={
              mode === 'canvas'
                ? 'Double-click to download · drag to canvas'
                : 'Click to inspect'
            }
          />
        )}

        {mode === 'canvas' && (
          <div className="canvas-column">
            <CanvasView
              project={project}
              reloadKey={graphVersion}
              onInspect={inspectFromCanvas}
              onGraph={setGraph}
            />
            {showFindings && graph && graph.diagnostics.length > 0 && (
              <div className="findings-panel">
                <div className="findings-head">
                  <span>Network review — {graph.diagnostics.length} finding{graph.diagnostics.length === 1 ? '' : 's'}</span>
                  <button className="x" onClick={() => setShowFindings(false)} title="Close">✕</button>
                </div>
                {graph.diagnostics.map((finding, i) => (
                  <div key={i} className={`finding ${finding.severity === 'error' ? 'bad' : 'warnc'}`}>
                    {finding.text}
                  </div>
                ))}
              </div>
            )}
            <div className="status-bar">
              {graph ? (
                <>
                  <span><b>{graph.summary.devices}</b> devices</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.confirmed }} /><b>{graph.summary.confirmed}</b> confirmed</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.probable }} /><b>{graph.summary.probable}</b> suggested</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.declared }} /><b>{graph.summary.declared}</b> declared</span>
                  {graph.summary.manual > 0 && (
                    <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.manual }} /><b>{graph.summary.manual}</b> drawn</span>
                  )}
                  <span className={graph.summary.conflicts ? 'conflict' : undefined}>
                    {graph.summary.conflicts} conflict{graph.summary.conflicts === 1 ? '' : 's'}
                  </span>
                  {graph.diagnostics.length > 0 && (
                    <button
                      className={showFindings ? 'findings-chip on' : 'findings-chip'}
                      onClick={() => setShowFindings((current) => !current)}
                    >
                      ⚠ {graph.diagnostics.length} network finding{graph.diagnostics.length === 1 ? '' : 's'}
                    </button>
                  )}
                </>
              ) : (
                <span>Drag a downloaded project onto the canvas to begin.</span>
              )}
            </div>
          </div>
        )}

        {mode === 'inspect' &&
          (selectedSource && tree && inspectSub === 'aggregate' && canAggregate ? (
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
          <CompareView key={project} project={project} projects={rtacProjects} uploads={uploads} />
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
        <span className="brand">Purview</span>
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
