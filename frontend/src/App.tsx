import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  createWorkspace,
  deleteRdbFile,
  fetchSourceItem,
  fetchSourceTree,
  listProjects,
  listRdbFiles,
  listWorkspaces,
  refreshProjects,
  startExport,
  uploadRdb,
} from './api'
import { AggregateView } from './components/AggregateView'
import { CanvasView } from './components/CanvasView'
import { CompareView } from './components/CompareView'
import { FileTree } from './components/FileTree'
import { Preview } from './components/Preview'
import { SourcesSidebar } from './components/SourcesSidebar'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { SegmentedControl } from './components/ui'
import { errorMessage } from './lib/errors'
import { TIER_COLOR } from './lib/tiers'
import { useFetch } from './lib/useFetch'
import { REF_SEPARATOR } from './types'
import type { DeviceSource, ProjectEntry, RdbFile, WorkspaceGraph } from './types'

const POLL_MS = 1200
const DEFAULT_WORKSPACE = 'Default'

type Mode = 'canvas' | 'inspect' | 'compare'
type InspectSub = 'browse' | 'aggregate'

const MODES: { value: Mode; label: string }[] = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'inspect', label: 'Inspect' },
  { value: 'compare', label: 'Compare' },
]

export default function App() {
  const [mode, setMode] = useState<Mode>('canvas')
  const [inspectSub, setInspectSub] = useState<InspectSub>('browse')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [rdbFiles, setRdbFiles] = useState<RdbFile[]>([])
  const [rdbError, setRdbError] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<DeviceSource | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE)
  const [workspaces, setWorkspaces] = useState<string[]>([DEFAULT_WORKSPACE])

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects()
      setProjects(list.projects)
      setListError(list.error)
    } catch (err) {
      setListError(`Cannot reach the backend: ${errorMessage(err)}`)
    }
  }, [])

  const refreshRdb = useCallback(async () => {
    try {
      setRdbFiles(await listRdbFiles())
    } catch (err) {
      setRdbError(errorMessage(err))
    }
  }, [])

  const retryList = useCallback(async () => {
    try {
      const list = await refreshProjects()
      setProjects(list.projects)
      setListError(list.error)
    } catch {
      await refresh()
    }
  }, [refresh])

  const refreshWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces())
    } catch {
      // Backend unreachable: the sidebar already surfaces it; keep the list.
    }
  }, [])

  useEffect(() => {
    refresh()
    refreshRdb()
    refreshWorkspaces()
  }, [refresh, refreshRdb, refreshWorkspaces])

  const handleCreateWorkspace = useCallback(
    async (name: string) => {
      await createWorkspace(name)
      await refreshWorkspaces()
      setWorkspace(name)
    },
    [refreshWorkspaces],
  )

  // Poll while any export is in flight so spinners resolve on their own —
  // each refresh replaces `projects`, which re-arms the timer.
  const exporting = projects.some((p) => p.status === 'exporting')
  useEffect(() => {
    if (!exporting) return
    const timer = window.setTimeout(refresh, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [exporting, projects, refresh])

  const handleExport = useCallback(
    async (name: string) => {
      try {
        await startExport(name)
      } catch (err) {
        setListError(`Could not start the export of ${name}: ${errorMessage(err)}`)
        return
      }
      setSelectedSource((current) => (current?.type === 'rtac' && current.ref === name ? null : current))
      await refresh()
    },
    [refresh],
  )

  const handleUploadRdb = useCallback(
    async (file: File) => {
      setRdbError(null)
      try {
        await uploadRdb(file)
        await refreshRdb()
        // New relay profiles may resolve existing ghosts — recompute the canvas.
        setGraphVersion((v) => v + 1)
      } catch (err) {
        setRdbError(errorMessage(err))
      }
    },
    [refreshRdb],
  )

  const handleDeleteRdb = useCallback(
    async (id: string) => {
      try {
        await deleteRdbFile(id)
      } catch (err) {
        setRdbError(errorMessage(err))
      }
      setSelectedSource((current) =>
        current?.type === 'rdb' && current.ref.startsWith(`${id}${REF_SEPARATOR}`) ? null : current,
      )
      await refreshRdb()
      setGraphVersion((v) => v + 1)
    },
    [refreshRdb],
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
    selectedSource ? () => fetchSourceTree(selectedSource) : null,
    [selectedSource],
  )
  const { data: item, error: itemError } = useFetch(
    selectedSource && selectedItem ? () => fetchSourceItem(selectedSource, selectedItem) : null,
    [selectedSource, selectedItem],
    { keepStale: true },
  )

  const placedRefs = useMemo(
    () =>
      new Set((graph?.devices ?? []).map((device) => `${device.source.type}:${device.source.ref}`)),
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
        {mode === 'canvas' && (
          <WorkspaceSwitcher
            current={workspace}
            workspaces={workspaces}
            onSelect={setWorkspace}
            onCreate={handleCreateWorkspace}
          />
        )}
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
            projects={projects}
            listError={listError}
            onRetryList={retryList}
            rdbFiles={rdbFiles}
            rdbError={rdbError}
            onUploadRdb={handleUploadRdb}
            onDeleteRdb={handleDeleteRdb}
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
              workspace={workspace}
              reloadKey={graphVersion}
              onInspect={inspectFromCanvas}
              onGraph={setGraph}
            />
            <div className="status-bar">
              {graph ? (
                <>
                  <span><b>{graph.summary.devices}</b> devices</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.confirmed }} /><b>{graph.summary.confirmed}</b> confirmed</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.probable }} /><b>{graph.summary.probable}</b> suggested</span>
                  <span className="tierdot"><span className="d" style={{ background: TIER_COLOR.declared }} /><b>{graph.summary.declared}</b> declared</span>
                  <span className={graph.summary.conflicts ? 'conflict' : undefined}>
                    {graph.summary.conflicts} conflict{graph.summary.conflicts === 1 ? '' : 's'}
                  </span>
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
              key={selectedSource.ref}
              project={selectedSource.ref}
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

        {mode === 'compare' && <CompareView projects={projects} />}
      </div>
    </>
  )
}
