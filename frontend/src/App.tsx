import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  deleteRdbFile,
  fetchSourceItem,
  fetchSourceTree,
  listProjects,
  listRdbFiles,
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
import { SegmentedControl } from './components/ui'
import type {
  DeviceSource,
  ProjectEntry,
  ProjectItem,
  ProjectTree,
  RdbFile,
  WorkspaceGraph,
} from './types'

const POLL_MS = 1200
const WORKSPACE = 'Default' // named workspaces get a switcher later

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
  const [tree, setTree] = useState<ProjectTree | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  const [item, setItem] = useState<ProjectItem | null>(null)
  const [itemError, setItemError] = useState<string | null>(null)
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const pollTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects()
      setProjects(list.projects)
      setListError(list.error)
      return list.projects
    } catch (err) {
      setListError(`Cannot reach the backend: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }, [])

  const refreshRdb = useCallback(async () => {
    try {
      setRdbFiles(await listRdbFiles())
    } catch (err) {
      setRdbError(err instanceof Error ? err.message : String(err))
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

  // Poll while any export is in flight so spinners resolve on their own.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const list = await refresh()
      if (cancelled) return
      if (list.some((p) => p.status === 'exporting')) {
        pollTimer.current = window.setTimeout(tick, POLL_MS)
      }
    }
    tick()
    refreshRdb()
    return () => {
      cancelled = true
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    }
  }, [refresh, refreshRdb])

  const handleExport = useCallback(
    async (name: string) => {
      try {
        await startExport(name)
      } catch (err) {
        setListError(
          `Could not start the export of ${name}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      setSelectedSource((current) => (current?.type === 'rtac' && current.ref === name ? null : current))
      const list = await refresh()
      if (list.some((p) => p.status === 'exporting') && pollTimer.current === null) {
        pollTimer.current = window.setTimeout(async function tick() {
          const next = await refresh()
          pollTimer.current = next.some((p) => p.status === 'exporting')
            ? window.setTimeout(tick, POLL_MS)
            : null
        }, POLL_MS)
      }
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
        setRdbError(err instanceof Error ? err.message : String(err))
      }
    },
    [refreshRdb],
  )

  const handleDeleteRdb = useCallback(
    async (id: string) => {
      try {
        await deleteRdbFile(id)
      } catch (err) {
        setRdbError(err instanceof Error ? err.message : String(err))
      }
      setSelectedSource((current) =>
        current?.type === 'rdb' && current.ref.startsWith(`${id}::`) ? null : current,
      )
      await refreshRdb()
      setGraphVersion((v) => v + 1)
    },
    [refreshRdb],
  )

  // Selecting a source (sidebar click, or canvas node click via onInspect).
  const handleSelectSource = useCallback((source: DeviceSource) => {
    setSelectedSource(source)
    setSelectedItem(null)
    setItem(null)
    setItemError(null)
    setInspectSub('browse')
  }, [])

  const inspectFromCanvas = useCallback(
    (source: DeviceSource) => {
      handleSelectSource(source)
      setMode('inspect')
    },
    [handleSelectSource],
  )

  useEffect(() => {
    if (!selectedSource) {
      setTree(null)
      return
    }
    let cancelled = false
    setTree(null)
    setTreeError(null)
    fetchSourceTree(selectedSource)
      .then((t) => !cancelled && setTree(t))
      .catch((err) => !cancelled && setTreeError(err.message))
    return () => {
      cancelled = true
    }
  }, [selectedSource])

  useEffect(() => {
    if (!selectedSource || !selectedItem) {
      setItem(null)
      return
    }
    let cancelled = false
    setItemError(null)
    fetchSourceItem(selectedSource, selectedItem)
      .then((i) => !cancelled && setItem(i))
      .catch((err) => !cancelled && setItemError(err.message))
    return () => {
      cancelled = true
    }
  }, [selectedSource, selectedItem])

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
        ? `${selectedSource.type === 'rdb' ? selectedSource.ref.replace('::', ' · ') : selectedSource.ref} · read-only`
        : ''

  return (
    <>
      <header className="topbar">
        <span className="brand">Gridlink</span>
        <SegmentedControl options={MODES} value={mode} onChange={setMode} />
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
              workspace={WORKSPACE}
              reloadKey={graphVersion}
              onInspect={inspectFromCanvas}
              onGraph={setGraph}
            />
            <div className="status-bar">
              {graph ? (
                <>
                  <span><b>{graph.summary.devices}</b> devices</span>
                  <span className="tierdot"><span className="d" style={{ background: '#1a9e5c' }} /><b>{graph.summary.confirmed}</b> confirmed</span>
                  <span className="tierdot"><span className="d" style={{ background: '#d7930a' }} /><b>{graph.summary.probable}</b> suggested</span>
                  <span className="tierdot"><span className="d" style={{ background: '#a9adb8' }} /><b>{graph.summary.declared}</b> declared</span>
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
