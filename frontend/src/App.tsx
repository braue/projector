import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  createProject,
  deleteUpload,
  fetchSourceItem,
  fetchSourceTree,
  listProjects,
  listRtacProjects,
  listUploads,
  refreshRtacProjects,
  startExport,
  uploadSourceFile,
} from './api'
import { AggregateView } from './components/AggregateView'
import { CanvasView } from './components/CanvasView'
import { CompareView } from './components/CompareView'
import { FileTree } from './components/FileTree'
import { Preview } from './components/Preview'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { SourcesSidebar } from './components/SourcesSidebar'
import { SegmentedControl } from './components/ui'
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
const DEFAULT_PROJECT = 'Default'

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
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const [projects, setProjects] = useState<string[]>([DEFAULT_PROJECT])
  const [rtacProjects, setRtacProjects] = useState<ProjectEntry[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [uploads, setUploads] = useState(EMPTY_UPLOADS)
  const [selectedSource, setSelectedSource] = useState<DeviceSource | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [showFindings, setShowFindings] = useState(false)

  const refreshRtac = useCallback(async () => {
    try {
      const list = await listRtacProjects(project)
      setRtacProjects(list.projects)
      setListError(list.error)
    } catch (err) {
      setListError(`Cannot reach the backend: ${errorMessage(err)}`)
    }
  }, [project])

  const refreshUploads = useCallback(async (type: UploadSourceType) => {
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

  const retryList = useCallback(async () => {
    try {
      const list = await refreshRtacProjects(project)
      setRtacProjects(list.projects)
      setListError(list.error)
    } catch {
      await refreshRtac()
    }
  }, [project, refreshRtac])

  const refreshProjects = useCallback(async () => {
    try {
      const names = await listProjects()
      if (names.length) setProjects(names)
      return names
    } catch {
      // Backend unreachable: the sidebar already surfaces it; keep the list.
      return []
    }
  }, [])

  // Startup: pick a real project (the backend guarantees at least one).
  useEffect(() => {
    refreshProjects().then((names) => {
      if (names.length && !names.includes(DEFAULT_PROJECT)) setProject(names[0])
    })
  }, [refreshProjects])

  // Switching projects swaps every source list and clears per-project state.
  useEffect(() => {
    setRtacProjects([])
    setUploads(EMPTY_UPLOADS)
    setSelectedSource(null)
    setSelectedItem(null)
    setGraph(null)
    setShowFindings(false)
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

  const setUploadError = useCallback((type: UploadSourceType, error: string | null) => {
    setUploads((current) => ({ ...current, [type]: { ...current[type], error } }))
  }, [])

  const handleUpload = useCallback(
    async (type: UploadSourceType, file: File) => {
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
    selectedSource ? () => fetchSourceTree(project, selectedSource) : null,
    [project, selectedSource],
  )
  const { data: item, error: itemError } = useFetch(
    selectedSource && selectedItem ? () => fetchSourceItem(project, selectedSource, selectedItem) : null,
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
            projects={rtacProjects}
            listError={listError}
            onRetryList={retryList}
            uploads={uploads}
            onUpload={handleUpload}
            onDeleteUpload={handleDeleteUpload}
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
